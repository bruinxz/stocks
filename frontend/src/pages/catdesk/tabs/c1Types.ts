import type {
  Band,
  CatalystKind,
  Conviction,
  EntryPlan,
  MarketScope,
  RiskGate,
  SourceVersions,
  Weights,
  WeightsProfile,
} from 'shared/scoring/types';
import type {
  RecommendationCatalystRelevance,
  RecommendationEntry,
  RecommendationEvidenceRef,
  RecommendationMarketScope,
  RecommendationProfile,
  RecommendationTriggerSignal,
  RecommendationWeights,
} from './daily-report/types';

export type { Band, CatalystKind };

export interface CandidateScoreDimension {
  score: number;
  band: Band;
  evidence?: string[];
  inputs?: Record<string, unknown>;
}

export interface CandidateScoreView {
  scoring_id: string;
  snapshot_hash: string;
  ticker?: string;
  as_of?: string;
  market_scope?: MarketScope;
  total: number;
  rating: Band;
  quality: CandidateScoreDimension;
  growth: CandidateScoreDimension;
  valuation: CandidateScoreDimension;
  moat: CandidateScoreDimension;
  trend: CandidateScoreDimension;
  risk: CandidateScoreDimension;
  weights?: Weights;
  weights_profile?: WeightsProfile;
  computed_at?: string;
  source_versions?: SourceVersions;
}

export interface CandidateProvenance {
  snapshot_id: string;
  as_of: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
  output_fingerprint: string;
  input_fingerprint: string;
  contract_version: '0.3.1';
  pipeline_version: string;
}

export interface CandidateListEntry {
  symbol: string;
  name: string;
  score: CandidateScoreView | null;
  rating_band: Band;
  conviction?: Conviction;
  risk_gate?: RiskGate;
  entry_plan?: EntryPlan;
  explanation?: RecommendationEntry['explanation'];
  evidence_refs?: RecommendationEvidenceRef[];
  trigger_signals?: RecommendationTriggerSignal[];
  weights?: RecommendationWeights;
  catalyst_relevance?: RecommendationCatalystRelevance;
  data_sources?: string[];
  provenance?: CandidateProvenance;
  latest_catalyst?: {
    kind: CatalystKind;
    title: string;
    occurred_at: string;
    sector?: string;
  };
}

const SCORE_DIMENSION_LABELS = [
  ['quality', '质量'],
  ['growth', '成长'],
  ['valuation', '估值'],
  ['moat', '护城河'],
  ['trend', '趋势'],
  ['risk', '风险'],
] as const;

export function scoreBandDimensions(score: CandidateScoreView | null) {
  if (!score) return [];

  return SCORE_DIMENSION_LABELS.map(([key, label]) => ({
    label,
    band: score[key].band,
  }));
}
