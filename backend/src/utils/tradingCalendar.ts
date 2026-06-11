/**
 * A 股交易日历 (Trading Calendar) — 节假日感知
 *
 * 简单 hard-code 2026-2027 节假日；后续可换 npm 包 chinese-holidays 或 cron-driven sync.
 *
 * 用法:
 *   import { isAShareTradeDay } from '../utils/tradingCalendar';
 *   if (!isAShareTradeDay(new Date())) return { skipped: true, reason: 'A_SHARE_HOLIDAY' };
 *
 * Cron 任务用此判断"虽然是周一-周五但今天是节假日 → 跳过"。
 *
 * 节假日数据源:
 *   - 2026: 国务院办公厅 2025-11 公告（http://www.gov.cn/zhengce/）
 *   - 2027: 待发布，2026 Q4 更新
 *
 * 维护提示: 国务院每年 11-12 月发布次年放假安排, 更新本文件 HOLIDAYS 常量即可.
 */

// A 股 2026 节假日（ISO date）
// 元旦：1.1   春节：2.16-2.24   清明：4.4-4.6
// 五一：5.1-5.5   端午：6.19-6.21   中秋：9.25-9.27 (与国庆相连)
// 国庆：10.1-10.8
const A_SHARE_HOLIDAYS_2026 = new Set([
  '2026-01-01',
  // 春节 2.16-2.24 (实际 2.17 除夕 - 2.23 初六, 调休 2.7+2.8 上班)
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', '2026-02-24',
  // 清明 4.4-4.6
  '2026-04-04', '2026-04-06',
  // 五一 5.1-5.5 (调休 4.26+5.9 上班)
  '2026-05-01', '2026-05-04', '2026-05-05',
  // 端午 6.19-6.21
  '2026-06-19',
  // 中秋 + 国庆 (中秋 9.25-9.27, 国庆 10.1-10.8 合并)
  '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08',
]);

// 调休补班日（虽然周末但实际上班/上市）— 2026 上证日历待确认
// A 股目前对调休补班的处理: 周末调班日通常**不交易**, 这里保守先空, 实测出问题再加
const A_SHARE_MAKEUP_WORKDAYS_2026 = new Set<string>();

const A_SHARE_HOLIDAYS_2027 = new Set<string>([
  // 2027 待国务院公告，先空
]);

/**
 * 判断给定日期是否 A 股交易日.
 *
 * @param date Date 对象 or ISO string (YYYY-MM-DD)
 * @returns true if 工作日 + 非节假日 (或调休补班日)
 */
export function isAShareTradeDay(date: Date | string): boolean {
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00+08:00') : date;
  // 使用 Asia/Shanghai 时区判断
  const shanghaiOffset = 8 * 60 * 60 * 1000;
  const sh = new Date(d.getTime() + shanghaiOffset - d.getTimezoneOffset() * 60_000);
  const isoDate = sh.toISOString().slice(0, 10);

  // 周末 → 除非是调休补班日
  const dow = sh.getUTCDay(); // 0=Sun 6=Sat
  if (dow === 0 || dow === 6) {
    return A_SHARE_MAKEUP_WORKDAYS_2026.has(isoDate);
  }

  // 工作日 → 排除节假日
  if (A_SHARE_HOLIDAYS_2026.has(isoDate)) return false;
  if (A_SHARE_HOLIDAYS_2027.has(isoDate)) return false;

  return true;
}

/**
 * 返回原因 string. 用于日志/审计.
 */
export function explainNonTradeDay(date: Date | string): string | null {
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00+08:00') : date;
  const shanghaiOffset = 8 * 60 * 60 * 1000;
  const sh = new Date(d.getTime() + shanghaiOffset - d.getTimezoneOffset() * 60_000);
  const isoDate = sh.toISOString().slice(0, 10);
  const dow = sh.getUTCDay();
  if (dow === 0) return `周日 (${isoDate})`;
  if (dow === 6) return `周六 (${isoDate})`;
  if (A_SHARE_HOLIDAYS_2026.has(isoDate) || A_SHARE_HOLIDAYS_2027.has(isoDate)) {
    return `A 股节假日 (${isoDate})`;
  }
  return null; // 是交易日
}
