export type Band = 'A' | 'B' | 'C' | 'D' | 'F';
export type ConvictionLevel = 'HIGH' | 'MED' | 'LOW';
export type RiskGateStatus = 'GREEN' | 'YELLOW' | 'RED';
export type TimeHorizon = 'INTRADAY' | 'SWING' | 'POSITION' | 'CORE_HOLD' | 'LONG_TERM';

export type SizeHintTier = 'TIER_5' | 'TIER_3' | 'TIER_2' | 'TIER_1' | 'SKIP';
export type SizeHintDisclaimerKey = 'size_hint_advisory';

export type SizeHint = {
  tier: SizeHintTier;
  pct: number;
  disclaimer_key: SizeHintDisclaimerKey;
};

export const SIZE_HINT_TIER_PCT: Readonly<Record<SizeHintTier, number>> = {
  TIER_5: 5.0,
  TIER_3: 3.0,
  TIER_2: 2.0,
  TIER_1: 1.0,
  SKIP: 0.0,
};

export type CatalystKind =
  | 'earnings'
  | 'upgrade_downgrade'
  | 'ma_activity'
  | 'sector_move'
  | 'regulator'
  | 'geo_macro'
  | 'product'
  | 'leadership'
  | 'unclassified';

export const CONVICTION_HIGH_MIN = 75;
export const CONVICTION_MED_MIN = 50;
export const CONVICTION_ADJUSTMENT_MAX_LEN = 5;
export const CONVICTION_ADJUSTMENT_SUM_MIN = -20;
export const CONVICTION_ADJUSTMENT_SUM_MAX = 20;

export type ScoreDimension = 'quality' | 'growth' | 'valuation' | 'moat' | 'trend' | 'risk';

export type ScoreDim = {
  key: ScoreDimension;
  score: number;
  band: Band;
  weight?: number;
};

export type Score = {
  scoring_id: string;
  snapshot_hash: string;
  score: number;
  band: Band;
  dims: ScoreDim[];
  evidence: string[];
  weights_profile?: 'us_preferred' | 'multibagger' | 'japan_korea' | 'custom';
  inputs?: Record<string, unknown>;
};

export type AdjustmentKindRef = CatalystKind | 'risk_gate' | 'evidence_micro';

export type Adjustment = {
  delta: number;
  reason: string;
  kind_ref?: AdjustmentKindRef;
  source_ref?: string;
};

export type Conviction = {
  ticker: string;
  as_of: string;
  base: number;
  score_ref: { scoring_id: string; snapshot_hash: string };
  adjustments: Adjustment[];
  final: number;
  level: ConvictionLevel;
};

export type RiskGateTriggerCode =
  | 'EARNINGS_T-2'
  | 'EARNINGS_T-0'
  | 'HALT'
  | 'MERGER'
  | 'LITIGATION'
  | 'IV_SHOCK'
  | 'LIQUIDITY_LOW'
  | 'RESTATEMENT'
  | 'DELISTING'
  | 'ST_TAG'
  | 'PRICE_LIMIT_APPROACH'
  | 'SUSPENDED';

export type RiskGateTriggerSeverity = 'low' | 'medium' | 'high';

export const RISK_GATE_TRIGGER_DEFAULT_SEVERITY: Readonly<
  Record<RiskGateTriggerCode, RiskGateTriggerSeverity>
> = {
  'EARNINGS_T-2': 'medium',
  'EARNINGS_T-0': 'high',
  HALT: 'high',
  MERGER: 'medium',
  LITIGATION: 'medium',
  IV_SHOCK: 'medium',
  LIQUIDITY_LOW: 'medium',
  RESTATEMENT: 'high',
  DELISTING: 'high',
  ST_TAG: 'high',
  PRICE_LIMIT_APPROACH: 'medium',
  SUSPENDED: 'high',
};

export type RiskGate = {
  status: RiskGateStatus;
  triggers: Array<{
    code: RiskGateTriggerCode;
    severity: RiskGateTriggerSeverity;
    detail: string;
  }>;
  evaluated_at: string;
};

export type EntryPlan = {
  price_band: { low: number; high: number; currency: 'CNY' | 'USD' | 'JPY' | 'KRW' };
  stop: number;
  targets: number[];
  size_hint: SizeHint;
  time_horizon: TimeHorizon;
  invalidation: string;
  conviction_ref: string;
};

export type CandidateListEntry = {
  symbol: string;
  name: string;
  score: Score;
  rating_band: Band;
  conviction?: Conviction;
  risk_gate?: RiskGate;
  entry_plan?: EntryPlan;
  latest_catalyst?: { kind: CatalystKind; title: string; occurred_at: string };
};
