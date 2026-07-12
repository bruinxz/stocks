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
import {
  ContractSchemaError,
  assertExactObject,
  jcsCanonicalize,
  sha256Text,
  strictArray,
  strictBoolean,
  strictIso8601,
  strictNumber,
  strictOptionalString,
  strictSemVer,
  strictSha256,
  strictString,
  strictStringArray,
  strictUuidV4,
  type ExactObject,
} from './contractSchema';

type UnknownRecord = ExactObject;
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
const ADJUSTMENT_KINDS = new Set([
  'earnings',
  'upgrade_downgrade',
  'product',
  'regulator',
  'geo_macro',
  'ma_activity',
  'sector_move',
  'leadership',
  'unclassified',
]);

export class RecommendationContractError extends Error {
  constructor(message: string) {
    super(`Recommendation v0.3.1 contract error: ${message}`);
    this.name = 'RecommendationContractError';
  }
}

function string(value: unknown, label: string): string {
  try {
    return strictString(value, label);
  } catch (error) {
    if (error instanceof ContractSchemaError) throw new RecommendationContractError(error.message);
    throw error;
  }
}

function uuid(value: unknown, label: string): string {
  try {
    return strictUuidV4(value, label);
  } catch (error) {
    if (error instanceof ContractSchemaError) throw new RecommendationContractError(error.message);
    throw error;
  }
}

function hash(value: unknown, label: string): string {
  try {
    return strictSha256(value, label);
  } catch (error) {
    if (error instanceof ContractSchemaError) throw new RecommendationContractError(error.message);
    throw error;
  }
}

function number(value: unknown, label: string): number {
  try {
    return strictNumber(value, label);
  } catch (error) {
    if (error instanceof ContractSchemaError) throw new RecommendationContractError(error.message);
    throw error;
  }
}

function boolean(value: unknown, label: string): boolean {
  try {
    return strictBoolean(value, label);
  } catch (error) {
    if (error instanceof ContractSchemaError) throw new RecommendationContractError(error.message);
    throw error;
  }
}

function exact(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string
): UnknownRecord {
  try {
    return assertExactObject(value, requiredKeys, optionalKeys, label);
  } catch (error) {
    if (error instanceof ContractSchemaError) {
      throw new RecommendationContractError(error.message);
    }
    throw error;
  }
}

function parseScoreRef(value: unknown, label: string): ScoreRef {
  const ref = exact(value, ['scoring_id', 'snapshot_hash'], [], label);
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
  recommendationAsOf: string,
  scoreTotal: number,
  index: number
): Conviction {
  const label = `items[${index}].recommendation.conviction`;
  const raw = exact(
    value,
    ['ticker', 'as_of', 'base', 'score_ref', 'adjustments', 'final', 'level'],
    [],
    label
  );
  if (string(raw.ticker, `${label}.ticker`) !== ticker) {
    throw new RecommendationContractError(`items[${index}] conviction ticker mismatch`);
  }
  const convictionAsOf = strictIso8601(raw.as_of, `${label}.as_of`);
  if (convictionAsOf !== recommendationAsOf) {
    throw new RecommendationContractError(`items[${index}] conviction as_of mismatch`);
  }
  const base = number(raw.base, `${label}.base`);
  if (Math.abs(base - scoreTotal) > 1e-6) {
    throw new RecommendationContractError(`items[${index}] conviction base mismatch`);
  }
  const final = number(raw.final, `${label}.final`);
  if (base < 0 || base > 100 || final < 0 || final > 100) {
    throw new RecommendationContractError(`items[${index}] conviction is out of range`);
  }
  const reference = parseScoreRef(raw.score_ref, `${label}.score_ref`);
  if (!sameScoreRef(reference, scoreRef)) {
    throw new RecommendationContractError(`items[${index}] conviction score_ref mismatch`);
  }
  const adjustments = strictArray(raw.adjustments, `${label}.adjustments`, { max: 5 }).map(
    (value, adjustmentIndex) => {
      const adjustmentLabel = `${label}.adjustments[${adjustmentIndex}]`;
      const adjustment = exact(
        value,
        ['delta', 'reason'],
        ['kind_ref', 'source_ref'],
        adjustmentLabel
      );
      const delta = strictNumber(adjustment.delta, `${adjustmentLabel}.delta`, {
        min: -20,
        max: 20,
      });
      const reason = strictString(adjustment.reason, `${adjustmentLabel}.reason`, { max: 200 });
      const kindRef = strictOptionalString(adjustment.kind_ref, `${adjustmentLabel}.kind_ref`);
      if (kindRef && !ADJUSTMENT_KINDS.has(kindRef)) {
        throw new RecommendationContractError(`items[${index}] adjustment kind_ref is invalid`);
      }
      return {
        delta,
        reason,
        ...(kindRef ? { kind_ref: kindRef as Conviction['adjustments'][number]['kind_ref'] } : {}),
        ...(adjustment.source_ref !== undefined
          ? {
              source_ref: strictOptionalString(
                adjustment.source_ref,
                `${adjustmentLabel}.source_ref`,
                { max: 240 }
              ),
            }
          : {}),
      };
    }
  );
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
    as_of: convictionAsOf,
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
  const raw = exact(
    value,
    ['ticker', 'evaluated_at', 'gate', 'triggers', 'ok_to_enter'],
    [],
    label
  );
  if (string(raw.ticker, `${label}.ticker`) !== ticker) {
    throw new RecommendationContractError(`items[${index}] risk ticker mismatch`);
  }
  const triggers = strictArray(raw.triggers, `${label}.triggers`).map((value, triggerIndex) => {
    const triggerLabel = `${label}.triggers[${triggerIndex}]`;
    const trigger = exact(value, ['code', 'severity', 'detail'], [], triggerLabel);
    const code = strictString(trigger.code, `${triggerLabel}.code`);
    if (!TRIGGER_CODES.has(code)) {
      throw new RecommendationContractError(`items[${index}] risk trigger code is invalid`);
    }
    const severity = strictString(trigger.severity, `${triggerLabel}.severity`);
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
      detail: strictString(trigger.detail, `${triggerLabel}.detail`, { max: 240 }),
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
    evaluated_at: strictIso8601(raw.evaluated_at, `${label}.evaluated_at`),
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
  const raw = exact(value, ['catalyst_id', 'kind', 'relevance_score', 'components'], [], label);
  const kind = string(raw.kind, `${label}.kind`);
  if (
    kind === 'unclassified' ||
    !CATALYST_KINDS.has(kind as RecommendationCatalystRelevance['kind'])
  ) {
    throw new RecommendationContractError(`items[${index}] catalyst kind is invalid`);
  }
  const relevanceScore = strictNumber(raw.relevance_score, `${label}.relevance_score`, {
    min: 0,
    max: 1,
  });
  const componentKeys = [
    'sector_map',
    'revenue_exposure',
    'adr_parity',
    'supply_chain',
    'historical_beta',
  ] as const;
  const components = exact(raw.components, componentKeys, [], `${label}.components`);
  const parsedComponents = Object.fromEntries(
    componentKeys.map(key => {
      const component = strictNumber(components[key], `${label}.components.${key}`, {
        min: 0,
        max: 1,
      });
      return [key, component];
    })
  ) as unknown as RecommendationCatalystRelevance['components'];
  const expectedRelevance =
    parsedComponents.sector_map * 0.35 +
    parsedComponents.revenue_exposure * 0.25 +
    parsedComponents.adr_parity * 0.2 +
    parsedComponents.supply_chain * 0.15 +
    parsedComponents.historical_beta * 0.05;
  if (Math.abs(relevanceScore - expectedRelevance) > 1e-6) {
    throw new RecommendationContractError(`items[${index}] catalyst relevance sum mismatch`);
  }
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
  const raw = exact(value, ['contributions', 'normalized'], [], label);
  const rawContributions = strictArray(raw.contributions, `${label}.contributions`);
  const normalized = strictBoolean(raw.normalized, `${label}.normalized`);
  if (rawContributions.length === 0) {
    if (normalized !== false) {
      throw new RecommendationContractError(`items[${index}] zero weights must be unnormalized`);
    }
    return { contributions: [], normalized: false };
  }
  if (normalized !== true) {
    throw new RecommendationContractError(`items[${index}] nonempty weights must be normalized`);
  }
  const contributions = rawContributions.map((value, contributionIndex) => {
    const contributionLabel = `${label}.contributions[${contributionIndex}]`;
    const source = exact(
      value,
      ['source_kind', 'source_ref', 'weight'],
      ['note'],
      contributionLabel
    );
    const sourceKind = strictString(source.source_kind, `${contributionLabel}.source_kind`);
    if (!['trigger', 'score_dim', 'catalyst_relevance'].includes(sourceKind)) {
      throw new RecommendationContractError(`items[${index}] weight source_kind is invalid`);
    }
    const weight = strictNumber(source.weight, `${contributionLabel}.weight`, {
      min: -1,
      max: 1,
    });
    const sourceRef = strictString(source.source_ref, `${contributionLabel}.source_ref`);
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
      ...(source.note !== undefined
        ? { note: strictOptionalString(source.note, `${contributionLabel}.note`, { max: 240 }) }
        : {}),
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
  return strictArray(value, label, { min: 1 }).map((rawValue, signalIndex) => {
    const signalLabel = `${label}[${signalIndex}]`;
    const signal = exact(rawValue, ['code', 'strength', 'detail'], ['source_ref'], signalLabel);
    const code = strictString(signal.code, `${signalLabel}.code`);
    if (!SIGNAL_CODES.has(code as RecommendationTriggerSignal['code'])) {
      throw new RecommendationContractError(`items[${index}] trigger signal code is invalid`);
    }
    const strength = strictString(signal.strength, `${signalLabel}.strength`);
    if (!SIGNAL_STRENGTHS.has(strength as RecommendationTriggerSignal['strength'])) {
      throw new RecommendationContractError(`items[${index}] trigger signal strength is invalid`);
    }
    const sourceRef = strictOptionalString(signal.source_ref, `${signalLabel}.source_ref`);
    if (sourceRef && !evidenceIds.has(sourceRef)) {
      throw new RecommendationContractError(`items[${index}] trigger source_ref is unknown`);
    }
    return {
      code: code as RecommendationTriggerSignal['code'],
      strength: strength as RecommendationTriggerSignal['strength'],
      detail: (() => {
        return strictString(signal.detail, `${signalLabel}.detail`, { max: 240 });
      })(),
      ...(sourceRef ? { source_ref: sourceRef } : {}),
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
  const raw = exact(
    value,
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
    [],
    label
  );
  if (string(raw.ticker, `${label}.ticker`) !== ticker) {
    throw new RecommendationContractError(`items[${index}] entry ticker mismatch`);
  }
  const reference = parseScoreRef(raw.score_ref, `${label}.score_ref`);
  if (!sameScoreRef(reference, scoreRef)) {
    throw new RecommendationContractError(`items[${index}] entry score_ref mismatch`);
  }
  const entry = exact(raw.entry, ['low', 'high', 'currency'], [], `${label}.entry`);
  const entryLow = number(entry.low, `${label}.entry.low`);
  const entryHigh = number(entry.high, `${label}.entry.high`);
  const entryCurrency = parseCurrency(entry.currency, `${label}.entry.currency`) as
    'USD' | 'CNY' | 'HKD' | 'JPY' | 'KRW';
  if (entryLow > entryHigh) {
    throw new RecommendationContractError(`items[${index}] entry price band is invalid`);
  }
  const parsePrice = (source: unknown, priceLabel: string) => {
    const price = exact(source, ['value', 'currency'], [], priceLabel);
    const currency = parseCurrency(price.currency, `${priceLabel}.currency`);
    if (currency !== entryCurrency) {
      throw new RecommendationContractError(`items[${index}] price currency mismatch`);
    }
    return { value: number(price.value, `${priceLabel}.value`), currency };
  };
  const stop = parsePrice(raw.stop, `${label}.stop`);
  const targets = strictArray(raw.targets, `${label}.targets`, { min: 1, max: 3 }).map(
    (target, targetIndex) => parsePrice(target, `${label}.targets[${targetIndex}]`)
  );
  const sizeHint = exact(
    raw.size_hint,
    ['tier', 'pct', 'disclaimer_key', 'rationale'],
    [],
    `${label}.size_hint`
  );
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
    generated_at: strictIso8601(raw.generated_at, `${label}.generated_at`),
    entry: { low: entryLow, high: entryHigh, currency: entryCurrency },
    stop,
    targets,
    size_hint: {
      tier: tier as EntryPlan['size_hint']['tier'],
      pct,
      disclaimer_key: 'size_hint_advisory',
      rationale: strictString(sizeHint.rationale, `${label}.size_hint.rationale`, { max: 200 }),
    },
    time_horizon: horizon as EntryPlan['time_horizon'],
    invalidation: strictString(raw.invalidation, `${label}.invalidation`, { max: 240 }),
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

export function bandFor(value: number): RatingBand {
  if (value >= 85) return 'A';
  if (value >= 70) return 'B';
  if (value >= 55) return 'C';
  if (value >= 40) return 'D';
  return 'F';
}

function sizeHintFor(conviction: number): {
  tier: EntryPlan['size_hint']['tier'];
  pct: number;
} {
  if (conviction >= 85) return { tier: 'TIER_5', pct: 5 };
  if (conviction >= 70) return { tier: 'TIER_3', pct: 3 };
  if (conviction >= 55) return { tier: 'TIER_2', pct: 2 };
  if (conviction >= 40) return { tier: 'TIER_1', pct: 1 };
  return { tier: 'SKIP', pct: 0 };
}

function parseRecommendation(
  value: unknown,
  snapshotId: string,
  profile: RecommendationProfile,
  marketScope: RecommendationMarketScope,
  disclaimerVersion: string,
  index: number
): RecommendationEntry {
  const recommendationLabel = `items[${index}].recommendation`;
  const item = exact(
    value,
    [
      'id',
      'snapshot_id',
      'ticker',
      'as_of',
      'score',
      'conviction',
      'risk_gate',
      'entry_plan',
      'trigger_signals',
      'weights',
      'explanation',
      'evidence_refs',
      'model_version',
      'disclaimer_version',
    ],
    ['catalyst_relevance'],
    recommendationLabel
  );
  if (uuid(item.snapshot_id, `items[${index}].recommendation.snapshot_id`) !== snapshotId) {
    throw new RecommendationContractError(`items[${index}] snapshot_id mismatch`);
  }

  const scoreLabel = `items[${index}].recommendation.score`;
  const score = exact(
    item.score,
    ['scoring_id', 'snapshot_hash', 'profile', 'market_scope', 'total', 'rating', 'dims'],
    [],
    scoreLabel
  );
  if (score.profile !== profile || score.market_scope !== marketScope) {
    throw new RecommendationContractError(`items[${index}] score scope mismatch`);
  }
  const rating = parseBand(score.rating, `items[${index}].recommendation.score.rating`);
  const scoringId = uuid(score.scoring_id, `items[${index}].recommendation.score.scoring_id`);
  const snapshotHash = hash(
    score.snapshot_hash,
    `items[${index}].recommendation.score.snapshot_hash`
  );
  const scoreDims = strictArray(score.dims, `${scoreLabel}.dims`, {
    min: DIM_KEYS.length,
    max: DIM_KEYS.length,
  });
  if (scoreDims.length !== DIM_KEYS.length) {
    throw new RecommendationContractError(`items[${index}] score dims must contain six rows`);
  }
  const dims = scoreDims.map((value, dimIndex) => {
    const dimLabel = `${scoreLabel}.dims[${dimIndex}]`;
    const dim = exact(value, ['key', 'score', 'band', 'weight'], [], dimLabel);
    if (dim.key !== DIM_KEYS[dimIndex]) {
      throw new RecommendationContractError(`items[${index}] score dims order is invalid`);
    }
    return {
      key: DIM_KEYS[dimIndex],
      score: (() => {
        const dimScore = strictNumber(dim.score, `${dimLabel}.score`, { min: 0, max: 100 });
        const dimBand = parseBand(dim.band, `${dimLabel}.band`);
        if (dimBand !== bandFor(dimScore)) {
          throw new RecommendationContractError(`items[${index}] score dim band mismatch`);
        }
        return dimScore;
      })(),
      band: parseBand(dim.band, `${dimLabel}.band`),
      weight: strictNumber(dim.weight, `${dimLabel}.weight`, { min: 0, max: 1 }),
    };
  });
  const weightSum = dims.reduce((sum, dim) => sum + dim.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new RecommendationContractError(`items[${index}] score dim weights must sum to 1`);
  }
  const scoreRef = { scoring_id: scoringId, snapshot_hash: snapshotHash };
  const ticker = string(item.ticker, `items[${index}].recommendation.ticker`);
  if (!/^[A-Z0-9][A-Z0-9.-]*$/.test(ticker)) {
    throw new RecommendationContractError(`items[${index}] ticker is not normalized`);
  }
  const recommendationAsOf = strictIso8601(item.as_of, `${recommendationLabel}.as_of`);
  const scoreTotal = strictNumber(score.total, `${scoreLabel}.total`, { min: 0, max: 100 });
  const conviction = parseConviction(
    item.conviction,
    scoreRef,
    ticker,
    recommendationAsOf,
    scoreTotal,
    index
  );
  const riskGate = parseRiskGate(item.risk_gate, ticker, marketScope, index);
  const entryPlan = parseEntryPlan(item.entry_plan, scoreRef, ticker, conviction.final, index);
  const explanationLabel = `items[${index}].recommendation.explanation`;
  const explanation = exact(
    item.explanation,
    ['headline', 'body', 'caveats', 'language', 'template_id', 'template_hash'],
    [],
    explanationLabel
  );
  const explanationLanguage = parseLocale(
    explanation.language,
    `items[${index}].explanation.language`
  );
  if (!PROFILE_LOCALES[profile].includes(explanationLanguage)) {
    throw new RecommendationContractError(`items[${index}] explanation locale is incompatible`);
  }
  const evidence = strictArray(item.evidence_refs, `${recommendationLabel}.evidence_refs`, {
    min: 1,
  });
  const evidenceRefs = evidence.map((source, evidenceIndex) => {
    const evidenceLabel = `${recommendationLabel}.evidence_refs[${evidenceIndex}]`;
    const ref = exact(
      source,
      ['id', 'kind', 'source_uri', 'as_of', 'hash'],
      ['short_text'],
      evidenceLabel
    );
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
    const shortText = strictOptionalString(ref.short_text, `${evidenceLabel}.short_text`, {
      max: 200,
    });
    const evidenceAsOf = strictIso8601(ref.as_of, `${evidenceLabel}.as_of`);
    if (Date.parse(evidenceAsOf) > Date.parse(recommendationAsOf)) {
      throw new RecommendationContractError(`items[${index}] evidence is after recommendation`);
    }
    return {
      id: string(ref.id, `items[${index}].evidence_refs[${evidenceIndex}].id`),
      kind: kind as RecommendationEntry['evidence_refs'][number]['kind'],
      source_uri: sourceUri,
      as_of: evidenceAsOf,
      hash: hash(ref.hash, `items[${index}].evidence_refs[${evidenceIndex}].hash`),
      ...(shortText ? { short_text: shortText } : {}),
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
  if (rating !== bandFor(scoreTotal)) {
    throw new RecommendationContractError(`items[${index}] aggregate rating mismatch`);
  }
  const weightedTotal = dims.reduce((sum, dim) => sum + dim.score * dim.weight, 0);
  if (Math.abs(scoreTotal - weightedTotal) > 1e-6) {
    throw new RecommendationContractError(`items[${index}] weighted score total mismatch`);
  }
  const expectedSizeHint = sizeHintFor(conviction.final);
  if (
    entryPlan.size_hint.tier !== expectedSizeHint.tier ||
    entryPlan.size_hint.pct !== expectedSizeHint.pct
  ) {
    throw new RecommendationContractError(`items[${index}] size_hint conviction mapping mismatch`);
  }

  const headline = strictString(explanation.headline, `${explanationLabel}.headline`, { max: 80 });
  const body = strictString(explanation.body, `${explanationLabel}.body`, { max: 600 });
  const caveats = strictStringArray(explanation.caveats, `${explanationLabel}.caveats`, {
    max: 3,
    itemMax: 120,
  });
  const templateId = strictString(explanation.template_id, `${explanationLabel}.template_id`);
  const templateHash = hash(explanation.template_hash, `items[${index}].explanation.template_hash`);

  return {
    ...item,
    id: uuid(item.id, `items[${index}].recommendation.id`),
    snapshot_id: snapshotId,
    ticker,
    as_of: recommendationAsOf,
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
    model_version: strictSemVer(item.model_version, `${recommendationLabel}.model_version`),
    disclaimer_version: disclaimerVersion,
  };
}

function parseRecommendationSnapshotUnsafe(value: unknown): RecommendationSnapshot {
  const envelope = exact(
    value,
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
    [],
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
  const disclaimer = exact(
    envelope.disclaimer,
    ['version', 'short_text', 'full_text', 'language', 'effective_at', 'hash'],
    [],
    'disclaimer'
  );
  const disclaimerVersion = strictSemVer(disclaimer.version, 'disclaimer.version');
  const disclaimerLanguage = parseLocale(disclaimer.language, 'disclaimer.language');
  if (!PROFILE_LOCALES[profile].includes(disclaimerLanguage)) {
    throw new RecommendationContractError('disclaimer language is incompatible with profile');
  }
  const meta = exact(
    envelope.meta,
    [
      'contract_version',
      'profile_version',
      'input_fingerprint',
      'strategy_version',
      'pipeline_version',
      'generated_by',
      'generation_ms',
    ],
    [],
    'meta'
  );
  if (meta.contract_version !== '0.3.1') {
    throw new RecommendationContractError('meta.contract_version must equal 0.3.1');
  }
  const itemsRaw = strictArray(envelope.items, 'items');
  const fullDisclaimerText = strictString(disclaimer.full_text, 'disclaimer.full_text', {
    max: 4000,
  });
  const disclaimerHash = strictSha256(disclaimer.hash, 'disclaimer.hash');
  if (sha256Text(fullDisclaimerText) !== disclaimerHash) {
    throw new RecommendationContractError('disclaimer.hash does not match full_text');
  }
  const outputFingerprint = strictSha256(envelope.output_fingerprint, 'output_fingerprint');

  const parsed: RecommendationSnapshot = {
    snapshot_id: snapshotId,
    as_of: strictIso8601(envelope.as_of, 'as_of'),
    profile,
    market_scope: marketScope,
    output_fingerprint: outputFingerprint,
    disclaimer: {
      version: disclaimerVersion,
      short_text: strictString(disclaimer.short_text, 'disclaimer.short_text', { max: 200 }),
      full_text: fullDisclaimerText,
      language: disclaimerLanguage,
      effective_at: strictIso8601(disclaimer.effective_at, 'disclaimer.effective_at'),
      hash: disclaimerHash,
    },
    meta: {
      contract_version: '0.3.1',
      profile_version: strictSemVer(meta.profile_version, 'meta.profile_version'),
      input_fingerprint: strictSha256(meta.input_fingerprint, 'meta.input_fingerprint'),
      strategy_version: strictSemVer(meta.strategy_version, 'meta.strategy_version'),
      pipeline_version: strictSemVer(meta.pipeline_version, 'meta.pipeline_version'),
      generated_by: strictString(meta.generated_by, 'meta.generated_by'),
      generation_ms: strictNumber(meta.generation_ms, 'meta.generation_ms', { min: 0 }),
    },
    items: [],
  };

  parsed.items = itemsRaw.map((rawItem, index) => {
    const item = exact(rawItem, ['recommendation', 'rating_band'], [], `items[${index}]`);
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
  const seenTickers = new Set<string>();
  for (const item of parsed.items) {
    if (seenTickers.has(item.recommendation.ticker)) {
      throw new RecommendationContractError('items contain duplicate tickers');
    }
    seenTickers.add(item.recommendation.ticker);
  }
  const expectedOutputFingerprint = sha256Text(jcsCanonicalize(itemsRaw));
  if (outputFingerprint !== expectedOutputFingerprint) {
    throw new RecommendationContractError('output_fingerprint does not match ordered items');
  }
  for (let index = 1; index < parsed.items.length; index += 1) {
    const previous = parsed.items[index - 1].recommendation;
    const current = parsed.items[index].recommendation;
    const correctlyOrdered =
      previous.conviction.final > current.conviction.final ||
      (previous.conviction.final === current.conviction.final &&
        previous.ticker.localeCompare(current.ticker) <= 0);
    if (!correctlyOrdered) {
      throw new RecommendationContractError('items are not in canonical conviction/ticker order');
    }
  }

  return parsed;
}

export function parseRecommendationSnapshot(value: unknown): RecommendationSnapshot {
  try {
    return parseRecommendationSnapshotUnsafe(value);
  } catch (error) {
    if (error instanceof ContractSchemaError) {
      throw new RecommendationContractError(error.message);
    }
    throw error;
  }
}
