import type {
  Band,
  CatalystKind,
  Conviction,
  EntryPlan,
  GateStatus,
  RiskGate,
  RiskGateTriggerCode,
  Score,
  SizeHintTier,
  TriggerSeverity,
} from '../scoring/types';

export type {
  Band,
  CatalystKind,
  Conviction,
  ConvictionLevel,
  EntryPlan,
  MarketScope,
  RiskGate,
  RiskGateTriggerCode,
  Score,
  SizeHint,
  SizeHintTier,
  TimeHorizon,
  TriggerSeverity as RiskGateTriggerSeverity,
} from '../scoring/types';

export type RiskGateStatus = GateStatus;
export type SizeHintDisclaimerKey = 'size_hint_advisory';

export const SIZE_HINT_TIER_PCT: Readonly<Record<SizeHintTier, number>> = {
  TIER_5: 5.0,
  TIER_3: 3.0,
  TIER_2: 2.0,
  TIER_1: 1.0,
  SKIP: 0.0,
};

export const CONVICTION_HIGH_MIN = 75;
export const CONVICTION_MED_MIN = 50;
export const CONVICTION_ADJUSTMENT_MAX_LEN = 5;
export const CONVICTION_ADJUSTMENT_SUM_MIN = -20;
export const CONVICTION_ADJUSTMENT_SUM_MAX = 20;

export type AdjustmentKindRef = CatalystKind | 'risk_gate' | 'evidence_micro';

export const RISK_GATE_TRIGGER_DEFAULT_SEVERITY: Readonly<
  Partial<Record<RiskGateTriggerCode, TriggerSeverity>>
> = {
  'EARNINGS_T-2': 'warn',
  'EARNINGS_T-0': 'block',
  HALT_ACTIVE: 'block',
  MERGER_PENDING: 'warn',
  LITIGATION_MATERIAL: 'warn',
  IV_SHOCK: 'warn',
  LIQUIDITY_LOW: 'warn',
  RESTATEMENT_30D: 'block',
  DELISTING_NOTICE: 'block',
  ST_TAG: 'block',
  PRICE_LIMIT_APPROACH: 'warn',
  SUSPENDED: 'block',
};

export type CandidateListEntry = {
  symbol: string;
  name: string;
  score: Score | null;
  rating_band: Band;
  conviction?: Conviction;
  risk_gate?: RiskGate;
  entry_plan?: EntryPlan;
  latest_catalyst?: { kind: CatalystKind; title: string; occurred_at: string };
};
