import {
  isBacktestStrategyScopeCompatible,
  type BacktestMarketScope,
  type BacktestSnapshotSlot,
  type BacktestStrategy,
} from './types';

export interface BacktestListQuery {
  marketScope: BacktestMarketScope;
  from?: string;
  to?: string;
  limit: number;
}

function assertCompatibleScope(strategy: BacktestStrategy, marketScope: BacktestMarketScope): void {
  if (!isBacktestStrategyScopeCompatible(strategy, marketScope)) {
    throw new Error(`market_scope "${marketScope}" is incompatible with strategy "${strategy}"`);
  }
}

export function buildBacktestListUrl(
  strategy: BacktestStrategy,
  { marketScope, from, to, limit }: BacktestListQuery
): string {
  assertCompatibleScope(strategy, marketScope);
  const params = new URLSearchParams();
  params.set('market_scope', marketScope);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('limit', String(limit));
  return `/api/v1/backtest-pit/${encodeURIComponent(strategy)}?${params}`;
}

export function buildBacktestSnapshotUrl(
  strategy: BacktestStrategy,
  marketScope: BacktestMarketScope,
  asOfUtc: string
): string {
  assertCompatibleScope(strategy, marketScope);
  const params = new URLSearchParams({ market_scope: marketScope });
  return `/api/v1/backtest-pit/${encodeURIComponent(strategy)}/${encodeURIComponent(asOfUtc)}?${params}`;
}

export function buildBacktestHoldingsUrl(
  strategy: BacktestStrategy,
  selectedSnapshot: Pick<BacktestSnapshotSlot, 'strategy' | 'market_scope' | 'as_of_utc'>
): string {
  if (selectedSnapshot.strategy !== strategy) {
    throw new Error(
      `selected snapshot strategy "${selectedSnapshot.strategy}" does not match "${strategy}"`
    );
  }
  assertCompatibleScope(strategy, selectedSnapshot.market_scope);
  const params = new URLSearchParams({ market_scope: selectedSnapshot.market_scope });
  return `/api/v1/backtest-pit/${encodeURIComponent(strategy)}/${encodeURIComponent(selectedSnapshot.as_of_utc)}/holdings?${params}`;
}
