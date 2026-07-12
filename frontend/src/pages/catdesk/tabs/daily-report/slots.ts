import type { KpiSlot } from '../../shared/KpiBar';
import type { DailyReportDocument, GenerationJob } from './types';

export function buildDailyReportKpi(report?: DailyReportDocument, job?: GenerationJob): KpiSlot[] {
  const highConviction =
    report?.snapshot.items.filter(item => item.recommendation.conviction.level === 'HIGH').length ??
    0;
  return [
    { label: '生成状态', value: job?.status ?? 'idle' },
    { label: '推荐条目', value: report ? String(report.snapshot.items.length) : '--' },
    { label: '高确信度', value: report ? String(highConviction) : '--' },
  ];
}
