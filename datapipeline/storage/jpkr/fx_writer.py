"""Transactional idempotent writer for ``jpkr_fx_observation``."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, ROUND_HALF_EVEN
from typing import Iterable, Mapping, Optional, Sequence, Tuple

from datapipeline.collectors.jpkr_deep.fx_rate_fetcher import canonical_fx_fact_hash
from datapipeline.contracts import FxObservation

DIRECTION = "LOCAL_PER_USD_WITH_RECIPROCAL"
RECIPROCAL_TOLERANCE = Decimal("0.00000001")
_PAIR_SOURCE = {"USDJPY": "BOJ", "USDKRW": "BOK"}

INSERT_SQL = """
INSERT INTO jpkr_fx_observation (
    pair, direction, observation_day, available_at_utc,
    source_kind, source_document_id, source_version,
    local_per_usd, usd_per_local, change_pct,
    previous_observation_day, previous_source_kind,
    previous_source_version, previous_fact_hash, fact_hash
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
    $11, $12, $13, $14, $15
)
ON CONFLICT (
    pair, direction, observation_day, source_kind, source_version
) DO NOTHING
RETURNING fact_hash
"""

SELECT_HASH_SQL = """
SELECT fact_hash
FROM jpkr_fx_observation
WHERE pair = $1
  AND direction = $2
  AND observation_day = $3
  AND source_kind = $4
  AND source_version = $5
"""

SELECT_PREDECESSOR_SQL = """
SELECT
    observation_day,
    available_at_utc,
    source_kind,
    source_version,
    local_per_usd,
    fact_hash
FROM jpkr_fx_observation
WHERE pair = $1
  AND direction = $2
  AND source_kind = $3
  AND observation_day < $4
  AND available_at_utc <= $5
ORDER BY
    observation_day DESC,
    available_at_utc DESC,
    source_version DESC,
    created_at DESC
LIMIT 1
"""


class FxIdempotencyConflict(RuntimeError):
    """One physical identity was observed with two different fact hashes."""


@dataclass(frozen=True)
class FxWriteResult:
    attempted: int
    inserted: int
    deduplicated: int


@dataclass(frozen=True)
class _StoredPredecessor:
    observation_day: date
    available_at_utc: datetime
    source_kind: str
    source_version: str
    local_per_usd: Decimal
    fact_hash: str


def _require_utc(value: datetime, field: str) -> None:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be timezone-aware UTC")


def _require_numeric_authority(
    value: Decimal,
    *,
    field: str,
    max_precision: int,
    max_scale: int,
) -> None:
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ValueError(f"{field} must be a finite Decimal")
    scale = max(-value.as_tuple().exponent, 0)
    integer_digits = 1 if value.is_zero() else max(value.copy_abs().adjusted() + 1, 0)
    if scale > max_scale:
        raise ValueError(f"{field} exceeds storage scale {max_scale}")
    if integer_digits > max_precision - max_scale:
        raise ValueError(
            f"{field} exceeds storage integer digits {max_precision - max_scale}"
        )


def _identity(observation: FxObservation) -> Tuple[str, str, object, str, str]:
    return (
        observation.pair,
        DIRECTION,
        observation.observation_day,
        observation.source_kind,
        observation.source_version,
    )


def _validate_observation(observation: FxObservation, as_of_utc: datetime) -> None:
    if not isinstance(observation, FxObservation):
        raise TypeError("writer accepts FxObservation records only")
    expected_source = _PAIR_SOURCE.get(observation.pair)
    if expected_source is None or observation.source_kind != expected_source:
        raise ValueError("pair and source_kind must use the frozen provider mapping")
    _require_utc(observation.available_at_utc, "available_at_utc")
    if observation.available_at_utc > as_of_utc:
        raise ValueError("FX observation is not available at as_of_utc")
    if observation.observation_day > as_of_utc.date():
        raise ValueError("FX economic day must not exceed as_of_utc")
    if not observation.source_document_id or observation.source_document_id.isspace():
        raise ValueError("source_document_id is required")
    if not observation.source_version or observation.source_version.isspace():
        raise ValueError("source_version is required")
    if len(observation.fact_hash) != 64 or any(
        char not in "0123456789abcdef" for char in observation.fact_hash
    ):
        raise ValueError("fact_hash must be lowercase SHA-256 hex")
    if (
        not isinstance(observation.local_per_usd, Decimal)
        or not isinstance(observation.usd_per_local, Decimal)
        or not observation.local_per_usd.is_finite()
        or not observation.usd_per_local.is_finite()
        or observation.local_per_usd <= 0
        or observation.usd_per_local <= 0
    ):
        raise ValueError("FX rates must be finite positive Decimals")
    _require_numeric_authority(
        observation.local_per_usd,
        field="local_per_usd",
        max_precision=24,
        max_scale=10,
    )
    _require_numeric_authority(
        observation.usd_per_local,
        field="usd_per_local",
        max_precision=24,
        max_scale=14,
    )
    if (
        abs(observation.local_per_usd * observation.usd_per_local - Decimal(1))
        > RECIPROCAL_TOLERANCE
    ):
        raise ValueError("FX reciprocal exceeds tolerance")
    previous = (
        observation.previous_observation_day,
        observation.previous_source_kind,
        observation.previous_source_version,
        observation.previous_fact_hash,
    )
    if observation.change_pct is None:
        if any(value is not None for value in previous):
            raise ValueError("previous lineage requires change_pct")
    elif (
        any(value is None for value in previous)
        or observation.previous_observation_day >= observation.observation_day
        or observation.previous_source_kind != observation.source_kind
    ):
        raise ValueError("change_pct requires complete earlier-observation lineage")
    if observation.previous_fact_hash is not None and (
        len(observation.previous_fact_hash) != 64
        or any(
            char not in "0123456789abcdef" for char in observation.previous_fact_hash
        )
    ):
        raise ValueError("previous_fact_hash must be lowercase SHA-256 hex")
    if observation.change_pct is not None and (
        not isinstance(observation.change_pct, Decimal)
        or not observation.change_pct.is_finite()
    ):
        raise ValueError("change_pct must be a finite Decimal")
    if observation.change_pct is not None:
        _require_numeric_authority(
            observation.change_pct,
            field="change_pct",
            max_precision=18,
            max_scale=8,
        )
    expected_hash = canonical_fx_fact_hash(
        pair=observation.pair,
        observation_day=observation.observation_day,
        available_at_utc=observation.available_at_utc,
        local_per_usd=observation.local_per_usd,
        usd_per_local=observation.usd_per_local,
        change_pct=observation.change_pct,
        source_kind=observation.source_kind,
        source_document_id=observation.source_document_id,
        source_version=observation.source_version,
        previous_observation_day=observation.previous_observation_day,
        previous_source_kind=observation.previous_source_kind,
        previous_source_version=observation.previous_source_version,
        previous_fact_hash=observation.previous_fact_hash,
    )
    if observation.fact_hash != expected_hash:
        raise ValueError("fact_hash does not match canonical FX payload")


def _row_value(row: object, field: str) -> object:
    if isinstance(row, Mapping):
        return row[field]
    # asyncpg.Record intentionally implements subscription without
    # registering as collections.abc.Mapping.  The production writer must
    # therefore support its native row shape instead of relying on the
    # attribute-only fake used by some unit tests.
    try:
        return row[field]  # type: ignore[index]
    except (KeyError, IndexError, TypeError):
        pass
    return getattr(row, field)


def _stored_predecessor(row: Optional[object]) -> Optional[_StoredPredecessor]:
    if row is None:
        return None
    predecessor = _StoredPredecessor(
        observation_day=_row_value(row, "observation_day"),
        available_at_utc=_row_value(row, "available_at_utc"),
        source_kind=str(_row_value(row, "source_kind")),
        source_version=str(_row_value(row, "source_version")),
        local_per_usd=Decimal(str(_row_value(row, "local_per_usd"))),
        fact_hash=str(_row_value(row, "fact_hash")),
    )
    _require_utc(predecessor.available_at_utc, "stored predecessor available_at_utc")
    _require_numeric_authority(
        predecessor.local_per_usd,
        field="stored predecessor local_per_usd",
        max_precision=24,
        max_scale=10,
    )
    if len(predecessor.fact_hash) != 64 or any(
        char not in "0123456789abcdef" for char in predecessor.fact_hash
    ):
        raise ValueError("stored predecessor fact_hash is invalid")
    return predecessor


def _verify_predecessor(
    observation: FxObservation,
    predecessor: Optional[_StoredPredecessor],
) -> None:
    cited = observation.previous_observation_day is not None
    if predecessor is None:
        if cited:
            raise ValueError("cited FX predecessor does not exist")
        return
    if not cited:
        raise ValueError("FX predecessor exists but lineage is missing")
    if (
        observation.previous_observation_day != predecessor.observation_day
        or observation.previous_source_kind != predecessor.source_kind
        or observation.previous_source_version != predecessor.source_version
        or observation.previous_fact_hash != predecessor.fact_hash
    ):
        raise ValueError("FX predecessor lineage is stale or fabricated")
    expected_change = (
        (observation.local_per_usd / predecessor.local_per_usd - Decimal(1))
        * Decimal(100)
    ).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_EVEN)
    if observation.change_pct != expected_change:
        raise ValueError("change_pct does not match authoritative predecessor")


def _deduplicate_batch(
    records: Iterable[FxObservation],
) -> Tuple[Tuple[FxObservation, ...], int]:
    unique = {}
    duplicate_count = 0
    for record in records:
        key = _identity(record)
        existing = unique.get(key)
        if existing is None:
            unique[key] = record
        elif existing.fact_hash == record.fact_hash:
            duplicate_count += 1
        else:
            raise FxIdempotencyConflict(
                "conflicting fact hashes in one FX writer batch"
            )
    return (
        tuple(
            sorted(
                unique.values(),
                key=lambda item: (
                    item.pair,
                    item.observation_day,
                    item.available_at_utc,
                    item.source_version,
                ),
            )
        ),
        duplicate_count,
    )


class FxObservationWriter:
    """Write one validated batch atomically through an injected async pool."""

    def __init__(self, db_pool: object) -> None:
        self._db_pool = db_pool

    async def write_batch(
        self,
        observations: Sequence[FxObservation],
        *,
        as_of_utc: datetime,
    ) -> FxWriteResult:
        _require_utc(as_of_utc, "as_of_utc")
        for observation in observations:
            _validate_observation(observation, as_of_utc)
        unique, deduplicated = _deduplicate_batch(observations)
        if not unique:
            return FxWriteResult(
                attempted=len(observations), inserted=0, deduplicated=deduplicated
            )

        inserted = 0
        async with self._db_pool.acquire() as connection:
            async with connection.transaction():
                for observation in unique:
                    existing_hash = await connection.fetchval(
                        SELECT_HASH_SQL, *_identity(observation)
                    )
                    if existing_hash is not None:
                        if existing_hash != observation.fact_hash:
                            raise FxIdempotencyConflict(
                                "stored FX identity has a different fact_hash"
                            )
                        deduplicated += 1
                        continue

                    predecessor = _stored_predecessor(
                        await connection.fetchrow(
                            SELECT_PREDECESSOR_SQL,
                            observation.pair,
                            DIRECTION,
                            observation.source_kind,
                            observation.observation_day,
                            observation.available_at_utc,
                        )
                    )
                    _verify_predecessor(observation, predecessor)

                    returned = await connection.fetchrow(
                        INSERT_SQL,
                        observation.pair,
                        DIRECTION,
                        observation.observation_day,
                        observation.available_at_utc,
                        observation.source_kind,
                        observation.source_document_id,
                        observation.source_version,
                        str(observation.local_per_usd),
                        str(observation.usd_per_local),
                        (
                            str(observation.change_pct)
                            if observation.change_pct is not None
                            else None
                        ),
                        observation.previous_observation_day,
                        observation.previous_source_kind,
                        observation.previous_source_version,
                        observation.previous_fact_hash,
                        observation.fact_hash,
                    )
                    if returned is not None:
                        inserted += 1
                        continue

                    raced_hash = await connection.fetchval(
                        SELECT_HASH_SQL, *_identity(observation)
                    )
                    if raced_hash is None:
                        raise RuntimeError(
                            "FX conflict row disappeared during one transaction"
                        )
                    if raced_hash != observation.fact_hash:
                        raise FxIdempotencyConflict(
                            "stored FX identity has a different fact_hash"
                        )
                    deduplicated += 1

        return FxWriteResult(
            attempted=len(observations),
            inserted=inserted,
            deduplicated=deduplicated,
        )
