"""Typed T5-B replay-candidate to T5-C storage-fact conversion."""

from __future__ import annotations

from dataclasses import asdict
from datetime import date, datetime
from decimal import Decimal, DecimalException, ROUND_HALF_EVEN
from uuid import NAMESPACE_URL, UUID, uuid5

from ai.replay.six_month import (
    SnapshotCandidate,
    authenticate_snapshot_candidate,
    canonical_holding_candidate_hash,
    canonical_snapshot_candidate_hash,
)

from .writer import (
    PitHoldingFact,
    PitSnapshotFact,
    canonical_holding_hash,
    canonical_snapshot_hash,
)

_STORAGE_QUANTUM = Decimal("0.0000000001")
_CANDIDATE_HASH_KEY = "t5b_candidate_fact_hash"
_CANDIDATE_HOLDING_HASHES_KEY = "t5b_holding_candidate_fact_hashes"
_CANDIDATE_RAW_VALUES_KEY = "t5b_candidate_raw_values"


def _utc(value: str, field: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError(f"{field} must be canonical UTC")
    parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    if parsed.isoformat().replace("+00:00", "Z") != value:
        raise ValueError(f"{field} must be canonical UTC")
    return parsed


def _uuid4(value: str) -> str:
    raw = bytearray(uuid5(NAMESPACE_URL, value).bytes)
    raw[6] = (raw[6] & 0x0F) | 0x40
    raw[8] = (raw[8] & 0x3F) | 0x80
    return str(UUID(bytes=bytes(raw)))


def deterministic_snapshot_id(strategy: str, scope: str, as_of_utc: str) -> str:
    return _uuid4(f"snapshot:{strategy}:{scope}:{as_of_utc}")


def deterministic_holding_id(
    strategy: str,
    scope: str,
    as_of_utc: str,
    position_order: int,
    ticker: str,
) -> str:
    return _uuid4(f"holding:{strategy}:{scope}:{as_of_utc}:{position_order}:{ticker}")


def _metrics(candidate: SnapshotCandidate) -> dict:
    data = asdict(candidate.metrics)
    if "drawdown" not in data or "max_drawdown" in data:
        raise ValueError("T5-B metrics must use canonical drawdown")
    if data.get("metric_contract_version") != "1.0.0":
        raise ValueError("T5-B metric_contract_version must equal 1.0.0")
    return data


def _storage_decimal(value: object, field: str) -> Decimal:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise ValueError(f"{field} must be numeric")
    decimal_value = Decimal(str(value))
    if not decimal_value.is_finite():
        raise ValueError(f"{field} must be finite")
    try:
        stored = decimal_value.quantize(_STORAGE_QUANTUM, rounding=ROUND_HALF_EVEN)
    except DecimalException as error:
        raise ValueError(f"{field} cannot be stored at scale 10") from error
    if not stored.is_finite():
        raise ValueError(f"{field} must be finite")
    return stored


def convert_snapshot_candidate(
    candidate: SnapshotCandidate,
) -> tuple[PitSnapshotFact, tuple[PitHoldingFact, ...]]:
    """Authenticate a T5-B candidate and seal its T5-C physical representation."""

    authenticate_snapshot_candidate(candidate)
    if candidate.fact_hash != canonical_snapshot_candidate_hash(candidate):
        raise ValueError("T5-B snapshot candidate fact_hash mismatch")
    candidate_holdings = tuple(candidate.holdings)
    child_candidate_hashes = tuple(
        canonical_holding_candidate_hash(child) for child in candidate_holdings
    )
    if child_candidate_hashes != tuple(child.fact_hash for child in candidate_holdings):
        raise ValueError("T5-B holding candidate fact_hash mismatch")
    lineage_closure = dict(candidate.lineage_closure)
    for reserved in (_CANDIDATE_HASH_KEY, _CANDIDATE_HOLDING_HASHES_KEY):
        if reserved in lineage_closure:
            raise ValueError(f"T5-B snapshot lineage contains reserved key {reserved}")

    strategy = candidate.strategy
    scope = candidate.market_scope
    as_of = _utc(candidate.as_of_utc, "as_of_utc")
    holdings = []
    for child, child_candidate_hash in zip(candidate_holdings, child_candidate_hashes):
        if child.snapshot_as_of_utc != candidate.as_of_utc:
            raise ValueError("holding snapshot_as_of_utc does not match candidate")
        lineage = dict(child.lineage)
        for reserved in (_CANDIDATE_HASH_KEY, _CANDIDATE_RAW_VALUES_KEY):
            if reserved in lineage:
                raise ValueError(
                    f"T5-B holding lineage contains reserved key {reserved}"
                )
        raw_values = {
            "entry_price": child.entry_price,
            "current_price": child.current_price,
            "weight": child.weight,
            "return_since_entry": child.return_since_entry,
        }
        stored_values = {
            field: _storage_decimal(value, f"holding {field}")
            for field, value in raw_values.items()
        }
        lineage["is_delisted_at_as_of"] = child.is_delisted_at_as_of
        lineage[_CANDIDATE_HASH_KEY] = child_candidate_hash
        lineage[_CANDIDATE_RAW_VALUES_KEY] = raw_values
        fact = PitHoldingFact(
            holding_id=deterministic_holding_id(
                strategy,
                scope,
                candidate.as_of_utc,
                child.position_order,
                child.ticker,
            ),
            position_order=child.position_order,
            market_scope=child.market_scope,
            ticker=child.ticker,
            weight=stored_values["weight"],
            return_since_entry=stored_values["return_since_entry"],
            is_stale=child.is_stale,
            is_delisted_at_as_of=child.is_delisted_at_as_of,
            source_kind=child.source_kind,
            source_document_id=child.source_document_id,
            source_version=child.source_version,
            available_at_utc=_utc(child.available_at_utc, "holding available_at_utc"),
            lineage=lineage,
            fact_hash="0" * 64,
        )
        object.__setattr__(fact, "fact_hash", canonical_holding_hash(fact))
        holdings.append(fact)
    ordered = tuple(sorted(holdings, key=lambda item: item.position_order))
    lineage_closure[_CANDIDATE_HASH_KEY] = candidate.fact_hash
    lineage_closure[_CANDIDATE_HOLDING_HASHES_KEY] = list(child_candidate_hashes)
    snapshot = PitSnapshotFact(
        snapshot_id=deterministic_snapshot_id(strategy, scope, candidate.as_of_utc),
        strategy=strategy,
        market_scope=scope,
        as_of_utc=as_of,
        snapshot_day=date.fromisoformat(candidate.snapshot_day),
        published_at_utc=as_of,
        is_survivorship_biased=candidate.is_survivorship_biased,
        is_delisted_at_as_of=candidate.is_delisted_at_as_of,
        source_versions=dict(candidate.source_versions),
        lineage_closure=lineage_closure,
        metrics=_metrics(candidate),
        fact_hash="0" * 64,
    )
    object.__setattr__(
        snapshot, "fact_hash", canonical_snapshot_hash(snapshot, ordered)
    )
    return snapshot, ordered
