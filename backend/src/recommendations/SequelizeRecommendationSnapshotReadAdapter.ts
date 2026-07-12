import { QueryTypes, Sequelize } from 'sequelize';
import {
  RECOMMENDATION_MARKET_SCOPES,
  RECOMMENDATION_PROFILES,
  RecommendationSnapshotConflictError,
  RecommendationSnapshotContractError,
  RecommendationSnapshotDiff,
  RecommendationSnapshotPage,
  RecommendationSnapshotReadPort,
  RecommendationSnapshotSummary,
  RecommendationSnapshotDetail,
  type RecommendationSnapshotDateQuery,
  type RecommendationSnapshotScope,
  isRecommendationScopeCompatible,
} from './RecommendationSnapshotReadPort';

type UnknownRecord = Record<string, unknown>;

function asObject(value: unknown, label: string): UnknownRecord {
  let parsed: unknown;
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_error) {
    throw new RecommendationSnapshotContractError(`${label} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RecommendationSnapshotContractError(`${label} must be an object`);
  }
  return parsed as UnknownRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RecommendationSnapshotContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function timestampString(value: unknown, label: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return requiredString(value, label);
}

function dateString(value: unknown, label: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return requiredString(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RecommendationSnapshotContractError(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function normalizeSummary(row: UnknownRecord): RecommendationSnapshotSummary {
  const profile = requiredString(row.profile, 'profile');
  const marketScope = requiredString(row.market_scope, 'market_scope');
  if (!RECOMMENDATION_PROFILES.includes(profile as RecommendationSnapshotSummary['profile'])) {
    throw new RecommendationSnapshotContractError('profile is not authorized');
  }
  if (
    !RECOMMENDATION_MARKET_SCOPES.includes(
      marketScope as RecommendationSnapshotSummary['market_scope']
    )
  ) {
    throw new RecommendationSnapshotContractError('market_scope is not authorized');
  }
  if (
    !isRecommendationScopeCompatible(
      profile as RecommendationSnapshotSummary['profile'],
      marketScope as RecommendationSnapshotSummary['market_scope']
    )
  ) {
    throw new RecommendationSnapshotContractError('profile/market_scope is incompatible');
  }
  return {
    snapshot_id: requiredString(row.snapshot_id, 'snapshot_id'),
    trading_day: dateString(row.trading_day, 'trading_day'),
    as_of: timestampString(row.as_of_utc, 'as_of_utc'),
    profile: profile as RecommendationSnapshotSummary['profile'],
    market_scope: marketScope as RecommendationSnapshotSummary['market_scope'],
    output_fingerprint: requiredString(row.output_fingerprint, 'output_fingerprint'),
    item_count: nonNegativeInteger(row.item_count, 'item_count'),
    created_at: timestampString(row.created_at, 'created_at'),
  };
}

function normalizeDetail(row: UnknownRecord): RecommendationSnapshotDetail {
  const envelope = asObject(row.envelope_json, 'envelope_json');
  const summary = normalizeSummary(row);
  if (
    envelope.snapshot_id !== summary.snapshot_id ||
    envelope.as_of !== summary.as_of ||
    envelope.profile !== summary.profile ||
    envelope.market_scope !== summary.market_scope ||
    envelope.output_fingerprint !== summary.output_fingerprint
  ) {
    throw new RecommendationSnapshotContractError('envelope_json does not match snapshot header');
  }
  if (!Array.isArray(envelope.items) || envelope.items.length !== summary.item_count) {
    throw new RecommendationSnapshotContractError('envelope_json item count does not match header');
  }
  const disclaimer = asObject(envelope.disclaimer, 'disclaimer');
  const meta = asObject(envelope.meta, 'meta');
  const language = requiredString(disclaimer.language, 'disclaimer.language');
  if (language !== 'zh-CN' && language !== 'en-US') {
    throw new RecommendationSnapshotContractError('disclaimer.language is not authorized');
  }
  const generationMs = Number(meta.generation_ms);
  if (!Number.isFinite(generationMs) || generationMs < 0) {
    throw new RecommendationSnapshotContractError('meta.generation_ms must be non-negative');
  }
  const items = envelope.items.map((value, index) => {
    const item = asObject(value, `items[${index}]`);
    const recommendation = asObject(item.recommendation, `items[${index}].recommendation`);
    const ratingBand = requiredString(item.rating_band, `items[${index}].rating_band`);
    if (!['A', 'B', 'C', 'D', 'F'].includes(ratingBand)) {
      throw new RecommendationSnapshotContractError(`items[${index}].rating_band is invalid`);
    }
    return {
      recommendation,
      rating_band: ratingBand as RecommendationSnapshotDetail['items'][number]['rating_band'],
    };
  });

  return {
    snapshot_id: summary.snapshot_id,
    as_of: summary.as_of,
    profile: summary.profile,
    market_scope: summary.market_scope,
    output_fingerprint: summary.output_fingerprint,
    disclaimer: {
      version: requiredString(disclaimer.version, 'disclaimer.version'),
      short_text: requiredString(disclaimer.short_text, 'disclaimer.short_text'),
      full_text: requiredString(disclaimer.full_text, 'disclaimer.full_text'),
      language,
      effective_at: requiredString(disclaimer.effective_at, 'disclaimer.effective_at'),
      hash: requiredString(disclaimer.hash, 'disclaimer.hash'),
    },
    meta: {
      strategy_version: requiredString(meta.strategy_version, 'meta.strategy_version'),
      pipeline_version: requiredString(meta.pipeline_version, 'meta.pipeline_version'),
      generated_by: requiredString(meta.generated_by, 'meta.generated_by'),
      generation_ms: generationMs,
    },
    items,
  };
}

function tickerSet(rows: UnknownRecord[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    result.set(
      requiredString(row.ticker, 'ticker'),
      requiredString(row.recommendation_hash, 'recommendation_hash')
    );
  }
  return result;
}

export class SequelizeRecommendationSnapshotReadAdapter implements RecommendationSnapshotReadPort {
  constructor(private readonly sequelize: Sequelize) {}

  async latest(scope: RecommendationSnapshotScope): Promise<RecommendationSnapshotDetail | null> {
    const rows = await this.sequelize.query<UnknownRecord>(
      `SELECT snapshot_id,
              trading_day,
              as_of_utc,
              profile,
              market_scope,
              output_fingerprint,
              item_count,
              envelope_json,
              created_at
       FROM ai_recommendation_snapshot
       WHERE profile = :profile
         AND market_scope = :market_scope
       ORDER BY as_of_utc DESC, created_at DESC, snapshot_id DESC
       LIMIT 2`,
      {
        replacements: {
          profile: scope.profile,
          market_scope: scope.market_scope,
        },
        type: QueryTypes.SELECT,
      }
    );
    if (rows.length > 1) {
      const [first, second] = rows;
      if (
        first &&
        second &&
        String(first.as_of_utc) === String(second.as_of_utc) &&
        String(first.created_at) === String(second.created_at)
      ) {
        throw new RecommendationSnapshotConflictError(
          'Latest recommendation snapshot is ambiguous'
        );
      }
    }
    return rows[0] ? normalizeDetail(rows[0]) : null;
  }

  async byDate(query: RecommendationSnapshotDateQuery): Promise<RecommendationSnapshotPage> {
    const offset = (query.page - 1) * query.page_size;
    const countRows = await this.sequelize.query<UnknownRecord>(
      `SELECT COUNT(*) AS total
       FROM ai_recommendation_snapshot
       WHERE trading_day = CAST(:trading_day AS date)
         AND profile = :profile
         AND market_scope = :market_scope`,
      {
        replacements: {
          trading_day: query.trading_day,
          profile: query.profile,
          market_scope: query.market_scope,
        },
        type: QueryTypes.SELECT,
      }
    );
    const rows = await this.sequelize.query<UnknownRecord>(
      `SELECT snapshot_id,
              trading_day,
              as_of_utc,
              profile,
              market_scope,
              output_fingerprint,
              item_count,
              created_at
       FROM ai_recommendation_snapshot
       WHERE trading_day = CAST(:trading_day AS date)
         AND profile = :profile
         AND market_scope = :market_scope
       ORDER BY as_of_utc DESC, created_at DESC, snapshot_id DESC
       LIMIT :page_size OFFSET :offset`,
      {
        replacements: { ...query, offset },
        type: QueryTypes.SELECT,
      }
    );
    return {
      entries: rows.map(normalizeSummary),
      total: nonNegativeInteger(countRows[0]?.total ?? 0, 'total'),
      page: query.page,
      page_size: query.page_size,
    };
  }

  async detail(snapshotId: string): Promise<RecommendationSnapshotDetail | null> {
    const rows = await this.sequelize.query<UnknownRecord>(
      `SELECT snapshot_id,
              trading_day,
              as_of_utc,
              profile,
              market_scope,
              output_fingerprint,
              item_count,
              envelope_json,
              created_at
       FROM ai_recommendation_snapshot
       WHERE snapshot_id = CAST(:snapshot_id AS uuid)
       LIMIT 2`,
      {
        replacements: { snapshot_id: snapshotId },
        type: QueryTypes.SELECT,
      }
    );
    if (rows.length > 1) {
      throw new RecommendationSnapshotConflictError(
        'Recommendation snapshot identity is ambiguous'
      );
    }
    return rows.length ? normalizeDetail(rows[0]) : null;
  }

  async diff(
    baseSnapshotId: string,
    targetSnapshotId: string
  ): Promise<RecommendationSnapshotDiff> {
    const [base, target] = await Promise.all([
      this.detail(baseSnapshotId),
      this.detail(targetSnapshotId),
    ]);
    if (!base || !target) {
      throw new RecommendationSnapshotContractError('Both snapshots are required for diff');
    }
    if (base.profile !== target.profile || base.market_scope !== target.market_scope) {
      throw new RecommendationSnapshotConflictError('Snapshot diff profile/market_scope mismatch');
    }
    const itemRows = await this.sequelize.query<UnknownRecord>(
      `SELECT snapshot_id, ticker, recommendation_hash
       FROM ai_recommendation_item
       WHERE snapshot_id IN (CAST(:base_snapshot_id AS uuid), CAST(:target_snapshot_id AS uuid))
       ORDER BY snapshot_id ASC, ticker ASC`,
      {
        replacements: {
          base_snapshot_id: baseSnapshotId,
          target_snapshot_id: targetSnapshotId,
        },
        type: QueryTypes.SELECT,
      }
    );
    const baseItems = tickerSet(itemRows.filter(row => row.snapshot_id === baseSnapshotId));
    const targetItems = tickerSet(itemRows.filter(row => row.snapshot_id === targetSnapshotId));
    const allTickers = [...new Set([...baseItems.keys(), ...targetItems.keys()])].sort();
    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];
    for (const ticker of allTickers) {
      if (!baseItems.has(ticker)) added.push(ticker);
      else if (!targetItems.has(ticker)) removed.push(ticker);
      else if (baseItems.get(ticker) !== targetItems.get(ticker)) changed.push(ticker);
      else unchanged.push(ticker);
    }
    return {
      base_snapshot_id: baseSnapshotId,
      target_snapshot_id: targetSnapshotId,
      profile: base.profile,
      market_scope: base.market_scope,
      fingerprint_match: base.output_fingerprint === target.output_fingerprint,
      added,
      removed,
      changed,
      unchanged,
    };
  }
}
