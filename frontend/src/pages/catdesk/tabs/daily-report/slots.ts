import type { KpiSlot } from '../../shared/KpiBar';
import type { DailyReportDocument, GenerationJob } from './types';
import { GENERATION_STATUS_LABELS } from '../../shared/uiLabels';

export function dailyReportStatusLabel(report?: DailyReportDocument, job?: GenerationJob): string {
  if (report && (!job || job.status === 'idle')) return '已归档';
  return GENERATION_STATUS_LABELS[job?.status ?? 'idle'] ?? '未生成';
}

export function buildDailyReportKpi(report?: DailyReportDocument, job?: GenerationJob): KpiSlot[] {
  const highConviction =
    report?.snapshot.items.filter(item => item.recommendation.conviction.level === 'HIGH').length ??
    0;
  return [
    { label: '生成状态', value: dailyReportStatusLabel(report, job) },
    { label: '推荐条目', value: report ? String(report.snapshot.items.length) : '--' },
    { label: '高确信度', value: report ? String(highConviction) : '--' },
  ];
}
