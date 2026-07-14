"""Canonical typed replay-capture construction and authentication.

This module is the single source of truth for the immutable JSON payload
stored in ``ai_replay_typed_source_capture``.  It has no database dependency:
callers provide typed source envelopes, while all derived pins and hashes are
computed here after lossless serialize/hydrate validation.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, fields, replace
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
from typing import Any
from uuid import UUID

from ai.replay.runtime import (
    SOURCE_VERSION_KEYS,
    TypedReplaySources,
    TypedScoreRecord,
    TypedSourceSnapshot,
    typed_score_fact_hash,
)
from ai.replay.service import ReplayService, ReplaySourceError
from ai.replay.types import ReplayPins
from ai.snapshot.fingerprint import jcs_canonicalize
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


@dataclass(frozen=True)
class TypedCaptureRequest:
    """Non-derived source material for one immutable typed capture."""

    trading_day: str
    as_of: str
    profile: str
    market_scope: str
    profile_version: str
    contract_version: str
    strategy_version: str
    pipeline_version: str
    source_versions: Mapping[str, str]
    filings: tuple[JpKrFilingEnvelope, ...]
    text_hits: tuple[TextHitEnvelope, ...]
    scores: tuple[TypedScoreRecord, ...]


@dataclass(frozen=True)
class TypedCaptureReceipt:
    capture_id: str
    pins: ReplayPins
    available_at_utc: str
    capture_hash: str
    created: bool


@dataclass(frozen=True)
class PreparedTypedCapture:
    """Fully authenticated, canonical capture ready for persistence."""

    pins: ReplayPins
    available_at_utc: str
    source_versions: Mapping[str, str]
    filings_json: tuple[Mapping[str, Any], ...]
    text_hits_json: tuple[Mapping[str, Any], ...]
    scores_json: tuple[Mapping[str, Any], ...]
    capture_hash: str
    snapshot: TypedSourceSnapshot

    def row(self, capture_id: str) -> dict[str, Any]:
        _require_uuid4(capture_id, "capture_id")
        return {
            "capture_id": capture_id,
            "trading_day": self.pins.trading_day,
            "as_of_utc": self.pins.as_of,
            "profile": self.pins.profile,
            "market_scope": self.pins.market_scope,
            "profile_version": self.pins.profile_version,
            "contract_version": self.pins.contract_version,
            "input_fingerprint": self.pins.input_fingerprint,
            "strategy_version": self.pins.strategy_version,
            "pipeline_version": self.pins.pipeline_version,
            "available_at_utc": self.available_at_utc,
            "source_versions": dict(self.source_versions),
            "filings_json": _json_value(self.filings_json),
            "text_hits_json": _json_value(self.text_hits_json),
            "scores_json": _json_value(self.scores_json),
            "capture_hash": self.capture_hash,
        }


@dataclass(frozen=True)
class HydratedTypedCapture:
    capture_id: str
    prepared: PreparedTypedCapture


class _SnapshotRepository:
    def __init__(self, snapshot: TypedSourceSnapshot) -> None:
        self._snapshot = snapshot

    def load(self, _pins: ReplayPins) -> TypedSourceSnapshot:
        return self._snapshot


def prepare_typed_capture(request: TypedCaptureRequest) -> PreparedTypedCapture:
    """Authenticate and canonicalize a request without performing I/O."""

    if type(request) is not TypedCaptureRequest:
        raise ReplaySourceError("typed capture request has invalid schema")
    if (
        type(request.filings) is not tuple
        or type(request.text_hits) is not tuple
        or type(request.scores) is not tuple
        or not isinstance(request.source_versions, Mapping)
    ):
        raise ReplaySourceError("typed capture collections have invalid schema")
    source_versions = _canonical_source_versions(request.source_versions)

    filings_json = tuple(
        sorted(
            (filing_envelope_to_json(item) for item in request.filings),
            key=_filing_sort_key,
        )
    )
    text_hits_json = tuple(
        sorted(
            (text_hit_envelope_to_json(item) for item in request.text_hits),
            key=_text_hit_sort_key,
        )
    )
    scores_json = tuple(
        sorted(
            (typed_score_record_to_json(item) for item in request.scores),
            key=_score_sort_key,
        )
    )

    # Hydration is intentional: it authenticates exact field sets, every fact
    # hash, strict JSON values, and immutable typed-contract relations.
    snapshot = TypedSourceSnapshot(
        filings=tuple(filing_envelope_from_json(item) for item in filings_json),
        text_hits=tuple(text_hit_envelope_from_json(item) for item in text_hits_json),
        scores=tuple(typed_score_record_from_json(item) for item in scores_json),
        source_versions=source_versions,
    )
    _validate_duplicate_facts(snapshot)
    provisional = ReplayPins(
        trading_day=request.trading_day,
        as_of=request.as_of,
        profile=request.profile,
        market_scope=request.market_scope,
        profile_version=request.profile_version,
        contract_version=request.contract_version,
        input_fingerprint="0" * 64,
        strategy_version=request.strategy_version,
        pipeline_version=request.pipeline_version,
    )
    ReplayService._validate_pins(provisional)
    sources = TypedReplaySources(_SnapshotRepository(snapshot))
    input_fingerprint = sources.input_fingerprint(provisional)
    pins = replace(provisional, input_fingerprint=input_fingerprint)
    ReplayService._validate_pins(pins)
    available_at_utc = _capture_available_at(snapshot, pins.as_of)
    capture_hash = typed_source_capture_hash(
        pins=pins,
        available_at_utc=available_at_utc,
        source_versions=source_versions,
        filings=filings_json,
        text_hits=text_hits_json,
        scores=scores_json,
    )
    return PreparedTypedCapture(
        pins=pins,
        available_at_utc=available_at_utc,
        source_versions=source_versions,
        filings_json=filings_json,
        text_hits_json=text_hits_json,
        scores_json=scores_json,
        capture_hash=capture_hash,
        snapshot=snapshot,
    )


def hydrate_typed_capture(
    row: Mapping[str, Any], pins: ReplayPins
) -> HydratedTypedCapture:
    """Authenticate an exact PostgreSQL capture projection."""

    ReplayService._validate_pins(pins)
    if not isinstance(row, Mapping) or set(row) != set(CAPTURE_COLUMNS):
        raise ReplaySourceError("typed source capture projection is invalid")
    capture_id = str(row["capture_id"])
    _require_uuid4(capture_id, "capture_id")
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
    source_versions = _canonical_source_versions(
        _json_object(row["source_versions"], "source_versions")
    )
    filings_json = tuple(_json_array(row["filings_json"], "filings_json"))
    text_hits_json = tuple(_json_array(row["text_hits_json"], "text_hits_json"))
    scores_json = tuple(_json_array(row["scores_json"], "scores_json"))
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

    snapshot = TypedSourceSnapshot(
        filings=tuple(filing_envelope_from_json(item) for item in filings_json),
        text_hits=tuple(text_hit_envelope_from_json(item) for item in text_hits_json),
        scores=tuple(typed_score_record_from_json(item) for item in scores_json),
        source_versions=source_versions,
    )
    _validate_duplicate_facts(snapshot)
    sources = TypedReplaySources(_SnapshotRepository(snapshot))
    if sources.input_fingerprint(pins) != pins.input_fingerprint:
        raise ReplaySourceError("typed source capture fingerprint is not authentic")
    if _capture_available_at(snapshot, pins.as_of) != available_at:
        raise ReplaySourceError("typed source capture availability is not canonical")

    canonical_filings = tuple(
        sorted(
            (filing_envelope_to_json(item) for item in snapshot.filings),
            key=_filing_sort_key,
        )
    )
    canonical_text_hits = tuple(
        sorted(
            (text_hit_envelope_to_json(item) for item in snapshot.text_hits),
            key=_text_hit_sort_key,
        )
    )
    canonical_scores = tuple(
        sorted(
            (typed_score_record_to_json(item) for item in snapshot.scores),
            key=_score_sort_key,
        )
    )
    if (
        filings_json != canonical_filings
        or text_hits_json != canonical_text_hits
        or scores_json != canonical_scores
    ):
        raise ReplaySourceError("typed source capture ordering is not canonical")
    prepared = PreparedTypedCapture(
        pins=pins,
        available_at_utc=available_at,
        source_versions=source_versions,
        filings_json=canonical_filings,
        text_hits_json=canonical_text_hits,
        scores_json=canonical_scores,
        capture_hash=expected_capture_hash,
        snapshot=snapshot,
    )
    return HydratedTypedCapture(capture_id=capture_id, prepared=prepared)


def typed_source_capture_hash(
    *,
    pins: ReplayPins,
    available_at_utc: str,
    source_versions: Mapping[str, str],
    filings: Sequence[Mapping[str, Any]],
    text_hits: Sequence[Mapping[str, Any]],
    scores: Sequence[Mapping[str, Any]],
) -> str:
    """Authenticate the exact canonical payload and every replay pin."""

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


def filing_envelope_to_json(envelope: JpKrFilingEnvelope) -> dict[str, Any]:
    if not isinstance(envelope, JpKrFilingEnvelope):
        raise ReplaySourceError("filing envelope has invalid type")
    payload = _json_value(asdict(envelope))
    assert isinstance(payload, dict)
    financials = payload["financials"]
    assert isinstance(financials, list)
    payload["financials"] = sorted(financials, key=_canonical_sort_key)
    # Re-hydration below is the hash/schema authority.
    filing_envelope_from_json(payload)
    return payload


def text_hit_envelope_to_json(envelope: TextHitEnvelope) -> dict[str, Any]:
    if not isinstance(envelope, TextHitEnvelope):
        raise ReplaySourceError("text hit envelope has invalid type")
    payload = _json_value(asdict(envelope))
    assert isinstance(payload, dict)
    text_hit_envelope_from_json(payload)
    return payload


def typed_score_record_to_json(score: TypedScoreRecord) -> dict[str, Any]:
    if not isinstance(score, TypedScoreRecord):
        raise ReplaySourceError("typed score has invalid type")
    payload = _json_value(asdict(score))
    assert isinstance(payload, dict)
    typed_score_record_from_json(payload)
    return payload


def typed_financial_fact_hash(payload: Mapping[str, Any]) -> str:
    """Hash the exact financial payload, excluding only its hash field."""

    _require_exact_keys(payload, _field_names(JpKrFinancialRecord), "financial")
    return _sha256({key: payload[key] for key in payload if key != "fact_hash"})


def typed_scan_document_fact_hash(payload: Mapping[str, Any]) -> str:
    """Hash an authorized scan document without its hash field."""

    _require_exact_keys(payload, _field_names(ScanDocument), "scan document")
    return _sha256(
        {key: payload[key] for key in payload if key != "document_fact_hash"}
    )


def typed_text_context_hash(text: str) -> str:
    if not isinstance(text, str) or not text:
        raise ReplaySourceError("text hit context must be non-empty")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def filing_envelope_from_json(value: object) -> JpKrFilingEnvelope:
    """Validate and reconstruct one lossless typed filing envelope."""

    envelope = _json_object(value, "filing")
    _require_exact_keys(envelope, {"disclosure", "financials"}, "filing")
    disclosure_json = _json_object(envelope["disclosure"], "disclosure")
    _require_exact_keys(
        disclosure_json, _field_names(JpKrDisclosureRecord), "disclosure"
    )
    try:
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
    except (TypeError, ValueError) as error:
        raise ReplaySourceError("disclosure contract is invalid") from error
    if disclosure.fact_hash != canonical_disclosure_fact_hash(disclosure):
        raise ReplaySourceError("disclosure fact_hash is not authentic")

    financials = []
    for raw in _json_array(envelope["financials"], "financials"):
        payload = _json_object(raw, "financial")
        _require_exact_keys(payload, _field_names(JpKrFinancialRecord), "financial")
        if payload["fact_hash"] != typed_financial_fact_hash(payload):
            raise ReplaySourceError("financial fact_hash is not authentic")
        try:
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
                        "net_income": _decimal(payload["net_income"], "net_income"),
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
        except (TypeError, ValueError) as error:
            raise ReplaySourceError("financial contract is invalid") from error
    try:
        return JpKrFilingEnvelope(disclosure, tuple(financials))
    except ValueError as error:
        raise ReplaySourceError("filing envelope contract is invalid") from error


def text_hit_envelope_from_json(value: object) -> TextHitEnvelope:
    """Validate document/context hashes and reconstruct one text hit."""

    envelope = _json_object(value, "text hit envelope")
    _require_exact_keys(envelope, {"document", "hit"}, "text hit envelope")
    document_json = _json_object(envelope["document"], "scan document")
    hit_json = _json_object(envelope["hit"], "text hit")
    _require_exact_keys(document_json, _field_names(ScanDocument), "scan document")
    _require_exact_keys(hit_json, _field_names(TextHit), "text hit")
    if document_json["document_fact_hash"] != typed_scan_document_fact_hash(
        document_json
    ):
        raise ReplaySourceError("scan document fact_hash is not authentic")
    try:
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
        result = TextHitEnvelope(document, hit)
    except (TypeError, ValueError) as error:
        raise ReplaySourceError("text hit envelope contract is invalid") from error
    selected = document.title if hit.field == "TITLE" else document.body
    if hit.context_hash != typed_text_context_hash(
        selected[hit.start_offset : hit.end_offset]
    ):
        raise ReplaySourceError("text hit context_hash is not authentic")
    return result


def typed_score_record_from_json(value: object) -> TypedScoreRecord:
    """Validate and reconstruct one authenticated Strategy score record."""

    payload = _json_object(value, "typed score")
    _require_exact_keys(payload, _field_names(TypedScoreRecord), "typed score")
    available_at = _parse_utc_json(payload["available_at_utc"], "available_at_utc")
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
    try:
        return TypedScoreRecord(**{**payload, "available_at_utc": available_at})
    except TypeError as error:
        raise ReplaySourceError("typed score contract is invalid") from error


def _canonical_source_versions(value: Mapping[str, Any]) -> dict[str, str]:
    if set(value) != set(SOURCE_VERSION_KEYS) or any(
        not isinstance(item, str) or not item or item.isspace()
        for item in value.values()
    ):
        raise ReplaySourceError("typed source capture versions are invalid")
    return {key: value[key] for key in SOURCE_VERSION_KEYS}


def _capture_available_at(snapshot: TypedSourceSnapshot, as_of: str) -> str:
    cutoff = _parse_utc_json(as_of, "as_of")
    values = [
        *(item.disclosure.available_at_utc for item in snapshot.filings),
        *(
            financial.available_at_utc
            for item in snapshot.filings
            for financial in item.financials
        ),
        *(item.document.available_at_utc for item in snapshot.text_hits),
        *(item.available_at_utc for item in snapshot.scores),
    ]
    available = max(values, default=cutoff)
    if available > cutoff:
        raise ReplaySourceError("typed source capture violates replay PIT cutoff")
    return _utc_datetime_text(available, "available_at_utc")


def _validate_duplicate_facts(snapshot: TypedSourceSnapshot) -> None:
    financial_hashes = [
        financial.fact_hash
        for filing in snapshot.filings
        for financial in filing.financials
    ]
    if len(financial_hashes) != len(set(financial_hashes)):
        raise ReplaySourceError("financial fact identity is duplicated")


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
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
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
    if parsed.tzinfo != timezone.utc or value != _utc_datetime_text(parsed, field):
        raise ReplaySourceError(f"{field} must be canonical UTC")
    return parsed


def _parse_date_json(
    value: object, field: str, *, optional: bool = False
) -> date | None:
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise ReplaySourceError(f"{field} must be an ISO date")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise ReplaySourceError(f"{field} must be an ISO date") from error
    if value != parsed.isoformat():
        raise ReplaySourceError(f"{field} must be a canonical ISO date")
    return parsed


def _decimal(value: object, field: str) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, str):
        raise ReplaySourceError(f"{field} must be an exact decimal string")
    try:
        parsed = Decimal(value)
    except (InvalidOperation, ValueError) as error:
        raise ReplaySourceError(f"{field} must be an exact decimal") from error
    if not parsed.is_finite() or format(parsed, "f") != value:
        raise ReplaySourceError(f"{field} must be a canonical finite decimal")
    return parsed


def _utc_text(value: object, field: str) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ReplaySourceError(f"database returned invalid {field}")
    normalized = value.astimezone(timezone.utc)
    return _utc_datetime_text(normalized, field)


def _utc_datetime_text(value: datetime, field: str) -> str:
    if value.tzinfo is None or value.utcoffset() != timezone.utc.utcoffset(value):
        raise ReplaySourceError(f"{field} must be UTC")
    return value.isoformat().replace("+00:00", "Z")


def _date_text(value: object, field: str) -> str:
    if not isinstance(value, date) or isinstance(value, datetime):
        raise ReplaySourceError(f"database returned invalid {field}")
    return value.isoformat()


def _json_value(value: object) -> Any:
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, float):
        try:
            jcs_canonicalize(value)
        except (TypeError, ValueError) as error:
            raise ReplaySourceError("typed source contains invalid number") from error
        return value
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ReplaySourceError("typed source contains non-finite Decimal")
        return format(value, "f")
    if isinstance(value, datetime):
        return _utc_datetime_text(value, "typed source datetime")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ReplaySourceError("typed source JSON object keys must be strings")
        return {key: _json_value(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_json_value(item) for item in value]
    raise ReplaySourceError(f"typed source contains unsupported {type(value).__name__}")


def _canonical_sort_key(value: object) -> str:
    try:
        return jcs_canonicalize(value)
    except (TypeError, ValueError) as error:
        raise ReplaySourceError("typed source payload is not strict JSON") from error


def _filing_sort_key(value: Mapping[str, Any]) -> tuple[str, ...]:
    disclosure = value["disclosure"]
    return (
        disclosure["source_kind"],
        disclosure["source_document_id"],
        disclosure["source_version"],
        _canonical_sort_key(value),
    )


def _text_hit_sort_key(value: Mapping[str, Any]) -> tuple[object, ...]:
    document = value["document"]
    hit = value["hit"]
    return (
        document["document_fact_hash"],
        hit["taxonomy_version"],
        hit["term_id"],
        hit["field"],
        hit["start_offset"],
        hit["end_offset"],
        _canonical_sort_key(value),
    )


def _score_sort_key(value: Mapping[str, Any]) -> tuple[str, str]:
    return (value["ticker"], _canonical_sort_key(value))


def _sha256(value: object) -> str:
    return hashlib.sha256(_canonical_sort_key(value).encode("utf-8")).hexdigest()


def _require_uuid4(value: object, field: str) -> str:
    try:
        parsed = UUID(value)  # type: ignore[arg-type]
    except (AttributeError, TypeError, ValueError) as error:
        raise ReplaySourceError(f"{field} must be UUIDv4") from error
    if not isinstance(value, str) or parsed.version != 4 or str(parsed) != value:
        raise ReplaySourceError(f"{field} must be canonical UUIDv4")
    return value
