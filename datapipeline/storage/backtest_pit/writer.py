"""Atomic, idempotent PIT snapshot and normalized holding writer."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
from typing import Mapping, Optional, Sequence, Tuple
from uuid import UUID

from .canonical_json import canonicalize_json

_PROFILE_SCOPES = {
    "us_preferred": frozenset(("cn_a", "us")),
    "multibagger": frozenset(("cn_a", "us")),
    "japan_blue_chip": frozenset(("jp",)),
    "japan_multibagger": frozenset(("jp",)),
    "korea_semiconductor_chain": frozenset(("kr",)),
    "korea_multibagger": frozenset(("kr",)),
}
_REQUIRED_METRICS = frozenset(
    (
        "net_value",
        "drawdown",
        "cumulative_return",
        "sharpe_ratio_6m",
        "win_rate_6m",
        "metric_contract_version",
        "window_start",
        "window_end",
        "evaluated_session_count",
        "checkpoint_index",
        "checkpoint_count",
        "initial_nav",
        "commission_bps_per_side",
        "slippage_bps_per_side",
        "annualization_sessions",
    )
)
_SEMVER = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
_WEIGHT_TOLERANCE = Decimal("0.000000001")

INSERT_SNAPSHOT_SQL = """
INSERT INTO backtest_pit_snapshot (
    snapshot_id, strategy, market_scope, as_of_utc, snapshot_day,
    published_at_utc, is_survivorship_biased, is_delisted_at_as_of,
    source_versions, lineage_closure, metrics, fact_hash
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12
)
ON CONFLICT (strategy, market_scope, as_of_utc) DO NOTHING
RETURNING snapshot_id
"""

INSERT_HOLDING_SQL = """
INSERT INTO backtest_pit_holding (
    backtest_pit_holding_id, snapshot_id, snapshot_as_of_utc,
    position_order, market_scope, ticker, weight, return_since_entry,
    is_stale, source_kind, source_document_id, source_version,
    available_at_utc, lineage, fact_hash
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15
)
"""

SELECT_SNAPSHOT_SQL = """
SELECT
    snapshot_id, strategy, market_scope, as_of_utc, snapshot_day,
    published_at_utc, is_survivorship_biased, is_delisted_at_as_of,
    source_versions, lineage_closure, metrics, fact_hash
FROM backtest_pit_snapshot
WHERE strategy = $1 AND market_scope = $2 AND as_of_utc = $3
"""

SELECT_HOLDINGS_SQL = """
SELECT
    backtest_pit_holding_id, snapshot_id, snapshot_as_of_utc,
    position_order, market_scope, ticker, weight, return_since_entry,
    is_stale, source_kind, source_document_id, source_version,
    available_at_utc, lineage, fact_hash
FROM backtest_pit_holding
WHERE snapshot_id = $1
ORDER BY position_order ASC
"""

LOCK_SQL = "SELECT pg_advisory_xact_lock($1)"


class PitIdempotencyConflict(RuntimeError):
    """Existing PIT identity differs from the proposed immutable snapshot."""


@dataclass(frozen=True)
class PitHoldingFact:
    holding_id: str
    position_order: int
    market_scope: str
    ticker: str
    weight: Decimal
    return_since_entry: Decimal
    is_stale: bool
    is_delisted_at_as_of: bool
    source_kind: str
    source_document_id: str
    source_version: str
    available_at_utc: datetime
    lineage: Mapping[str, object]
    fact_hash: str


@dataclass(frozen=True)
class PitSnapshotFact:
    snapshot_id: str
    strategy: str
    market_scope: str
    as_of_utc: datetime
    snapshot_day: date
    published_at_utc: datetime
    is_survivorship_biased: bool
    is_delisted_at_as_of: bool
    source_versions: Mapping[str, str]
    lineage_closure: Mapping[str, object]
    metrics: Mapping[str, object]
    fact_hash: str


@dataclass(frozen=True)
class PitSnapshotManifest:
    snapshot_id: str
    strategy: str
    market_scope: str
    as_of_utc: datetime
    snapshot_day: date
    snapshot_fact_hash: str
    holding_fact_hashes: Tuple[str, ...]
    inserted: bool


def _utc(value: datetime, field: str) -> str:
    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError(f"{field} must be timezone-aware UTC")
    return value.isoformat().replace("+00:00", "Z")


def _uuid(value: str, field: str) -> str:
    try:
        parsed = UUID(value)
    except (ValueError, TypeError) as error:
        raise ValueError(f"{field} must be UUID") from error
    if parsed.version != 4:
        raise ValueError(f"{field} must be UUIDv4")
    return str(parsed)


def _sha(value: str, field: str) -> None:
    if len(value) != 64 or any(char not in "0123456789abcdef" for char in value):
        raise ValueError(f"{field} must be lowercase SHA-256 hex")


def _text(value: str, field: str) -> None:
    if not value or value.isspace():
        raise ValueError(f"{field} is required")


def _numeric(value: Decimal, field: str, precision: int, scale: int) -> str:
    if not isinstance(value, Decimal) or not value.is_finite():
        raise ValueError(f"{field} must be a finite Decimal")
    fractional = max(-value.as_tuple().exponent, 0)
    integer = 1 if value.is_zero() else max(value.copy_abs().adjusted() + 1, 0)
    if fractional > scale:
        raise ValueError(f"{field} exceeds storage scale {scale}")
    if integer > precision - scale:
        raise ValueError(f"{field} exceeds storage integer digits {precision - scale}")
    return format(value, "f")


def _json(value: object, field: str) -> str:
    try:
        return canonicalize_json(value)
    except ValueError as error:
        raise ValueError(f"{field}: {error}") from error


def canonical_holding_hash(holding: PitHoldingFact) -> str:
    body = {
        "available_at_utc": _utc(holding.available_at_utc, "available_at_utc"),
        "holding_id": _uuid(holding.holding_id, "holding_id"),
        "is_delisted_at_as_of": holding.is_delisted_at_as_of,
        "is_stale": holding.is_stale,
        "lineage": holding.lineage,
        "market_scope": holding.market_scope,
        "position_order": holding.position_order,
        "return_since_entry": _numeric(
            holding.return_since_entry, "return_since_entry", 24, 10
        ),
        "source_document_id": holding.source_document_id,
        "source_kind": holding.source_kind,
        "source_version": holding.source_version,
        "ticker": holding.ticker,
        "weight": _numeric(holding.weight, "weight", 18, 10),
    }
    return hashlib.sha256(_json(body, "holding").encode("utf-8")).hexdigest()


def canonical_snapshot_hash(
    snapshot: PitSnapshotFact, holdings: Sequence[PitHoldingFact]
) -> str:
    body = {
        "as_of_utc": _utc(snapshot.as_of_utc, "as_of_utc"),
        "holding_fact_hashes": [item.fact_hash for item in holdings],
        "is_delisted_at_as_of": snapshot.is_delisted_at_as_of,
        "is_survivorship_biased": snapshot.is_survivorship_biased,
        "lineage_closure": snapshot.lineage_closure,
        "market_scope": snapshot.market_scope,
        "metrics": snapshot.metrics,
        "published_at_utc": _utc(snapshot.published_at_utc, "published_at_utc"),
        "snapshot_day": snapshot.snapshot_day.isoformat(),
        "snapshot_id": _uuid(snapshot.snapshot_id, "snapshot_id"),
        "source_versions": snapshot.source_versions,
        "strategy": snapshot.strategy,
    }
    return hashlib.sha256(_json(body, "snapshot").encode("utf-8")).hexdigest()


def _validate(
    snapshot: PitSnapshotFact, holdings: Sequence[PitHoldingFact]
) -> Tuple[Tuple[PitHoldingFact, ...], str, str, str]:
    _uuid(snapshot.snapshot_id, "snapshot_id")
    allowed_scopes = _PROFILE_SCOPES.get(snapshot.strategy)
    if allowed_scopes is None or snapshot.market_scope not in allowed_scopes:
        raise ValueError("strategy and market_scope are incompatible")
    _utc(snapshot.as_of_utc, "as_of_utc")
    _utc(snapshot.published_at_utc, "published_at_utc")
    if snapshot.snapshot_day != snapshot.as_of_utc.date():
        raise ValueError("snapshot_day must equal the as-of session date")
    if snapshot.published_at_utc < snapshot.as_of_utc:
        raise ValueError("published_at_utc must not precede as_of_utc")
    if not snapshot.source_versions or any(
        not isinstance(key, str) or not key or not isinstance(value, str) or not value
        for key, value in snapshot.source_versions.items()
    ):
        raise ValueError("source_versions must be a non-empty string map")
    if snapshot.is_survivorship_biased:
        raise ValueError("fixture replay cannot persist survivorship-biased snapshots")
    evidence = snapshot.lineage_closure.get("survivorship_evidence")
    if not isinstance(evidence, Mapping) or not evidence:
        raise ValueError("survivorship evidence is required")
    if set(snapshot.metrics) != _REQUIRED_METRICS:
        raise ValueError("metrics must contain the exact replay metric contract")
    version = snapshot.metrics["metric_contract_version"]
    if not isinstance(version, str) or _SEMVER.fullmatch(version) is None:
        raise ValueError("metric_contract_version must be strict SemVer")
    for field in (
        "net_value",
        "drawdown",
        "cumulative_return",
        "initial_nav",
        "commission_bps_per_side",
        "slippage_bps_per_side",
    ):
        value = snapshot.metrics[field]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"{field} must be a finite JSON number")
        canonicalize_json(value)
    for field in ("sharpe_ratio_6m", "win_rate_6m"):
        value = snapshot.metrics[field]
        if value is not None:
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{field} must be null or a finite JSON number")
            canonicalize_json(value)
    if snapshot.metrics["net_value"] <= 0 or snapshot.metrics["initial_nav"] <= 0:
        raise ValueError("net_value and initial_nav must be positive")
    expected_cumulative = (
        snapshot.metrics["net_value"] / snapshot.metrics["initial_nav"] - 1
    )
    if abs(snapshot.metrics["cumulative_return"] - expected_cumulative) > 1e-10:
        raise ValueError("cumulative_return relation is invalid")
    if not -1 <= snapshot.metrics["drawdown"] <= 0:
        raise ValueError("drawdown must be in [-1,0]")
    win_rate = snapshot.metrics["win_rate_6m"]
    if win_rate is not None and not 0 <= win_rate <= 1:
        raise ValueError("win_rate_6m must be in [0,1]")

    ordered = tuple(sorted(holdings, key=lambda item: item.position_order))
    if len(ordered) != 3:
        raise ValueError("each fixture snapshot requires exactly three holdings")
    if [item.position_order for item in ordered] != list(range(len(ordered))):
        raise ValueError("holding position_order must be contiguous from zero")
    if len({item.ticker for item in ordered}) != len(ordered):
        raise ValueError("holding tickers must be unique")
    weight_sum = Decimal(0)
    for item in ordered:
        _uuid(item.holding_id, "holding_id")
        _text(item.ticker, "ticker")
        if item.ticker.startswith("__AGGREGATE__:"):
            raise ValueError("aggregate ticker cannot be a holding")
        if item.market_scope != snapshot.market_scope:
            raise ValueError("holding scope must match snapshot scope")
        if item.available_at_utc > snapshot.as_of_utc:
            raise ValueError("holding availability exceeds snapshot as-of")
        _utc(item.available_at_utc, "holding available_at_utc")
        _text(item.source_kind, "source_kind")
        _text(item.source_document_id, "source_document_id")
        _text(item.source_version, "source_version")
        weight_sum += item.weight
        _numeric(item.weight, "weight", 18, 10)
        _numeric(item.return_since_entry, "return_since_entry", 24, 10)
        if item.lineage.get("is_delisted_at_as_of") is not item.is_delisted_at_as_of:
            raise ValueError("holding lineage must mirror delisted-at-as-of")
        _sha(item.fact_hash, "holding fact_hash")
        if item.fact_hash != canonical_holding_hash(item):
            raise ValueError("holding fact_hash is not authentic")
    if abs(weight_sum - Decimal(1)) > _WEIGHT_TOLERANCE:
        raise ValueError("holding weights must sum to one")
    if snapshot.is_delisted_at_as_of != any(
        item.is_delisted_at_as_of for item in ordered
    ):
        raise ValueError("snapshot delisted flag must equal held-member OR")
    _sha(snapshot.fact_hash, "snapshot fact_hash")
    if snapshot.fact_hash != canonical_snapshot_hash(snapshot, ordered):
        raise ValueError("snapshot fact_hash is not authentic")
    return (
        ordered,
        _json(snapshot.source_versions, "source_versions"),
        _json(snapshot.lineage_closure, "lineage_closure"),
        _json(snapshot.metrics, "metrics"),
    )


class PitSnapshotWriter:
    """Write or verify one immutable snapshot and complete ordered child set."""

    def __init__(self, db_pool: object) -> None:
        self._db_pool = db_pool

    async def write_or_verify(
        self, snapshot: PitSnapshotFact, holdings: Sequence[PitHoldingFact]
    ) -> PitSnapshotManifest:
        ordered, sources_json, lineage_json, metrics_json = _validate(
            snapshot, holdings
        )
        async with self._db_pool.acquire() as connection:
            async with connection.transaction():
                await connection.fetchval(
                    LOCK_SQL,
                    _advisory_key(
                        snapshot.strategy, snapshot.market_scope, snapshot.as_of_utc
                    ),
                )
                existing = await connection.fetchrow(
                    SELECT_SNAPSHOT_SQL,
                    snapshot.strategy,
                    snapshot.market_scope,
                    snapshot.as_of_utc,
                )
                if existing is not None:
                    existing_holdings = await connection.fetch(
                        SELECT_HOLDINGS_SQL, snapshot.snapshot_id
                    )
                    _verify_existing(snapshot, ordered, existing, existing_holdings)
                    return _manifest(snapshot, ordered, inserted=False)
                inserted = await connection.fetchrow(
                    INSERT_SNAPSHOT_SQL,
                    snapshot.snapshot_id,
                    snapshot.strategy,
                    snapshot.market_scope,
                    snapshot.as_of_utc,
                    snapshot.snapshot_day,
                    snapshot.published_at_utc,
                    snapshot.is_survivorship_biased,
                    snapshot.is_delisted_at_as_of,
                    sources_json,
                    lineage_json,
                    metrics_json,
                    snapshot.fact_hash,
                )
                if inserted is None:
                    raise RuntimeError("PIT snapshot insert disappeared after lock")
                for item in ordered:
                    await connection.fetchrow(
                        INSERT_HOLDING_SQL,
                        item.holding_id,
                        snapshot.snapshot_id,
                        snapshot.as_of_utc,
                        item.position_order,
                        item.market_scope,
                        item.ticker,
                        str(item.weight),
                        str(item.return_since_entry),
                        item.is_stale,
                        item.source_kind,
                        item.source_document_id,
                        item.source_version,
                        item.available_at_utc,
                        _json(item.lineage, "holding lineage"),
                        item.fact_hash,
                    )
        return _manifest(snapshot, ordered, inserted=True)

    async def readback(
        self, *, strategy: str, market_scope: str, as_of_utc: datetime
    ) -> Optional[PitSnapshotManifest]:
        _utc(as_of_utc, "as_of_utc")
        async with self._db_pool.acquire() as connection:
            snapshot = await connection.fetchrow(
                SELECT_SNAPSHOT_SQL, strategy, market_scope, as_of_utc
            )
            if snapshot is None:
                return None
            holdings = await connection.fetch(
                SELECT_HOLDINGS_SQL, _row(snapshot, "snapshot_id")
            )
            hashes = tuple(str(_row(item, "fact_hash")) for item in holdings)
            return PitSnapshotManifest(
                snapshot_id=str(_row(snapshot, "snapshot_id")),
                strategy=str(_row(snapshot, "strategy")),
                market_scope=str(_row(snapshot, "market_scope")),
                as_of_utc=_row(snapshot, "as_of_utc"),
                snapshot_day=_row(snapshot, "snapshot_day"),
                snapshot_fact_hash=str(_row(snapshot, "fact_hash")),
                holding_fact_hashes=hashes,
                inserted=False,
            )


def _advisory_key(strategy: str, market_scope: str, as_of_utc: datetime) -> int:
    body = f"{strategy}\0{market_scope}\0{_utc(as_of_utc, 'as_of_utc')}"
    value = int.from_bytes(hashlib.sha256(body.encode()).digest()[:8], "big")
    return value if value < 2**63 else value - 2**64


def _row(row: object, field: str) -> object:
    if isinstance(row, Mapping):
        return row[field]
    return getattr(row, field)


def _json_value(value: object, field: str) -> object:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise PitIdempotencyConflict(f"stored {field} is not valid JSON") from error
    canonicalize_json(value)
    return value


def _verify_existing(
    snapshot: PitSnapshotFact,
    holdings: Sequence[PitHoldingFact],
    existing: object,
    existing_holdings: Sequence[object],
) -> None:
    if (
        str(_row(existing, "snapshot_id")) != snapshot.snapshot_id
        or str(_row(existing, "strategy")) != snapshot.strategy
        or str(_row(existing, "market_scope")) != snapshot.market_scope
        or _row(existing, "as_of_utc") != snapshot.as_of_utc
        or str(_row(existing, "fact_hash")) != snapshot.fact_hash
        or _row(existing, "snapshot_day") != snapshot.snapshot_day
        or _row(existing, "published_at_utc") != snapshot.published_at_utc
        or bool(_row(existing, "is_survivorship_biased"))
        != snapshot.is_survivorship_biased
        or bool(_row(existing, "is_delisted_at_as_of")) != snapshot.is_delisted_at_as_of
        or canonicalize_json(
            _json_value(_row(existing, "source_versions"), "source_versions")
        )
        != canonicalize_json(snapshot.source_versions)
        or canonicalize_json(
            _json_value(_row(existing, "lineage_closure"), "lineage_closure")
        )
        != canonicalize_json(snapshot.lineage_closure)
        or canonicalize_json(_json_value(_row(existing, "metrics"), "metrics"))
        != canonicalize_json(snapshot.metrics)
    ):
        raise PitIdempotencyConflict("existing PIT snapshot header differs")
    existing_ordered = sorted(
        existing_holdings, key=lambda item: int(_row(item, "position_order"))
    )
    if len(existing_ordered) != len(holdings):
        raise PitIdempotencyConflict("existing PIT child count differs")
    for expected, current in zip(holdings, existing_ordered):
        if (
            str(_row(current, "backtest_pit_holding_id")) != expected.holding_id
            or str(_row(current, "snapshot_id")) != snapshot.snapshot_id
            or _row(current, "snapshot_as_of_utc") != snapshot.as_of_utc
            or str(_row(current, "ticker")) != expected.ticker
            or int(_row(current, "position_order")) != expected.position_order
            or str(_row(current, "market_scope")) != expected.market_scope
            or Decimal(str(_row(current, "weight"))) != expected.weight
            or Decimal(str(_row(current, "return_since_entry")))
            != expected.return_since_entry
            or bool(_row(current, "is_stale")) != expected.is_stale
            or str(_row(current, "source_kind")) != expected.source_kind
            or str(_row(current, "source_document_id")) != expected.source_document_id
            or str(_row(current, "source_version")) != expected.source_version
            or _row(current, "available_at_utc") != expected.available_at_utc
            or canonicalize_json(
                _json_value(_row(current, "lineage"), "holding lineage")
            )
            != canonicalize_json(expected.lineage)
            or str(_row(current, "fact_hash")) != expected.fact_hash
        ):
            raise PitIdempotencyConflict("existing PIT holding differs")


def _manifest(
    snapshot: PitSnapshotFact,
    holdings: Sequence[PitHoldingFact],
    *,
    inserted: bool,
) -> PitSnapshotManifest:
    return PitSnapshotManifest(
        snapshot_id=snapshot.snapshot_id,
        strategy=snapshot.strategy,
        market_scope=snapshot.market_scope,
        as_of_utc=snapshot.as_of_utc,
        snapshot_day=snapshot.snapshot_day,
        snapshot_fact_hash=snapshot.fact_hash,
        holding_fact_hashes=tuple(item.fact_hash for item in holdings),
        inserted=inserted,
    )
