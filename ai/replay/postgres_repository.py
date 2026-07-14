"""Fail-closed PostgreSQL repository for one immutable typed replay capture.

The repository deliberately performs one query for one exact pin set.  The
physical boundary is ``ai_replay_typed_source_capture``: an upstream-owned,
append-only capture containing lossless disclosure/financial, text-hit and
Strategy score envelopes plus their four source-version pins.  This module
does not fall back to current tables, rebuild missing source documents, or
re-seal a different payload as an historical fact.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import fields
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import os
from typing import Any, Optional

from ai.replay.runtime import (
    SOURCE_VERSION_KEYS,
    TypedScoreRecord,
    TypedSourceSnapshot,
    typed_score_fact_hash,
)
from ai.replay.service import ReplayService, ReplaySourceError
from ai.replay.types import ReplayPins
from ai.snapshot.fingerprint import jcs_canonicalize
from ai.snapshot.postgres_store import validate_database_url
from datapipeline.collectors.jpkr_deep.official_fixture_parser import (
    canonical_disclosure_fact_hash,
)
from datapipeline.contracts import (
    JpKrDisclosureRecord,
    JpKrFilingEnvelope,
    JpKrFinancialRecord,
    ScanDocument,
    TextHit,
    TextHitEnvelope,
)


CAPTURE_COLUMNS = (
    "capture_id",
    "trading_day",
    "as_of_utc",
    "profile",
    "market_scope",
    "profile_version",
    "contract_version",
    "input_fingerprint",
    "strategy_version",
    "pipeline_version",
    "available_at_utc",
    "source_versions",
    "filings_json",
    "text_hits_json",
    "scores_json",
    "capture_hash",
)
_CAPTURE_PROJECTION = ", ".join(CAPTURE_COLUMNS)

SELECT_CAPTURE = f"""
SELECT {_CAPTURE_PROJECTION}
FROM ai_replay_typed_source_capture
WHERE trading_day = %s::date
  AND as_of_utc = %s::timestamptz
  AND profile = %s
  AND market_scope = %s
  AND profile_version = %s
  AND contract_version = %s
  AND input_fingerprint = %s
  AND strategy_version = %s
  AND pipeline_version = %s
  AND available_at_utc <= %s::timestamptz
ORDER BY capture_id ASC
"""

_FORBIDDEN_LIBPQ_ENV = (
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGDATABASE",
    "PGUSER",
    "PGPASSWORD",
    "PGPASSFILE",
)


class TypedSourceRepositoryConfigurationError(ValueError):
    """The repository connection boundary is missing or ambiguous."""


class TypedSourceRepositoryDependencyError(RuntimeError):
    """The required psycopg3 runtime is unavailable."""


class TypedSourceRepositoryReadError(RuntimeError):
    """The capture could not be read without leaking connection details."""


def _default_connector(database_url: str):
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise TypedSourceRepositoryDependencyError(
            "psycopg3 is required for PostgresTypedSourceRepository"
        ) from error
    try:
        return psycopg.connect(
            database_url,
            row_factory=dict_row,
            connect_timeout=5,
            application_name="stocks-ai-typed-replay-source",
            passfile="",
        )
    except Exception as error:
        raise TypedSourceRepositoryReadError(
            "unable to connect using DATABASE_URL"
        ) from error


Connector = Callable[[str], Any]


class PostgresTypedSourceRepository:
    """Load one exact immutable capture in one read-only DB transaction."""

    def __init__(
        self,
        database_url: str,
        *,
        connector: Optional[Connector] = None,
    ) -> None:
        try:
            self._database_url = validate_database_url(database_url)
        except ValueError as error:
            raise TypedSourceRepositoryConfigurationError(
                "DATABASE_URL is invalid for typed replay sources"
            ) from error
        self._connector = connector or _default_connector

    @classmethod
    def from_env(
        cls,
        environ: Optional[Mapping[str, str]] = None,
        *,
        connector: Optional[Connector] = None,
    ) -> "PostgresTypedSourceRepository":
        source = os.environ if environ is None else environ
        if any(source.get(variable) for variable in _FORBIDDEN_LIBPQ_ENV):
            raise TypedSourceRepositoryConfigurationError(
                "libpq environment fallbacks are forbidden with DATABASE_URL"
            )
        return cls(source.get("DATABASE_URL", ""), connector=connector)

    def load(self, pins: ReplayPins) -> TypedSourceSnapshot:
        # Direct repository callers receive the same pre-read guard as the
        # ReplayService submit boundary.  Invalid/custom pairs never connect.
        ReplayService._validate_pins(pins)
        connection = self._connect()
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
                    )
                    cursor.execute(SELECT_CAPTURE, _pin_parameters(pins))
                    rows = cursor.fetchall()
        except ReplaySourceError:
            raise
        except Exception as error:
            raise TypedSourceRepositoryReadError(
                "unable to load typed replay source capture"
            ) from error
        finally:
            connection.close()

        if len(rows) != 1:
            if not rows:
                raise ReplaySourceError("typed source capture not found")
            raise ReplaySourceError("typed source capture identity is duplicated")
        return _snapshot_from_capture(rows[0], pins)

    def _connect(self):
        try:
            return self._connector(self._database_url)
        except (
            TypedSourceRepositoryConfigurationError,
            TypedSourceRepositoryDependencyError,
            TypedSourceRepositoryReadError,
        ):
            raise
        except Exception as error:
            raise TypedSourceRepositoryReadError(
                "unable to connect using DATABASE_URL"
            ) from error


def _pin_parameters(pins: ReplayPins) -> tuple[str, ...]:
    return (
        pins.trading_day,
        pins.as_of,
        pins.profile,
        pins.market_scope,
        pins.profile_version,
        pins.contract_version,
        pins.input_fingerprint,
        pins.strategy_version,
        pins.pipeline_version,
        pins.as_of,
    )


def typed_source_capture_hash(
    *,
    pins: ReplayPins,
    available_at_utc: str,
    source_versions: Mapping[str, str],
    filings: Sequence[Mapping[str, Any]],
    text_hits: Sequence[Mapping[str, Any]],
    scores: Sequence[Mapping[str, Any]],
) -> str:
    """Authenticate the exact lossless capture payload and every replay pin."""

    material = {
        "available_at_utc": available_at_utc,
        "contract_version": pins.contract_version,
        "filings": list(filings),
        "input_fingerprint": pins.input_fingerprint,
        "market_scope": pins.market_scope,
        "pipeline_version": pins.pipeline_version,
        "profile": pins.profile,
        "profile_version": pins.profile_version,
        "scores": list(scores),
        "source_versions": dict(source_versions),
        "strategy_version": pins.strategy_version,
        "text_hits": list(text_hits),
        "trading_day": pins.trading_day,
        "as_of": pins.as_of,
    }
    return _sha256(material)


def typed_financial_fact_hash(payload: Mapping[str, Any]) -> str:
    """Hash the exact typed financial payload, excluding only its hash field."""

    _require_exact_keys(
        payload,
        _field_names(JpKrFinancialRecord),
        "financial",
    )
    return _sha256({key: payload[key] for key in payload if key != "fact_hash"})


def typed_scan_document_fact_hash(payload: Mapping[str, Any]) -> str:
    """Hash an authorized normalized scan document without its hash field."""

    _require_exact_keys(payload, _field_names(ScanDocument), "scan document")
    return _sha256(
        {key: payload[key] for key in payload if key != "document_fact_hash"}
    )


def typed_text_context_hash(text: str) -> str:
    if not isinstance(text, str) or not text:
        raise ReplaySourceError("text hit context must be non-empty")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _snapshot_from_capture(
    row: Mapping[str, Any], pins: ReplayPins
) -> TypedSourceSnapshot:
    if not isinstance(row, Mapping) or set(row) != set(CAPTURE_COLUMNS):
        raise ReplaySourceError("typed source capture projection is invalid")
    if _date_text(row["trading_day"], "trading_day") != pins.trading_day:
        raise ReplaySourceError("typed source capture trading_day mismatch")
    if _utc_text(row["as_of_utc"], "as_of_utc") != pins.as_of:
        raise ReplaySourceError("typed source capture as_of mismatch")
    for field in (
        "profile",
        "market_scope",
        "profile_version",
        "contract_version",
        "input_fingerprint",
        "strategy_version",
        "pipeline_version",
    ):
        if row[field] != getattr(pins, field):
            raise ReplaySourceError(f"typed source capture {field} mismatch")

    available_at = _utc_text(row["available_at_utc"], "available_at_utc")
    if available_at > pins.as_of:
        raise ReplaySourceError("typed source capture violates replay PIT cutoff")
    source_versions = _json_object(row["source_versions"], "source_versions")
    if set(source_versions) != set(SOURCE_VERSION_KEYS) or any(
        not isinstance(value, str) or not value
        for value in source_versions.values()
    ):
        raise ReplaySourceError("typed source capture versions are invalid")
    filings_json = _json_array(row["filings_json"], "filings_json")
    text_hits_json = _json_array(row["text_hits_json"], "text_hits_json")
    scores_json = _json_array(row["scores_json"], "scores_json")
    expected_capture_hash = typed_source_capture_hash(
        pins=pins,
        available_at_utc=available_at,
        source_versions=source_versions,
        filings=filings_json,
        text_hits=text_hits_json,
        scores=scores_json,
    )
    if row["capture_hash"] != expected_capture_hash:
        raise ReplaySourceError("typed source capture hash is not authentic")

    filings = tuple(filing_envelope_from_json(item) for item in filings_json)
    text_hits = tuple(
        text_hit_envelope_from_json(item) for item in text_hits_json
    )
    scores = tuple(typed_score_record_from_json(item) for item in scores_json)
    return TypedSourceSnapshot(
        filings=filings,
        text_hits=text_hits,
        scores=scores,
        source_versions=dict(source_versions),
    )


def filing_envelope_from_json(value: object) -> JpKrFilingEnvelope:
    """Validate and reconstruct one lossless typed filing envelope."""

    envelope = _json_object(value, "filing")
    _require_exact_keys(envelope, {"disclosure", "financials"}, "filing")
    disclosure_json = _json_object(envelope["disclosure"], "disclosure")
    _require_exact_keys(
        disclosure_json,
        _field_names(JpKrDisclosureRecord),
        "disclosure",
    )
    disclosure = JpKrDisclosureRecord(
        **{
            **disclosure_json,
            "event_time_utc": _parse_utc_json(
                disclosure_json["event_time_utc"], "event_time_utc"
            ),
            "available_at_utc": _parse_utc_json(
                disclosure_json["available_at_utc"], "available_at_utc"
            ),
        }
    )
    if disclosure.fact_hash != canonical_disclosure_fact_hash(disclosure):
        raise ReplaySourceError("disclosure fact_hash is not authentic")

    financials = []
    for raw in _json_array(envelope["financials"], "financials"):
        payload = _json_object(raw, "financial")
        _require_exact_keys(
            payload,
            _field_names(JpKrFinancialRecord),
            "financial",
        )
        if payload["fact_hash"] != typed_financial_fact_hash(payload):
            raise ReplaySourceError("financial fact_hash is not authentic")
        financials.append(
            JpKrFinancialRecord(
                **{
                    **payload,
                    "fiscal_period_start": _parse_date_json(
                        payload["fiscal_period_start"],
                        "fiscal_period_start",
                        optional=True,
                    ),
                    "fiscal_period_end": _parse_date_json(
                        payload["fiscal_period_end"], "fiscal_period_end"
                    ),
                    "revenue": _decimal(payload["revenue"], "revenue"),
                    "eps": _decimal(payload["eps"], "eps"),
                    "net_income": _decimal(
                        payload["net_income"], "net_income"
                    ),
                    "total_assets": _decimal(
                        payload["total_assets"], "total_assets"
                    ),
                    "total_equity": _decimal(
                        payload["total_equity"], "total_equity"
                    ),
                    "total_liabilities": _decimal(
                        payload["total_liabilities"], "total_liabilities"
                    ),
                    "operating_cash_flow": _decimal(
                        payload["operating_cash_flow"],
                        "operating_cash_flow",
                    ),
                    "research_and_development": _decimal(
                        payload["research_and_development"],
                        "research_and_development",
                    ),
                    "segment_facts": tuple(payload["segment_facts"]),
                    "parse_warnings": tuple(payload["parse_warnings"]),
                    "effective_at_utc": _parse_utc_json(
                        payload["effective_at_utc"], "effective_at_utc"
                    ),
                    "available_at_utc": _parse_utc_json(
                        payload["available_at_utc"], "available_at_utc"
                    ),
                }
            )
        )
    return JpKrFilingEnvelope(disclosure, tuple(financials))


def text_hit_envelope_from_json(value: object) -> TextHitEnvelope:
    """Validate document/content hashes and reconstruct one text hit."""

    envelope = _json_object(value, "text hit envelope")
    _require_exact_keys(
        envelope, {"document", "hit"}, "text hit envelope"
    )
    document_json = _json_object(envelope["document"], "scan document")
    hit_json = _json_object(envelope["hit"], "text hit")
    _require_exact_keys(document_json, _field_names(ScanDocument), "scan document")
    _require_exact_keys(hit_json, _field_names(TextHit), "text hit")
    if (
        document_json["document_fact_hash"]
        != typed_scan_document_fact_hash(document_json)
    ):
        raise ReplaySourceError("scan document fact_hash is not authentic")
    document = ScanDocument(
        **{
            **document_json,
            "published_at_utc": _parse_utc_json(
                document_json["published_at_utc"], "published_at_utc"
            ),
            "available_at_utc": _parse_utc_json(
                document_json["available_at_utc"], "available_at_utc"
            ),
        }
    )
    hit = TextHit(**hit_json)
    selected = document.title if hit.field == "TITLE" else document.body
    if hit.context_hash != typed_text_context_hash(
        selected[hit.start_offset : hit.end_offset]
    ):
        raise ReplaySourceError("text hit context_hash is not authentic")
    return TextHitEnvelope(document, hit)


def typed_score_record_from_json(value: object) -> TypedScoreRecord:
    """Validate and reconstruct one authenticated Strategy score record."""

    payload = _json_object(value, "typed score")
    _require_exact_keys(payload, _field_names(TypedScoreRecord), "typed score")
    available_at = _parse_utc_json(
        payload["available_at_utc"], "available_at_utc"
    )
    expected = typed_score_fact_hash(
        ticker=payload["ticker"],
        profile=payload["profile"],
        market_scope=payload["market_scope"],
        as_of=payload["as_of"],
        available_at_utc=available_at,
        source_version=payload["source_version"],
        features=payload["features"],
    )
    if payload["fact_hash"] != expected:
        raise ReplaySourceError("typed score fact_hash is not authentic")
    return TypedScoreRecord(
        **{
            **payload,
            "available_at_utc": available_at,
        }
    )


def _field_names(data_class: type) -> set[str]:
    return {field.name for field in fields(data_class)}


def _require_exact_keys(
    value: Mapping[str, Any], expected: set[str], field: str
) -> None:
    if set(value) != expected:
        raise ReplaySourceError(f"{field} keys are not exact")


def _json_object(value: object, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ReplaySourceError(f"{field} must be a JSON object")
    try:
        jcs_canonicalize(value)
    except (TypeError, ValueError) as error:
        raise ReplaySourceError(f"{field} is not strict JSON") from error
    return value


def _json_array(value: object, field: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(
        not isinstance(item, dict) for item in value
    ):
        raise ReplaySourceError(f"{field} must be an array of JSON objects")
    try:
        jcs_canonicalize(value)
    except (TypeError, ValueError) as error:
        raise ReplaySourceError(f"{field} is not strict JSON") from error
    return value


def _parse_utc_json(value: object, field: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ReplaySourceError(f"{field} must be UTC")
    try:
        parsed = datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise ReplaySourceError(f"{field} must be UTC") from error
    if parsed.tzinfo != timezone.utc:
        raise ReplaySourceError(f"{field} must be UTC")
    return parsed


def _parse_date_json(
    value: object, field: str, *, optional: bool = False
) -> date | None:
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise ReplaySourceError(f"{field} must be an ISO date")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise ReplaySourceError(f"{field} must be an ISO date") from error


def _decimal(value: object, field: str) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise ReplaySourceError(f"{field} must be an exact decimal string")
    try:
        parsed = Decimal(value)
    except (InvalidOperation, ValueError) as error:
        raise ReplaySourceError(f"{field} must be an exact decimal") from error
    if not parsed.is_finite():
        raise ReplaySourceError(f"{field} must be finite")
    return parsed


def _utc_text(value: object, field: str) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ReplaySourceError(f"database returned invalid {field}")
    normalized = value.astimezone(timezone.utc)
    if normalized.microsecond != 0:
        raise ReplaySourceError(f"database returned sub-second {field}")
    return normalized.strftime("%Y-%m-%dT%H:%M:%SZ")


def _date_text(value: object, field: str) -> str:
    if not isinstance(value, date) or isinstance(value, datetime):
        raise ReplaySourceError(f"database returned invalid {field}")
    return value.isoformat()


def _sha256(value: object) -> str:
    try:
        canonical = jcs_canonicalize(value)
    except (TypeError, ValueError) as error:
        raise ReplaySourceError("typed source payload is not strict JSON") from error
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
