import { parseB5DailyReport, parseB5ReportHistory } from './b5ProjectionAdapter';
import {
  canonicalizeRecommendationFingerprintPreimage,
  parseRecommendationSnapshot,
  RecommendationContractError,
} from './recommendationAdapter';
import { jcsCanonicalize, sha256Text } from './contractSchema';
import { parseGenerationJob } from './generationMachine';
import { authenticatedFetch } from 'services/api';
import {
  RECOMMENDATION_PROFILE_SCOPES,
  type DailyReportDocument,
  type GenerationJob,
  type RecommendationMarketScope,
  type RecommendationProfile,
  type RecommendationSnapshot,
} from './types';
import type { ReportHistoryPage, ReportHistoryQuery, SnapshotDiff } from '../report-history/types';

export interface ReplayRequest {
  trading_day: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
}

export interface Tab67Api {
  latest(
    profile: RecommendationProfile,
    marketScope: RecommendationMarketScope,
    signal: AbortSignal
  ): Promise<DailyReportDocument>;
  daily(
    tradingDay: string,
    profile: RecommendationProfile,
    marketScope: RecommendationMarketScope,
    signal: AbortSignal
  ): Promise<DailyReportDocument>;
  history(query: ReportHistoryQuery, signal: AbortSignal): Promise<ReportHistoryPage>;
  snapshot(snapshotId: string, signal: AbortSignal): Promise<RecommendationSnapshot>;
  diff(
    baseSnapshotId: string,
    targetSnapshotId: string,
    signal: AbortSignal
  ): Promise<SnapshotDiff>;
  submitReplay(request: ReplayRequest, signal: AbortSignal): Promise<GenerationJob>;
  replayStatus(jobId: string, signal: AbortSignal): Promise<GenerationJob>;
}

export class Tab67ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'Tab67ApiError';
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function assertScope(profile: RecommendationProfile, marketScope: RecommendationMarketScope): void {
  if (!RECOMMENDATION_PROFILE_SCOPES[profile].includes(marketScope)) {
    throw new RecommendationContractError(
      `profile "${profile}" is incompatible with market_scope "${marketScope}"`
    );
  }
}

function assertDay(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RecommendationContractError(`${label} must be YYYY-MM-DD`);
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID_V4.test(value)) {
    throw new RecommendationContractError(`${label} must be UUIDv4`);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `${response.status} ${response.statusText}`;
    throw new Tab67ApiError(response.status, message);
  }
  return payload;
}

function scopeParams(
  profile: RecommendationProfile,
  marketScope: RecommendationMarketScope
): URLSearchParams {
  assertScope(profile, marketScope);
  return new URLSearchParams({ profile, market_scope: marketScope });
}

function parseDiff(value: unknown): SnapshotDiff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecommendationContractError('snapshot diff must be an object');
  }
  const raw = value as Record<string, unknown>;
  const exactKeys = [
    'base_snapshot_id',
    'target_snapshot_id',
    'profile',
    'market_scope',
    'fingerprint_match',
    'added',
    'removed',
    'changed',
    'unchanged',
  ];
  if (
    Object.keys(raw).length !== exactKeys.length ||
    exactKeys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))
  ) {
    throw new RecommendationContractError('snapshot diff has missing or unknown fields');
  }
  const base = String(raw.base_snapshot_id);
  const target = String(raw.target_snapshot_id);
  assertUuid(base, 'base_snapshot_id');
  assertUuid(target, 'target_snapshot_id');
  const profile = raw.profile as RecommendationProfile;
  const marketScope = raw.market_scope as RecommendationMarketScope;
  assertScope(profile, marketScope);
  if (typeof raw.fingerprint_match !== 'boolean') {
    throw new RecommendationContractError('fingerprint_match must be boolean');
  }
  const parseStrings = (key: 'added' | 'removed' | 'changed' | 'unchanged') => {
    const values = raw[key];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
      throw new RecommendationContractError(`${key} must be a string array`);
    }
    return values as string[];
  };
  return {
    base_snapshot_id: base,
    target_snapshot_id: target,
    profile,
    market_scope: marketScope,
    fingerprint_match: raw.fingerprint_match,
    added: parseStrings('added'),
    removed: parseStrings('removed'),
    changed: parseStrings('changed'),
    unchanged: parseStrings('unchanged'),
  };
}

function parseSnapshotDetail(value: unknown): RecommendationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecommendationContractError('snapshot detail must be an object');
  }
  const raw = value as Record<string, unknown>;
  const exactKeys = [
    'snapshot_id',
    'as_of',
    'profile',
    'market_scope',
    'output_fingerprint',
    'fingerprint_preimage_jcs',
    'disclaimer',
    'meta',
    'items',
  ];
  if (
    Object.keys(raw).length !== exactKeys.length ||
    exactKeys.some(key => !Object.prototype.hasOwnProperty.call(raw, key))
  ) {
    throw new RecommendationContractError('snapshot detail has missing or unknown fields');
  }
  if (typeof raw.fingerprint_preimage_jcs !== 'string') {
    throw new RecommendationContractError('fingerprint_preimage_jcs must be a string');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw.fingerprint_preimage_jcs);
  } catch (_error) {
    throw new RecommendationContractError('fingerprint_preimage_jcs must be JSON');
  }
  if (jcsCanonicalize(decoded) !== raw.fingerprint_preimage_jcs) {
    throw new RecommendationContractError('fingerprint_preimage_jcs must be canonical JCS');
  }
  if (
    typeof raw.output_fingerprint !== 'string' ||
    sha256Text(raw.fingerprint_preimage_jcs) !== raw.output_fingerprint
  ) {
    throw new RecommendationContractError('snapshot detail fingerprint mismatch');
  }
  const envelope = {
    snapshot_id: raw.snapshot_id,
    as_of: raw.as_of,
    profile: raw.profile,
    market_scope: raw.market_scope,
    output_fingerprint: raw.output_fingerprint,
    disclaimer: raw.disclaimer,
    meta: raw.meta,
    items: raw.items,
  };
  if (canonicalizeRecommendationFingerprintPreimage(envelope) !== raw.fingerprint_preimage_jcs) {
    throw new RecommendationContractError('snapshot detail preimage does not match envelope');
  }
  return parseRecommendationSnapshot(envelope);
}

export function createTab67HttpApi(fetcher: FetchLike = authenticatedFetch): Tab67Api {
  const get = async (url: string, signal: AbortSignal) =>
    responseJson(await fetcher(url, { method: 'GET', signal }));

  return {
    async latest(profile, marketScope, signal) {
      const params = scopeParams(profile, marketScope);
      return parseB5DailyReport(
        await get(`/api/v1/daily-report/latest?${params.toString()}`, signal)
      );
    },

    async daily(tradingDay, profile, marketScope, signal) {
      assertDay(tradingDay, 'trading_day');
      const params = scopeParams(profile, marketScope);
      return parseB5DailyReport(
        await get(
          `/api/v1/daily-report/${encodeURIComponent(tradingDay)}?${params.toString()}`,
          signal
        )
      );
    },

    async history(query, signal) {
      const params = new URLSearchParams();
      if (query.profile) params.set('profile', query.profile);
      if (query.market_scope) params.set('market_scope', query.market_scope);
      if (query.profile && query.market_scope) assertScope(query.profile, query.market_scope);
      if (query.search) params.set('query', query.search);
      if (query.date) {
        assertDay(query.date, 'date');
        params.set('from_day', query.date);
        params.set('to_day', query.date);
      }
      return parseB5ReportHistory(
        await get(`/api/v1/daily-report/history?${params.toString()}`, signal),
        query.page,
        query.page_size
      );
    },

    async snapshot(snapshotId, signal) {
      assertUuid(snapshotId, 'snapshot_id');
      return parseSnapshotDetail(
        await get(`/api/v1/ai/recommendations/${encodeURIComponent(snapshotId)}`, signal)
      );
    },

    async diff(baseSnapshotId, targetSnapshotId, signal) {
      assertUuid(baseSnapshotId, 'base_snapshot_id');
      assertUuid(targetSnapshotId, 'target_snapshot_id');
      return parseDiff(
        await get(
          `/api/v1/ai/recommendations/${encodeURIComponent(
            baseSnapshotId
          )}/diff/${encodeURIComponent(targetSnapshotId)}`,
          signal
        )
      );
    },

    async submitReplay(request, signal) {
      assertDay(request.trading_day, 'trading_day');
      assertScope(request.profile, request.market_scope);
      const response = await fetcher('/api/v1/ai/recommendations/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      return parseGenerationJob(await responseJson(response));
    },

    async replayStatus(jobId, signal) {
      assertUuid(jobId, 'job_id');
      const params = new URLSearchParams({ job_id: jobId });
      return parseGenerationJob(
        await get(`/api/v1/ai/recommendations/status?${params.toString()}`, signal)
      );
    },
  };
}

export function isFingerprint(value: string): boolean {
  return SHA256.test(value);
}
