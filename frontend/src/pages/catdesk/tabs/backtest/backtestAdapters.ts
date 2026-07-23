import {
  BACKTEST_MARKET_SCOPES,
  BACKTEST_STRATEGIES,
  type BacktestHolding,
  type BacktestEvidenceBlocker,
  type BacktestEvidenceStatus,
  type BacktestMarketScope,
  type BacktestSnapshotListEnvelope,
  type BacktestSnapshotSlot,
  type BacktestStrategy,
  type RawBacktestSnapshot,
  isBacktestStrategyScopeCompatible,
} from './types';

const STRATEGY_SET = new Set<string>(BACKTEST_STRATEGIES);
const MARKET_SCOPE_SET = new Set<string>(BACKTEST_MARKET_SCOPES);
const METRIC_KEYS = [
  'net_value',
  'drawdown',
  'cumulative_return',
  'sharpe_ratio_6m',
  'win_rate_6m',
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];
type UnknownRecord = Record<string, unknown>;

export class BacktestContractError extends Error {
  constructor(message: string) {
    super(`Backtest API contract error: ${message}`);
    this.name = 'BacktestContractError';
  }
}

function asRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BacktestContractError(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BacktestContractError(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new BacktestContractError(`${label} must be a boolean`);
  }
  return value;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new BacktestContractError(`${label} must be a finite number when present`);
}

function requiredNumber(value: unknown, label: string): number {
  const parsed = optionalNumber(value, label);
  if (parsed == null) {
    throw new BacktestContractError(`${label} is required`);
  }
  return parsed;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  const parsed = requiredNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BacktestContractError(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function optionalRecord(value: unknown, label: string): UnknownRecord | undefined {
  if (value == null) return undefined;
  return asRecord(value, label);
}

function parseStrategy(value: unknown, label: string): BacktestStrategy {
  if (typeof value !== 'string' || !STRATEGY_SET.has(value)) {
    throw new BacktestContractError(`${label} is not an authorized strategy`);
  }
  return value as BacktestStrategy;
}

function parseMarketScope(value: unknown, label: string): BacktestMarketScope {
  if (typeof value !== 'string' || !MARKET_SCOPE_SET.has(value)) {
    throw new BacktestContractError(`${label} is not an authorized market_scope`);
  }
  return value as BacktestMarketScope;
}

function rejectProfileAlias(value: UnknownRecord, label: string): void {
  if ('profile' in value) {
    throw new BacktestContractError(`${label}.profile is a forbidden legacy alias`);
  }
}

function assertCompatibleScope(
  strategy: BacktestStrategy,
  marketScope: BacktestMarketScope,
  label: string
): void {
  if (!isBacktestStrategyScopeCompatible(strategy, marketScope)) {
    throw new BacktestContractError(
      `${label} strategy "${strategy}" is incompatible with market_scope "${marketScope}"`
    );
  }
}

function metricValue(
  raw: RawBacktestSnapshot,
  nestedMetrics: UnknownRecord,
  key: MetricKey,
  index: number
): number | undefined {
  const topLevelValue = raw[key];
  const value = topLevelValue !== undefined ? topLevelValue : nestedMetrics[key];
  return optionalNumber(value, `snapshots[${index}].${key}`);
}

function parseSnapshot(
  value: unknown,
  requestedStrategy: BacktestStrategy,
  requestedMarketScope: BacktestMarketScope,
  index: number
): BacktestSnapshotSlot {
  const rawRecord = asRecord(value, `snapshots[${index}]`);
  rejectProfileAlias(rawRecord, `snapshots[${index}]`);
  const raw = rawRecord as RawBacktestSnapshot;
  const strategy = parseStrategy(raw.strategy, `snapshots[${index}].strategy`);
  if (strategy !== requestedStrategy) {
    throw new BacktestContractError(
      `snapshots[${index}].strategy "${strategy}" does not match request "${requestedStrategy}"`
    );
  }
  const marketScope = parseMarketScope(raw.market_scope, `snapshots[${index}].market_scope`);
  assertCompatibleScope(strategy, marketScope, `snapshots[${index}]`);
  if (marketScope !== requestedMarketScope) {
    throw new BacktestContractError(
      `snapshots[${index}].market_scope "${marketScope}" does not match request "${requestedMarketScope}"`
    );
  }

  const nestedMetrics = optionalRecord(raw.metrics, `snapshots[${index}].metrics`) ?? {};
  return {
    snapshot_id: requiredString(raw.snapshot_id, `snapshots[${index}].snapshot_id`),
    snapshot_day: requiredString(raw.snapshot_day, `snapshots[${index}].snapshot_day`),
    strategy,
    market_scope: marketScope,
    as_of_utc: requiredString(raw.as_of_utc, `snapshots[${index}].as_of_utc`),
    is_survivorship_biased: requiredBoolean(
      raw.is_survivorship_biased,
      `snapshots[${index}].is_survivorship_biased`
    ),
    is_delisted_at_as_of:
      raw.is_delisted_at_as_of == null
        ? undefined
        : requiredBoolean(raw.is_delisted_at_as_of, `snapshots[${index}].is_delisted_at_as_of`),
    fact_hash:
      raw.fact_hash == null ? '' : requiredString(raw.fact_hash, `snapshots[${index}].fact_hash`),
    net_value: metricValue(raw, nestedMetrics, 'net_value', index),
    drawdown: metricValue(raw, nestedMetrics, 'drawdown', index),
    cumulative_return: metricValue(raw, nestedMetrics, 'cumulative_return', index),
    sharpe_ratio_6m: metricValue(raw, nestedMetrics, 'sharpe_ratio_6m', index),
    win_rate_6m: metricValue(raw, nestedMetrics, 'win_rate_6m', index),
    source_versions: optionalRecord(raw.source_versions, `snapshots[${index}].source_versions`),
  };
}

export function parseSnapshotListResponse(
  value: unknown,
  requestedStrategy: BacktestStrategy,
  requestedMarketScope: BacktestMarketScope
): BacktestSnapshotSlot[] {
  const envelope = asRecord(value, 'response');
  rejectProfileAlias(envelope, 'response');
  const envelopeStrategy = parseStrategy(envelope.strategy, 'response.strategy');
  if (envelopeStrategy !== requestedStrategy) {
    throw new BacktestContractError(
      `response.strategy "${envelopeStrategy}" does not match request "${requestedStrategy}"`
    );
  }
  const envelopeMarketScope = parseMarketScope(envelope.market_scope, 'response.market_scope');
  assertCompatibleScope(envelopeStrategy, envelopeMarketScope, 'response');
  if (envelopeMarketScope !== requestedMarketScope) {
    throw new BacktestContractError(
      `response.market_scope "${envelopeMarketScope}" does not match request "${requestedMarketScope}"`
    );
  }
  if (!Array.isArray(envelope.snapshots)) {
    throw new BacktestContractError('response.snapshots must be an array');
  }
  return envelope.snapshots.map((snapshot, index) =>
    parseSnapshot(snapshot, requestedStrategy, requestedMarketScope, index)
  );
}

function parseEvidenceBlocker(value: unknown, index: number): BacktestEvidenceBlocker {
  const raw = asRecord(value, `evidence_status.blockers[${index}]`);
  const observed = optionalNumber(raw.observed, `evidence_status.blockers[${index}].observed`);
  const required = optionalNumber(raw.required, `evidence_status.blockers[${index}].required`);
  return {
    code: requiredString(raw.code, `evidence_status.blockers[${index}].code`),
    title: requiredString(raw.title, `evidence_status.blockers[${index}].title`),
    detail: requiredString(raw.detail, `evidence_status.blockers[${index}].detail`),
    ...(observed == null ? {} : { observed }),
    ...(required == null ? {} : { required }),
    ...(raw.unit == null
      ? {}
      : { unit: requiredString(raw.unit, `evidence_status.blockers[${index}].unit`) }),
  };
}

function parseEvidenceStatus(value: unknown): BacktestEvidenceStatus {
  const raw = asRecord(value, 'evidence_status');
  if (raw.state !== 'ready' && raw.state !== 'blocked') {
    throw new BacktestContractError('evidence_status.state must be ready or blocked');
  }
  if (!Array.isArray(raw.blockers)) {
    throw new BacktestContractError('evidence_status.blockers must be an array');
  }
  const status: BacktestEvidenceStatus = {
    state: raw.state,
    snapshot_count: requiredNonNegativeInteger(
      raw.snapshot_count,
      'evidence_status.snapshot_count'
    ),
    required_checkpoint_count: requiredNonNegativeInteger(
      raw.required_checkpoint_count,
      'evidence_status.required_checkpoint_count'
    ),
    blockers: raw.blockers.map(parseEvidenceBlocker),
  };
  if (status.state === 'ready' && status.blockers.length > 0) {
    throw new BacktestContractError('ready evidence_status must not contain blockers');
  }
  if (status.state === 'blocked' && status.blockers.length === 0) {
    throw new BacktestContractError('blocked evidence_status must contain blockers');
  }
  return status;
}

export function parseSnapshotListEnvelope(
  value: unknown,
  requestedStrategy: BacktestStrategy,
  requestedMarketScope: BacktestMarketScope
): BacktestSnapshotListEnvelope {
  const envelope = asRecord(value, 'response');
  const snapshots = parseSnapshotListResponse(value, requestedStrategy, requestedMarketScope);
  const evidenceStatus = parseEvidenceStatus(envelope.evidence_status);
  if (evidenceStatus.snapshot_count !== snapshots.length) {
    throw new BacktestContractError(
      'evidence_status.snapshot_count must match response.snapshots length'
    );
  }
  if (snapshots.length === 0 && evidenceStatus.state !== 'blocked') {
    throw new BacktestContractError(
      'empty snapshots must be accompanied by blocked evidence_status'
    );
  }
  return { snapshots, evidence_status: evidenceStatus };
}

export function parseHoldingsResponse(value: unknown): BacktestHolding[] {
  const envelope = asRecord(value, 'holdings response');
  if (!Array.isArray(envelope.holdings)) {
    throw new BacktestContractError('holdings response.holdings must be an array');
  }

  return envelope.holdings.map((value, index) => {
    const raw = asRecord(value, `holdings[${index}]`);
    return {
      ticker: requiredString(raw.ticker, `holdings[${index}].ticker`),
      weight: requiredNumber(raw.weight, `holdings[${index}].weight`),
      return_since_entry: requiredNumber(
        raw.return_since_entry,
        `holdings[${index}].return_since_entry`
      ),
      is_stale: requiredBoolean(raw.is_stale, `holdings[${index}].is_stale`),
    };
  });
}
