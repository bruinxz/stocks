import {
  RECOMMENDATION_MARKET_SCOPES,
  RECOMMENDATION_PROFILES,
  RECOMMENDATION_PROFILE_SCOPES,
  type RecommendationMarketScope,
  type RecommendationProfile,
} from '../daily-report/types';
import type { ReportHistoryQuery } from './types';

export function parseHistoryQuery(search: string): ReportHistoryQuery {
  const params = new URLSearchParams(search);
  const profile = params.get('profile');
  const scope = params.get('market_scope');
  const parsedProfile = RECOMMENDATION_PROFILES.includes(profile as RecommendationProfile)
    ? (profile as RecommendationProfile)
    : undefined;
  const parsedScope = RECOMMENDATION_MARKET_SCOPES.includes(scope as RecommendationMarketScope)
    ? (scope as RecommendationMarketScope)
    : undefined;
  if (
    parsedProfile &&
    parsedScope &&
    !RECOMMENDATION_PROFILE_SCOPES[parsedProfile].includes(parsedScope)
  ) {
    throw new Error('History profile/market_scope is incompatible');
  }
  return {
    date: params.get('date') || undefined,
    profile: parsedProfile,
    market_scope: parsedScope,
    search: params.get('search') || undefined,
    page: Math.max(1, Number(params.get('page')) || 1),
    page_size: Math.min(100, Math.max(1, Number(params.get('page_size')) || 20)),
  };
}

export function mergeHistoryQuery(search: string, patch: Partial<ReportHistoryQuery>): string {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}
