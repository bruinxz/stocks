import type { KpiSlot } from '../../shared/KpiBar';
import type { ReportHistoryPage } from './types';

export function buildReportHistoryKpi(page?: ReportHistoryPage): KpiSlot[] {
  const highConviction =
    page?.entries.reduce((sum, entry) => sum + entry.high_conviction_count, 0) ?? 0;
  const earliest = page?.entries.at(-1)?.trading_day;
  return [
    { label: '归档报告', value: page ? String(page.total) : '--' },
    { label: '本页高确信度', value: page ? String(highConviction) : '--' },
    { label: '本页最早日期', value: earliest ?? '--' },
  ];
}
