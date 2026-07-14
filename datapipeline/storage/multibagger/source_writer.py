"""Transactional writer for immutable ``multibagger_universe`` source facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
from typing import Iterable, Mapping, Optional, Sequence, Tuple

from datapipeline.contracts import MultibaggerSourceRecord

from .canonical_json import canonicalize_json

_MARKET_EXCHANGES = {
    "cn_a": frozenset(("sh", "sz", "bj")),
    "us": frozenset(("nyse", "nasdaq")),
    "jp": frozenset(("tse", "ose")),
    "kr": frozenset(("krx", "kosdaq")),
}
_MARKET_SCOPE = {"CN": "cn_a", "US": "us", "JP": "jp", "KR": "kr"}
_RECORD_KINDS = frozenset(
    ("NEW_LISTING", "LIFECYCLE", "DAILY", "FRENCH_AGGREGATE", "TEXT_HIT")
)
_FORBIDDEN_DERIVED_KEYS = frozenset(
    (
        "score",
        "rating",
        "rating_band",
        "conviction",
        "risk_gate",
        "entry_plan",
        "stage",
        "conclusion",
    )
)

INSERT_SQL = """
INSERT INTO multibagger_universe (
    market_scope, provider_market_label, exchange, ticker, record_kind,
    universe_source_kind, source_document_id, source_version,
    effective_at_utc, available_at_utc, as_of_utc,
    features, evidence_refs, text_hit_kinds, fundamental_snapshot,
    filter_pass_bitmap, market_cap_cny_100m, fact_hash
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
    $16, $17, $18
)
ON CONFLICT (
    universe_source_kind, record_kind, ticker,
    source_document_id, source_version, fact_hash
) DO NOTHING
RETURNING multibagger_universe_id
"""

SELECT_HASHES_SQL = """
SELECT fact_hash
FROM multibagger_universe
WHERE universe_source_kind = $1
  AND record_kind = $2
  AND ticker = $3
  AND source_document_id = $4
  AND source_version = $5
"""

LOCK_SQL = "SELECT pg_advisory_xact_lock($1)"


class MultibaggerIdempotencyConflict(RuntimeError):
    """One logical source identity has more than one immutable fact hash."""


@dataclass(frozen=True)
class MultibaggerWriteResult:
    attempted: int
    inserted: int
    deduplicated: int


@dataclass(frozen=True)
class _StorageRow:
    record: MultibaggerSourceRecord
    provider_market_label: str
    features_json: str
    evidence_refs_json: str
    text_hit_kinds_json: str
    fundamental_snapshot_json: str
    filter_pass_bitmap: int
    market_cap_cny_100m: Optional[str]
    canonical_body: Mapping[str, object]


def _require_utc(value: datetime, field: str) -> None:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be timezone-aware UTC")


def _require_non_empty(value: str, field: str) -> None:
    if not value or value.isspace():
        raise ValueError(f"{field} is required")


def _require_sha256(value: str, field: str) -> None:
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError(f"{field} must be lowercase SHA-256 hex")


def _datetime_text(value: datetime, field: str) -> str:
    _require_utc(value, field)
    return value.isoformat().replace("+00:00", "Z")


def _walk_forbidden(value: object, path: str = "features") -> None:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{path} contains a non-string JSON key")
            if key in _FORBIDDEN_DERIVED_KEYS:
                raise ValueError(f"{path} contains forbidden derived key {key}")
            _walk_forbidden(nested, f"{path}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            _walk_forbidden(nested, f"{path}[{index}]")


def _numeric_18_4(value: object) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValueError("market_cap_cny_100m cannot be boolean")
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError("market_cap_cny_100m must be decimal-compatible") from error
    if not parsed.is_finite() or parsed < 0:
        raise ValueError("market_cap_cny_100m must be finite and non-negative")
    scale = max(-parsed.as_tuple().exponent, 0)
    integer_digits = 1 if parsed.is_zero() else max(parsed.adjusted() + 1, 0)
    if scale > 4:
        raise ValueError("market_cap_cny_100m exceeds storage scale 4")
    if integer_digits > 14:
        raise ValueError("market_cap_cny_100m exceeds storage integer digits 14")
    return format(parsed, "f")


def _validate_market_identity(record: MultibaggerSourceRecord) -> None:
    if record.record_kind not in _RECORD_KINDS:
        raise ValueError("record_kind is not supported")
    expected_scope = _MARKET_SCOPE.get(record.market)
    if expected_scope is None or record.market_scope != expected_scope:
        raise ValueError("market and market_scope must use the canonical mapping")
    if record.market_scope not in _MARKET_EXCHANGES:
        raise ValueError("market_scope is not supported")
    if record.record_kind == "FRENCH_AGGREGATE":
        if (
            record.market != "US"
            or record.market_scope != "us"
            or record.exchange != "ACADEMIC_REFERENCE"
            or not record.ticker.startswith("__AGGREGATE__:")
        ):
            raise ValueError("French aggregate identity is invalid")
        return
    if record.exchange not in _MARKET_EXCHANGES[record.market_scope]:
        raise ValueError("market_scope and exchange must use the canonical mapping")
    if record.exchange == "ACADEMIC_REFERENCE" or record.ticker.startswith(
        "__AGGREGATE__:"
    ):
        raise ValueError("reserved aggregate identity cannot enter ticker facts")


def multibagger_storage_fact_body(
    *,
    market_scope: str,
    exchange: str,
    ticker: str,
    record_kind: str,
    universe_source_kind: str,
    source_document_id: str,
    source_version: str,
    effective_at_utc: datetime,
    available_at_utc: datetime,
    as_of_utc: datetime,
    provider_market_label: str,
    features: object,
    evidence_refs: object,
    text_hit_kinds: object,
    fundamental_snapshot: object,
    filter_pass_bitmap: int,
    market_cap_cny_100m: Optional[str],
) -> Mapping[str, object]:
    return {
        "as_of_utc": _datetime_text(as_of_utc, "as_of_utc"),
        "available_at_utc": _datetime_text(available_at_utc, "available_at_utc"),
        "effective_at_utc": _datetime_text(effective_at_utc, "effective_at_utc"),
        "evidence_refs": evidence_refs,
        "exchange": exchange,
        "features": features,
        "filter_pass_bitmap": filter_pass_bitmap,
        "fundamental_snapshot": fundamental_snapshot,
        "market_cap_cny_100m": market_cap_cny_100m,
        "market_scope": market_scope,
        "provider_market_label": provider_market_label,
        "record_kind": record_kind,
        "source_document_id": source_document_id,
        "source_version": source_version,
        "text_hit_kinds": text_hit_kinds,
        "ticker": ticker,
        "universe_source_kind": universe_source_kind,
    }


def canonical_multibagger_storage_fact_hash(**values: object) -> str:
    body = multibagger_storage_fact_body(**values)  # type: ignore[arg-type]
    return hashlib.sha256(canonicalize_json(body).encode("utf-8")).hexdigest()


def _storage_row(record: MultibaggerSourceRecord) -> _StorageRow:
    if not isinstance(record, MultibaggerSourceRecord):
        raise TypeError("writer accepts MultibaggerSourceRecord only")
    _validate_market_identity(record)
    _require_non_empty(record.ticker, "ticker")
    _require_non_empty(record.source_kind, "source_kind")
    _require_non_empty(record.source_document_id, "source_document_id")
    _require_non_empty(record.source_version, "source_version")
    _require_utc(record.effective_at_utc, "effective_at_utc")
    _require_utc(record.available_at_utc, "available_at_utc")
    _require_utc(record.as_of_utc, "as_of_utc")
    if record.available_at_utc > record.as_of_utc:
        raise ValueError("available_at_utc must not exceed as_of_utc")
    if not isinstance(record.features, Mapping):
        raise ValueError("features must be a JSON object")
    _walk_forbidden(record.features)
    features = dict(record.features)
    features_json = canonicalize_json(features)
    evidence_refs = list(record.evidence_refs)
    if any(
        not isinstance(ref, str) or not ref or ref.isspace() for ref in evidence_refs
    ):
        raise ValueError("evidence_refs must contain non-empty strings")
    evidence_json = canonicalize_json(evidence_refs)
    text_hit_kinds = []
    fundamental_snapshot = {}
    filter_pass_bitmap = 0
    market_cap = _numeric_18_4(features.get("market_cap_cny_100m"))
    if market_cap is not None and record.market_scope != "cn_a":
        raise ValueError("market_cap_cny_100m is valid only for market_scope=cn_a")
    provider_label = record.market
    body = multibagger_storage_fact_body(
        market_scope=record.market_scope,
        exchange=record.exchange,
        ticker=record.ticker,
        record_kind=record.record_kind,
        universe_source_kind=record.source_kind,
        source_document_id=record.source_document_id,
        source_version=record.source_version,
        effective_at_utc=record.effective_at_utc,
        available_at_utc=record.available_at_utc,
        as_of_utc=record.as_of_utc,
        provider_market_label=provider_label,
        features=features,
        evidence_refs=evidence_refs,
        text_hit_kinds=text_hit_kinds,
        fundamental_snapshot=fundamental_snapshot,
        filter_pass_bitmap=filter_pass_bitmap,
        market_cap_cny_100m=market_cap,
    )
    return _StorageRow(
        record=record,
        provider_market_label=provider_label,
        features_json=features_json,
        evidence_refs_json=evidence_json,
        text_hit_kinds_json=canonicalize_json(text_hit_kinds),
        fundamental_snapshot_json=canonicalize_json(fundamental_snapshot),
        filter_pass_bitmap=filter_pass_bitmap,
        market_cap_cny_100m=market_cap,
        canonical_body=body,
    )


def canonical_multibagger_fact_hash(record: MultibaggerSourceRecord) -> str:
    row = _storage_row(record)
    return hashlib.sha256(
        canonicalize_json(row.canonical_body).encode("utf-8")
    ).hexdigest()


def build_storage_row(record: MultibaggerSourceRecord) -> _StorageRow:
    row = _storage_row(record)
    _require_sha256(record.fact_hash, "fact_hash")
    expected_hash = hashlib.sha256(
        canonicalize_json(row.canonical_body).encode("utf-8")
    ).hexdigest()
    if record.fact_hash != expected_hash:
        raise ValueError("fact_hash does not match canonical storage source fact")
    return row


def _logical_identity(record: MultibaggerSourceRecord) -> Tuple[str, ...]:
    return (
        record.source_kind,
        record.record_kind,
        record.ticker,
        record.source_document_id,
        record.source_version,
    )


def _advisory_key(identity: Sequence[str]) -> int:
    digest = hashlib.sha256("\0".join(identity).encode("utf-8")).digest()[:8]
    unsigned = int.from_bytes(digest, byteorder="big", signed=False)
    return unsigned if unsigned < 2**63 else unsigned - 2**64


INSERT_SQL = """
INSERT INTO multibagger_universe (
    market_scope, provider_market_label, exchange, ticker, record_kind,
    universe_source_kind, source_document_id, source_version,
    effective_at_utc, available_at_utc, as_of_utc,
    features, evidence_refs, text_hit_kinds, fundamental_snapshot,
    filter_pass_bitmap, market_cap_cny_100m, fact_hash
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb,
    $16, $17, $18
)
ON CONFLICT (
    universe_source_kind, record_kind, ticker,
    source_document_id, source_version, fact_hash
) DO NOTHING
RETURNING multibagger_universe_id
"""

SELECT_HASHES_SQL = """
SELECT fact_hash
FROM multibagger_universe
WHERE universe_source_kind = $1
  AND record_kind = $2
  AND ticker = $3
  AND source_document_id = $4
  AND source_version = $5
"""

LOCK_SQL = "SELECT pg_advisory_xact_lock($1)"


class MultibaggerIdempotencyConflict(RuntimeError):
    """One logical source identity has more than one immutable fact hash."""


@dataclass(frozen=True)
class MultibaggerWriteResult:
    attempted: int
    inserted: int
    deduplicated: int


def _deduplicate(
    rows: Iterable[_StorageRow],
) -> Tuple[Tuple[_StorageRow, ...], int]:
    unique = {}
    duplicates = 0
    for row in rows:
        key = _logical_identity(row.record)
        existing = unique.get(key)
        if existing is None:
            unique[key] = row
        elif existing.record.fact_hash == row.record.fact_hash:
            duplicates += 1
        else:
            raise MultibaggerIdempotencyConflict(
                "batch has conflicting multibagger source facts"
            )
    return (
        tuple(sorted(unique.values(), key=lambda row: _logical_identity(row.record))),
        duplicates,
    )


class MultibaggerSourceWriter:
    """Write one source-fact batch atomically through an injected async pool."""

    def __init__(self, db_pool: object) -> None:
        self._db_pool = db_pool

    async def write_batch(
        self, records: Sequence[MultibaggerSourceRecord]
    ) -> MultibaggerWriteResult:
        rows, deduplicated = _deduplicate(build_storage_row(item) for item in records)
        if not rows:
            return MultibaggerWriteResult(len(records), 0, deduplicated)

        inserted = 0
        async with self._db_pool.acquire() as connection:
            async with connection.transaction():
                for row in rows:
                    identity = _logical_identity(row.record)
                    await connection.fetchval(LOCK_SQL, _advisory_key(identity))
                    hashes = await connection.fetch(SELECT_HASHES_SQL, *identity)
                    stored_hashes = {
                        str(
                            item["fact_hash"]
                            if isinstance(item, Mapping)
                            else item.fact_hash
                        )
                        for item in hashes
                    }
                    if stored_hashes:
                        if stored_hashes != {row.record.fact_hash}:
                            raise MultibaggerIdempotencyConflict(
                                "stored logical identity has a different fact_hash"
                            )
                        deduplicated += 1
                        continue
                    returned = await connection.fetchrow(
                        INSERT_SQL,
                        row.record.market_scope,
                        row.provider_market_label,
                        row.record.exchange,
                        row.record.ticker,
                        row.record.record_kind,
                        row.record.source_kind,
                        row.record.source_document_id,
                        row.record.source_version,
                        row.record.effective_at_utc,
                        row.record.available_at_utc,
                        row.record.as_of_utc,
                        row.features_json,
                        row.evidence_refs_json,
                        row.text_hit_kinds_json,
                        row.fundamental_snapshot_json,
                        row.filter_pass_bitmap,
                        row.market_cap_cny_100m,
                        row.record.fact_hash,
                    )
                    if returned is None:
                        raced = await connection.fetch(SELECT_HASHES_SQL, *identity)
                        raced_hashes = {
                            str(
                                item["fact_hash"]
                                if isinstance(item, Mapping)
                                else item.fact_hash
                            )
                            for item in raced
                        }
                        if raced_hashes == {row.record.fact_hash}:
                            deduplicated += 1
                            continue
                        if raced_hashes:
                            raise MultibaggerIdempotencyConflict(
                                "raced logical identity has a different fact_hash"
                            )
                        raise RuntimeError(
                            "multibagger insert disappeared after advisory lock"
                        )
                    inserted += 1
        return MultibaggerWriteResult(len(records), inserted, deduplicated)
