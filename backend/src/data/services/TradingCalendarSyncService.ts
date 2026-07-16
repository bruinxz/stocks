import { TradingCalendar } from '../../models/TradingCalendar';
import { BaostockClient } from '../sources/BaostockClient';
import { AKShareClient } from '../sources/AKShareClient';
import { logger } from '../../utils/logger';

/**
 * 交易日历同步服务 — §D4.G2 契约 (PR #94 `ad586ef6` + DDL PR #96 `6299a3d4` + Model PR #98 `50ae249e` + Loader PR #100 `6d3d831d` + α doc PR #103 `b7a88f1b`).
 *
 * 数据源:
 *   - 主源: Baostock `bs.query_trade_dates(start_date, end_date)` (owner 冻结 msg=4f6d2466).
 *   - 备源 (Path C.2): AKShare `tool_trade_date_hist_sina()` — Baostock 三次退避重试全失败后走 fallback.
 *
 * 同步策略:
 *   1. 调 Baostock 拿区间内所有交易日字符串列表 (只含 is_trading_day='1' 的日期), 带 1s/2s/4s 三档指数退避
 *   2. Baostock 三次全失败 → 一次 AKShare fallback (fallback 失败即返 error 结果, zero side-effect)
 *   3. 在应用侧枚举区间内每个自然日, 与交易日 Set 求交 → 标注 is_open
 *   4. 单次线性扫描填 prev_trade_date / next_trade_date (nullable · 区间首/末日无值)
 *   5. is_half 硬编 A 股节前调休名单 (春节/国庆/中秋前的半日市 · 每年 update)
 *   6. TradingCalendar.upsert() 批量幂等入库
 *
 * 语义硬约束:
 *   - Timezone: Asia/Shanghai · YYYY-MM-DD 无时区
 *   - source 字段: 主源 'baostock' · fallback 生效时 'akshare' · 反映最终数据来源
 *   - 幂等: upsert 冲突 PK 时保留新写入的 is_half / prev / next / source 字段
 */

/**
 * A 股节前调休半日市名单 (每年 update · YYYY-MM-DD 格式).
 * 名单锚: 中国证券登记结算有限责任公司 A 股节前提前收市历史惯例 + 上交所/深交所年度交易时间安排通知.
 *
 * 语义: 上午 09:30-11:30 正常撮合 · 下午集合竞价+盘中撮合缩短为 13:00-14:00 (春节前/国庆前) 或全天不含下午 (个别年度).
 * 覆盖 2025-2027 三年 · 三档惯例节前一交易日:
 *   - 春节前 (通常小年后一交易日): 2025-01-27 · 2026-02-16 · 2027-02-05
 *   - 五一/劳动节前: 部分年度不设 · 2027 未定 · 不写入
 *   - 国庆前 (通常 9-30): 2025-09-30 · 2026-09-30 · 2027-09-30
 *   - 中秋前 (与国庆重合年份不重复): 2025 与国庆同日重合 (中秋 10-06 后于国庆 · 无独立半日) · 2026-09-24 · 2027-09-14
 *   备注: 若某年国务院公告调整休市窗口, 需在此追增/修正; 2025 半日市实际以证交所公告为准.
 */
const HALF_DAY_TRADING_DATES: Set<string> = new Set<string>([
  '2025-01-27',
  '2025-09-30',
  '2026-02-16',
  '2026-09-24',
  '2026-09-30',
  '2027-02-05',
  '2027-09-14',
  '2027-09-30',
]);

/** 三档指数退避延时 (ms): 1s / 2s / 4s · Path C.2 主源韧性 */
const BAOSTOCK_BACKOFF_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

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
  /** Baostock 主源尝试次数 (1-3 · fallback 判定用) */
  baostock_attempts?: number;
  /** 是否走了 AKShare fallback */
  fallback_used?: boolean;
  error?: string;
}

/**
 * 通用退避重试包装 · Path C.2 主源韧性件.
 * @param fn 目标异步函数
 * @param delaysMs 每次失败后等待毫秒列表 · 长度决定重试次数 (attempts = delaysMs.length + 1)
 * @param onAttempt 每次尝试前回调 (attemptIdx 1-based)
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = BAOSTOCK_BACKOFF_DELAYS_MS,
  onAttempt?: (attemptIdx: number) => void
): Promise<T> {
  const totalAttempts = delaysMs.length + 1;
  let lastErr: Error | undefined;
  for (let i = 0; i < totalAttempts; i += 1) {
    if (onAttempt) onAttempt(i + 1);
    try {
      return await fn();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (i < delaysMs.length) {
        await new Promise(r => setTimeout(r, delaysMs[i]));
      }
    }
  }
  throw lastErr ?? new Error('retryWithBackoff exhausted with no captured error');
}

export class TradingCalendarSyncService {
  private client: BaostockClient;
  private fallback: AKShareClient | undefined;
  private backoffDelaysMs: readonly number[];

  constructor(
    client: BaostockClient = new BaostockClient(),
    fallback?: AKShareClient,
    backoffDelaysMs: readonly number[] = BAOSTOCK_BACKOFF_DELAYS_MS
  ) {
    this.client = client;
    this.fallback = fallback;
    this.backoffDelaysMs = backoffDelaysMs;
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
    let source: 'baostock' | 'akshare' = 'baostock';
    let baostockAttempts = 0;
    let fallbackUsed = false;

    try {
      tradingDaysList = await retryWithBackoff(
        () => this.client.queryTradeDates(startDate, endDate),
        this.backoffDelaysMs,
        attemptIdx => {
          baostockAttempts = attemptIdx;
        }
      );
    } catch (baostockErr) {
      const baostockMsg = (baostockErr as Error).message;
      logger.warn(
        `TradingCalendar: Baostock queryTradeDates exhausted ${baostockAttempts} attempts — ${baostockMsg}`
      );

      if (!this.fallback) {
        return {
          start_date: startDate,
          end_date: endDate,
          total_calendar_days: 0,
          trading_days: 0,
          half_days: 0,
          upserted: 0,
          source: 'baostock',
          baostock_attempts: baostockAttempts,
          fallback_used: false,
          error: baostockMsg,
        };
      }

      logger.info('TradingCalendar: attempting AKShare fallback');
      try {
        tradingDaysList = await this.fallback.queryTradeDates(startDate, endDate);
        source = 'akshare';
        fallbackUsed = true;
      } catch (fallbackErr) {
        const fallbackMsg = (fallbackErr as Error).message;
        logger.error(
          `TradingCalendar: AKShare fallback also failed — baostock=${baostockMsg} akshare=${fallbackMsg}`
        );
        return {
          start_date: startDate,
          end_date: endDate,
          total_calendar_days: 0,
          trading_days: 0,
          half_days: 0,
          upserted: 0,
          source: 'akshare',
          baostock_attempts: baostockAttempts,
          fallback_used: true,
          error: `baostock: ${baostockMsg}; akshare: ${fallbackMsg}`,
        };
      }
    }

    const tradingSet = new Set<string>(tradingDaysList);
    const allDates = enumerateDates(startDate, endDate);

    const rows = buildCalendarRows(allDates, tradingSet, HALF_DAY_TRADING_DATES, source);

    let upserted = 0;
    for (const row of rows) {
      await TradingCalendar.upsert(row);
      upserted += 1;
    }

    const tradingCount = rows.filter(r => r.is_open).length;
    const halfCount = rows.filter(r => r.is_half).length;

    logger.info(
      `TradingCalendar: upserted ${upserted} rows (trading=${tradingCount} half=${halfCount} total=${rows.length} source=${source} baostock_attempts=${baostockAttempts} fallback=${fallbackUsed})`
    );

    return {
      start_date: startDate,
      end_date: endDate,
      total_calendar_days: rows.length,
      trading_days: tradingCount,
      half_days: halfCount,
      upserted,
      source,
      baostock_attempts: baostockAttempts,
      fallback_used: fallbackUsed,
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
 * @param source 数据来源标签, 落到每行的 source 字段.
 */
export function buildCalendarRows(
  allDates: string[],
  tradingSet: Set<string>,
  halfDaySet: Set<string>,
  source = 'baostock'
): Array<{
  trade_date: string;
  is_open: boolean;
  is_half: boolean;
  prev_trade_date: string | null;
  next_trade_date: string | null;
  source: string;
}> {
  const n = allDates.length;
  const isOpen: boolean[] = allDates.map(d => tradingSet.has(d));
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
    source,
  }));
}

/** 对外暴露 · 测试/审计用 · HALF_DAY_TRADING_DATES 只读副本 */
export function getHalfDayTradingDates(): ReadonlySet<string> {
  return HALF_DAY_TRADING_DATES;
}
