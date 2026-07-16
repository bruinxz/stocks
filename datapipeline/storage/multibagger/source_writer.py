"""Transactional writer for immutable ``multibagger_universe`` source facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
import json
from typing import Iterable, Mapping, Optional, Sequence, Tuple

from datapipeline.contracts import (
    MultibaggerSourceRecord,
    is_canonical_sha256,
    is_canonical_source_version,
)

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


def _fact_hash_from_row(row: object) -> str:
    if isinstance(row, Mapping):
        return str(row["fact_hash"])
    try:
        return str(row["fact_hash"])  # type: ignore[index]
    except (KeyError, IndexError, TypeError):
        return str(row.fact_hash)  # type: ignore[attr-defined]


@dataclass(frozen=True)
class MultibaggerWriteResult:
    attempted: int
    inserted: int
    deduplicated: int


@dataclass(frozen=True)
class _StorageRow:
    market_scope: str
    provider_market_label: str
    exchange: str
    ticker: str
    record_kind: str
    universe_source_kind: str
    source_document_id: str
    source_version: str
    effective_at_utc: datetime
    available_at_utc: datetime
    as_of_utc: datetime
    features_json: str
    evidence_refs_json: str
    text_hit_kinds_json: str
    fundamental_snapshot_json: str
    filter_pass_bitmap: int
    market_cap_cny_100m: Optional[str]
    fact_hash: str
    canonical_body_json: str

    @property
    def canonical_body(self) -> Mapping[str, object]:
        # Compatibility projection. The authoritative prepared snapshot remains
        # the immutable canonical JSON string retained by this row.
        body = json.loads(self.canonical_body_json)
        assert isinstance(body, dict)
        return body

    @property
    def identity(self) -> Tuple[str, ...]:
        return (
            self.universe_source_kind,
            self.record_kind,
            self.ticker,
            self.source_document_id,
            self.source_version,
        )

    @property
    def insert_params(self) -> Tuple[object, ...]:
        return (
            self.market_scope,
            self.provider_market_label,
            self.exchange,
            self.ticker,
            self.record_kind,
            self.universe_source_kind,
            self.source_document_id,
            self.source_version,
            self.effective_at_utc,
            self.available_at_utc,
            self.as_of_utc,
            self.features_json,
            self.evidence_refs_json,
            self.text_hit_kinds_json,
            self.fundamental_snapshot_json,
            self.filter_pass_bitmap,
            self.market_cap_cny_100m,
            self.fact_hash,
        )


def _require_utc(value: datetime, field: str) -> None:
    if (
        type(value) is not datetime
        or value.tzinfo is None
        or value.utcoffset() != timedelta(0)
    ):
        raise ValueError(f"{field} must be timezone-aware UTC")


def _require_non_empty(value: str, field: str) -> None:
    if type(value) is not str or not value or value.isspace():
        raise ValueError(f"{field} is required")


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


def _validate_market_identity(
    *, market: str, market_scope: str, exchange: str, ticker: str, record_kind: str
) -> None:
    if record_kind not in _RECORD_KINDS:
        raise ValueError("record_kind is not supported")
    expected_scope = _MARKET_SCOPE.get(market)
    if expected_scope is None or market_scope != expected_scope:
        raise ValueError("market and market_scope must use the canonical mapping")
    if market_scope not in _MARKET_EXCHANGES:
        raise ValueError("market_scope is not supported")
    if record_kind == "FRENCH_AGGREGATE":
        if (
            market != "US"
            or market_scope != "us"
            or exchange != "ACADEMIC_REFERENCE"
            or not ticker.startswith("__AGGREGATE__:")
        ):
            raise ValueError("French aggregate identity is invalid")
        return
    if exchange not in _MARKET_EXCHANGES[market_scope]:
        raise ValueError("market_scope and exchange must use the canonical mapping")
    if exchange == "ACADEMIC_REFERENCE" or ticker.startswith("__AGGREGATE__:"):
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
    if type(record) is not MultibaggerSourceRecord:
        raise TypeError("writer accepts MultibaggerSourceRecord only")

    # Snapshot every caller-owned field before producing any derived material.
    # Nothing retained in _StorageRow refers back to the source dataclass.
    market = record.market
    market_scope = record.market_scope
    exchange = record.exchange
    ticker = record.ticker
    record_kind = record.record_kind
    source_kind = record.source_kind
    source_document_id = record.source_document_id
    source_version = record.source_version
    effective_at_utc = record.effective_at_utc
    available_at_utc = record.available_at_utc
    as_of_utc = record.as_of_utc
    features_source = record.features
    evidence_refs_source = record.evidence_refs
    fact_hash = record.fact_hash

    for value, field in (
        (market, "market"),
        (market_scope, "market_scope"),
        (exchange, "exchange"),
        (ticker, "ticker"),
        (record_kind, "record_kind"),
        (source_kind, "source_kind"),
        (source_document_id, "source_document_id"),
    ):
        _require_non_empty(value, field)
    _validate_market_identity(
        market=market,
        market_scope=market_scope,
        exchange=exchange,
        ticker=ticker,
        record_kind=record_kind,
    )
    if not is_canonical_source_version(source_version):
        raise ValueError("source_version must be a printable ASCII token")
    _require_utc(effective_at_utc, "effective_at_utc")
    _require_utc(available_at_utc, "available_at_utc")
    _require_utc(as_of_utc, "as_of_utc")
    if available_at_utc > as_of_utc:
        raise ValueError("available_at_utc must not exceed as_of_utc")
    if not isinstance(features_source, Mapping):
        raise ValueError("features must be a JSON object")
    try:
        features_json = canonicalize_json(features_source)
    except ValueError as error:
        if str(error) == "JSON object keys must be strings":
            raise ValueError("features contains a non-string JSON key") from error
        raise
    features = json.loads(features_json)
    if not isinstance(features, dict):
        raise ValueError("features must be a JSON object")
    _walk_forbidden(features)
    evidence_refs = list(evidence_refs_source)
    if any(
        type(ref) is not str or not ref or ref.isspace() for ref in evidence_refs
    ):
        raise ValueError("evidence_refs must contain non-empty strings")
    evidence_json = canonicalize_json(evidence_refs)
    text_hit_kinds = []
    fundamental_snapshot = {}
    filter_pass_bitmap = 0
    market_cap = _numeric_18_4(features.get("market_cap_cny_100m"))
    if market_cap is not None and market_scope != "cn_a":
        raise ValueError("market_cap_cny_100m is valid only for market_scope=cn_a")
    provider_label = market
    body = multibagger_storage_fact_body(
        market_scope=market_scope,
        exchange=exchange,
        ticker=ticker,
        record_kind=record_kind,
        universe_source_kind=source_kind,
        source_document_id=source_document_id,
        source_version=source_version,
        effective_at_utc=effective_at_utc,
        available_at_utc=available_at_utc,
        as_of_utc=as_of_utc,
        provider_market_label=provider_label,
        features=features,
        evidence_refs=evidence_refs,
        text_hit_kinds=text_hit_kinds,
        fundamental_snapshot=fundamental_snapshot,
        filter_pass_bitmap=filter_pass_bitmap,
        market_cap_cny_100m=market_cap,
    )
    canonical_body_json = canonicalize_json(body)
    return _StorageRow(
        market_scope=market_scope,
        provider_market_label=provider_label,
        exchange=exchange,
        ticker=ticker,
        record_kind=record_kind,
        universe_source_kind=source_kind,
        source_document_id=source_document_id,
        source_version=source_version,
        effective_at_utc=effective_at_utc,
        available_at_utc=available_at_utc,
        as_of_utc=as_of_utc,
        features_json=features_json,
        evidence_refs_json=evidence_json,
        text_hit_kinds_json=canonicalize_json(text_hit_kinds),
        fundamental_snapshot_json=canonicalize_json(fundamental_snapshot),
        filter_pass_bitmap=filter_pass_bitmap,
        market_cap_cny_100m=market_cap,
        fact_hash=fact_hash,
        canonical_body_json=canonical_body_json,
    )


def canonical_multibagger_fact_hash(record: MultibaggerSourceRecord) -> str:
    row = _storage_row(record)
    return hashlib.sha256(row.canonical_body_json.encode("utf-8")).hexdigest()


def build_storage_row(record: MultibaggerSourceRecord) -> _StorageRow:
    row = _storage_row(record)
    if not is_canonical_sha256(row.fact_hash):
        raise ValueError("fact_hash must be lowercase SHA-256 hex")
    expected_hash = hashlib.sha256(row.canonical_body_json.encode("utf-8")).hexdigest()
    if row.fact_hash != expected_hash:
        raise ValueError("fact_hash does not match canonical storage source fact")
    return row


def _logical_identity(row: _StorageRow) -> Tuple[str, ...]:
    return row.identity


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
        key = _logical_identity(row)
        existing = unique.get(key)
        if existing is None:
            unique[key] = row
        elif existing.fact_hash == row.fact_hash:
            duplicates += 1
        else:
            raise MultibaggerIdempotencyConflict(
                "batch has conflicting multibagger source facts"
            )
    return (
        tuple(sorted(unique.values(), key=_logical_identity)),
        duplicates,
    )


class MultibaggerSourceWriter:
    """Write one source-fact batch atomically through an injected async pool."""

    def __init__(self, db_pool: object) -> None:
        self._db_pool = db_pool

    async def write_batch(
        self, records: Sequence[MultibaggerSourceRecord]
    ) -> MultibaggerWriteResult:
        records_snapshot = tuple(records)
        attempted = len(records_snapshot)
        rows, deduplicated = _deduplicate(
            build_storage_row(item) for item in records_snapshot
        )
        del records_snapshot
        del records
        if not rows:
            return MultibaggerWriteResult(attempted, 0, deduplicated)

        inserted = 0
        async with self._db_pool.acquire() as connection:
            async with connection.transaction():
                for row in rows:
                    identity = _logical_identity(row)
                    await connection.fetchval(LOCK_SQL, _advisory_key(identity))
                    hashes = await connection.fetch(SELECT_HASHES_SQL, *identity)
                    stored_hashes = {_fact_hash_from_row(item) for item in hashes}
                    if stored_hashes:
                        if stored_hashes != {row.fact_hash}:
                            raise MultibaggerIdempotencyConflict(
                                "stored logical identity has a different fact_hash"
                            )
                        deduplicated += 1
                        continue
                    returned = await connection.fetchrow(
                        INSERT_SQL,
                        *row.insert_params,
                    )
                    if returned is None:
                        raced = await connection.fetch(SELECT_HASHES_SQL, *identity)
                        raced_hashes = {_fact_hash_from_row(item) for item in raced}
                        if raced_hashes == {row.fact_hash}:
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
        return MultibaggerWriteResult(attempted, inserted, deduplicated)
