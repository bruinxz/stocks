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
} from '@/shared/types/catdesk';

export type MultibaggerStage = 'seed' | 'early' | 'growth' | 'break_below' | 'deep';

export type MultibaggerConclusion = 'MULTIBAGGER_2X' | 'MULTIBAGGER_5X' | 'MULTIBAGGER_10X' | 'SKIP';

export type MultibaggerMarket = 'A' | 'US' | 'JP' | 'KR';

export type MultibaggerRow = CandidateListEntry & {
  market: MultibaggerMarket;
  stage: MultibaggerStage;
  conclusion: MultibaggerConclusion;
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
