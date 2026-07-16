import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { authenticatedFetch } from 'services/api';
import type { JpKrMarket, JpKrMarketResponse, JpKrMarketRow } from './types';
import { parseJpKrDetailResponse, parseJpKrMarketResponse } from './jpkrAdapters';
import {
  parseRecommendationCandidateFeed,
  recommendationLatestUrl,
} from '../recommendationCandidates';
import type { RecommendationCandidateFeed } from '../recommendationCandidates';
import type { JpKrRecommendationStatus } from './types';

function recommendationProfile(market: JpKrMarket): JpKrRecommendationStatus['profile'] {
  return market === 'JP' ? 'japan_blue_chip' : 'korea_semiconductor_chain';
}

async function fetchRecommendations(
  signal: AbortSignal,
  market: JpKrMarket
): Promise<{
  status: JpKrRecommendationStatus;
  feed: RecommendationCandidateFeed | null;
}> {
  const profile = recommendationProfile(market);
  const marketScope = market === 'JP' ? 'jp' : 'kr';
  const response = await authenticatedFetch(recommendationLatestUrl(profile, marketScope), {
    signal,
  });
  if (response.status === 404) {
    return { status: { kind: 'not_generated', profile }, feed: null };
  }
  if (response.status === 503) {
    return { status: { kind: 'unavailable', profile }, feed: null };
  }
  if (!response.ok) throw new Error(`jpkr-recommendation ${response.status}`);
  return {
    status: { kind: 'ready', profile },
    feed: parseRecommendationCandidateFeed(
      (await response.json()) as unknown,
      profile,
      marketScope
    ),
  };
}

async function fetchJpKrMarket(
  signal: AbortSignal,
  date: string,
  market: JpKrMarket
): Promise<JpKrMarketResponse> {
  const [marketResponse, recommendations] = await Promise.all([
    authenticatedFetch(
      `/api/v1/jpkr-market/${encodeURIComponent(date)}?market=${encodeURIComponent(market)}`,
      { signal }
    ),
    fetchRecommendations(signal, market),
  ]);
  if (!marketResponse.ok) throw new Error(`jpkr-market ${marketResponse.status}`);
  const payload: unknown = await marketResponse.json();
  const parsed = parseJpKrMarketResponse(payload, date, market);
  const byTicker = new Map(
    (recommendations.feed?.candidates ?? []).map(candidate => [candidate.symbol, candidate])
  );
  return {
    ...parsed,
    rows: parsed.rows.map(row => ({
      ...row,
      ...(byTicker.has(row.symbol) ? { recommendation: byTicker.get(row.symbol) } : {}),
    })),
    recommendation_status: recommendations.status,
  };
}

async function fetchJpKrDetail(
  signal: AbortSignal,
  symbol: string,
  date: string
): Promise<JpKrMarketRow> {
  const res = await authenticatedFetch(
    `/api/v1/jpkr-market/${encodeURIComponent(symbol)}/detail?date=${encodeURIComponent(date)}`,
    { signal }
  );
  if (!res.ok) throw new Error(`jpkr-detail ${res.status}`);
  const payload: unknown = await res.json();
  return parseJpKrDetailResponse(payload, symbol);
}

export function useJpKrMarketData(date: string, market: JpKrMarket) {
  return useAbortableRequest(signal => fetchJpKrMarket(signal, date, market), [date, market]);
}

export function useJpKrDetail(symbol: string | null, date: string) {
  return useAbortableRequest(
    signal => {
      if (!symbol) return Promise.resolve(null);
      return fetchJpKrDetail(signal, symbol, date);
    },
    [symbol, date]
  );
}
