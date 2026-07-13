from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Mapping, Optional


MarketScope = Literal["cn_a", "us", "jp", "kr"]
ReplayProfile = Literal[
    "us_preferred",
    "multibagger",
    "japan_blue_chip",
    "japan_multibagger",
    "korea_semiconductor_chain",
    "korea_multibagger",
]


@dataclass(frozen=True)
class SourceFact:
    source_kind: str
    source_document_id: str
    source_version: str
    effective_at_utc: str
    available_at_utc: str
    payload: Mapping[str, Any]
    fact_hash: str


@dataclass(frozen=True)
class CalendarSession:
    market_scope: MarketScope
    trade_date: str
    close_utc: str
    is_checkpoint: bool


@dataclass(frozen=True)
class MarketCalendar:
    market_scope: MarketScope
    window_start: str
    window_end: str
    fixture_hash: str
    synthetic: bool
    disclaimer: str
    sessions: tuple[CalendarSession, ...]


@dataclass(frozen=True)
class MembershipRecord:
    ticker: str
    market_scope: MarketScope
    as_of_utc: str
    is_member_at_as_of: bool
    is_delisted_at_as_of: bool
    fact: SourceFact


@dataclass(frozen=True)
class ScoreRecord:
    ticker: str
    profile: ReplayProfile
    market_scope: MarketScope
    as_of_utc: str
    score: float
    strategy_version: str
    fact: SourceFact


@dataclass(frozen=True)
class PriceRecord:
    ticker: str
    market_scope: MarketScope
    as_of_utc: str
    adjusted_close: float
    is_stale: bool
    fact: SourceFact


@dataclass(frozen=True)
class CostModel:
    version: str = "synthetic-cost-v1"
    initial_nav: float = 1.0
    commission_bps_per_side: int = 5
    slippage_bps_per_side: int = 5
    risk_free_annual: float = 0.0
    annualization_sessions: int = 252


@dataclass(frozen=True)
class ReplayMetrics:
    metric_contract_version: str
    window_start: str
    window_end: str
    evaluated_session_count: int
    checkpoint_index: int
    checkpoint_count: int
    initial_nav: float
    commission_bps_per_side: int
    slippage_bps_per_side: int
    annualization_sessions: int
    net_value: float
    cumulative_return: float
    max_drawdown: float
    sharpe_ratio_6m: Optional[float]
    win_rate_6m: Optional[float]


@dataclass(frozen=True)
class HoldingCandidate:
    ticker: str
    position_order: int
    market_scope: MarketScope
    snapshot_as_of_utc: str
    weight: float
    entry_price: float
    current_price: float
    return_since_entry: float
    is_stale: bool
    is_delisted_at_as_of: bool
    source_kind: str
    source_document_id: str
    source_version: str
    available_at_utc: str
    lineage: Mapping[str, Any]
    fact_hash: str


@dataclass(frozen=True)
class SnapshotCandidate:
    strategy: ReplayProfile
    market_scope: MarketScope
    snapshot_day: str
    as_of_utc: str
    metrics: ReplayMetrics
    holdings: tuple[HoldingCandidate, ...]
    lineage_closure: Mapping[str, Any]
    is_survivorship_biased: bool
    is_delisted_at_as_of: bool
    source_versions: Mapping[str, str]
    fact_hash: str


@dataclass(frozen=True)
class ReplayRun:
    strategy: ReplayProfile
    market_scope: MarketScope
    evaluated_session_count: int
    snapshots: tuple[SnapshotCandidate, ...]


@dataclass(frozen=True)
class ReplayBatch:
    runs: tuple[ReplayRun, ...]
    daily_evaluations: int
    snapshot_count: int
    holding_count: int
