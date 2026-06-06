import { Op } from 'sequelize';
import { LimitUpStock } from '../../models/LimitUpStock';
import { logger } from '../../utils/logger';
import { LimitUpClient, LimitUpStockRow, limitUpClient } from '../sources/LimitUpClient';

/**
 * 涨停板（含连板高度）日度入库服务
 *
 * - `syncDate(date)`：拉取单日涨停 + 强势股池，按 (trade_date, stock_code) upsert。
 *   入库前会**基于过去 5 个交易日已入库的记录**复算 `continuous_days`：
 *     - 若该股票在前一交易日 (trade_date - N) 已有 continuous_days = k，
 *       则今日 continuous_days = k + 1。
 *     - 否则按 AKShare 返回的初值兜底（通常也是 1）。
 *   这种"基于库内历史"的连板计算与 AKShare 自带的 `连板数` 字段互为校验，
 *   且能在 AKShare 偶发缺数据时仍保持下游策略可用。
 *
 * - `syncRange(start, end)`：闭区间按日遍历，支持「断点续传」——
 *   环境变量 `LIMIT_UP_SKIP_EXISTING=0` 或入参 `skipExisting=false` 可禁用。
 *
 * 失败的单日不中断 range，便于隔夜补漏。
 */
export interface SyncDateResult {
  trade_date: string;
  fetched: number;
  upserted: number;
  /** 通过历史回看复算（且与 AKShare 初值不同）的股票数量 */
  recomputed_continuous_days: number;
  skipped: boolean;
  error?: string;
}

export interface SyncRangeOptions {
  /** 单日已有任意一条 limit_up_stocks 时跳过整日，默认 true */
  skipExisting?: boolean;
}

export interface SyncRangeResult {
  start: string;
  end: string;
  total_days: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncDateResult[];
}

/** 回看几个交易日来推算连板数。5 个自然日足够覆盖跨周末场景。 */
const LOOKBACK_DAYS = 5;

export class LimitUpSyncService {
  private client: LimitUpClient;

  constructor(client: LimitUpClient = limitUpClient) {
    this.client = client;
  }

  /**
   * 同步指定日期的涨停股池
   * @param date ISO YYYY-MM-DD
   */
  async syncDate(date: string): Promise<SyncDateResult> {
    try {
      const rows = await this.client.fetchDailyPool(date);
      if (rows.length === 0) {
        logger.warn(`LimitUp: no data returned for ${date}, marking as empty success`);
        return {
          trade_date: date,
          fetched: 0,
          upserted: 0,
          recomputed_continuous_days: 0,
          skipped: false,
        };
      }

      // 回看过去 LOOKBACK_DAYS 个自然日的所有连板记录，构建
      // (stock_code) -> [{ trade_date, continuous_days }] 的索引，
      // 用于复算今日的连板天数。
      const historyByCode = await this.loadRecentHistory(date, LOOKBACK_DAYS);

      let recomputed = 0;
      const records = rows.map((row: LimitUpStockRow) => {
        const recomputedCD = this.computeContinuousDays(
          row.stock_code,
          row.trade_date,
          historyByCode
        );
        // 若复算结果与 AKShare 初值不一致，记一笔便于事后比对
        const akInit = row.continuous_days ?? 1;
        const finalCD = Math.max(recomputedCD, akInit);
        if (finalCD !== akInit) {
          recomputed += 1;
        }
        return {
          trade_date: row.trade_date,
          stock_code: row.stock_code,
          stock_name: row.stock_name ?? undefined,
          limit_up_time: row.limit_up_time ?? undefined,
          limit_up_amount: row.limit_up_amount ?? undefined,
          limit_up_open_times: row.limit_up_open_times ?? 0,
          continuous_days: finalCD,
          reason: row.reason ?? undefined,
          industry: row.industry ?? undefined,
          is_one_word_board: row.is_one_word_board,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      await LimitUpStock.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'limit_up_time',
          'limit_up_amount',
          'limit_up_open_times',
          'continuous_days',
          'reason',
          'industry',
          'is_one_word_board',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `LimitUp: upserted ${records.length} rows for ${date} (recomputed_cd=${recomputed})`
      );
      return {
        trade_date: date,
        fetched: rows.length,
        upserted: records.length,
        recomputed_continuous_days: recomputed,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`LimitUp syncDate(${date}) failed: ${message}`);
      return {
        trade_date: date,
        fetched: 0,
        upserted: 0,
        recomputed_continuous_days: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 闭区间按日遍历（含两端），断点续传。
   * AKShare 在周末/节假日返回空池；这种情况记 fetched=0 的 detail，不计失败。
   */
  async syncRange(
    start: string,
    end: string,
    options: SyncRangeOptions = {}
  ): Promise<SyncRangeResult> {
    const skipExisting = options.skipExisting ?? process.env.LIMIT_UP_SKIP_EXISTING !== '0';

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (startDate > endDate) {
      throw new Error(`LimitUp syncRange: start ${start} after end ${end}`);
    }

    const details: SyncDateResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;
    let totalDays = 0;

    for (
      let cursor = new Date(startDate);
      cursor <= endDate;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      totalDays += 1;
      const iso = cursor.toISOString().slice(0, 10);

      if (skipExisting) {
        const existing = await LimitUpStock.count({ where: { trade_date: iso } });
        if (existing > 0) {
          logger.info(`LimitUp: skip ${iso} (${existing} rows already present)`);
          details.push({
            trade_date: iso,
            fetched: 0,
            upserted: 0,
            recomputed_continuous_days: 0,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }

      const dayResult = await this.syncDate(iso);
      details.push(dayResult);
      if (dayResult.error) failed += 1;
      else succeeded += 1;
    }

    return {
      start,
      end,
      total_days: totalDays,
      succeeded,
      skipped,
      failed,
      details,
    };
  }

  /**
   * 拉取过去 N 个自然日的所有涨停记录，按 stock_code 分桶。
   * 返回的每个桶里数组按 trade_date 倒序排列，方便逐日回看。
   */
  private async loadRecentHistory(
    today: string,
    lookbackDays: number
  ): Promise<Map<string, Array<{ trade_date: string; continuous_days: number }>>> {
    const today_d = parseIsoDate(today);
    const start = new Date(today_d);
    start.setUTCDate(start.getUTCDate() - lookbackDays);
    const startIso = start.toISOString().slice(0, 10);

    const prevRecords = await LimitUpStock.findAll({
      attributes: ['stock_code', 'trade_date', 'continuous_days'],
      where: {
        trade_date: { [Op.gte]: startIso, [Op.lt]: today },
      },
      raw: true,
    });

    const byCode = new Map<string, Array<{ trade_date: string; continuous_days: number }>>();
    for (const r of prevRecords as unknown as Array<{
      stock_code: string;
      trade_date: string;
      continuous_days: number;
    }>) {
      const bucket = byCode.get(r.stock_code) ?? [];
      bucket.push({ trade_date: r.trade_date, continuous_days: r.continuous_days });
      byCode.set(r.stock_code, bucket);
    }
    for (const arr of byCode.values()) {
      arr.sort((a, b) => (a.trade_date < b.trade_date ? 1 : a.trade_date > b.trade_date ? -1 : 0));
    }
    return byCode;
  }

  /**
   * 给定股票 today 的连板数 = 前一交易日 continuous_days + 1（若前一日有记录）。
   * "前一交易日"在 history 桶里就是 trade_date 倒序的第一个早于 today 的元素。
   * 桶为空 ⇒ 视为首板 (1)。
   *
   * 注意：history 里只存「涨停日」，所以只要桶里最近一条早于今日且距今 ≤ 1 个
   * 交易日，就视为连板。回看跨度由 LOOKBACK_DAYS 控制（含周末容差）。
   */
  private computeContinuousDays(
    stockCode: string,
    today: string,
    history: Map<string, Array<{ trade_date: string; continuous_days: number }>>
  ): number {
    const bucket = history.get(stockCode);
    if (!bucket || bucket.length === 0) return 1;

    const yesterday = bucket.find(b => b.trade_date < today);
    if (!yesterday) return 1;

    // 若昨日记录与今日相邻（含周末跨度，最长 ~3 天），视为续涨
    const gap = daysBetween(yesterday.trade_date, today);
    // A 股一般周五涨停 → 周一仍算续涨，gap=3；超过 4 自然日则视为中断。
    if (gap > 4) return 1;

    return yesterday.continuous_days + 1;
  }
}

/** ISO YYYY-MM-DD → Date (UTC midnight)，避免本地时区漂移 */
function parseIsoDate(iso: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    throw new Error(`Invalid ISO date (expected YYYY-MM-DD): ${iso}`);
  }
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetween(earlierIso: string, laterIso: string): number {
  const a = parseIsoDate(earlierIso).getTime();
  const b = parseIsoDate(laterIso).getTime();
  return Math.round((b - a) / 86_400_000);
}

export const limitUpSyncService = new LimitUpSyncService();
