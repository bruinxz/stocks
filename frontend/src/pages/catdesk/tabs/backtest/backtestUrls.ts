import type { BacktestSnapshotSlot, BacktestStrategy } from './types';

export interface BacktestListQuery {
  from?: string;
  to?: string;
  limit: number;
}

export function buildBacktestListUrl(
  strategy: BacktestStrategy,
  { from, to, limit }: BacktestListQuery
): string {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('limit', String(limit));
  return `/api/v1/backtest-pit/${encodeURIComponent(strategy)}?${params}`;
}

export function buildBacktestHoldingsUrl(
  strategy: BacktestStrategy,
  selectedSnapshot: Pick<BacktestSnapshotSlot, 'as_of_utc'>
): string {
  return `/api/v1/backtest-pit/${encodeURIComponent(strategy)}/${encodeURIComponent(selectedSnapshot.as_of_utc)}/holdings`;
}
