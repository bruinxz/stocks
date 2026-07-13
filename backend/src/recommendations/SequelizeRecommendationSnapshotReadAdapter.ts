import { QueryTypes, Sequelize } from 'sequelize';
import { createHash } from 'crypto';
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

function sha256(value: unknown, label: string): string {
  const digest = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new RecommendationSnapshotContractError(`${label} must be lowercase SHA-256`);
  }
  return digest;
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RecommendationSnapshotContractError('JCS values must be finite');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`;
  if (typeof value === 'object' && value) {
    const record = value as UnknownRecord;
    return `{${Object.keys(record)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(',')}}`;
  }
  throw new RecommendationSnapshotContractError('JCS values must be JSON serializable');
}

function utf16SortKey(value: string): number[] {
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    result.push(value.charCodeAt(index));
  }
  return result;
}

function compareUtf16(left: string, right: string): number {
  const leftKey = utf16SortKey(left);
  const rightKey = utf16SortKey(right);
  const length = Math.min(leftKey.length, rightKey.length);
  for (let index = 0; index < length; index += 1) {
    const delta = leftKey[index] - rightKey[index];
    if (delta !== 0) return delta;
  }
  return leftKey.length - rightKey.length;
}

function semanticFingerprintPreimage(envelope: UnknownRecord): string {
  const semantic = JSON.parse(JSON.stringify(envelope)) as UnknownRecord;
  delete semantic.output_fingerprint;
  delete semantic.snapshot_id;
  const meta = asObject(semantic.meta, 'meta');
  delete meta.generated_by;
  delete meta.generation_ms;
  if (!Array.isArray(semantic.items)) {
    throw new RecommendationSnapshotContractError('items must be an array');
  }
  for (const value of semantic.items) {
    const item = asObject(value, 'item');
    const recommendation = asObject(item.recommendation, 'recommendation');
    delete recommendation.id;
    delete recommendation.snapshot_id;
  }
  return canonicalizeJsonWithKeySort(semantic);
}

function canonicalizeJsonWithKeySort(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RecommendationSnapshotContractError('JCS values must be finite');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalizeJsonWithKeySort).join(',')}]`;
  if (typeof value === 'object' && value) {
    const record = value as UnknownRecord;
    return `{${Object.keys(record)
      .sort(compareUtf16)
      .map(key => `${JSON.stringify(key)}:${canonicalizeJsonWithKeySort(record[key])}`)
      .join(',')}}`;
  }
  throw new RecommendationSnapshotContractError('JCS values must be JSON serializable');
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
    output_fingerprint: sha256(row.output_fingerprint, 'output_fingerprint'),
    item_count: nonNegativeInteger(row.item_count, 'item_count'),
    created_at: timestampString(row.created_at, 'created_at'),
  };
}

function normalizeDetail(
  row: UnknownRecord,
  itemRows: UnknownRecord[]
): RecommendationSnapshotDetail {
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
  const contractVersion = requiredString(row.contract_version, 'contract_version');
  const profileVersion = requiredString(row.profile_version, 'profile_version');
  const inputFingerprint = sha256(row.input_fingerprint, 'input_fingerprint');
  const headerDisclaimerHash = sha256(row.disclaimer_hash, 'disclaimer_hash');
  const fingerprintPreimageJcs = requiredString(
    row.fingerprint_preimage_jcs,
    'fingerprint_preimage_jcs'
  );
  const disclaimer = asObject(envelope.disclaimer, 'disclaimer');
  const meta = asObject(envelope.meta, 'meta');
  const language = requiredString(disclaimer.language, 'disclaimer.language');
  if (!['zh-CN', 'en-US', 'ja-JP', 'ko-KR'].includes(language)) {
    throw new RecommendationSnapshotContractError('disclaimer.language is not authorized');
  }
  const disclaimerFullText = requiredString(disclaimer.full_text, 'disclaimer.full_text');
  const disclaimerHash = sha256(disclaimer.hash, 'disclaimer.hash');
  if (disclaimerHash !== headerDisclaimerHash) {
    throw new RecommendationSnapshotContractError(
      'envelope disclaimer.hash does not match snapshot header'
    );
  }
  if (sha256Text(disclaimerFullText) !== disclaimerHash) {
    throw new RecommendationSnapshotContractError('disclaimer.hash does not match full_text');
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
  if (contractVersion !== '0.3.1' || meta.contract_version !== contractVersion) {
    throw new RecommendationSnapshotContractError(
      'meta.contract_version does not match snapshot header'
    );
  }
  if (meta.profile_version !== profileVersion) {
    throw new RecommendationSnapshotContractError(
      'meta.profile_version does not match snapshot header'
    );
  }
  if (meta.input_fingerprint !== inputFingerprint) {
    throw new RecommendationSnapshotContractError(
      'meta.input_fingerprint does not match snapshot header'
    );
  }
  if (itemRows.length !== summary.item_count) {
    throw new RecommendationSnapshotContractError(
      'physical item count does not match snapshot header'
    );
  }
  itemRows.forEach((itemRow, index) => {
    if (nonNegativeInteger(itemRow.sort_rank, `item_rows[${index}].sort_rank`) !== index) {
      throw new RecommendationSnapshotContractError('physical item ranks must be contiguous');
    }
    const itemId = requiredString(itemRow.item_id, `item_rows[${index}].item_id`);
    const ticker = requiredString(itemRow.ticker, `item_rows[${index}].ticker`);
    const recommendationJcs = requiredString(
      itemRow.recommendation_jcs,
      `item_rows[${index}].recommendation_jcs`
    );
    const recommendationHash = sha256(
      itemRow.recommendation_hash,
      `item_rows[${index}].recommendation_hash`
    );
    if (sha256Text(recommendationJcs) !== recommendationHash) {
      throw new RecommendationSnapshotContractError(
        `item_rows[${index}].recommendation_hash does not authenticate JCS`
      );
    }
    const recommendation = asObject(
      itemRow.recommendation_json,
      `item_rows[${index}].recommendation_json`
    );
    const parsedJcs = asObject(recommendationJcs, `item_rows[${index}].recommendation_jcs`);
    if (canonicalizeJson(recommendation) !== canonicalizeJson(parsedJcs)) {
      throw new RecommendationSnapshotContractError(
        `item_rows[${index}] JCS/JSON semantic mismatch`
      );
    }
    if (recommendation.id !== itemId || recommendation.ticker !== ticker) {
      throw new RecommendationSnapshotContractError(
        `item_rows[${index}] identity does not match recommendation`
      );
    }
    const ratingBand = requiredString(itemRow.rating_band, `item_rows[${index}].rating_band`);
    const expectedEnvelopeItem = { recommendation, rating_band: ratingBand };
    if (canonicalizeJson(items[index]) !== canonicalizeJson(expectedEnvelopeItem)) {
      throw new RecommendationSnapshotContractError(
        `item_rows[${index}] does not match envelope item`
      );
    }
  });
  if (sha256Text(fingerprintPreimageJcs) !== summary.output_fingerprint) {
    throw new RecommendationSnapshotContractError(
      'output_fingerprint does not authenticate fingerprint preimage JCS'
    );
  }
  if (semanticFingerprintPreimage(envelope) !== fingerprintPreimageJcs) {
    throw new RecommendationSnapshotContractError(
      'fingerprint preimage JCS does not match semantic envelope'
    );
  }

  return {
    snapshot_id: summary.snapshot_id,
    as_of: summary.as_of,
    profile: summary.profile,
    market_scope: summary.market_scope,
    output_fingerprint: summary.output_fingerprint,
    fingerprint_preimage_jcs: fingerprintPreimageJcs,
    disclaimer: {
      version: requiredString(disclaimer.version, 'disclaimer.version'),
      short_text: requiredString(disclaimer.short_text, 'disclaimer.short_text'),
      full_text: disclaimerFullText,
      language: language as RecommendationSnapshotDetail['disclaimer']['language'],
      effective_at: requiredString(disclaimer.effective_at, 'disclaimer.effective_at'),
      hash: disclaimerHash,
    },
    meta: {
      contract_version: (() => {
        const value = requiredString(meta.contract_version, 'meta.contract_version');
        if (value !== '0.3.1') {
          throw new RecommendationSnapshotContractError('meta.contract_version must equal 0.3.1');
        }
        return '0.3.1' as const;
      })(),
      profile_version: profileVersion,
      input_fingerprint: inputFingerprint,
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
      sha256(row.recommendation_hash, 'recommendation_hash')
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
              contract_version,
              profile_version,
              input_fingerprint,
              disclaimer_hash,
              fingerprint_preimage_jcs,
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
    return rows[0] ? this.hydrateDetail(rows[0]) : null;
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
              contract_version,
              profile_version,
              input_fingerprint,
              disclaimer_hash,
              fingerprint_preimage_jcs,
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
              contract_version,
              profile_version,
              input_fingerprint,
              disclaimer_hash,
              fingerprint_preimage_jcs,
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
    return rows[0] ? this.hydrateDetail(rows[0]) : null;
  }

  async diff(
    baseSnapshotId: string,
    targetSnapshotId: string
  ): Promise<RecommendationSnapshotDiff> {
    const base = await this.detail(baseSnapshotId);
    const target = await this.detail(targetSnapshotId);
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

  private async hydrateDetail(row: UnknownRecord): Promise<RecommendationSnapshotDetail> {
    const snapshotId = requiredString(row.snapshot_id, 'snapshot_id');
    const itemRows = await this.sequelize.query<UnknownRecord>(
      `SELECT item_id,
              ticker,
              sort_rank,
              recommendation_json,
              recommendation_jcs,
              recommendation_hash,
              rating_band
       FROM ai_recommendation_item
       WHERE snapshot_id = CAST(:snapshot_id AS uuid)
       ORDER BY sort_rank ASC`,
      {
        replacements: { snapshot_id: snapshotId },
        type: QueryTypes.SELECT,
      }
    );
    return normalizeDetail(row, itemRows);
  }
}
