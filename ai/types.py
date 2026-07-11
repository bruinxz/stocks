from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ScoreDim:
    key: str
    score: float
    band: str
    weight: float


@dataclass
class ScoreRef:
    scoring_id: str
    snapshot_hash: str
    profile: str
    total: float
    band: str
    dims: list[ScoreDim] = field(default_factory=list)


@dataclass
class Adjustment:
    delta: float
    reason: str
    kind_ref: Optional[str] = None
    source_ref: Optional[str] = None


@dataclass
class Conviction:
    base: float
    adjustments: list[Adjustment] = field(default_factory=list)
    final: float = 0.0
    level: str = "LOW"


@dataclass
class RiskTrigger:
    code: str
    severity: str
    detail: str


@dataclass
class RiskGate:
    gate: str
    ok_to_enter: bool
    triggers: list[RiskTrigger] = field(default_factory=list)


@dataclass
class SizeHint:
    tier: str
    pct: float
    disclaimer_key: str = "size_hint_advisory"


@dataclass
class PriceBand:
    low: float
    high: float
    currency: str


@dataclass
class EntryPlan:
    price_band: PriceBand
    stop: float
    targets: list[float] = field(default_factory=list)
    size_hint: SizeHint = field(default_factory=lambda: SizeHint("SKIP", 0.0))
    time_horizon: str = "POSITION"
    invalidation: str = ""
    conviction_ref: str = ""


@dataclass
class CatalystComponent:
    sector_map: float = 0.0
    revenue_exposure: float = 0.0
    adr_parity: float = 0.0
    supply_chain: float = 0.0
    historical_beta: float = 0.0


@dataclass
class CatalystRelevance:
    catalyst_id: str
    kind: str
    relevance_score: float
    components: CatalystComponent = field(default_factory=CatalystComponent)


@dataclass
class TriggerSignal:
    code: str
    strength: str
    detail: str
    source_ref: Optional[str] = None


@dataclass
class Contribution:
    source_kind: str
    source_ref: str
    weight: float
    note: Optional[str] = None


@dataclass
class WeightAttribution:
    contributions: list[Contribution] = field(default_factory=list)
    normalized: bool = False


@dataclass
class Explanation:
    headline: str
    body: str
    caveats: list[str] = field(default_factory=list)
    language: str = "zh-CN"
    template_id: str = ""
    template_hash: str = ""


@dataclass
class EvidenceRef:
    id: str
    kind: str
    source_uri: str
    as_of: str
    hash: str
    short_text: Optional[str] = None


BAND_RATING_SEQUENCE = ("A", "B", "C", "D", "F")
BAND_RATINGS = frozenset(BAND_RATING_SEQUENCE)
BAND_THRESHOLDS = {"A": 85, "B": 70, "C": 55, "D": 40}

CATALYST_KINDS = frozenset({
    "earnings", "upgrade_downgrade", "ma_activity", "sector_move",
    "regulator", "geo_macro", "product", "leadership", "unclassified",
})

RISK_TRIGGER_CODE_SEQUENCE_V0_3 = (
    "EARNINGS_T-2",
    "EARNINGS_T-0",
    "HALT_ACTIVE",
    "MERGER_PENDING",
    "LITIGATION_MATERIAL",
    "IV_SHOCK",
    "LIQUIDITY_LOW",
    "RESTATEMENT_30D",
    "DELISTING_NOTICE",
    "ST_TAG",
    "PRICE_LIMIT_APPROACH",
    "SUSPENDED",
    "TSE_HALT",
    "EDINET_DELAY",
    "CORPORATE_GOVERNANCE_ISSUE",
    "TSE_TOKUBETSU_CHI",
    "TSE_KANRI",
    "KRX_HALT",
    "DART_LATE_FILING",
    "INSIDER_TRADING_FLAG",
    "KRX_UNFAITHFUL",
    "KRX_INVESTOR_ALERT",
)

RISK_TRIGGER_CODES = frozenset(RISK_TRIGGER_CODE_SEQUENCE_V0_3)

SIZE_HINT_TIER_PCT = {
    "TIER_5": 5.0, "TIER_3": 3.0, "TIER_2": 2.0, "TIER_1": 1.0, "SKIP": 0.0,
}

CANONICAL_URI_PREFIXES = (
    "sec-edgar://", "nasdaq://", "fda-rss://", "baostock://",
    "akshare://", "jpx-edinet://", "krx://", "dart://",
    "catalyst-event://", "ai-rule://", "ai-model://", "news://",
)
