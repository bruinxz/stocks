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
  '2026-02-16',
  '2026-02-17',
  '2026-02-18',
  '2026-02-19',
  '2026-02-20',
  '2026-02-23',
  '2026-02-24',
  // 清明 4.4-4.6
  '2026-04-04',
  '2026-04-06',
  // 五一 5.1-5.5 (调休 4.26+5.9 上班)
  '2026-05-01',
  '2026-05-04',
  '2026-05-05',
  // 端午 6.19-6.21
  '2026-06-19',
  // 中秋 + 国庆 (中秋 9.25-9.27, 国庆 10.1-10.8 合并)
  '2026-09-25',
  '2026-09-28',
  '2026-09-29',
  '2026-09-30',
  '2026-10-01',
  '2026-10-02',
  '2026-10-05',
  '2026-10-06',
  '2026-10-07',
  '2026-10-08',
]);

// 调休补班日（虽然周末但实际上班/上市）— 2026 上证日历待确认
// A 股目前对调休补班的处理: 周末调班日通常**不交易**, 这里保守先空, 实测出问题再加
const A_SHARE_MAKEUP_WORKDAYS_2026 = new Set<string>();

const A_SHARE_HOLIDAYS_2027 = new Set<string>([
  // 2027 待国务院公告，先空
]);

/**
 * 内部 helper — 把任意 Date 转成 Asia/Shanghai 时区的 { isoDate, dow }.
 *
 * **历史踩坑 (2026-06-27 prod 事故):** 原实现用 `d.getTime() + 8h - d.getTimezoneOffset() * 60_000`
 * 手算 offset, 在已经处于 CST 时区 (offset=-480) 的进程上等价于 `+8h - (-480 min) = +16h`,
 * 让周五 16:00+ 全部被误判成周六, 30+ 个 cron 在周五盘后被节假日 guard 错杀.
 *
 * 正确做法: 直接走 `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' })`,
 * 让 IANA 时区库做转换, 不论 host 进程时区如何 (UTC / CST / 其它) 结果一致.
 */
function toShanghaiParts(date: Date | string): { isoDate: string; dow: number } {
  const d = typeof date === 'string' ? new Date(date + 'T00:00:00+08:00') : date;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string): string => parts.find(p => p.type === type)?.value || '';
  const isoDate = `${get('year')}-${get('month')}-${get('day')}`;
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dow = dowMap[get('weekday')] ?? -1;
  return { isoDate, dow };
}

/**
 * 判断给定日期是否 A 股交易日.
 *
 * @param date Date 对象 or ISO string (YYYY-MM-DD)
 * @returns true if 工作日 + 非节假日 (或调休补班日)
 */
export function isAShareTradeDay(date: Date | string): boolean {
  const { isoDate, dow } = toShanghaiParts(date);

  // 周末 → 除非是调休补班日
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
  const { isoDate, dow } = toShanghaiParts(date);
  if (dow === 0) return `周日 (${isoDate})`;
  if (dow === 6) return `周六 (${isoDate})`;
  if (A_SHARE_HOLIDAYS_2026.has(isoDate) || A_SHARE_HOLIDAYS_2027.has(isoDate)) {
    return `A 股节假日 (${isoDate})`;
  }
  return null; // 是交易日
}

/**
 * 判断给定时刻是否在 A 股可下单时段 (Asia/Shanghai 09:30-11:30 + 13:00-15:00) 且是交易日.
 *
 * 与 PaperTradingFacade._placeOrderInner 的 guard 同源, 抽出来给 autoBuyFromSignals
 * 这类 "不走 facade 的自动下单链路" 复用, 避免每条信号绕过交易时段限制 (bug: 2026-06-16
 * 09:20 集合竞价时段下单, 用昨日 close 当成交价).
 *
 * @returns { allowed: boolean, reason?: string, code?: string }
 *   - allowed=true → 当前可下单
 *   - allowed=false → reason 是中文给用户看的原因, code 是机器读的分类:
 *     'NON_TRADING_HOURS_HOLIDAY' / 'NON_TRADING_HOURS_PRE_OPEN' / 'NON_TRADING_HOURS_LUNCH' /
 *     'NON_TRADING_HOURS_AFTER_CLOSE' / 'NON_TRADING_HOURS_EARLY_MORNING'
 */
export interface TradingHoursCheck {
  allowed: boolean;
  reason?: string;
  code?:
    | 'NON_TRADING_HOURS_HOLIDAY'
    | 'NON_TRADING_HOURS_PRE_OPEN'
    | 'NON_TRADING_HOURS_LUNCH'
    | 'NON_TRADING_HOURS_AFTER_CLOSE'
    | 'NON_TRADING_HOURS_EARLY_MORNING';
}

export function checkAShareTradingHours(now: Date = new Date()): TradingHoursCheck {
  // 1. 节假日 / 周末
  if (!isAShareTradeDay(now)) {
    const reason = explainNonTradeDay(now) || '非 A 股交易日';
    return { allowed: false, reason: `${reason}, A 股不开市`, code: 'NON_TRADING_HOURS_HOLIDAY' };
  }
  // 2. 时段判定 (Asia/Shanghai = UTC+8)
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const hour = shanghai.getUTCHours();
  const minute = shanghai.getUTCMinutes();
  const totalMinutes = hour * 60 + minute;
  const MORNING_START = 9 * 60 + 30; // 09:30
  const MORNING_END = 11 * 60 + 30; // 11:30
  const AFTERNOON_START = 13 * 60; // 13:00
  const AFTERNOON_END = 15 * 60; // 15:00
  const inMorning = totalMinutes >= MORNING_START && totalMinutes < MORNING_END;
  const inAfternoon = totalMinutes >= AFTERNOON_START && totalMinutes < AFTERNOON_END;
  if (inMorning || inAfternoon) return { allowed: true };
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  // 集合竞价时段也禁单 — 09:00-09:30, 实际撮合 09:25, 与连续竞价价格语义不同
  if (totalMinutes >= 9 * 60 && totalMinutes < MORNING_START) {
    return {
      allowed: false,
      reason: `当前 ${hh}:${mm} (Asia/Shanghai) 集合竞价时段 (09:00-09:30), 等待 09:30 开盘`,
      code: 'NON_TRADING_HOURS_PRE_OPEN',
    };
  }
  if (totalMinutes >= MORNING_END && totalMinutes < AFTERNOON_START) {
    return {
      allowed: false,
      reason: `当前 ${hh}:${mm} (Asia/Shanghai) 午休时段 (11:30-13:00)`,
      code: 'NON_TRADING_HOURS_LUNCH',
    };
  }
  if (totalMinutes >= AFTERNOON_END) {
    return {
      allowed: false,
      reason: `当前 ${hh}:${mm} (Asia/Shanghai) 已收盘 (>15:00)`,
      code: 'NON_TRADING_HOURS_AFTER_CLOSE',
    };
  }
  return {
    allowed: false,
    reason: `当前 ${hh}:${mm} (Asia/Shanghai) 尚未开盘 (<09:00)`,
    code: 'NON_TRADING_HOURS_EARLY_MORNING',
  };
}
