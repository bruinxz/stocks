import type { KpiSlot } from '../../shared/KpiBar';

export function buildReportHistoryKpi(): KpiSlot[] {
  return [
    { label: '归档报告数', value: '--' },
    { label: '最早归档日期', value: '--' },
    { label: '存储占用估算', value: '--' },
  ];
}
