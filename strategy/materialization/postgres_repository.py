"""Point-in-time PostgreSQL reader for multibagger materialization inputs."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional, Tuple

from ai.snapshot.postgres_store import (
    SnapshotStoreConnectionError,
    SnapshotStoreDependencyError,
    validate_database_url,
)
from strategy.materialization.multibagger_candidate import TextHitFact, UniverseFact


TRANSACTION_SQL = "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"

UNIVERSE_SQL = """
SELECT
  market_scope, provider_market_label, exchange, ticker, record_kind,
  universe_source_kind, source_document_id, source_version,
  effective_at_utc, available_at_utc, as_of_utc,
  features, evidence_refs, text_hit_kinds, fundamental_snapshot,
  filter_pass_bitmap, market_cap_cny_100m, fact_hash
FROM multibagger_universe
WHERE market_scope = %s
  AND exchange = %s
  AND ticker = %s
  AND effective_at_utc <= %s::timestamptz
  AND available_at_utc <= %s::timestamptz
  AND as_of_utc <= %s::timestamptz
ORDER BY
  available_at_utc ASC,
  universe_source_kind ASC,
  source_document_id ASC,
  source_version ASC,
  fact_hash ASC
"""

TEXT_HIT_SQL = """
SELECT
  market_scope, ticker, source_kind, source_document_id, source_version,
  document_fact_hash, taxonomy_version, term_id, hit_kind,
  language, field, start_offset, end_offset, context_hash, hit_fact_hash,
  effective_at_utc, available_at_utc
FROM multibagger_text_hit
WHERE market_scope = %s
  AND ticker = %s
  AND effective_at_utc <= %s::timestamptz
  AND available_at_utc <= %s::timestamptz
ORDER BY
  available_at_utc ASC,
  source_kind ASC,
  source_document_id ASC,
  taxonomy_version ASC,
  term_id ASC,
  field ASC,
  start_offset ASC
"""

class MaterializationSourceError(RuntimeError):
    """Stored source facts are missing, ambiguous, or lossy."""


def _default_connector(database_url: str):
    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        raise SnapshotStoreDependencyError("psycopg3 is required") from error
    try:
        return psycopg.connect(
            database_url,
            row_factory=dict_row,
            connect_timeout=5,
            application_name="stocks-multibagger-materializer",
            passfile="",
        )
    except Exception as error:
        raise SnapshotStoreConnectionError(
            "unable to connect using DATABASE_URL"
        ) from error


def _utc(value: object, field: str) -> datetime:
    if not isinstance(value, datetime):
        raise MaterializationSourceError(f"{field} is not a PostgreSQL timestamp")
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    normalized = value.astimezone(timezone.utc)
    if normalized.microsecond:
        raise MaterializationSourceError(f"{field} must use whole UTC seconds")
    return normalized


def _mapping(value: object, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise MaterializationSourceError(f"{field} must be a JSON object")
    return dict(value)


def _string_tuple(value: object, field: str) -> Tuple[str, ...]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item for item in value
    ):
        raise MaterializationSourceError(f"{field} must be a string array")
    return tuple(value)


class PostgresMaterializationRepository:
    """Load one ticker's immutable source facts at an explicit PIT cutoff."""

    def __init__(
        self,
        database_url: str,
        *,
        connector: Optional[Callable[[str], Any]] = None,
    ) -> None:
        self._database_url = validate_database_url(database_url)
        self._connector = connector or _default_connector

    def load(
        self,
        *,
        market_scope: str,
        exchange: str,
        ticker: str,
        as_of_utc: datetime,
    ) -> tuple[tuple[UniverseFact, ...], tuple[TextHitFact, ...]]:
        cutoff = _utc(as_of_utc, "as_of_utc")
        connection = self._connector(self._database_url)
        try:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute(TRANSACTION_SQL)
                    cursor.execute(
                        UNIVERSE_SQL,
                        (
                            market_scope,
                            exchange,
                            ticker,
                            cutoff,
                            cutoff,
                            cutoff,
                        ),
                    )
                    universe_rows = cursor.fetchall()
                    cursor.execute(
                        TEXT_HIT_SQL,
                        (market_scope, ticker, cutoff, cutoff),
                    )
                    text_rows = cursor.fetchall()
                    universes = tuple(
                        self._universe(row) for row in universe_rows
                    )
                    hits = tuple(
                        self._text_hit(row) for row in text_rows
                    )
        except MaterializationSourceError:
            raise
        except Exception as error:
            raise SnapshotStoreConnectionError(
                "unable to read materialization sources"
            ) from error
        finally:
            connection.close()
        if not universes:
            raise MaterializationSourceError("no PIT-visible universe source facts")
        return universes, hits

    @staticmethod
    def _universe(row: Mapping[str, Any]) -> UniverseFact:
        market_cap = row["market_cap_cny_100m"]
        if isinstance(market_cap, Decimal):
            market_cap = format(market_cap, "f")
        elif market_cap is not None:
            market_cap = str(market_cap)
        return UniverseFact(
            market_scope=row["market_scope"],
            provider_market_label=row["provider_market_label"],
            exchange=row["exchange"],
            ticker=row["ticker"],
            record_kind=row["record_kind"],
            universe_source_kind=row["universe_source_kind"],
            source_document_id=row["source_document_id"],
            source_version=row["source_version"],
            effective_at_utc=_utc(row["effective_at_utc"], "effective_at_utc"),
            available_at_utc=_utc(row["available_at_utc"], "available_at_utc"),
            as_of_utc=_utc(row["as_of_utc"], "source as_of_utc"),
            features=_mapping(row["features"], "features"),
            evidence_refs=_string_tuple(row["evidence_refs"], "evidence_refs"),
            text_hit_kinds=_string_tuple(row["text_hit_kinds"], "text_hit_kinds"),
            fundamental_snapshot=_mapping(
                row["fundamental_snapshot"], "fundamental_snapshot"
            ),
            filter_pass_bitmap=row["filter_pass_bitmap"],
            market_cap_cny_100m=market_cap,
            fact_hash=row["fact_hash"],
        )

    @staticmethod
    def _text_hit(row: Mapping[str, Any]) -> TextHitFact:
        return TextHitFact(
            market_scope=row["market_scope"],
            ticker=row["ticker"],
            source_kind=row["source_kind"],
            source_document_id=row["source_document_id"],
            source_version=row["source_version"],
            document_fact_hash=row["document_fact_hash"],
            taxonomy_version=row["taxonomy_version"],
            term_id=row["term_id"],
            hit_kind=row["hit_kind"],
            language=row["language"],
            field=row["field"],
            start_offset=row["start_offset"],
            end_offset=row["end_offset"],
            context_hash=row["context_hash"],
            hit_fact_hash=row["hit_fact_hash"],
            effective_at_utc=_utc(
                row["effective_at_utc"], "text hit effective_at_utc"
            ),
            available_at_utc=_utc(
                row["available_at_utc"], "text hit available_at_utc"
            ),
        )
