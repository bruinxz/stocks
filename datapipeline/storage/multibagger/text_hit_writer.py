"""Canonical append-only writer for ``multibagger_text_hit`` facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import hashlib
from typing import Iterable, Mapping, Sequence, Tuple

from datapipeline.contracts.source_envelopes import TextHitEnvelope

from .canonical_json import canonicalize_json


INSERT_SQL = """
INSERT INTO multibagger_text_hit (
  market_scope, ticker, source_kind, source_document_id, source_version,
  document_fact_hash, taxonomy_version, term_id, hit_kind, language,
  field, start_offset, end_offset, context_hash, hit_fact_hash,
  effective_at_utc, available_at_utc
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
  $11, $12, $13, $14, $15, $16, $17
)
ON CONFLICT (
  document_fact_hash, taxonomy_version, term_id,
  field, start_offset, end_offset
) DO NOTHING
RETURNING multibagger_text_hit_id
"""

SELECT_SQL = """
SELECT hit_fact_hash
FROM multibagger_text_hit
WHERE document_fact_hash = $1
  AND taxonomy_version = $2
  AND term_id = $3
  AND field = $4
  AND start_offset = $5
  AND end_offset = $6
"""

LOCK_SQL = "SELECT pg_advisory_xact_lock($1)"


class TextHitIdempotencyConflict(RuntimeError):
    """One logical text-hit identity has conflicting authenticated content."""


@dataclass(frozen=True)
class TextHitWriteResult:
    attempted: int
    inserted: int
    deduplicated: int


@dataclass(frozen=True)
class TextHitStorageRow:
    market_scope: str
    ticker: str
    source_kind: str
    source_document_id: str
    source_version: str
    document_fact_hash: str
    taxonomy_version: str
    term_id: str
    hit_kind: str
    language: str
    field: str
    start_offset: int
    end_offset: int
    context_hash: str
    hit_fact_hash: str
    effective_at_utc: datetime
    available_at_utc: datetime

    @property
    def identity(self) -> Tuple[object, ...]:
        return (
            self.document_fact_hash,
            self.taxonomy_version,
            self.term_id,
            self.field,
            self.start_offset,
            self.end_offset,
        )

    @property
    def insert_params(self) -> Tuple[object, ...]:
        return (
            self.market_scope,
            self.ticker,
            self.source_kind,
            self.source_document_id,
            self.source_version,
            self.document_fact_hash,
            self.taxonomy_version,
            self.term_id,
            self.hit_kind,
            self.language,
            self.field,
            self.start_offset,
            self.end_offset,
            self.context_hash,
            self.hit_fact_hash,
            self.effective_at_utc,
            self.available_at_utc,
        )


def _utc_text(value: datetime, field: str) -> str:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be timezone-aware UTC")
    if value.microsecond:
        raise ValueError(f"{field} must use whole UTC seconds")
    return value.isoformat().replace("+00:00", "Z")


def text_hit_fact_body(
    *,
    market_scope: str,
    ticker: str,
    source_kind: str,
    source_document_id: str,
    source_version: str,
    document_fact_hash: str,
    taxonomy_version: str,
    term_id: str,
    hit_kind: str,
    language: str,
    field: str,
    start_offset: int,
    end_offset: int,
    context_hash: str,
    effective_at_utc: datetime,
    available_at_utc: datetime,
) -> Mapping[str, object]:
    """Return the DataPipeline-owned physical TextHit hash preimage."""

    return {
        "available_at_utc": _utc_text(available_at_utc, "available_at_utc"),
        "context_hash": context_hash,
        "document_fact_hash": document_fact_hash,
        "effective_at_utc": _utc_text(effective_at_utc, "effective_at_utc"),
        "end_offset": end_offset,
        "field": field,
        "hit_kind": hit_kind,
        "language": language,
        "market_scope": market_scope,
        "source_document_id": source_document_id,
        "source_kind": source_kind,
        "source_version": source_version,
        "start_offset": start_offset,
        "taxonomy_version": taxonomy_version,
        "term_id": term_id,
        "ticker": ticker,
    }


def canonical_text_hit_fact_hash(**values: object) -> str:
    body = text_hit_fact_body(**values)  # type: ignore[arg-type]
    return hashlib.sha256(canonicalize_json(body).encode("utf-8")).hexdigest()


def build_text_hit_storage_row(envelope: TextHitEnvelope) -> TextHitStorageRow:
    if not isinstance(envelope, TextHitEnvelope):
        raise TypeError("writer accepts TextHitEnvelope only")
    document = envelope.document
    hit = envelope.hit
    values = {
        "market_scope": document.market_scope,
        "ticker": document.ticker,
        "source_kind": document.source_kind,
        "source_document_id": document.document_id,
        "source_version": document.source_version,
        "document_fact_hash": document.document_fact_hash,
        "taxonomy_version": hit.taxonomy_version,
        "term_id": hit.term_id,
        "hit_kind": hit.hit_kind,
        "language": hit.language,
        "field": hit.field,
        "start_offset": hit.start_offset,
        "end_offset": hit.end_offset,
        "context_hash": hit.context_hash,
        "effective_at_utc": document.published_at_utc,
        "available_at_utc": document.available_at_utc,
    }
    return TextHitStorageRow(
        **values,
        hit_fact_hash=canonical_text_hit_fact_hash(**values),
    )


def _advisory_key(identity: Sequence[object]) -> int:
    digest = hashlib.sha256(
        "\0".join(str(value) for value in identity).encode("utf-8")
    ).digest()[:8]
    unsigned = int.from_bytes(digest, byteorder="big", signed=False)
    return unsigned if unsigned < 2**63 else unsigned - 2**64


class TextHitWriter:
    def __init__(self, db_pool) -> None:
        self._db_pool = db_pool

    async def write_batch(
        self,
        envelopes: Iterable[TextHitEnvelope],
        *,
        as_of_utc: datetime,
    ) -> TextHitWriteResult:
        rows_by_identity: dict[Tuple[object, ...], TextHitStorageRow] = {}
        attempted = 0
        for envelope in envelopes:
            attempted += 1
            envelope.require_available_by(as_of_utc)
            row = build_text_hit_storage_row(envelope)
            existing = rows_by_identity.get(row.identity)
            if existing is not None and existing.hit_fact_hash != row.hit_fact_hash:
                raise TextHitIdempotencyConflict(
                    "batch has conflicting text-hit facts"
                )
            rows_by_identity[row.identity] = row

        # Acquire transaction-scoped advisory locks in one deterministic order.
        # Otherwise two callers submitting the same identities in reverse batch
        # order can each hold one lock while waiting forever for the other.
        rows = tuple(
            sorted(rows_by_identity.values(), key=lambda candidate: candidate.identity)
        )

        inserted = 0
        async with self._db_pool.acquire() as connection:
            async with connection.transaction():
                for row in rows:
                    await connection.fetchval(LOCK_SQL, _advisory_key(row.identity))
                    existing = await connection.fetchrow(SELECT_SQL, *row.identity)
                    if existing is not None:
                        if existing["hit_fact_hash"] != row.hit_fact_hash:
                            raise TextHitIdempotencyConflict(
                                "stored text-hit identity has conflicting content"
                            )
                        continue
                    returned = await connection.fetchrow(INSERT_SQL, *row.insert_params)
                    if returned is None:
                        raced = await connection.fetchrow(SELECT_SQL, *row.identity)
                        if raced is None or raced["hit_fact_hash"] != row.hit_fact_hash:
                            raise TextHitIdempotencyConflict(
                                "raced text-hit identity has conflicting content"
                            )
                    else:
                        inserted += 1

        return TextHitWriteResult(
            attempted=attempted,
            inserted=inserted,
            deduplicated=attempted - inserted,
        )
