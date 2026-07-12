export const RECOMMENDATION_PROFILES = [
  'us_preferred',
  'multibagger',
  'japan_blue_chip',
  'japan_multibagger',
  'korea_semiconductor_chain',
  'korea_multibagger',
] as const;

export type RecommendationProfile = (typeof RECOMMENDATION_PROFILES)[number];

export const RECOMMENDATION_MARKET_SCOPES = ['cn_a', 'us', 'jp', 'kr'] as const;

export type RecommendationMarketScope = (typeof RECOMMENDATION_MARKET_SCOPES)[number];
export type RecommendationLocale = 'zh-CN' | 'en-US' | 'ja-JP' | 'ko-KR';
export type RatingBand = 'A' | 'B' | 'C' | 'D' | 'F';

export const RECOMMENDATION_PROFILE_SCOPES: Record<
  RecommendationProfile,
  readonly RecommendationMarketScope[]
> = {
  us_preferred: ['cn_a', 'us'],
  multibagger: ['cn_a', 'us'],
  japan_blue_chip: ['jp'],
  japan_multibagger: ['jp'],
  korea_semiconductor_chain: ['kr'],
  korea_multibagger: ['kr'],
};

export interface RecommendationDisclaimer {
  version: string;
  short_text: string;
  full_text: string;
  language: RecommendationLocale;
  effective_at: string;
  hash: string;
}

export interface RecommendationMeta {
  contract_version: '0.3.1';
  profile_version: string;
  input_fingerprint: string;
  strategy_version: string;
  pipeline_version: string;
  generated_by: string;
  generation_ms: number;
}

export interface RecommendationEvidenceRef {
  id: string;
  kind:
    | 'CATALYST_EVENT'
    | 'SCORE_INPUT'
    | 'PRICE_TICK'
    | 'DISCLOSURE'
    | 'RULE'
    | 'MODEL_OUTPUT'
    | 'NEWS';
  source_uri: string;
  as_of: string;
  hash: string;
  short_text?: string;
}

export interface RecommendationScoreDim {
  key: 'Q' | 'G' | 'V' | 'M' | 'T' | 'R';
  score: number;
  band: RatingBand;
  weight: number;
}

export type TriggerSignalCode =
  | 'CATALYST_MATCHED'
  | 'CONVICTION_HIGH'
  | 'SCORE_TOTAL_TOP'
  | 'DIM_BAND_A'
  | 'RISK_GATE_CLEAN'
  | 'ENTRY_PLAN_TIGHT'
  | 'EVENT_FRESH'
  | 'SECTOR_MOMENTUM'
  | 'RULE_MATCHED'
  | 'MODEL_INFERENCE';

export interface RecommendationTriggerSignal {
  code: TriggerSignalCode;
  strength: 'STRONG' | 'MEDIUM' | 'WEAK';
  detail: string;
  source_ref?: string;
}

export interface RecommendationContribution {
  source_kind: 'trigger' | 'score_dim' | 'catalyst_relevance';
  source_ref: string;
  weight: number;
  note?: string;
}

export type RecommendationWeights =
  | { contributions: RecommendationContribution[]; normalized: true }
  | { contributions: []; normalized: false };

export interface RecommendationEntry {
  id: string;
  snapshot_id: string;
  ticker: string;
  as_of: string;
  score: {
    scoring_id: string;
    snapshot_hash: string;
    profile: RecommendationProfile;
    market_scope: RecommendationMarketScope;
    total: number;
    rating: RatingBand;
    dims: RecommendationScoreDim[];
  };
  conviction: Conviction;
  risk_gate: RiskGate;
  entry_plan: EntryPlan;
  trigger_signals: RecommendationTriggerSignal[];
  weights: RecommendationWeights;
  explanation: {
    headline: string;
    body: string;
    caveats: string[];
    language: RecommendationLocale;
    template_id: string;
    template_hash: string;
  };
  evidence_refs: RecommendationEvidenceRef[];
  model_version: string;
  disclaimer_version: string;
  [key: string]: unknown;
}

export interface RecommendationItem {
  recommendation: RecommendationEntry;
  rating_band: RatingBand;
}

export interface RecommendationSnapshot {
  snapshot_id: string;
  as_of: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
  items: RecommendationItem[];
  output_fingerprint: string;
  disclaimer: RecommendationDisclaimer;
  meta: RecommendationMeta;
}

export interface DailyReportSection {
  key: string;
  title: string;
  markdown: string;
}

export interface DailyReportDocument {
  report_id: string;
  trading_day: string;
  source_snapshot_ids: string[];
  snapshot: RecommendationSnapshot;
  title: string;
  markdown: string;
  sections: DailyReportSection[];
}

export type GenerationStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed';

export interface GenerationJob {
  job_id: string;
  status: GenerationStatus;
  snapshot_id?: string;
  error?: string;
  retry_after_ms?: number;
}

export type DailyReportViewState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; profile: RecommendationProfile; market_scope: RecommendationMarketScope }
  | {
      kind: 'ready';
      report: DailyReportDocument;
      generation: GenerationJob;
    };
import type { Conviction, EntryPlan, RiskGate } from 'shared/scoring/types';
