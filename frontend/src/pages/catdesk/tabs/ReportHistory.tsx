import React, { useMemo } from 'react';
import { LoadingState } from '../shared/LoadingState';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import type { KpiSlot } from '../shared/KpiBar';

export function ReportHistory() {
  const loading = false;
  const error: string | null = null;
  const entries: unknown[] = [];

  const kpiSlots: KpiSlot[] = useMemo(() => [
    { label: '归档报告数', value: '--' },
    { label: '最早归档日期', value: '--' },
    { label: '存储占用估算', value: '--' },
  ], []);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  if (!entries.length) {
    return (
      <EmptyState
        title="归档为空 · 从 tab 6 生成的日报会自动归档到这里"
      />
    );
  }

  return <div className="report-history">{/* Sprint 2 real components */}</div>;
}

export default ReportHistory;
