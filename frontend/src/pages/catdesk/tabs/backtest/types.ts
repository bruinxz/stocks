export const BACKTEST_STRATEGIES = [
  'us_preferred',
  'multibagger',
  'japan_blue_chip',
  'korea_semiconductor_chain',
  'japan_multibagger',
  'korea_multibagger',
] as const;

export type BacktestStrategy = (typeof BACKTEST_STRATEGIES)[number];

export interface BacktestSnapshotSlot {
  snapshot_id: string;
  snapshot_day: string;
  strategy: BacktestStrategy;
  as_of_utc: string;
  is_survivorship_biased: boolean;
  is_delisted_at_as_of?: boolean;
  fact_hash: string;
  net_value?: number;
  drawdown?: number;
  cumulative_return?: number;
  sharpe_ratio_6m?: number;
  win_rate_6m?: number;
  source_versions?: Record<string, unknown>;
}

export interface BacktestHolding {
  ticker: string;
  weight: number;
  return_since_entry: number;
  is_stale: boolean;
}

export interface EquityDataPoint {
  date: string;
  netValue: number;
  drawdown: number;
}

export interface RawBacktestSnapshot {
  snapshot_id?: unknown;
  snapshot_day?: unknown;
  strategy?: unknown;
  as_of_utc?: unknown;
  is_survivorship_biased?: unknown;
  is_delisted_at_as_of?: unknown;
  fact_hash?: unknown;
  source_versions?: unknown;
  net_value?: unknown;
  drawdown?: unknown;
  cumulative_return?: unknown;
  sharpe_ratio_6m?: unknown;
  win_rate_6m?: unknown;
  metrics?: unknown;
}

export interface RawBacktestHoldingsResponse {
  holdings?: unknown;
}
