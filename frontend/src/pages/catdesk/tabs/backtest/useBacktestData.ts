import { useState, useMemo, useCallback } from 'react';
import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import { authenticatedFetch } from 'services/api';
import type {
  BacktestHolding,
  BacktestSnapshotListEnvelope,
  BacktestMarketScope,
  BacktestStrategy,
} from './types';
import { parseHoldingsResponse, parseSnapshotListEnvelope } from './backtestAdapters';
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
    data: snapshotEnvelope,
    loading: snapshotsLoading,
    error: snapshotsError,
    refetch: refetchSnapshots,
  } = useAbortableRequest<BacktestSnapshotListEnvelope>(
    async signal => {
      const response = await authenticatedFetch(snapshotListUrl, { signal });
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      return parseSnapshotListEnvelope(await response.json(), strategy, marketScope);
    },
    [snapshotListUrl, strategy, marketScope]
  );

  const snapshots = useMemo(() => snapshotEnvelope?.snapshots ?? [], [snapshotEnvelope]);

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
      const response = await authenticatedFetch(holdingsUrl, { signal });
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
    evidenceStatus: snapshotEnvelope?.evidence_status ?? null,
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
