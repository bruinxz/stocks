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
  type RecommendationTriggerSignal,
  type RecommendationWeights,
  type RecommendationCatalystRelevance,
} from './types';
import {
  RISK_GATE_TRIGGER_CODES_V0_3,
  type Conviction,
  type EntryPlan,
  type GateStatus,
  type RiskGate,
  type RiskGateTriggerCode,
  type ScoreRef,
  type TriggerSeverity,
} from 'shared/scoring/types';

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
const TRIGGER_CODES = new Set<string>(RISK_GATE_TRIGGER_CODES_V0_3);
const TRIGGER_SEVERITIES = new Set<TriggerSeverity>(['info', 'warn', 'block']);
const TRIGGER_RULES: Record<
  RiskGateTriggerCode,
  { severity: TriggerSeverity; scopes: readonly RecommendationMarketScope[] }
> = {
  'EARNINGS_T-2': { severity: 'warn', scopes: ['us'] },
  'EARNINGS_T-0': { severity: 'block', scopes: ['us'] },
  HALT_ACTIVE: { severity: 'block', scopes: ['us'] },
  MERGER_PENDING: { severity: 'warn', scopes: ['us'] },
  LITIGATION_MATERIAL: { severity: 'warn', scopes: ['us'] },
  IV_SHOCK: { severity: 'warn', scopes: ['us'] },
  LIQUIDITY_LOW: { severity: 'warn', scopes: ['us'] },
  RESTATEMENT_30D: { severity: 'block', scopes: ['us'] },
  DELISTING_NOTICE: { severity: 'block', scopes: ['us'] },
  ST_TAG: { severity: 'block', scopes: ['cn_a'] },
  PRICE_LIMIT_APPROACH: { severity: 'warn', scopes: ['cn_a'] },
  SUSPENDED: { severity: 'block', scopes: ['cn_a'] },
  TSE_HALT: { severity: 'block', scopes: ['jp'] },
  EDINET_DELAY: { severity: 'warn', scopes: ['jp'] },
  CORPORATE_GOVERNANCE_ISSUE: { severity: 'warn', scopes: ['jp'] },
  TSE_TOKUBETSU_CHI: { severity: 'warn', scopes: ['jp'] },
  TSE_KANRI: { severity: 'block', scopes: ['jp'] },
  KRX_HALT: { severity: 'block', scopes: ['kr'] },
  DART_LATE_FILING: { severity: 'warn', scopes: ['kr'] },
  INSIDER_TRADING_FLAG: { severity: 'block', scopes: ['kr'] },
  KRX_UNFAITHFUL: { severity: 'warn', scopes: ['kr'] },
  KRX_INVESTOR_ALERT: { severity: 'warn', scopes: ['kr'] },
};
const CURRENCIES = new Set(['USD', 'CNY', 'HKD', 'JPY', 'KRW']);
const HORIZONS = new Set(['INTRADAY', 'SWING', 'POSITION', 'CORE_HOLD', 'LONG_TERM']);
const SIGNAL_CODES = new Set<RecommendationTriggerSignal['code']>([
  'CATALYST_MATCHED',
  'CONVICTION_HIGH',
  'SCORE_TOTAL_TOP',
  'DIM_BAND_A',
  'RISK_GATE_CLEAN',
  'ENTRY_PLAN_TIGHT',
  'EVENT_FRESH',
  'SECTOR_MOMENTUM',
  'RULE_MATCHED',
  'MODEL_INFERENCE',
]);
const SIGNAL_STRENGTHS = new Set<RecommendationTriggerSignal['strength']>([
  'STRONG',
  'MEDIUM',
  'WEAK',
]);
const CATALYST_KINDS = new Set<RecommendationCatalystRelevance['kind']>([
  'earnings',
  'upgrade_downgrade',
  'ma_activity',
  'sector_move',
  'regulator',
  'geo_macro',
  'product',
  'leadership',
]);

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

function parseScoreRef(value: unknown, label: string): ScoreRef {
  const ref = record(value, label);
  rejectUnknownKeys(ref, ['scoring_id', 'snapshot_hash'], label);
  return {
    scoring_id: uuid(ref.scoring_id, `${label}.scoring_id`),
    snapshot_hash: hash(ref.snapshot_hash, `${label}.snapshot_hash`),
  };
}

function sameScoreRef(left: ScoreRef, right: ScoreRef): boolean {
  return left.scoring_id === right.scoring_id && left.snapshot_hash === right.snapshot_hash;
}

function parseConviction(
  value: unknown,
  scoreRef: ScoreRef,
  ticker: string,
  index: number
): Conviction {
  const label = `items[${index}].recommendation.conviction`;
  const raw = record(value, label);
  rejectUnknownKeys(
    raw,
    ['ticker', 'as_of', 'base', 'score_ref', 'adjustments', 'final', 'level'],
    label
  );
  if (string(raw.ticker, `${label}.ticker`) !== ticker) {
    throw new RecommendationContractError(`items[${index}] conviction ticker mismatch`);
  }
  const base = number(raw.base, `${label}.base`);
  const final = number(raw.final, `${label}.final`);
  if (base < 0 || base > 100 || final < 0 || final > 100) {
    throw new RecommendationContractError(`items[${index}] conviction is out of range`);
  }
  const reference = parseScoreRef(raw.score_ref, `${label}.score_ref`);
  if (!sameScoreRef(reference, scoreRef)) {
    throw new RecommendationContractError(`items[${index}] conviction score_ref mismatch`);
  }
  if (!Array.isArray(raw.adjustments) || raw.adjustments.length > 5) {
    throw new RecommendationContractError(`items[${index}] conviction adjustments are invalid`);
  }
  const adjustments = raw.adjustments.map((value, adjustmentIndex) => {
    const adjustment = record(value, `${label}.adjustments[${adjustmentIndex}]`);
    rejectUnknownKeys(
      adjustment,
      ['delta', 'reason', 'kind_ref', 'source_ref'],
      `${label}.adjustments[${adjustmentIndex}]`
    );
    const delta = number(adjustment.delta, `${label}.adjustments[${adjustmentIndex}].delta`);
    if (delta < -20 || delta > 20) {
      throw new RecommendationContractError(`items[${index}] adjustment delta is invalid`);
    }
    const reason = string(adjustment.reason, `${label}.adjustments[${adjustmentIndex}].reason`);
    return {
      delta,
      reason,
      kind_ref:
        typeof adjustment.kind_ref === 'string'
          ? (adjustment.kind_ref as Conviction['adjustments'][number]['kind_ref'])
          : undefined,
      source_ref: typeof adjustment.source_ref === 'string' ? adjustment.source_ref : undefined,
    };
  });
  const deltaSum = adjustments.reduce((sum, adjustment) => sum + adjustment.delta, 0);
  if (deltaSum < -20 || deltaSum > 20 || final !== Math.max(0, Math.min(100, base + deltaSum))) {
    throw new RecommendationContractError(`items[${index}] conviction final mismatch`);
  }
  const level = string(raw.level, `${label}.level`);
  const expectedLevel = final >= 75 ? 'HIGH' : final >= 50 ? 'MED' : 'LOW';
  if (level !== expectedLevel) {
    throw new RecommendationContractError(`items[${index}] conviction level mismatch`);
  }
  return {
    ticker,
    as_of: string(raw.as_of, `${label}.as_of`),
    base,
    score_ref: reference,
    adjustments,
    final,
    level: expectedLevel,
  };
}

function deriveGate(triggers: RiskGate['triggers']): GateStatus {
  if (triggers.some(trigger => trigger.severity === 'block')) return 'RED';
  if (triggers.some(trigger => trigger.severity === 'warn')) return 'YELLOW';
  return 'GREEN';
}

function parseRiskGate(
  value: unknown,
  ticker: string,
  marketScope: RecommendationMarketScope,
  index: number
): RiskGate {
  const label = `items[${index}].recommendation.risk_gate`;
  const raw = record(value, label);
  rejectUnknownKeys(raw, ['ticker', 'evaluated_at', 'gate', 'triggers', 'ok_to_enter'], label);
  if (string(raw.ticker, `${label}.ticker`) !== ticker) {
    throw new RecommendationContractError(`items[${index}] risk ticker mismatch`);
  }
  if (!Array.isArray(raw.triggers)) {
    throw new RecommendationContractError(`items[${index}] risk triggers must be an array`);
  }
  const triggers = raw.triggers.map((value, triggerIndex) => {
    const trigger = record(value, `${label}.triggers[${triggerIndex}]`);
    rejectUnknownKeys(
      trigger,
      ['code', 'severity', 'detail'],
      `${label}.triggers[${triggerIndex}]`
    );
    const code = string(trigger.code, `${label}.triggers[${triggerIndex}].code`);
    if (!TRIGGER_CODES.has(code)) {
      throw new RecommendationContractError(`items[${index}] risk trigger code is invalid`);
    }
    const severity = string(trigger.severity, `${label}.triggers[${triggerIndex}].severity`);
    if (!TRIGGER_SEVERITIES.has(severity as TriggerSeverity)) {
      throw new RecommendationContractError(`items[${index}] risk trigger severity is invalid`);
    }
    const rule = TRIGGER_RULES[code as RiskGateTriggerCode];
    if (severity !== rule.severity) {
      throw new RecommendationContractError(`items[${index}] risk trigger severity mismatch`);
    }
    if (!rule.scopes.includes(marketScope)) {
      throw new RecommendationContractError(`items[${index}] risk trigger market mismatch`);
    }
    return {
      code: code as RiskGateTriggerCode,
      severity: severity as TriggerSeverity,
      detail: string(trigger.detail, `${label}.triggers[${triggerIndex}].detail`),
    };
  });
  const gate = string(raw.gate, `${label}.gate`) as GateStatus;
  const expectedGate = deriveGate(triggers);
  if (gate !== expectedGate) {
    throw new RecommendationContractError(`items[${index}] risk gate derivation mismatch`);
  }
  const okToEnter = boolean(raw.ok_to_enter, `${label}.ok_to_enter`);
  if (okToEnter !== (gate === 'GREEN')) {
    throw new RecommendationContractError(`items[${index}] risk ok_to_enter mismatch`);
  }
  if (gate !== 'GREEN' || !okToEnter) {
    throw new RecommendationContractError(`items[${index}] persisted risk gate must be GREEN`);
  }
  return {
    ticker,
    evaluated_at: string(raw.evaluated_at, `${label}.evaluated_at`),
    gate,
    triggers,
    ok_to_enter: okToEnter,
  };
}

function parseCatalystRelevance(
  value: unknown,
  index: number
): RecommendationCatalystRelevance | undefined {
  if (value == null) return undefined;
  const label = `items[${index}].recommendation.catalyst_relevance`;
  const raw = record(value, label);
  rejectUnknownKeys(raw, ['catalyst_id', 'kind', 'relevance_score', 'components'], label);
  const kind = string(raw.kind, `${label}.kind`);
  if (
    kind === 'unclassified' ||
    !CATALYST_KINDS.has(kind as RecommendationCatalystRelevance['kind'])
  ) {
    throw new RecommendationContractError(`items[${index}] catalyst kind is invalid`);
  }
  const relevanceScore = number(raw.relevance_score, `${label}.relevance_score`);
  if (relevanceScore < 0 || relevanceScore > 1) {
    throw new RecommendationContractError(`items[${index}] catalyst relevance is out of range`);
  }
  const components = record(raw.components, `${label}.components`);
  const componentKeys = [
    'sector_map',
    'revenue_exposure',
    'adr_parity',
    'supply_chain',
    'historical_beta',
  ] as const;
  rejectUnknownKeys(components, componentKeys, `${label}.components`);
  const parsedComponents = Object.fromEntries(
    componentKeys.map(key => {
      const component = number(components[key], `${label}.components.${key}`);
      if (component < 0 || component > 1) {
        throw new RecommendationContractError(`items[${index}] catalyst component is out of range`);
      }
      return [key, component];
    })
  ) as unknown as RecommendationCatalystRelevance['components'];
  return {
    catalyst_id: string(raw.catalyst_id, `${label}.catalyst_id`),
    kind: kind as RecommendationCatalystRelevance['kind'],
    relevance_score: relevanceScore,
    components: parsedComponents,
  };
}

function parseWeights(
  value: unknown,
  triggerCodes: ReadonlySet<string>,
  catalystId: string | undefined,
  index: number
): RecommendationWeights {
  const label = `items[${index}].recommendation.weights`;
  const raw = record(value, label);
  rejectUnknownKeys(raw, ['contributions', 'normalized'], label);
  if (!Array.isArray(raw.contributions) || typeof raw.normalized !== 'boolean') {
    throw new RecommendationContractError(`items[${index}] weights shape is invalid`);
  }
  if (raw.contributions.length === 0) {
    if (raw.normalized !== false) {
      throw new RecommendationContractError(`items[${index}] zero weights must be unnormalized`);
    }
    return { contributions: [], normalized: false };
  }
  if (raw.normalized !== true) {
    throw new RecommendationContractError(`items[${index}] nonempty weights must be normalized`);
  }
  const contributions = raw.contributions.map((value, contributionIndex) => {
    const source = record(value, `${label}.contributions[${contributionIndex}]`);
    rejectUnknownKeys(
      source,
      ['source_kind', 'source_ref', 'weight', 'note'],
      `${label}.contributions[${contributionIndex}]`
    );
    const sourceKind = string(
      source.source_kind,
      `${label}.contributions[${contributionIndex}].source_kind`
    );
    if (!['trigger', 'score_dim', 'catalyst_relevance'].includes(sourceKind)) {
      throw new RecommendationContractError(`items[${index}] weight source_kind is invalid`);
    }
    const weight = number(source.weight, `${label}.contributions[${contributionIndex}].weight`);
    if (weight < -1 || weight > 1) {
      throw new RecommendationContractError(`items[${index}] contribution weight is invalid`);
    }
    const sourceRef = string(
      source.source_ref,
      `${label}.contributions[${contributionIndex}].source_ref`
    );
    const refValid =
      (sourceKind === 'trigger' && triggerCodes.has(sourceRef)) ||
      (sourceKind === 'score_dim' && (DIM_KEYS as readonly string[]).includes(sourceRef)) ||
      (sourceKind === 'catalyst_relevance' && catalystId != null && sourceRef === catalystId);
    if (!refValid) {
      throw new RecommendationContractError(`items[${index}] weight source_ref is invalid`);
    }
    return {
      source_kind: sourceKind as RecommendationWeights['contributions'][number]['source_kind'],
      source_ref: sourceRef,
      weight,
      note: typeof source.note === 'string' ? source.note : undefined,
    };
  });
  const l1 = contributions.reduce((sum, contribution) => sum + Math.abs(contribution.weight), 0);
  if (Math.abs(l1 - 1) > 1e-6) {
    throw new RecommendationContractError(`items[${index}] contribution L1 must equal 1`);
  }
  return { contributions, normalized: true };
}

function parseTriggerSignals(
  value: unknown,
  evidenceIds: ReadonlySet<string>,
  index: number
): RecommendationTriggerSignal[] {
  const label = `items[${index}].recommendation.trigger_signals`;
  if (!Array.isArray(value) || value.length === 0) {
    throw new RecommendationContractError(`items[${index}].trigger_signals is empty`);
  }
  return value.map((rawValue, signalIndex) => {
    const signal = record(rawValue, `${label}[${signalIndex}]`);
    rejectUnknownKeys(
      signal,
      ['code', 'strength', 'detail', 'source_ref'],
      `${label}[${signalIndex}]`
    );
    const code = string(signal.code, `${label}[${signalIndex}].code`);
    if (!SIGNAL_CODES.has(code as RecommendationTriggerSignal['code'])) {
      throw new RecommendationContractError(`items[${index}] trigger signal code is invalid`);
    }
    const strength = string(signal.strength, `${label}[${signalIndex}].strength`);
    if (!SIGNAL_STRENGTHS.has(strength as RecommendationTriggerSignal['strength'])) {
      throw new RecommendationContractError(`items[${index}] trigger signal strength is invalid`);
    }
    const sourceRef = typeof signal.source_ref === 'string' ? signal.source_ref : undefined;
    if (sourceRef && !evidenceIds.has(sourceRef)) {
      throw new RecommendationContractError(`items[${index}] trigger source_ref is unknown`);
    }
    return {
      code: code as RecommendationTriggerSignal['code'],
      strength: strength as RecommendationTriggerSignal['strength'],
      detail: (() => {
        const detail = string(signal.detail, `${label}[${signalIndex}].detail`);
        if (detail.length > 240) {
          throw new RecommendationContractError(`items[${index}] trigger detail is too long`);
        }
        return detail;
      })(),
      source_ref: sourceRef,
    };
  });
}

function parseCurrency(value: unknown, label: string): string {
  const currency = string(value, label);
  if (!CURRENCIES.has(currency)) throw new RecommendationContractError(`${label} is invalid`);
  return currency;
}

function parseEntryPlan(
  value: unknown,
  scoreRef: ScoreRef,
  ticker: string,
  convictionFinal: number,
  index: number
): EntryPlan {
  const label = `items[${index}].recommendation.entry_plan`;
  const raw = record(value, label);
  rejectUnknownKeys(
    raw,
    [
      'ticker',
      'generated_at',
      'entry',
      'stop',
      'targets',
      'size_hint',
      'time_horizon',
      'invalidation',
      'conviction_ref',
      'score_ref',
    ],
    label
  );
  if (string(raw.ticker, `${label}.ticker`) !== ticker) {
    throw new RecommendationContractError(`items[${index}] entry ticker mismatch`);
  }
  const reference = parseScoreRef(raw.score_ref, `${label}.score_ref`);
  if (!sameScoreRef(reference, scoreRef)) {
    throw new RecommendationContractError(`items[${index}] entry score_ref mismatch`);
  }
  const entry = record(raw.entry, `${label}.entry`);
  rejectUnknownKeys(entry, ['low', 'high', 'currency'], `${label}.entry`);
  const entryLow = number(entry.low, `${label}.entry.low`);
  const entryHigh = number(entry.high, `${label}.entry.high`);
  const entryCurrency = parseCurrency(entry.currency, `${label}.entry.currency`) as
    'USD' | 'CNY' | 'HKD' | 'JPY' | 'KRW';
  if (entryLow > entryHigh) {
    throw new RecommendationContractError(`items[${index}] entry price band is invalid`);
  }
  const parsePrice = (source: unknown, priceLabel: string) => {
    const price = record(source, priceLabel);
    rejectUnknownKeys(price, ['value', 'currency'], priceLabel);
    const currency = parseCurrency(price.currency, `${priceLabel}.currency`);
    if (currency !== entryCurrency) {
      throw new RecommendationContractError(`items[${index}] price currency mismatch`);
    }
    return { value: number(price.value, `${priceLabel}.value`), currency };
  };
  const stop = parsePrice(raw.stop, `${label}.stop`);
  if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
    throw new RecommendationContractError(`items[${index}] targets are required`);
  }
  const targets = raw.targets.map((target, targetIndex) =>
    parsePrice(target, `${label}.targets[${targetIndex}]`)
  );
  const sizeHint = record(raw.size_hint, `${label}.size_hint`);
  rejectUnknownKeys(sizeHint, ['tier', 'pct', 'disclaimer_key', 'rationale'], `${label}.size_hint`);
  const tier = string(sizeHint.tier, `${label}.size_hint.tier`);
  if (!(tier in SIZE_HINT_PCT)) {
    throw new RecommendationContractError(`items[${index}] size_hint tier is invalid`);
  }
  const pct = number(sizeHint.pct, `${label}.size_hint.pct`);
  if (pct !== SIZE_HINT_PCT[tier as keyof typeof SIZE_HINT_PCT]) {
    throw new RecommendationContractError(`items[${index}] size_hint pct mismatch`);
  }
  if (sizeHint.disclaimer_key !== 'size_hint_advisory') {
    throw new RecommendationContractError(`items[${index}] size_hint disclaimer key is invalid`);
  }
  const horizon = string(raw.time_horizon, `${label}.time_horizon`);
  if (!HORIZONS.has(horizon)) {
    throw new RecommendationContractError(`items[${index}] time_horizon is invalid`);
  }
  const convictionRef = number(raw.conviction_ref, `${label}.conviction_ref`);
  if (convictionRef !== convictionFinal) {
    throw new RecommendationContractError(`items[${index}] conviction_ref mismatch`);
  }
  return {
    ticker,
    generated_at: string(raw.generated_at, `${label}.generated_at`),
    entry: { low: entryLow, high: entryHigh, currency: entryCurrency },
    stop,
    targets,
    size_hint: {
      tier: tier as EntryPlan['size_hint']['tier'],
      pct,
      disclaimer_key: 'size_hint_advisory',
      rationale: string(sizeHint.rationale, `${label}.size_hint.rationale`),
    },
    time_horizon: horizon as EntryPlan['time_horizon'],
    invalidation: string(raw.invalidation, `${label}.invalidation`),
    conviction_ref: convictionRef,
    score_ref: reference,
  };
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
  const scoreRef = { scoring_id: scoringId, snapshot_hash: snapshotHash };
  const ticker = string(item.ticker, `items[${index}].recommendation.ticker`);
  const conviction = parseConviction(item.conviction, scoreRef, ticker, index);
  const riskGate = parseRiskGate(item.risk_gate, ticker, marketScope, index);
  const entryPlan = parseEntryPlan(item.entry_plan, scoreRef, ticker, conviction.final, index);
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
    const shortText = typeof ref.short_text === 'string' ? ref.short_text : undefined;
    if (shortText && shortText.length > 200) {
      throw new RecommendationContractError(`items[${index}] evidence short_text is too long`);
    }
    return {
      id: string(ref.id, `items[${index}].evidence_refs[${evidenceIndex}].id`),
      kind: kind as RecommendationEntry['evidence_refs'][number]['kind'],
      source_uri: sourceUri,
      as_of: string(ref.as_of, `items[${index}].evidence_refs[${evidenceIndex}].as_of`),
      hash: hash(ref.hash, `items[${index}].evidence_refs[${evidenceIndex}].hash`),
      short_text: shortText,
    };
  });
  if (string(item.disclaimer_version, `items[${index}].disclaimer_version`) !== disclaimerVersion) {
    throw new RecommendationContractError(`items[${index}] disclaimer_version mismatch`);
  }
  const evidenceIds = new Set(evidenceRefs.map(ref => ref.id));
  const triggerSignals = parseTriggerSignals(item.trigger_signals, evidenceIds, index);
  const catalystRelevance = parseCatalystRelevance(item.catalyst_relevance, index);
  const weights = parseWeights(
    item.weights,
    new Set(triggerSignals.map(signal => signal.code)),
    catalystRelevance?.catalyst_id,
    index
  );
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

  const headline = string(explanation.headline, `items[${index}].explanation.headline`);
  const body = string(explanation.body, `items[${index}].explanation.body`);
  const caveats = stringArray(explanation.caveats, `items[${index}].explanation.caveats`);
  if (
    headline.length > 80 ||
    body.length > 600 ||
    caveats.length > 3 ||
    caveats.some(caveat => caveat.length > 120)
  ) {
    throw new RecommendationContractError(`items[${index}] explanation length is invalid`);
  }
  const templateId = string(explanation.template_id, `items[${index}].explanation.template_id`);
  const templateHash = hash(explanation.template_hash, `items[${index}].explanation.template_hash`);

  return {
    ...item,
    id: uuid(item.id, `items[${index}].recommendation.id`),
    snapshot_id: snapshotId,
    ticker,
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
    conviction,
    risk_gate: riskGate,
    entry_plan: entryPlan,
    catalyst_relevance: catalystRelevance,
    trigger_signals: triggerSignals,
    weights,
    explanation: {
      headline,
      body,
      caveats,
      language: explanationLanguage,
      template_id: templateId,
      template_hash: templateHash,
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
