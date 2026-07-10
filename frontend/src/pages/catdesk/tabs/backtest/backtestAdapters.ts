import {
  BACKTEST_STRATEGIES,
  type BacktestHolding,
  type BacktestSnapshotSlot,
  type BacktestStrategy,
  type RawBacktestSnapshot,
} from './types';

const STRATEGY_SET = new Set<string>(BACKTEST_STRATEGIES);
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
  index: number
): BacktestSnapshotSlot {
  const raw = asRecord(value, `snapshots[${index}]`) as RawBacktestSnapshot;
  const strategy = parseStrategy(raw.strategy, `snapshots[${index}].strategy`);
  if (strategy !== requestedStrategy) {
    throw new BacktestContractError(
      `snapshots[${index}].strategy "${strategy}" does not match request "${requestedStrategy}"`
    );
  }

  const nestedMetrics = optionalRecord(raw.metrics, `snapshots[${index}].metrics`) ?? {};
  return {
    snapshot_id: requiredString(raw.snapshot_id, `snapshots[${index}].snapshot_id`),
    snapshot_day: requiredString(raw.snapshot_day, `snapshots[${index}].snapshot_day`),
    strategy,
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
  requestedStrategy: BacktestStrategy
): BacktestSnapshotSlot[] {
  const envelope = asRecord(value, 'response');
  const envelopeStrategy = parseStrategy(envelope.strategy, 'response.strategy');
  if (envelopeStrategy !== requestedStrategy) {
    throw new BacktestContractError(
      `response.strategy "${envelopeStrategy}" does not match request "${requestedStrategy}"`
    );
  }
  if (!Array.isArray(envelope.snapshots)) {
    throw new BacktestContractError('response.snapshots must be an array');
  }
  return envelope.snapshots.map((snapshot, index) =>
    parseSnapshot(snapshot, requestedStrategy, index)
  );
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
