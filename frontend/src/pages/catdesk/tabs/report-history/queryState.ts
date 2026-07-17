import type { ReportHistoryQuery } from './types';

export function parseHistoryQuery(search: string): ReportHistoryQuery {
  const params = new URLSearchParams(search);
  return {
    date: params.get('date') || undefined,
    // 报告历史固定为详细 A 股主报告；海外只在日报的板块催化摘要中出现。
    profile: 'us_preferred',
    market_scope: 'cn_a',
    search: params.get('search') || undefined,
    page: Math.max(1, Number(params.get('page')) || 1),
    page_size: Math.min(100, Math.max(1, Number(params.get('page_size')) || 20)),
  };
}

export function mergeHistoryQuery(search: string, patch: Partial<ReportHistoryQuery>): string {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}
