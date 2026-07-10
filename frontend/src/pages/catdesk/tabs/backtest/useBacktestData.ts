import { useState, useMemo, useCallback } from 'react';
import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import type {
  BacktestSnapshotSlot,
  BacktestHolding,
  BacktestStrategy,
  RawBacktestSnapshot,
  RawBacktestHoldingsResponse,
} from './types';
import { buildBacktestHoldingsUrl, buildBacktestListUrl } from './backtestUrls';

interface UseBacktestDataOptions {
  strategy: BacktestStrategy;
  from?: string;
  to?: string;
  limit?: number;
}

interface SnapshotListResponse {
  strategy?: unknown;
  snapshots?: RawBacktestSnapshot[];
}

const STRATEGIES = new Set<BacktestStrategy>([
  'us_preferred',
  'multibagger',
  'japan_blue_chip',
  'korea_semiconductor_chain',
  'japan_multibagger',
  'korea_multibagger',
]);

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function mapSnapshot(
  raw: RawBacktestSnapshot,
  requestedStrategy: BacktestStrategy
): BacktestSnapshotSlot | null {
  const snapshotId = typeof raw.snapshot_id === 'string' ? raw.snapshot_id : '';
  const snapshotDay = typeof raw.snapshot_day === 'string' ? raw.snapshot_day : '';
  const asOfUtc = typeof raw.as_of_utc === 'string' ? raw.as_of_utc : '';
  if (!snapshotId || !snapshotDay || !asOfUtc) return null;

  const rawStrategy = typeof raw.strategy === 'string' ? raw.strategy : '';
  const strategy = STRATEGIES.has(rawStrategy as BacktestStrategy)
    ? (rawStrategy as BacktestStrategy)
    : requestedStrategy;
  const metrics = optionalRecord(raw.metrics) ?? {};

  return {
    snapshot_id: snapshotId,
    snapshot_day: snapshotDay,
    strategy,
    as_of_utc: asOfUtc,
    is_survivorship_biased: raw.is_survivorship_biased === true,
    is_delisted_at_as_of: raw.is_delisted_at_as_of === true,
    fact_hash: typeof raw.fact_hash === 'string' ? raw.fact_hash : '',
    net_value: optionalNumber(metrics.net_value),
    drawdown: optionalNumber(metrics.drawdown),
    cumulative_return: optionalNumber(metrics.cumulative_return),
    sharpe_ratio_6m: optionalNumber(metrics.sharpe_ratio_6m),
    win_rate_6m: optionalNumber(metrics.win_rate_6m),
    source_versions: optionalRecord(raw.source_versions),
  };
}

function mapHolding(raw: unknown): BacktestHolding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.ticker !== 'string') return null;

  const weight = optionalNumber(item.weight);
  const returnSinceEntry = optionalNumber(item.return_since_entry);
  if (weight == null || returnSinceEntry == null) return null;

  return {
    ticker: item.ticker,
    weight,
    return_since_entry: returnSinceEntry,
    is_stale: item.is_stale === true,
  };
}

export function useBacktestData({ strategy, from, to, limit = 60 }: UseBacktestDataOptions) {
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);

  const snapshotListUrl = useMemo(() => {
    return buildBacktestListUrl(strategy, { from, to, limit });
  }, [strategy, from, to, limit]);

  const {
    data: snapshotsRaw,
    loading: snapshotsLoading,
    error: snapshotsError,
    refetch: refetchSnapshots,
  } = useAbortableRequest<SnapshotListResponse>(
    signal =>
      fetch(snapshotListUrl, { signal }).then(r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      }),
    [snapshotListUrl]
  );

  const snapshots = useMemo(
    () =>
      (snapshotsRaw?.snapshots ?? [])
        .map(snapshot => mapSnapshot(snapshot, strategy))
        .filter((snapshot): snapshot is BacktestSnapshotSlot => snapshot != null),
    [snapshotsRaw, strategy]
  );

  const selectedSnapshot = useMemo(
    () => snapshots.find(s => s.snapshot_id === selectedSnapshotId) ?? null,
    [snapshots, selectedSnapshotId]
  );

  const holdingsUrl = useMemo(() => {
    if (!selectedSnapshot) return null;
    return buildBacktestHoldingsUrl(strategy, selectedSnapshot);
  }, [strategy, selectedSnapshot]);

  const {
    data: holdingsRaw,
    loading: holdingsLoading,
    error: holdingsError,
  } = useAbortableRequest<RawBacktestHoldingsResponse | null>(
    signal => {
      if (!holdingsUrl) return Promise.resolve(null);
      return fetch(holdingsUrl, { signal }).then(r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      });
    },
    [holdingsUrl]
  );

  const holdings = useMemo(() => {
    const raw = holdingsRaw?.holdings;
    if (!Array.isArray(raw)) return [];
    return raw.map(mapHolding).filter((holding): holding is BacktestHolding => holding != null);
  }, [holdingsRaw]);

  const selectSnapshot = useCallback((id: string | null) => {
    setSelectedSnapshotId(id);
  }, []);

  return {
    snapshots,
    selectedSnapshot,
    holdings,
    loading: snapshotsLoading,
    holdingsLoading,
    error: snapshotsError,
    holdingsError,
    selectSnapshot,
    refetchSnapshots,
  };
}
