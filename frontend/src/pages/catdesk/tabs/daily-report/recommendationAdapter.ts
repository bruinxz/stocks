import {
  RECOMMENDATION_MARKET_SCOPES,
  RECOMMENDATION_PROFILES,
  RECOMMENDATION_PROFILE_SCOPES,
  type RatingBand,
  type RecommendationEntry,
  type RecommendationLocale,
  type RecommendationMarketScope,
  type RecommendationProfile,
  type RecommendationSnapshot,
} from './types';

type UnknownRecord = Record<string, unknown>;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCALES = new Set<RecommendationLocale>(['zh-CN', 'en-US', 'ja-JP', 'ko-KR']);
const BANDS = new Set<RatingBand>(['A', 'B', 'C', 'D', 'F']);
const PROFILE_LOCALES: Record<RecommendationProfile, readonly RecommendationLocale[]> = {
  us_preferred: ['zh-CN', 'en-US'],
  multibagger: ['zh-CN', 'en-US'],
  japan_blue_chip: ['ja-JP'],
  japan_multibagger: ['ja-JP'],
  korea_semiconductor_chain: ['ko-KR'],
  korea_multibagger: ['ko-KR'],
};
const SIZE_HINT_PCT = {
  TIER_5: 5,
  TIER_3: 3,
  TIER_2: 2,
  TIER_1: 1,
  SKIP: 0,
} as const;
const EVIDENCE_KINDS = new Set([
  'CATALYST_EVENT',
  'SCORE_INPUT',
  'PRICE_TICK',
  'DISCLOSURE',
  'RULE',
  'MODEL_OUTPUT',
  'NEWS',
]);
const EVIDENCE_SCHEMES = [
  'sec-edgar://',
  'nasdaq://',
  'fda-rss://',
  'baostock://',
  'akshare://',
  'jpx-edinet://',
  'krx://',
  'dart://',
  'catalyst-event://',
  'ai-rule://',
  'ai-model://',
  'news://',
] as const;
const DIM_KEYS = ['Q', 'G', 'V', 'M', 'T', 'R'] as const;

export class RecommendationContractError extends Error {
  constructor(message: string) {
    super(`Recommendation v0.3.1 contract error: ${message}`);
    this.name = 'RecommendationContractError';
  }
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecommendationContractError(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RecommendationContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!UUID_V4.test(parsed)) throw new RecommendationContractError(`${label} must be UUIDv4`);
  return parsed;
}

function hash(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!SHA256.test(parsed)) {
    throw new RecommendationContractError(`${label} must be a lowercase SHA-256`);
  }
  return parsed;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RecommendationContractError(`${label} must be finite`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RecommendationContractError(`${label} must be boolean`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new RecommendationContractError(`${label} must be a string array`);
  }
  return value as string[];
}

function rejectUnknownKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) {
    throw new RecommendationContractError(
      `${label} contains unknown fields: ${unknown.join(', ')}`
    );
  }
}

function parseProfile(value: unknown): RecommendationProfile {
  if (
    typeof value !== 'string' ||
    !RECOMMENDATION_PROFILES.includes(value as RecommendationProfile)
  ) {
    throw new RecommendationContractError('profile is not authorized');
  }
  return value as RecommendationProfile;
}

function parseScope(value: unknown): RecommendationMarketScope {
  if (
    typeof value !== 'string' ||
    !RECOMMENDATION_MARKET_SCOPES.includes(value as RecommendationMarketScope)
  ) {
    throw new RecommendationContractError('market_scope is not authorized');
  }
  return value as RecommendationMarketScope;
}

function parseLocale(value: unknown, label: string): RecommendationLocale {
  if (typeof value !== 'string' || !LOCALES.has(value as RecommendationLocale)) {
    throw new RecommendationContractError(`${label} is not authorized`);
  }
  return value as RecommendationLocale;
}

function parseBand(value: unknown, label: string): RatingBand {
  if (typeof value !== 'string' || !BANDS.has(value as RatingBand)) {
    throw new RecommendationContractError(`${label} is invalid`);
  }
  return value as RatingBand;
}

function parseRecommendation(
  value: unknown,
  snapshotId: string,
  profile: RecommendationProfile,
  marketScope: RecommendationMarketScope,
  disclaimerVersion: string,
  index: number
): RecommendationEntry {
  const item = record(value, `items[${index}].recommendation`);
  if (uuid(item.snapshot_id, `items[${index}].recommendation.snapshot_id`) !== snapshotId) {
    throw new RecommendationContractError(`items[${index}] snapshot_id mismatch`);
  }

  const score = record(item.score, `items[${index}].recommendation.score`);
  if (score.profile !== profile || score.market_scope !== marketScope) {
    throw new RecommendationContractError(`items[${index}] score scope mismatch`);
  }
  const rating = parseBand(score.rating, `items[${index}].recommendation.score.rating`);
  const scoringId = uuid(score.scoring_id, `items[${index}].recommendation.score.scoring_id`);
  const snapshotHash = hash(
    score.snapshot_hash,
    `items[${index}].recommendation.score.snapshot_hash`
  );
  if (!Array.isArray(score.dims) || score.dims.length !== DIM_KEYS.length) {
    throw new RecommendationContractError(`items[${index}] score dims must contain six rows`);
  }
  const dims = score.dims.map((value, dimIndex) => {
    const dim = record(value, `items[${index}].score.dims[${dimIndex}]`);
    if (dim.key !== DIM_KEYS[dimIndex]) {
      throw new RecommendationContractError(`items[${index}] score dims order is invalid`);
    }
    return {
      key: DIM_KEYS[dimIndex],
      score: number(dim.score, `items[${index}].score.dims[${dimIndex}].score`),
      band: parseBand(dim.band, `items[${index}].score.dims[${dimIndex}].band`),
      weight: number(dim.weight, `items[${index}].score.dims[${dimIndex}].weight`),
    };
  });
  const weightSum = dims.reduce((sum, dim) => sum + dim.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new RecommendationContractError(`items[${index}] score dim weights must sum to 1`);
  }
  const conviction = record(item.conviction, `items[${index}].recommendation.conviction`);
  const convictionLevel = string(
    conviction.level,
    `items[${index}].recommendation.conviction.level`
  );
  if (!['HIGH', 'MED', 'LOW'].includes(convictionLevel)) {
    throw new RecommendationContractError(`items[${index}] conviction level is invalid`);
  }
  const riskGate = record(item.risk_gate, `items[${index}].recommendation.risk_gate`);
  const gate = string(riskGate.gate, `items[${index}].recommendation.risk_gate.gate`);
  if (!['GREEN', 'YELLOW', 'RED'].includes(gate)) {
    throw new RecommendationContractError(`items[${index}] risk gate is invalid`);
  }
  if (!boolean(riskGate.ok_to_enter, `items[${index}].risk_gate.ok_to_enter`)) {
    throw new RecommendationContractError(`items[${index}] risk gate blocks entry`);
  }
  const entryPlan = record(item.entry_plan, `items[${index}].recommendation.entry_plan`);
  const sizeHint = record(
    entryPlan.size_hint,
    `items[${index}].recommendation.entry_plan.size_hint`
  );
  const sizeTier = string(sizeHint.tier, `items[${index}].size_hint.tier`);
  if (!(sizeTier in SIZE_HINT_PCT)) {
    throw new RecommendationContractError(`items[${index}] size_hint tier is invalid`);
  }
  const sizePct = number(sizeHint.pct, `items[${index}].size_hint.pct`);
  if (sizePct !== SIZE_HINT_PCT[sizeTier as keyof typeof SIZE_HINT_PCT]) {
    throw new RecommendationContractError(`items[${index}] size_hint pct mismatch`);
  }
  if (sizeHint.disclaimer_key !== 'size_hint_advisory') {
    throw new RecommendationContractError(`items[${index}] size_hint disclaimer key is invalid`);
  }
  const explanation = record(item.explanation, `items[${index}].recommendation.explanation`);
  const explanationLanguage = parseLocale(
    explanation.language,
    `items[${index}].explanation.language`
  );
  if (!PROFILE_LOCALES[profile].includes(explanationLanguage)) {
    throw new RecommendationContractError(`items[${index}] explanation locale is incompatible`);
  }
  const evidence = item.evidence_refs;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new RecommendationContractError(`items[${index}].recommendation.evidence_refs is empty`);
  }
  const evidenceRefs = evidence.map((source, evidenceIndex) => {
    const ref = record(source, `items[${index}].evidence_refs[${evidenceIndex}]`);
    const kind = string(ref.kind, `items[${index}].evidence_refs[${evidenceIndex}].kind`);
    if (!EVIDENCE_KINDS.has(kind)) {
      throw new RecommendationContractError(`items[${index}] evidence kind is invalid`);
    }
    const sourceUri = string(
      ref.source_uri,
      `items[${index}].evidence_refs[${evidenceIndex}].source_uri`
    );
    if (!EVIDENCE_SCHEMES.some(scheme => sourceUri.startsWith(scheme))) {
      throw new RecommendationContractError(`items[${index}] evidence URI is not canonical`);
    }
    return {
      id: string(ref.id, `items[${index}].evidence_refs[${evidenceIndex}].id`),
      kind: kind as RecommendationEntry['evidence_refs'][number]['kind'],
      source_uri: sourceUri,
      as_of: string(ref.as_of, `items[${index}].evidence_refs[${evidenceIndex}].as_of`),
      hash: hash(ref.hash, `items[${index}].evidence_refs[${evidenceIndex}].hash`),
      short_text: typeof ref.short_text === 'string' ? ref.short_text : undefined,
    };
  });
  if (!Array.isArray(item.trigger_signals) || item.trigger_signals.length === 0) {
    throw new RecommendationContractError(`items[${index}].trigger_signals is empty`);
  }
  if (string(item.disclaimer_version, `items[${index}].disclaimer_version`) !== disclaimerVersion) {
    throw new RecommendationContractError(`items[${index}] disclaimer_version mismatch`);
  }
  const evidenceIds = new Set(evidenceRefs.map(ref => ref.id));
  const tokens = string(explanation.body, `items[${index}].explanation.body`).match(/\[(E\d+)\]/g);
  for (const token of tokens ?? []) {
    if (!evidenceIds.has(token.slice(1, -1))) {
      throw new RecommendationContractError(`items[${index}] evidence token ${token} is unknown`);
    }
  }
  const scoreTotal = number(score.total, `items[${index}].recommendation.score.total`);
  if (scoreTotal < 0 || scoreTotal > 100) {
    throw new RecommendationContractError(`items[${index}] score total is out of range`);
  }

  return {
    ...item,
    id: uuid(item.id, `items[${index}].recommendation.id`),
    snapshot_id: snapshotId,
    ticker: string(item.ticker, `items[${index}].recommendation.ticker`),
    as_of: string(item.as_of, `items[${index}].recommendation.as_of`),
    score: {
      scoring_id: scoringId,
      snapshot_hash: snapshotHash,
      profile,
      market_scope: marketScope,
      total: scoreTotal,
      rating,
      dims,
    },
    conviction: {
      final: number(conviction.final, `items[${index}].recommendation.conviction.final`),
      level: convictionLevel as 'HIGH' | 'MED' | 'LOW',
    },
    risk_gate: {
      gate: gate as 'GREEN' | 'YELLOW' | 'RED',
      ok_to_enter: true,
    },
    entry_plan: {
      size_hint: {
        tier: sizeTier as 'TIER_5' | 'TIER_3' | 'TIER_2' | 'TIER_1' | 'SKIP',
        pct: sizePct,
        disclaimer_key: 'size_hint_advisory',
      },
    },
    trigger_signals: item.trigger_signals,
    weights: record(item.weights, `items[${index}].recommendation.weights`),
    explanation: {
      headline: string(explanation.headline, `items[${index}].explanation.headline`),
      body: string(explanation.body, `items[${index}].explanation.body`),
      caveats: stringArray(explanation.caveats, `items[${index}].explanation.caveats`),
      language: explanationLanguage,
    },
    evidence_refs: evidenceRefs,
    model_version: string(item.model_version, `items[${index}].model_version`),
    disclaimer_version: disclaimerVersion,
  };
}

export function parseRecommendationSnapshot(value: unknown): RecommendationSnapshot {
  const envelope = record(value, 'snapshot');
  rejectUnknownKeys(
    envelope,
    [
      'snapshot_id',
      'as_of',
      'profile',
      'market_scope',
      'items',
      'output_fingerprint',
      'disclaimer',
      'meta',
    ],
    'snapshot'
  );
  if ('custom' === envelope.profile || 'profile_alias' in envelope) {
    throw new RecommendationContractError('legacy/custom profile is forbidden');
  }
  const snapshotId = uuid(envelope.snapshot_id, 'snapshot_id');
  const profile = parseProfile(envelope.profile);
  const marketScope = parseScope(envelope.market_scope);
  if (!RECOMMENDATION_PROFILE_SCOPES[profile].includes(marketScope)) {
    throw new RecommendationContractError('profile/market_scope is incompatible');
  }
  const disclaimer = record(envelope.disclaimer, 'disclaimer');
  rejectUnknownKeys(
    disclaimer,
    ['version', 'short_text', 'full_text', 'language', 'effective_at', 'hash'],
    'disclaimer'
  );
  const disclaimerVersion = string(disclaimer.version, 'disclaimer.version');
  const disclaimerLanguage = parseLocale(disclaimer.language, 'disclaimer.language');
  if (!PROFILE_LOCALES[profile].includes(disclaimerLanguage)) {
    throw new RecommendationContractError('disclaimer language is incompatible with profile');
  }
  const meta = record(envelope.meta, 'meta');
  rejectUnknownKeys(
    meta,
    [
      'contract_version',
      'profile_version',
      'input_fingerprint',
      'strategy_version',
      'pipeline_version',
      'generated_by',
      'generation_ms',
    ],
    'meta'
  );
  if (meta.contract_version !== '0.3.1') {
    throw new RecommendationContractError('meta.contract_version must equal 0.3.1');
  }
  const itemsRaw = envelope.items;
  if (!Array.isArray(itemsRaw)) throw new RecommendationContractError('items must be an array');

  const parsed: RecommendationSnapshot = {
    snapshot_id: snapshotId,
    as_of: string(envelope.as_of, 'as_of'),
    profile,
    market_scope: marketScope,
    output_fingerprint: hash(envelope.output_fingerprint, 'output_fingerprint'),
    disclaimer: {
      version: disclaimerVersion,
      short_text: string(disclaimer.short_text, 'disclaimer.short_text'),
      full_text: string(disclaimer.full_text, 'disclaimer.full_text'),
      language: disclaimerLanguage,
      effective_at: string(disclaimer.effective_at, 'disclaimer.effective_at'),
      hash: hash(disclaimer.hash, 'disclaimer.hash'),
    },
    meta: {
      contract_version: '0.3.1',
      profile_version: string(meta.profile_version, 'meta.profile_version'),
      input_fingerprint: hash(meta.input_fingerprint, 'meta.input_fingerprint'),
      strategy_version: string(meta.strategy_version, 'meta.strategy_version'),
      pipeline_version: string(meta.pipeline_version, 'meta.pipeline_version'),
      generated_by: string(meta.generated_by, 'meta.generated_by'),
      generation_ms: number(meta.generation_ms, 'meta.generation_ms'),
    },
    items: [],
  };

  parsed.items = itemsRaw.map((rawItem, index) => {
    const item = record(rawItem, `items[${index}]`);
    rejectUnknownKeys(item, ['recommendation', 'rating_band'], `items[${index}]`);
    const recommendation = parseRecommendation(
      item.recommendation,
      snapshotId,
      profile,
      marketScope,
      disclaimerVersion,
      index
    );
    const ratingBand = parseBand(item.rating_band, `items[${index}].rating_band`);
    if (ratingBand !== recommendation.score.rating) {
      throw new RecommendationContractError(`items[${index}] rating mirror mismatch`);
    }
    return { recommendation, rating_band: ratingBand };
  });

  return parsed;
}
