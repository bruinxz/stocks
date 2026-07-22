import {
  RISK_GATE_TRIGGER_CODES_V0_3,
  type Conviction,
  type EntryPlan,
  type RiskGate,
  type Score,
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
  strictSha256,
  strictString,
  strictStringArray,
  strictUuidV4,
} from '../daily-report/contractSchema';
import type {
  MultibaggerConclusion,
  MultibaggerKpi,
  MultibaggerMarket,
  MultibaggerResponse,
  MultibaggerRow,
  MultibaggerStage,
} from './types';

type UnknownRecord = Record<string, unknown>;

const MARKETS = new Set<MultibaggerMarket>(['A', 'US', 'JP', 'KR']);
const STAGE_VALUES = ['seed', 'early', 'growth', 'break_below', 'deep'] as const;
const STAGES = new Set<MultibaggerStage>(STAGE_VALUES);
const CONCLUSION_VALUES = ['MULTIBAGGER_2X', 'MULTIBAGGER_5X', 'MULTIBAGGER_10X', 'SKIP'] as const;
const CONCLUSIONS = new Set<MultibaggerConclusion>(CONCLUSION_VALUES);
const BANDS = new Set(['A', 'B', 'C', 'D', 'F']);
const CONVICTION_LEVELS = new Set(['HIGH', 'MED', 'LOW']);
const GATES = new Set(['GREEN', 'YELLOW', 'RED']);
const SEVERITIES = new Set(['info', 'warn', 'block']);
const CATALYST_KINDS = new Set([
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
const CURRENCIES = new Set(['USD', 'CNY', 'HKD', 'JPY', 'KRW']);
const HORIZONS = new Set(['INTRADAY', 'SWING', 'POSITION', 'CORE_HOLD', 'LONG_TERM']);
const SIZE_HINT_PCT = { TIER_5: 5, TIER_3: 3, TIER_2: 2, TIER_1: 1, SKIP: 0 } as const;
const DIMENSIONS = ['quality', 'growth', 'valuation', 'moat', 'trend', 'risk'] as const;
const SOURCE_VERSION_KEYS = [
  'quality_engine',
  'growth_engine',
  'valuation_engine',
  'moat_engine',
  'trend_engine',
  'risk_engine',
] as const;
const MARKET_SCOPE: Record<MultibaggerMarket, string> = {
  A: 'cn_a',
  US: 'us',
  JP: 'jp',
  KR: 'kr',
};
const MARKET_EXCHANGES: Record<MultibaggerMarket, readonly string[]> = {
  A: ['sh', 'sz', 'bj'],
  US: ['nyse', 'nasdaq'],
  JP: ['tse', 'ose'],
  KR: ['krx', 'kosdaq'],
};
const PROFILE_SCOPE: Record<string, readonly string[]> = {
  multibagger: ['cn_a', 'us'],
  japan_multibagger: ['jp'],
  korea_multibagger: ['kr'],
};

export class MultibaggerContractError extends Error {
  constructor(message: string) {
    super(`Multibagger API contract error: ${message}`);
    this.name = 'MultibaggerContractError';
  }
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, path: string): T {
  const parsed = strictString(value, path) as T;
  if (!allowed.has(parsed)) throw new ContractSchemaError(`${path} is not authorized`);
  return parsed;
}

function looseObject(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ContractSchemaError(`${path} must be an object`);
  }
  return value as UnknownRecord;
}

function sortedUnique(values: string[], path: string): string[] {
  if (
    new Set(values).size !== values.length ||
    [...values].sort().some((value, i) => value !== values[i])
  ) {
    throw new ContractSchemaError(`${path} must be sorted and unique`);
  }
  return values;
}

function parseDimension(value: unknown, path: string) {
  const raw = assertExactObject(value, ['score', 'band', 'evidence', 'inputs'], [], path);
  return {
    score: strictNumber(raw.score, `${path}.score`, { min: 0, max: 100 }),
    band: enumValue(raw.band, BANDS, `${path}.band`),
    evidence: strictStringArray(raw.evidence, `${path}.evidence`, { min: 1, itemMax: 200 }),
    inputs: looseObject(raw.inputs, `${path}.inputs`),
  };
}

function parseScore(
  value: unknown,
  symbol: string,
  market: MultibaggerMarket,
  asOf: string
): Score | null {
  if (value === null) return null;
  const keys = [
    'scoring_id',
    'snapshot_hash',
    'ticker',
    'as_of',
    'market_scope',
    ...DIMENSIONS,
    'weights',
    'weights_profile',
    'total',
    'rating',
    'computed_at',
    'source_versions',
  ];
  const raw = assertExactObject(value, keys, [], 'row.score');
  const ticker = strictString(raw.ticker, 'row.score.ticker');
  if (ticker !== symbol)
    throw new ContractSchemaError('row.score.ticker does not match row.symbol');
  const marketScope = strictString(raw.market_scope, 'row.score.market_scope');
  if (marketScope !== MARKET_SCOPE[market]) {
    throw new ContractSchemaError('row.score.market_scope does not match row.market');
  }
  const scoreAsOf = strictIso8601(raw.as_of, 'row.score.as_of');
  const computedAt = strictIso8601(raw.computed_at, 'row.score.computed_at');
  if (Date.parse(computedAt) > Date.parse(asOf)) {
    throw new ContractSchemaError('row.score.computed_at exceeds candidate as_of_utc');
  }

  const weightsRaw = assertExactObject(raw.weights, DIMENSIONS, [], 'row.score.weights');
  const weights = Object.fromEntries(
    DIMENSIONS.map(key => [
      key,
      strictNumber(weightsRaw[key], `row.score.weights.${key}`, { min: 0, max: 1 }),
    ])
  ) as unknown as Score['weights'];
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (Math.abs(weightTotal - 1) > 1e-9) {
    throw new ContractSchemaError('row.score.weights must sum to 1');
  }
  const profile = strictString(raw.weights_profile, 'row.score.weights_profile');
  if (!PROFILE_SCOPE[profile]?.includes(marketScope)) {
    throw new ContractSchemaError('row.score.weights_profile is incompatible with market_scope');
  }
  const sourceVersionsRaw = assertExactObject(
    raw.source_versions,
    SOURCE_VERSION_KEYS,
    [],
    'row.score.source_versions'
  );
  const sourceVersions = Object.fromEntries(
    SOURCE_VERSION_KEYS.map(key => [
      key,
      strictString(sourceVersionsRaw[key], `row.score.source_versions.${key}`),
    ])
  ) as unknown as Score['source_versions'];
  const dimensions = Object.fromEntries(
    DIMENSIONS.map(key => [key, parseDimension(raw[key], `row.score.${key}`)])
  ) as Pick<Score, (typeof DIMENSIONS)[number]>;
  const scoringId = strictUuidV4(raw.scoring_id, 'row.score.scoring_id');
  const snapshotHash = strictSha256(raw.snapshot_hash, 'row.score.snapshot_hash');
  const rating = enumValue(raw.rating, BANDS, 'row.score.rating');
  const hashBody = { ...raw };
  delete hashBody.scoring_id;
  delete hashBody.snapshot_hash;
  if (sha256Text(jcsCanonicalize(hashBody)) !== snapshotHash) {
    throw new ContractSchemaError('row.score.snapshot_hash does not authenticate score');
  }
  return {
    scoring_id: scoringId,
    snapshot_hash: snapshotHash,
    ticker,
    as_of: scoreAsOf,
    market_scope: marketScope as Score['market_scope'],
    ...dimensions,
    weights,
    weights_profile: profile as Score['weights_profile'],
    total: strictNumber(raw.total, 'row.score.total', { min: 0, max: 100 }),
    rating: rating as Score['rating'],
    computed_at: computedAt,
    source_versions: sourceVersions,
  };
}

function parseScoreRef(value: unknown, score: Score, path: string) {
  const raw = assertExactObject(value, ['scoring_id', 'snapshot_hash'], [], path);
  const reference = {
    scoring_id: strictUuidV4(raw.scoring_id, `${path}.scoring_id`),
    snapshot_hash: strictSha256(raw.snapshot_hash, `${path}.snapshot_hash`),
  };
  if (
    reference.scoring_id !== score.scoring_id ||
    reference.snapshot_hash !== score.snapshot_hash
  ) {
    throw new ContractSchemaError(`${path} does not match score`);
  }
  return reference;
}

function parseConviction(value: unknown, score: Score, symbol: string): Conviction | undefined {
  if (value === null) return undefined;
  const raw = assertExactObject(
    value,
    ['ticker', 'as_of', 'base', 'score_ref', 'adjustments', 'final', 'level'],
    [],
    'row.conviction'
  );
  if (strictString(raw.ticker, 'row.conviction.ticker') !== symbol) {
    throw new ContractSchemaError('row.conviction.ticker does not match row.symbol');
  }
  const adjustments = strictArray(raw.adjustments, 'row.conviction.adjustments', { max: 5 }).map(
    (value, index) => {
      const item = assertExactObject(
        value,
        ['delta', 'reason'],
        ['kind_ref', 'source_ref'],
        `row.conviction.adjustments[${index}]`
      );
      return {
        delta: strictNumber(item.delta, `row.conviction.adjustments[${index}].delta`, {
          min: -20,
          max: 20,
        }),
        reason: strictString(item.reason, `row.conviction.adjustments[${index}].reason`, {
          max: 200,
        }),
        ...(item.kind_ref === undefined
          ? {}
          : {
              kind_ref: enumValue(
                item.kind_ref,
                CATALYST_KINDS,
                `row.conviction.adjustments[${index}].kind_ref`
              ),
            }),
        ...(item.source_ref === undefined
          ? {}
          : {
              source_ref: strictString(
                item.source_ref,
                `row.conviction.adjustments[${index}].source_ref`
              ),
            }),
      };
    }
  );
  return {
    ticker: symbol,
    as_of: strictIso8601(raw.as_of, 'row.conviction.as_of'),
    base: strictNumber(raw.base, 'row.conviction.base', { min: 0, max: 100 }),
    score_ref: parseScoreRef(raw.score_ref, score, 'row.conviction.score_ref'),
    adjustments: adjustments as Conviction['adjustments'],
    final: strictNumber(raw.final, 'row.conviction.final', { min: 0, max: 100 }),
    level: enumValue(raw.level, CONVICTION_LEVELS, 'row.conviction.level') as Conviction['level'],
  };
}

function parseRiskGate(value: unknown, symbol: string, asOf: string): RiskGate | undefined {
  if (value === null) return undefined;
  const raw = assertExactObject(
    value,
    ['ticker', 'evaluated_at', 'gate', 'triggers', 'ok_to_enter'],
    [],
    'row.risk_gate'
  );
  if (strictString(raw.ticker, 'row.risk_gate.ticker') !== symbol) {
    throw new ContractSchemaError('row.risk_gate.ticker does not match row.symbol');
  }
  const evaluatedAt = strictIso8601(raw.evaluated_at, 'row.risk_gate.evaluated_at');
  if (Date.parse(evaluatedAt) > Date.parse(asOf)) {
    throw new ContractSchemaError('row.risk_gate.evaluated_at exceeds candidate as_of_utc');
  }
  const triggerCodes = new Set<string>(RISK_GATE_TRIGGER_CODES_V0_3);
  const triggers = strictArray(raw.triggers, 'row.risk_gate.triggers').map((value, index) => {
    const item = assertExactObject(
      value,
      ['code', 'severity', 'detail'],
      [],
      `row.risk_gate.triggers[${index}]`
    );
    return {
      code: enumValue(item.code, triggerCodes, `row.risk_gate.triggers[${index}].code`),
      severity: enumValue(item.severity, SEVERITIES, `row.risk_gate.triggers[${index}].severity`),
      detail: strictString(item.detail, `row.risk_gate.triggers[${index}].detail`, { max: 240 }),
    };
  });
  const gate = enumValue(raw.gate, GATES, 'row.risk_gate.gate');
  const expectedGate = triggers.some(trigger => trigger.severity === 'block')
    ? 'RED'
    : triggers.some(trigger => trigger.severity === 'warn')
      ? 'YELLOW'
      : 'GREEN';
  const okToEnter = strictBoolean(raw.ok_to_enter, 'row.risk_gate.ok_to_enter');
  if (gate !== expectedGate || okToEnter !== (gate === 'GREEN')) {
    throw new ContractSchemaError('row.risk_gate derived state is inconsistent');
  }
  return {
    ticker: symbol,
    evaluated_at: evaluatedAt,
    gate: gate as RiskGate['gate'],
    triggers: triggers as RiskGate['triggers'],
    ok_to_enter: okToEnter,
  };
}

function parseCurrency(value: unknown, path: string): string {
  return enumValue(value, CURRENCIES, path);
}

function parseEntryPlan(
  value: unknown,
  score: Score,
  conviction: Conviction,
  symbol: string,
  asOf: string
): EntryPlan | undefined {
  if (value === null) return undefined;
  const raw = assertExactObject(
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
    'row.entry_plan'
  );
  if (strictString(raw.ticker, 'row.entry_plan.ticker') !== symbol) {
    throw new ContractSchemaError('row.entry_plan.ticker does not match row.symbol');
  }
  const generatedAt = strictIso8601(raw.generated_at, 'row.entry_plan.generated_at');
  if (Date.parse(generatedAt) > Date.parse(asOf)) {
    throw new ContractSchemaError('row.entry_plan.generated_at exceeds candidate as_of_utc');
  }
  const entryRaw = assertExactObject(
    raw.entry,
    ['low', 'high', 'currency'],
    [],
    'row.entry_plan.entry'
  );
  const low = strictNumber(entryRaw.low, 'row.entry_plan.entry.low');
  const high = strictNumber(entryRaw.high, 'row.entry_plan.entry.high');
  if (low > high) throw new ContractSchemaError('row.entry_plan.entry.low exceeds high');
  const stopRaw = assertExactObject(raw.stop, ['value', 'currency'], [], 'row.entry_plan.stop');
  const targets = strictArray(raw.targets, 'row.entry_plan.targets', { min: 1 }).map(
    (value, index) => {
      const target = assertExactObject(
        value,
        ['value', 'currency'],
        [],
        `row.entry_plan.targets[${index}]`
      );
      return {
        value: strictNumber(target.value, `row.entry_plan.targets[${index}].value`),
        currency: parseCurrency(target.currency, `row.entry_plan.targets[${index}].currency`),
      };
    }
  );
  const sizeHintRaw = assertExactObject(
    raw.size_hint,
    ['tier', 'pct', 'disclaimer_key', 'rationale'],
    [],
    'row.entry_plan.size_hint'
  );
  const tier = enumValue(
    sizeHintRaw.tier,
    new Set(Object.keys(SIZE_HINT_PCT)),
    'row.entry_plan.size_hint.tier'
  ) as keyof typeof SIZE_HINT_PCT;
  const pct = strictNumber(sizeHintRaw.pct, 'row.entry_plan.size_hint.pct', { min: 0, max: 5 });
  if (pct !== SIZE_HINT_PCT[tier]) {
    throw new ContractSchemaError('row.entry_plan.size_hint.pct does not match tier');
  }
  const convictionRef = strictNumber(raw.conviction_ref, 'row.entry_plan.conviction_ref');
  if (convictionRef !== conviction.final) {
    throw new ContractSchemaError('row.entry_plan.conviction_ref does not match conviction.final');
  }
  if (
    strictString(sizeHintRaw.disclaimer_key, 'row.entry_plan.size_hint.disclaimer_key') !==
    'size_hint_advisory'
  ) {
    throw new ContractSchemaError('row.entry_plan.size_hint.disclaimer_key is not authorized');
  }
  return {
    ticker: symbol,
    generated_at: generatedAt,
    entry: {
      low,
      high,
      currency: parseCurrency(
        entryRaw.currency,
        'row.entry_plan.entry.currency'
      ) as EntryPlan['entry']['currency'],
    },
    stop: {
      value: strictNumber(stopRaw.value, 'row.entry_plan.stop.value'),
      currency: parseCurrency(stopRaw.currency, 'row.entry_plan.stop.currency'),
    },
    targets,
    size_hint: {
      tier,
      pct,
      disclaimer_key: 'size_hint_advisory',
      rationale: strictString(sizeHintRaw.rationale, 'row.entry_plan.size_hint.rationale'),
    },
    time_horizon: enumValue(
      raw.time_horizon,
      HORIZONS,
      'row.entry_plan.time_horizon'
    ) as EntryPlan['time_horizon'],
    invalidation: strictString(raw.invalidation, 'row.entry_plan.invalidation'),
    conviction_ref: convictionRef,
    score_ref: parseScoreRef(raw.score_ref, score, 'row.entry_plan.score_ref'),
  };
}

function parseCandidate(value: unknown, path: string): MultibaggerRow {
  const raw = assertExactObject(
    value,
    [
      'symbol',
      'name',
      'score',
      'rating_band',
      'conviction',
      'risk_gate',
      'entry_plan',
      'latest_catalyst',
      'market',
      'market_scope',
      'exchange',
      'stage',
      'conclusion',
      'fact_hash',
      'source_fact_hashes',
      'as_of_utc',
      'available_at_utc',
      'strategy_version',
      'classification_policy_version',
      'classification_reason_codes',
    ],
    ['research_day'],
    path
  );
  const symbol = strictString(raw.symbol, `${path}.symbol`);
  const market = enumValue(raw.market, MARKETS, `${path}.market`);
  const marketScope = strictString(raw.market_scope, `${path}.market_scope`);
  if (marketScope !== MARKET_SCOPE[market]) {
    throw new ContractSchemaError(`${path}.market_scope does not match market`);
  }
  const exchange = strictString(raw.exchange, `${path}.exchange`);
  if (!MARKET_EXCHANGES[market].includes(exchange)) {
    throw new ContractSchemaError(`${path}.exchange does not match market`);
  }
  const asOf = strictIso8601(raw.as_of_utc, `${path}.as_of_utc`);
  const availableAt = strictIso8601(raw.available_at_utc, `${path}.available_at_utc`);
  if (Date.parse(availableAt) > Date.parse(asOf)) {
    throw new ContractSchemaError(`${path}.available_at_utc exceeds as_of_utc`);
  }
  const score = parseScore(raw.score, symbol, market, asOf);
  const rating = enumValue(raw.rating_band, BANDS, `${path}.rating_band`);
  if (score && score.rating !== rating) {
    throw new ContractSchemaError(`${path}.rating_band does not mirror score.rating`);
  }
  const conviction = score ? parseConviction(raw.conviction, score, symbol) : undefined;
  const riskGate = parseRiskGate(raw.risk_gate, symbol, asOf);
  const entryPlan =
    score && conviction
      ? parseEntryPlan(raw.entry_plan, score, conviction, symbol, asOf)
      : undefined;
  if (!score && (raw.conviction !== null || raw.entry_plan !== null)) {
    throw new ContractSchemaError(`${path} cannot expose conviction/entry_plan without score`);
  }
  const catalyst =
    raw.latest_catalyst === null
      ? undefined
      : (() => {
          const item = assertExactObject(
            raw.latest_catalyst,
            ['kind', 'title', 'occurred_at', 'available_at_utc', 'source_ref', 'fact_hash'],
            [],
            `${path}.latest_catalyst`
          );
          const occurredAt = strictIso8601(item.occurred_at, `${path}.latest_catalyst.occurred_at`);
          if (Date.parse(occurredAt) > Date.parse(asOf)) {
            throw new ContractSchemaError(`${path}.latest_catalyst.occurred_at exceeds as_of_utc`);
          }
          const catalystAvailableAt = strictIso8601(
            item.available_at_utc,
            `${path}.latest_catalyst.available_at_utc`
          );
          if (
            Date.parse(occurredAt) > Date.parse(catalystAvailableAt) ||
            Date.parse(catalystAvailableAt) > Date.parse(asOf)
          ) {
            throw new ContractSchemaError(`${path}.latest_catalyst is not PIT-visible`);
          }
          const sourceRef = strictString(item.source_ref, `${path}.latest_catalyst.source_ref`);
          const catalystFactHash = strictSha256(
            item.fact_hash,
            `${path}.latest_catalyst.fact_hash`
          );
          return {
            kind: enumValue(
              item.kind,
              CATALYST_KINDS,
              `${path}.latest_catalyst.kind`
            ) as NonNullable<MultibaggerRow['latest_catalyst']>['kind'],
            title: strictString(item.title, `${path}.latest_catalyst.title`),
            occurred_at: occurredAt,
            available_at_utc: catalystAvailableAt,
            source_ref: sourceRef,
            fact_hash: catalystFactHash,
          };
        })();
  const sourceHashes = sortedUnique(
    strictStringArray(raw.source_fact_hashes, `${path}.source_fact_hashes`, { min: 1 }).map(
      (hash, index) => strictSha256(hash, `${path}.source_fact_hashes[${index}]`)
    ),
    `${path}.source_fact_hashes`
  );
  const reasonCodes = sortedUnique(
    strictStringArray(raw.classification_reason_codes, `${path}.classification_reason_codes`, {
      min: 1,
      itemMax: 100,
    }),
    `${path}.classification_reason_codes`
  );
  if (catalyst && !sourceHashes.includes(catalyst.fact_hash)) {
    throw new ContractSchemaError(`${path}.latest_catalyst.fact_hash is outside source closure`);
  }
  return {
    symbol,
    name: strictString(raw.name, `${path}.name`),
    score,
    rating_band: rating as MultibaggerRow['rating_band'],
    ...(conviction ? { conviction } : {}),
    ...(riskGate ? { risk_gate: riskGate } : {}),
    ...(entryPlan ? { entry_plan: entryPlan } : {}),
    ...(catalyst ? { latest_catalyst: catalyst } : {}),
    market,
    market_scope: marketScope as MultibaggerRow['market_scope'],
    exchange,
    stage: enumValue(raw.stage, STAGES, `${path}.stage`),
    conclusion: enumValue(raw.conclusion, CONCLUSIONS, `${path}.conclusion`),
    fact_hash: strictSha256(raw.fact_hash, `${path}.fact_hash`),
    source_fact_hashes: sourceHashes,
    as_of_utc: asOf,
    available_at_utc: availableAt,
    strategy_version: strictString(raw.strategy_version, `${path}.strategy_version`),
    classification_policy_version: strictString(
      raw.classification_policy_version,
      `${path}.classification_policy_version`
    ),
    classification_reason_codes: reasonCodes,
    research_day:
      raw.research_day === null || raw.research_day === undefined
        ? null
        : strictString(raw.research_day, `${path}.research_day`),
  };
}

function parseCounterMap<T extends string>(
  value: unknown,
  keys: readonly T[],
  path: string
): Record<T, number> {
  const raw = assertExactObject(value, keys, [], path);
  return Object.fromEntries(
    keys.map(key => [key, strictNumber(raw[key], `${path}.${key}`, { min: 0, integer: true })])
  ) as Record<T, number>;
}

function parseUnsafe(value: unknown): MultibaggerResponse {
  const envelope = assertExactObject(value, ['kpi', 'rows'], [], 'response');
  const rows = strictArray(envelope.rows, 'response.rows', { max: 200 }).map((row, index) =>
    parseCandidate(row, `response.rows[${index}]`)
  );
  const kpiRaw = assertExactObject(
    envelope.kpi,
    ['total_candidates', 'stage_distribution', 'conclusion_coverage'],
    [],
    'response.kpi'
  );
  const kpi: MultibaggerKpi = {
    total_candidates: strictNumber(kpiRaw.total_candidates, 'response.kpi.total_candidates', {
      min: 0,
      integer: true,
    }),
    stage_distribution: parseCounterMap(
      kpiRaw.stage_distribution,
      STAGE_VALUES,
      'response.kpi.stage_distribution'
    ),
    conclusion_coverage: parseCounterMap(
      kpiRaw.conclusion_coverage,
      CONCLUSION_VALUES,
      'response.kpi.conclusion_coverage'
    ),
  };
  const stageTotal = Object.values(kpi.stage_distribution).reduce((sum, count) => sum + count, 0);
  const conclusionTotal = Object.values(kpi.conclusion_coverage).reduce(
    (sum, count) => sum + count,
    0
  );
  if (
    kpi.total_candidates !== rows.length ||
    stageTotal !== rows.length ||
    conclusionTotal !== rows.length
  ) {
    throw new ContractSchemaError('response.kpi counts do not match rows');
  }
  return { kpi, rows };
}

export function parseMultibaggerResponse(value: unknown): MultibaggerResponse {
  try {
    return parseUnsafe(value);
  } catch (error) {
    if (error instanceof MultibaggerContractError) throw error;
    const message = error instanceof Error ? error.message : 'unknown contract failure';
    throw new MultibaggerContractError(message);
  }
}

export function parseMultibaggerDetail(value: unknown): MultibaggerRow {
  try {
    return parseCandidate(value, 'response');
  } catch (error) {
    if (error instanceof MultibaggerContractError) throw error;
    const message = error instanceof Error ? error.message : 'unknown contract failure';
    throw new MultibaggerContractError(message);
  }
}
