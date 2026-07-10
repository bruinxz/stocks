import React, { useMemo } from 'react';
import { LoadingState } from '../shared/LoadingState';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import type { KpiSlot } from '../shared/KpiBar';

export function DailyReport() {
  const loading = false;
  const error: string | null = null;
  const hasReport = false;

  const kpiSlots: KpiSlot[] = useMemo(() => [
    { label: '今日生成状态', value: '--' },
    { label: '已生成日报数(近 30 天)', value: '--' },
    { label: '待生成 tickers 数', value: '--' },
  ], []);

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;
  if (!hasReport) {
    return (
      <EmptyState
        title="今日尚未生成日报 · 点击「生成」触发 AI 荐股 pipeline"
      />
    );
  }

  return <div className="daily-report">{/* Sprint 2 real components */}</div>;
}

export default DailyReport;
