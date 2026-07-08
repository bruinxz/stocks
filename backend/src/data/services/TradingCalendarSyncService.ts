import { TradingCalendar } from '../../models/TradingCalendar';
import { BaostockClient } from '../sources/BaostockClient';
import { logger } from '../../utils/logger';

/**
 * 交易日历同步服务 — §D4.G2 契约 (PR #94 `ad586ef6` + DDL PR #96 `6299a3d4` + Model PR #98 `50ae249e`).
 *
 * 数据源: Baostock `bs.query_trade_dates(start_date, end_date)` 主源 (owner 冻结 msg=4f6d2466).
 *
 * 同步策略:
 *   1. 调 Baostock 拿区间内所有交易日字符串列表 (只含 is_trading_day='1' 的日期)
 *   2. 在应用侧枚举区间内每个自然日, 与交易日 Set 求交 → 标注 is_open
 *   3. 单次线性扫描填 prev_trade_date / next_trade_date (nullable · 区间首/末日无值)
 *   4. is_half 硬编 A 股节前调休名单 (春节/国庆/中秋前的半日市 · 每年 update)
 *   5. TradingCalendar.upsert() 批量幂等入库
 *
 * 备源 AKShare `tool_trade_date_hist_sina()` — Baostock 连续 3 次网络失败后走 fallback
 * (fallback 实现待 Path C.2 追增位; 本 v0 只落 Baostock 主源).
 *
 * 语义硬约束:
 *   - Timezone: Asia/Shanghai · YYYY-MM-DD 无时区
 *   - source 字段: baostock 主源固定写 'baostock'
 *   - 幂等: upsert 冲突 PK 时保留新写入的 is_half / prev / next / source 字段
 */

/** A 股节前调休半日市名单 (每年 update · YYYY-MM-DD 格式) */
const HALF_DAY_TRADING_DATES: Set<string> = new Set<string>([
  // Baseline 空 · 由 v1.1 追增位人工填 (示例格式如下)
  // '2025-01-27', // 春节前一日
  // '2025-09-30', // 国庆前一日
]);

export interface SyncCalendarOptions {
  /** 区间起始日 YYYY-MM-DD (含) */
  startDate: string;
  /** 区间结束日 YYYY-MM-DD (含) */
  endDate: string;
}

export interface SyncCalendarResult {
  start_date: string;
  end_date: string;
  /** 区间内自然日总数 (含休市) */
  total_calendar_days: number;
  /** 交易日数 (is_open=true) */
  trading_days: number;
  /** 半日市数 (is_half=true) */
  half_days: number;
  /** upsert 成功行数 */
  upserted: number;
  /** 数据源 ('baostock' 主 / 'akshare' fallback) */
  source: string;
  error?: string;
}

export class TradingCalendarSyncService {
  private client: BaostockClient;

  constructor(client: BaostockClient = new BaostockClient()) {
    this.client = client;
  }

  /**
   * 拉取 [startDate, endDate] 区间的完整交易日历并落库.
   */
  async syncRange(options: SyncCalendarOptions): Promise<SyncCalendarResult> {
    const { startDate, endDate } = options;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      throw new Error(
        `Invalid date format (expected YYYY-MM-DD): start=${startDate} end=${endDate}`
      );
    }
    if (startDate > endDate) {
      throw new Error(`startDate ${startDate} must be <= endDate ${endDate}`);
    }

    logger.info(`TradingCalendar: syncing range ${startDate} → ${endDate} from Baostock`);

    let tradingDaysList: string[];
    try {
      tradingDaysList = await this.client.queryTradeDates(startDate, endDate);
    } catch (err) {
      const message = (err as Error).message;
      logger.error(`TradingCalendar: Baostock queryTradeDates failed — ${message}`);
      return {
        start_date: startDate,
        end_date: endDate,
        total_calendar_days: 0,
        trading_days: 0,
        half_days: 0,
        upserted: 0,
        source: 'baostock',
        error: message,
      };
    }

    const tradingSet = new Set<string>(tradingDaysList);
    const allDates = enumerateDates(startDate, endDate);

    const rows = buildCalendarRows(allDates, tradingSet, HALF_DAY_TRADING_DATES);

    let upserted = 0;
    for (const row of rows) {
      await TradingCalendar.upsert(row);
      upserted += 1;
    }

    const tradingCount = rows.filter((r) => r.is_open).length;
    const halfCount = rows.filter((r) => r.is_half).length;

    logger.info(
      `TradingCalendar: upserted ${upserted} rows (trading=${tradingCount} half=${halfCount} total=${rows.length})`
    );

    return {
      start_date: startDate,
      end_date: endDate,
      total_calendar_days: rows.length,
      trading_days: tradingCount,
      half_days: halfCount,
      upserted,
      source: 'baostock',
    };
  }
}

/**
 * 枚举 [start, end] 区间内的所有自然日 (含端点) 为 YYYY-MM-DD 字符串数组.
 * 内部走 UTC 加天数以避免 DST/时区噪音 (calendar_date 本身无时区语义).
 */
export function enumerateDates(startDate: string, endDate: string): string[] {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * 构造完整的 TradingCalendar 行. prev/next_trade_date 单次线性扫描:
 *   prev: 从前往后扫 · 每见到 is_open=true 就更新 lastOpen 指针
 *   next: 从后往前扫 · 每见到 is_open=true 就更新 nextOpen 指针
 */
export function buildCalendarRows(
  allDates: string[],
  tradingSet: Set<string>,
  halfDaySet: Set<string>
): Array<{
  trade_date: string;
  is_open: boolean;
  is_half: boolean;
  prev_trade_date: string | null;
  next_trade_date: string | null;
  source: string;
}> {
  const n = allDates.length;
  const isOpen: boolean[] = allDates.map((d) => tradingSet.has(d));
  const prevArr: (string | null)[] = new Array(n).fill(null);
  const nextArr: (string | null)[] = new Array(n).fill(null);

  let lastOpen: string | null = null;
  for (let i = 0; i < n; i += 1) {
    prevArr[i] = lastOpen;
    if (isOpen[i]) lastOpen = allDates[i];
  }

  let nextOpen: string | null = null;
  for (let i = n - 1; i >= 0; i -= 1) {
    nextArr[i] = nextOpen;
    if (isOpen[i]) nextOpen = allDates[i];
  }

  return allDates.map((d, i) => ({
    trade_date: d,
    is_open: isOpen[i],
    is_half: isOpen[i] && halfDaySet.has(d),
    prev_trade_date: prevArr[i],
    next_trade_date: nextArr[i],
    source: 'baostock',
  }));
}
