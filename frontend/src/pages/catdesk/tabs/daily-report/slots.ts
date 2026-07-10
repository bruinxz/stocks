import type { KpiSlot } from '../../shared/KpiBar';

export function buildDailyReportKpi(): KpiSlot[] {
  return [
    { label: '今日生成状态', value: '--' },
    { label: '已生成日报数(近 30 天)', value: '--' },
    { label: '待生成 tickers 数', value: '--' },
  ];
}
