import React, { useMemo } from 'react';
import { LoadingState } from '../shared/LoadingState';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import type { KpiSlot } from '../shared/KpiBar';

export function BacktestEvidence() {
  const loading = false;
  const error: string | null = null;
  const snapshots: unknown[] = [];

  const kpiSlots: KpiSlot[] = useMemo(() => [
    { label: '近 6 月胜率', value: '--' },
    { label: '最大回撤', value: '--' },
    { label: '夏普比率', value: '--' },
  ], []);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  if (!snapshots.length) {
    return (
      <EmptyState
        title="暂无回测快照 · 请等待 6-month PIT 数据入库或切换 profile"
      />
    );
  }

  return <div className="backtest-evidence">{/* Sprint 2 real components */}</div>;
}

export default BacktestEvidence;
