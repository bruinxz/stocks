import { parseRecommendationSnapshot } from './daily-report/recommendationAdapter';
import type {
  RecommendationEntry,
  RecommendationMarketScope,
  RecommendationProfile,
  RecommendationSnapshot,
} from './daily-report/types';
import type { CandidateListEntry, CandidateScoreDimension, CandidateScoreView } from './c1Types';
import { authenticatedFetch } from 'services/api';

const DIMENSION_KEYS = {
  quality: 'Q',
  growth: 'G',
  valuation: 'V',
  moat: 'M',
  trend: 'T',
  risk: 'R',
} as const;

export class RecommendationCandidateContractError extends Error {
  constructor(message: string) {
    super(`Recommendation candidate feed error: ${message}`);
    this.name = 'RecommendationCandidateContractError';
  }
}

export interface RecommendationCandidateFeed {
  snapshot: RecommendationSnapshot;
  candidates: CandidateListEntry[];
  kpi: {
    total: number;
    high_conviction: number;
    avg_score: number;
    updated_at: string;
  };
}

export type RecommendationCandidateLoadResult =
  | { kind: 'ready'; feed: RecommendationCandidateFeed }
  | { kind: 'not_generated' }
  | { kind: 'unavailable' };

export type RecommendationCandidateFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export class RecommendationCandidateHttpError extends Error {
  constructor(readonly status: number) {
    super(`Recommendation candidate request failed with HTTP ${status}`);
    this.name = 'RecommendationCandidateHttpError';
  }
}

function scoreDimension(
  recommendation: RecommendationEntry,
  key: (typeof DIMENSION_KEYS)[keyof typeof DIMENSION_KEYS]
): CandidateScoreDimension {
  const dimension = recommendation.score.dims.find(item => item.key === key);
  if (!dimension) {
    throw new RecommendationCandidateContractError(
      `${recommendation.ticker} is missing score dimension ${key}`
    );
  }
  return { score: dimension.score, band: dimension.band };
}

function scoreView(recommendation: RecommendationEntry): CandidateScoreView {
  const dimensions = Object.fromEntries(
    recommendation.score.dims.map(dimension => [dimension.key, dimension])
  ) as Record<'Q' | 'G' | 'V' | 'M' | 'T' | 'R', RecommendationEntry['score']['dims'][number]>;
  return {
    scoring_id: recommendation.score.scoring_id,
    snapshot_hash: recommendation.score.snapshot_hash,
    ticker: recommendation.ticker,
    as_of: recommendation.as_of,
    market_scope: recommendation.score.market_scope,
    total: recommendation.score.total,
    rating: recommendation.score.rating,
    quality: scoreDimension(recommendation, DIMENSION_KEYS.quality),
    growth: scoreDimension(recommendation, DIMENSION_KEYS.growth),
    valuation: scoreDimension(recommendation, DIMENSION_KEYS.valuation),
    moat: scoreDimension(recommendation, DIMENSION_KEYS.moat),
    trend: scoreDimension(recommendation, DIMENSION_KEYS.trend),
    risk: scoreDimension(recommendation, DIMENSION_KEYS.risk),
    weights: {
      quality: dimensions.Q.weight,
      growth: dimensions.G.weight,
      valuation: dimensions.V.weight,
      moat: dimensions.M.weight,
      trend: dimensions.T.weight,
      risk: dimensions.R.weight,
    },
    weights_profile: recommendation.score.profile,
  };
}

function sourceLabels(recommendation: RecommendationEntry): string[] {
  return Array.from(
    new Set(recommendation.evidence_refs.map(evidence => evidence.source_uri))
  ).sort();
}

function candidateFromRecommendation(
  recommendation: RecommendationEntry,
  snapshot: RecommendationSnapshot
): CandidateListEntry {
  const catalyst = recommendation.catalyst_relevance;
  const catalystEvidence = catalyst
    ? (recommendation.evidence_refs.find(evidence => evidence.id === catalyst.catalyst_id) ??
      recommendation.evidence_refs.find(evidence => evidence.kind === 'CATALYST_EVENT') ??
      recommendation.evidence_refs[0])
    : undefined;

  return {
    symbol: recommendation.ticker,
    // Recommendation v0.3.1 intentionally carries a canonical ticker, not a
    // mutable company-name snapshot. Reusing the ticker is honest and stable.
    name: recommendation.ticker,
    score: scoreView(recommendation),
    rating_band: recommendation.score.rating,
    conviction: recommendation.conviction,
    risk_gate: recommendation.risk_gate,
    entry_plan: recommendation.entry_plan,
    explanation: recommendation.explanation,
    evidence_refs: recommendation.evidence_refs,
    trigger_signals: recommendation.trigger_signals,
    weights: recommendation.weights,
    catalyst_relevance: catalyst,
    data_sources: sourceLabels(recommendation),
    provenance: {
      snapshot_id: snapshot.snapshot_id,
      as_of: snapshot.as_of,
      profile: snapshot.profile,
      market_scope: snapshot.market_scope,
      output_fingerprint: snapshot.output_fingerprint,
      input_fingerprint: snapshot.meta.input_fingerprint,
      contract_version: snapshot.meta.contract_version,
      pipeline_version: snapshot.meta.pipeline_version,
    },
    ...(catalyst && catalystEvidence
      ? {
          latest_catalyst: {
            kind: catalyst.kind,
            title: catalystEvidence.short_text ?? catalyst.kind,
            occurred_at: catalystEvidence.as_of,
          },
        }
      : {}),
  };
}

export function parseRecommendationCandidateFeed(
  value: unknown,
  expectedProfile: RecommendationProfile,
  expectedMarketScope: RecommendationMarketScope
): RecommendationCandidateFeed {
  const snapshot = parseRecommendationSnapshot(value);
  if (snapshot.profile !== expectedProfile || snapshot.market_scope !== expectedMarketScope) {
    throw new RecommendationCandidateContractError(
      `expected ${expectedProfile}/${expectedMarketScope}, received ${snapshot.profile}/${snapshot.market_scope}`
    );
  }
  const candidates = snapshot.items.map(item =>
    candidateFromRecommendation(item.recommendation, snapshot)
  );
  return {
    snapshot,
    candidates,
    kpi: {
      total: candidates.length,
      high_conviction: candidates.filter(candidate => candidate.conviction?.level === 'HIGH')
        .length,
      avg_score:
        candidates.length === 0
          ? 0
          : candidates.reduce((sum, candidate) => sum + (candidate.score?.total ?? 0), 0) /
            candidates.length,
      updated_at: snapshot.as_of,
    },
  };
}

export function recommendationLatestUrl(
  profile: RecommendationProfile,
  marketScope: RecommendationMarketScope
): string {
  return `/api/v1/ai/recommendations/latest?profile=${encodeURIComponent(
    profile
  )}&market_scope=${encodeURIComponent(marketScope)}`;
}

/**
 * Authenticated, fail-closed boundary for the recommendation latest endpoint.
 * Absence and service availability are explicit data states. Every successful
 * payload still crosses the strict Recommendation v0.3.1 parser before it can
 * become a candidate feed; no fallback or placeholder candidates are created.
 */
export async function loadRecommendationCandidateFeed(
  signal: AbortSignal,
  profile: RecommendationProfile,
  marketScope: RecommendationMarketScope,
  fetcher: RecommendationCandidateFetch = authenticatedFetch
): Promise<RecommendationCandidateLoadResult> {
  const response = await fetcher(recommendationLatestUrl(profile, marketScope), { signal });
  if (response.status === 404) return { kind: 'not_generated' };
  if (response.status === 503) return { kind: 'unavailable' };
  if (!response.ok) throw new RecommendationCandidateHttpError(response.status);
  return {
    kind: 'ready',
    feed: parseRecommendationCandidateFeed(
      (await response.json()) as unknown,
      profile,
      marketScope
    ),
  };
}
