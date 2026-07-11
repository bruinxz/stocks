import { useState, useMemo, useCallback } from 'react';
import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import type {
  BacktestHolding,
  BacktestMarketScope,
  BacktestSnapshotSlot,
  BacktestStrategy,
} from './types';
import { parseHoldingsResponse, parseSnapshotListResponse } from './backtestAdapters';
import { buildBacktestHoldingsUrl, buildBacktestListUrl } from './backtestUrls';

interface UseBacktestDataOptions {
  strategy: BacktestStrategy;
  marketScope: BacktestMarketScope;
  from?: string;
  to?: string;
  limit?: number;
}

export function useBacktestData({
  strategy,
  marketScope,
  from,
  to,
  limit = 60,
}: UseBacktestDataOptions) {
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);

  const snapshotListUrl = useMemo(() => {
    return buildBacktestListUrl(strategy, { marketScope, from, to, limit });
  }, [strategy, marketScope, from, to, limit]);

  const {
    data: snapshotsRaw,
    loading: snapshotsLoading,
    error: snapshotsError,
    refetch: refetchSnapshots,
  } = useAbortableRequest<BacktestSnapshotSlot[]>(
    async signal => {
      const response = await fetch(snapshotListUrl, { signal });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return parseSnapshotListResponse(await response.json(), strategy, marketScope);
    },
    [snapshotListUrl, strategy, marketScope]
  );

  const snapshots = useMemo(() => snapshotsRaw ?? [], [snapshotsRaw]);

  const selectedSnapshot = useMemo(
    () => snapshots.find(snapshot => snapshot.snapshot_id === selectedSnapshotId) ?? null,
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
  } = useAbortableRequest<BacktestHolding[] | null>(
    async signal => {
      if (!holdingsUrl) return null;
      const response = await fetch(holdingsUrl, { signal });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return parseHoldingsResponse(await response.json());
    },
    [holdingsUrl]
  );

  const holdings = holdingsRaw ?? [];

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
