export const BACKTEST_STRATEGIES = [
  'us_preferred',
  'multibagger',
  'japan_blue_chip',
  'korea_semiconductor_chain',
  'japan_multibagger',
  'korea_multibagger',
] as const;

export type BacktestStrategy = (typeof BACKTEST_STRATEGIES)[number];

export const BACKTEST_MARKET_SCOPES = ['cn_a', 'us', 'jp', 'kr'] as const;

export type BacktestMarketScope = (typeof BACKTEST_MARKET_SCOPES)[number];

export const BACKTEST_STRATEGY_MARKET_SCOPES: Record<
  BacktestStrategy,
  readonly BacktestMarketScope[]
> = {
  us_preferred: ['cn_a', 'us'],
  multibagger: ['cn_a', 'us'],
  japan_blue_chip: ['jp'],
  japan_multibagger: ['jp'],
  korea_semiconductor_chain: ['kr'],
  korea_multibagger: ['kr'],
};

export const DEFAULT_BACKTEST_MARKET_SCOPE: Record<BacktestStrategy, BacktestMarketScope> = {
  us_preferred: 'us',
  multibagger: 'us',
  japan_blue_chip: 'jp',
  japan_multibagger: 'jp',
  korea_semiconductor_chain: 'kr',
  korea_multibagger: 'kr',
};

export function isBacktestStrategyScopeCompatible(
  strategy: BacktestStrategy,
  marketScope: BacktestMarketScope
): boolean {
  return BACKTEST_STRATEGY_MARKET_SCOPES[strategy].includes(marketScope);
}

export function coerceBacktestMarketScope(
  strategy: BacktestStrategy,
  currentScope: BacktestMarketScope
): BacktestMarketScope {
  return isBacktestStrategyScopeCompatible(strategy, currentScope)
    ? currentScope
    : DEFAULT_BACKTEST_MARKET_SCOPE[strategy];
}

export interface BacktestSnapshotSlot {
  snapshot_id: string;
  snapshot_day: string;
  strategy: BacktestStrategy;
  market_scope: BacktestMarketScope;
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

export interface BacktestEvidenceBlocker {
  code: string;
  title: string;
  detail: string;
  observed?: number;
  required?: number;
  unit?: string;
}

export interface BacktestEvidenceStatus {
  state: 'ready' | 'blocked';
  snapshot_count: number;
  required_checkpoint_count: number;
  blockers: BacktestEvidenceBlocker[];
}

export interface BacktestSnapshotListEnvelope {
  snapshots: BacktestSnapshotSlot[];
  evidence_status: BacktestEvidenceStatus;
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
  market_scope?: unknown;
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
