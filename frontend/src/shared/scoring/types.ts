export type Band = "A" | "B" | "C" | "D" | "F";

export interface Dimension {
  score: number;
  band: Band;
  evidence: string[];
  inputs: Record<string, unknown>;
}

export interface Weights {
  quality: number;
  growth: number;
  valuation: number;
  moat: number;
  trend: number;
  risk: number;
}

export interface Score {
  scoring_id: string;
  snapshot_hash: string;
  ticker: string;
  as_of: string;
  quality: Dimension;
  growth: Dimension;
  valuation: Dimension;
  moat: Dimension;
  trend: Dimension;
  risk: Dimension;
  weights: Weights;
  weights_profile: WeightsProfile;
  total: number;
  rating: Band;
  computed_at: string;
  source_versions: SourceVersions;
}

export type WeightsProfile =
  | "us_preferred"
  | "multibagger"
  | "custom"
  | "japan_blue_chip"
  | "korea_semiconductor_chain";

export interface SourceVersions {
  quality_engine: string;
  growth_engine: string;
  valuation_engine: string;
  moat_engine: string;
  trend_engine: string;
  risk_engine: string;
}

export type CatalystKind =
  | "earnings"
  | "upgrade_downgrade"
  | "product"
  | "regulator"
  | "geo_macro"
  | "ma_activity"
  | "sector_move"
  | "leadership"
  | "unclassified";

export interface Adjustment {
  delta: number;
  reason: string;
  kind_ref?: CatalystKind;
  source_ref?: string;
}

export interface Conviction {
  ticker: string;
  as_of: string;
  base: number;
  score_ref: ScoreRef;
  adjustments: Adjustment[];
  final: number;
  level: ConvictionLevel;
}

export type ConvictionLevel = "HIGH" | "MED" | "LOW";

export interface ScoreRef {
  scoring_id: string;
  snapshot_hash: string;
}

export type TriggerSeverity = "info" | "warn" | "block";
export type GateStatus = "GREEN" | "YELLOW" | "RED";

export type RiskGateTriggerCode =
  | "EARNINGS_T-2"
  | "EARNINGS_T-0"
  | "HALT_ACTIVE"
  | "MERGER_PENDING"
  | "LITIGATION_MATERIAL"
  | "IV_SHOCK"
  | "LIQUIDITY_LOW"
  | "RESTATEMENT_30D"
  | "DELISTING_NOTICE"
  | "ST_TAG"
  | "PRICE_LIMIT_APPROACH"
  | "SUSPENDED";

export interface Trigger {
  code: RiskGateTriggerCode;
  severity: TriggerSeverity;
  detail: string;
}

export interface RiskGate {
  ticker: string;
  evaluated_at: string;
  gate: GateStatus;
  triggers: Trigger[];
  ok_to_enter: boolean;
}

export type SizeHintTier = "TIER_5" | "TIER_3" | "TIER_2" | "TIER_1" | "SKIP";

export interface SizeHint {
  tier: SizeHintTier;
  pct: number;
  disclaimer_key: "size_hint_advisory";
  rationale: string;
}

export type TimeHorizon =
  | "INTRADAY"
  | "SWING"
  | "POSITION"
  | "CORE_HOLD"
  | "LONG_TERM";

export interface PriceBand {
  low: number;
  high: number;
  currency: "USD" | "CNY" | "HKD" | "JPY" | "KRW";
}

export interface Price {
  value: number;
  currency: string;
}

export interface EntryPlan {
  ticker: string;
  generated_at: string;
  entry: PriceBand;
  stop: Price;
  targets: Price[];
  size_hint: SizeHint;
  time_horizon: TimeHorizon;
  invalidation: string;
  conviction_ref: number;
  score_ref: ScoreRef;
}

export interface TickerDataBundle {
  ticker: string;
  as_of: string;
  quality_inputs: QualityInputs;
  growth_inputs: GrowthInputs;
  valuation_inputs: ValuationInputs;
  moat_inputs: MoatInputs;
  trend_inputs: TrendInputs;
  risk_inputs: RiskInputs;
}

export interface QualityInputs {
  roic_5y_median: number;
  roe_5y_median: number;
  fcf_margin_5y_median: number;
  gross_margin_stability_5y_sigma: number;
  interest_coverage_4q: number;
  accruals_ratio_sloan: number;
}

export interface GrowthInputs {
  revenue_cagr_3y: number;
  revenue_cagr_5y: number;
  eps_cagr_3y: number;
  eps_cagr_5y: number;
  segment_mix_available: boolean;
  segment_mix_score?: number;
}

export interface ValuationInputs {
  pe_ttm: number | null;
  ev_ebitda_ttm: number;
  pb: number;
  peer_pe_percentile: number;
  peer_ev_ebitda_percentile: number;
  fcf_yield: number;
}

export interface MoatInputs {
  gross_margin_absolute: number;
  gross_margin_sector_rank: number;
  roic_wacc_spread_2y: number;
  market_share_stability_3y: number;
  intangible_rd_intensity: number;
  evidence: string[];
}

export interface TrendInputs {
  ma_50d: number;
  ma_200d: number;
  ma_cross_slope: number;
  return_6m_sector_percentile: number;
  rs_line_vs_sector: number;
  volume_breakout?: boolean;
}

export interface RiskInputs {
  realized_vol_30d: number;
  realized_vol_90d: number;
  max_drawdown_12m: number;
  beta_30d_rolling: number;
  net_debt_ebitda: number;
  current_ratio: number;
  concentration_risk: number;
  regulatory_litigation_flag: boolean;
}
