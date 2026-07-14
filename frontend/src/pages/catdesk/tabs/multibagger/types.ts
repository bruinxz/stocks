import type {
  Band,
  CandidateListEntry,
  CatalystKind,
  ConvictionLevel,
  RiskGateStatus,
  Score,
  Conviction,
  RiskGate,
  EntryPlan,
  SizeHintTier,
} from 'shared/types/catdesk';

export type MultibaggerStage = 'seed' | 'early' | 'growth' | 'break_below' | 'deep';

export type MultibaggerConclusion =
  | 'MULTIBAGGER_2X'
  | 'MULTIBAGGER_5X'
  | 'MULTIBAGGER_10X'
  | 'SKIP';

export type MultibaggerMarket = 'A' | 'US' | 'JP' | 'KR';

export type MultibaggerRow = CandidateListEntry & {
  market: MultibaggerMarket;
  market_scope: 'cn_a' | 'us' | 'jp' | 'kr';
  exchange: string;
  stage: MultibaggerStage;
  conclusion: MultibaggerConclusion;
  fact_hash: string;
  source_fact_hashes: string[];
  as_of_utc: string;
  available_at_utc: string;
  strategy_version: string;
  classification_policy_version: string;
  classification_reason_codes: string[];
  latest_catalyst?: NonNullable<CandidateListEntry['latest_catalyst']> & {
    available_at_utc: string;
    source_ref: string;
    fact_hash: string;
  };
};

export type MultibaggerKpi = {
  total_candidates: number;
  stage_distribution: Record<MultibaggerStage, number>;
  conclusion_coverage: Record<MultibaggerConclusion, number>;
};

export type MultibaggerResponse = {
  kpi: MultibaggerKpi;
  rows: MultibaggerRow[];
};
