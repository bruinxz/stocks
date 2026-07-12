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
  language: 'zh-CN' | 'en-US';
  effective_at: string;
  hash: string;
}

export interface RecommendationSnapshotMeta {
  strategy_version: string;
  pipeline_version: string;
  generated_by: string;
  generation_ms: number;
}

export interface RecommendationSnapshotItem {
  recommendation: Record<string, unknown>;
  rating_band: 'A' | 'B' | 'C' | 'D' | 'F';
}

export interface RecommendationSnapshotSummary {
  snapshot_id: string;
  trading_day: string;
  as_of: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
  output_fingerprint: string;
  item_count: number;
  created_at: string;
}

export interface RecommendationSnapshotDetail {
  snapshot_id: string;
  as_of: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
  output_fingerprint: string;
  disclaimer: RecommendationDisclaimer;
  meta: RecommendationSnapshotMeta;
  items: RecommendationSnapshotItem[];
}

export interface RecommendationSnapshotPage {
  entries: RecommendationSnapshotSummary[];
  total: number;
  page: number;
  page_size: number;
}

export interface RecommendationSnapshotDiff {
  base_snapshot_id: string;
  target_snapshot_id: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
  fingerprint_match: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: string[];
}

export interface RecommendationSnapshotScope {
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
}

export interface RecommendationSnapshotDateQuery extends RecommendationSnapshotScope {
  trading_day: string;
  page: number;
  page_size: number;
}

export interface RecommendationSnapshotReadPort {
  latest(scope: RecommendationSnapshotScope): Promise<RecommendationSnapshotDetail | null>;
  byDate(query: RecommendationSnapshotDateQuery): Promise<RecommendationSnapshotPage>;
  detail(snapshotId: string): Promise<RecommendationSnapshotDetail | null>;
  diff(baseSnapshotId: string, targetSnapshotId: string): Promise<RecommendationSnapshotDiff>;
}

export class RecommendationSnapshotNotFoundError extends Error {
  constructor(message = 'Recommendation snapshot not found') {
    super(message);
    this.name = 'RecommendationSnapshotNotFoundError';
  }
}

export class RecommendationSnapshotConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecommendationSnapshotConflictError';
  }
}

export class RecommendationSnapshotContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecommendationSnapshotContractError';
  }
}

export class RecommendationSnapshotStoreUnavailableError extends Error {
  constructor(message = 'Recommendation snapshot store is not available') {
    super(message);
    this.name = 'RecommendationSnapshotStoreUnavailableError';
  }
}

export function isRecommendationScopeCompatible(
  profile: RecommendationProfile,
  marketScope: RecommendationMarketScope
): boolean {
  return RECOMMENDATION_PROFILE_SCOPES[profile].includes(marketScope);
}

export const unavailableRecommendationSnapshotReadPort: RecommendationSnapshotReadPort = {
  async latest() {
    throw new RecommendationSnapshotStoreUnavailableError();
  },
  async byDate() {
    throw new RecommendationSnapshotStoreUnavailableError();
  },
  async detail() {
    throw new RecommendationSnapshotStoreUnavailableError();
  },
  async diff() {
    throw new RecommendationSnapshotStoreUnavailableError();
  },
};
