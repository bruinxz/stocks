import { useState, useMemo, useCallback } from 'react';
import { useAbortableRequest } from 'shared/hooks/useAbortableRequest';
import type { BacktestSnapshotSlot, BacktestHolding } from './types';

type Profile = 'us_preferred' | 'multibagger';

interface UseBacktestDataOptions {
  profile: Profile;
  from?: string;
  to?: string;
  limit?: number;
}

export function useBacktestData({ profile, from, to, limit = 60 }: UseBacktestDataOptions) {
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);

  const snapshotListUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('limit', String(limit));
    return `/api/v1/backtest-pit/${profile}?${params}`;
  }, [profile, from, to, limit]);

  const {
    data: snapshotsRaw,
    loading: snapshotsLoading,
    error: snapshotsError,
    refetch: refetchSnapshots,
  } = useAbortableRequest<{ snapshots: BacktestSnapshotSlot[] }>(
    (signal) =>
      fetch(snapshotListUrl, { signal }).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      }),
    [snapshotListUrl],
  );

  const snapshots = snapshotsRaw?.snapshots ?? [];

  const selectedSnapshot = useMemo(
    () => snapshots.find((s) => s.snapshot_id === selectedSnapshotId) ?? null,
    [snapshots, selectedSnapshotId],
  );

  const holdingsUrl = useMemo(() => {
    if (!selectedSnapshot) return null;
    return `/api/v1/backtest-pit/${profile}/${selectedSnapshot.as_of_utc}/holdings`;
  }, [profile, selectedSnapshot]);

  const {
    data: holdingsRaw,
    loading: holdingsLoading,
    error: holdingsError,
  } = useAbortableRequest<{ holdings: BacktestHolding[] }>(
    (signal) => {
      if (!holdingsUrl) return Promise.resolve({ holdings: [] });
      return fetch(holdingsUrl, { signal }).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      });
    },
    [holdingsUrl],
  );

  const holdings = holdingsRaw?.holdings ?? [];

  const selectSnapshot = useCallback((id: string | null) => {
    setSelectedSnapshotId(id);
  }, []);

  return {
    snapshots,
    selectedSnapshot,
    holdings,
    loading: snapshotsLoading,
    holdingsLoading,
    error: snapshotsError ?? holdingsError ?? null,
    selectSnapshot,
    refetchSnapshots,
  };
}
