import { Op } from 'sequelize';
import { MarginTradingBalance } from '../../models/MarginTradingBalance';
import { logger } from '../../utils/logger';
import {
  MarginTradingClient,
  MarginTradingDetailRow,
  marginTradingClient,
} from '../sources/MarginTradingClient';

/**
 * 融资融券明细入库服务 — US-091 数据层.
 *
 * AKShare 融资融券明细按日检索 (深交所 + 上交所合并到 per-stock 单表),
 * 本服务面向**单日**或**日期范围**进行同步:
 *
 *   - `syncDate(date)`               — 拉取单日并 bulkCreate upsert
 *   - `syncRange(start, end, opts?)` — 闭区间按日遍历, 支持断点续传
 *
 * **PK = (trade_date, stock_code) 二元组** 与 NorthboundHolding (US-005) 同款形态;
 * bulkCreate + updateOnDuplicate 在二元 PK 上 idempotent.
 *
 * **day-to-day diff 推算 fin_repay_amt** (与 US-057 MarginBalance 累计量 day-to-day
 * diff 范式同源):
 *   - 上交所原始返回 "融资偿还额" 列, 直接落库;
 *   - 深交所无 "融资偿还额" 原始列, 但 Identity:
 *       fin_balance[T] = fin_balance[T-1] + fin_buy_amt[T] - fin_repay_amt[T]
 *     ⇒ fin_repay_amt[T] = max(0, fin_balance[T-1] + fin_buy_amt[T] - fin_balance[T])
 *   - sync 时查 T-1 日深交所同股的 fin_balance, 若有 → 推算填入; 否则保留 null.
 *   - max(0, ...) 保护: 若数据噪音让 diff 为负 (e.g. 股东大单回购影响), 不写负值.
 *
 * **断点续传**: 默认按日 skip-existing (与 NorthboundSyncService 同款); `--force`
 * 强制覆盖.
 */
export interface SyncDateResult {
  trade_date: string;
  fetched: number;
  upserted: number;
  /** 深交所 day-to-day diff 推算 fin_repay_amt 成功的行数 (debug 用) */
  szse_repay_imputed: number;
  /** 各交易所的入库行数 (debug 用) */
  by_exchange: { SZSE: number; SSE: number };
  skipped: boolean;
  error?: string;
}

export interface SyncRangeOptions {
  /** 单日已有任意一条 margin_trading_balances 时跳过整日 (默认 true) */
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class MarginTradingSyncService {
  private client: MarginTradingClient;

  constructor(client: MarginTradingClient = marginTradingClient) {
    this.client = client;
  }

  /**
   * 同步单个交易日的全市场融资融券明细 (深交所 + 上交所).
   * @param date ISO YYYY-MM-DD
   */
  async syncDate(date: string): Promise<SyncDateResult> {
    if (!ISO_DATE_RE.test(date)) {
      return {
        trade_date: date,
        fetched: 0,
        upserted: 0,
        szse_repay_imputed: 0,
        by_exchange: { SZSE: 0, SSE: 0 },
        skipped: false,
        error: `Invalid date format (expected YYYY-MM-DD): ${date}`,
      };
    }

    try {
      const rows = await this.client.fetchDate(date);
      if (rows.length === 0) {
        logger.warn(`MarginTrading: no data returned for ${date}, marking as empty success`);
        return {
          trade_date: date,
          fetched: 0,
          upserted: 0,
          szse_repay_imputed: 0,
          by_exchange: { SZSE: 0, SSE: 0 },
          skipped: false,
        };
      }

      // ----- 服务层 in-memory dedup -----
      // PK = (trade_date, stock_code) 二元组.
      // 同股票理论上一日只有一行 (深交所 + 上交所互不重叠), 但 dedup 兜底
      // 跨方言 idempotent (与 US-030 / US-089 / US-090 同款模式).
      const seen = new Map<string, MarginTradingDetailRow>();
      for (const row of rows) {
        const key = `${row.trade_date}::${row.stock_code}`;
        if (seen.has(key)) continue;
        seen.set(key, row);
      }
      const uniqueRows = Array.from(seen.values());

      // ----- 深交所 fin_repay_amt day-to-day diff 推算 -----
      const szseCodes = uniqueRows
        .filter(r => r.exchange === 'SZSE' && r.fin_balance !== null)
        .map(r => r.stock_code);
      const prevFinBalanceMap = await this.loadPrevDayFinBalanceForCodes(date, szseCodes);
      let szseRepayImputed = 0;

      const records = uniqueRows.map(row => {
        let finRepayAmt = row.fin_repay_amt;
        if (
          row.exchange === 'SZSE' &&
          finRepayAmt === null &&
          row.fin_balance !== null &&
          row.fin_buy_amt !== null
        ) {
          const prevBalance = prevFinBalanceMap.get(row.stock_code);
          if (prevBalance !== undefined && prevBalance !== null) {
            // fin_balance[T] = fin_balance[T-1] + fin_buy_amt[T] - fin_repay_amt[T]
            // ⇒ fin_repay_amt[T] = prev_balance + fin_buy_amt - fin_balance
            const repay = prevBalance + (row.fin_buy_amt ?? 0) - (row.fin_balance ?? 0);
            finRepayAmt = Math.max(0, repay);
            szseRepayImputed += 1;
          }
        }

        return {
          trade_date: row.trade_date,
          stock_code: row.stock_code,
          stock_name: row.stock_name ?? undefined,
          exchange: row.exchange,
          fin_balance: row.fin_balance ?? undefined,
          fin_buy_amt: row.fin_buy_amt ?? undefined,
          fin_repay_amt: finRepayAmt ?? undefined,
          short_balance: row.short_balance ?? undefined,
          short_sell_vol: row.short_sell_vol ?? undefined,
          short_repay_vol: row.short_repay_vol ?? undefined,
          short_volume: row.short_volume ?? undefined,
          total_margin_balance: row.total_margin_balance ?? undefined,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      const byExchange = { SZSE: 0, SSE: 0 };
      for (const r of records) {
        if (r.exchange === 'SZSE') byExchange.SZSE += 1;
        else if (r.exchange === 'SSE') byExchange.SSE += 1;
      }

      await MarginTradingBalance.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'exchange',
          'fin_balance',
          'fin_buy_amt',
          'fin_repay_amt',
          'short_balance',
          'short_sell_vol',
          'short_repay_vol',
          'short_volume',
          'total_margin_balance',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `MarginTrading: upserted ${records.length} rows for ${date} ` +
          `(SZSE=${byExchange.SZSE} SSE=${byExchange.SSE} ` +
          `szse_repay_imputed=${szseRepayImputed})`
      );

      return {
        trade_date: date,
        fetched: rows.length,
        upserted: records.length,
        szse_repay_imputed: szseRepayImputed,
        by_exchange: byExchange,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`MarginTrading syncDate(${date}) failed: ${message}`);
      return {
        trade_date: date,
        fetched: 0,
        upserted: 0,
        szse_repay_imputed: 0,
        by_exchange: { SZSE: 0, SSE: 0 },
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 闭区间按日遍历 (含两端), 断点续传: 默认遇到当日已有数据则跳过.
   *
   * 注意: 融资融券明细只在交易日才有; 遇到周末/节假日 AKShare 返回空 dataframe,
   * 我们记一个 fetched=0 的 day-result, 便于 ops 区分"跳过"和"为空".
   */
  async syncRange(
    start: string,
    end: string,
    options: SyncRangeOptions = {}
  ): Promise<SyncRangeResult> {
    const skipExisting = options.skipExisting ?? process.env.MARGIN_TRADING_SKIP_EXISTING !== '0';

    const startDate = parseIsoDate(start);
    const endDate = parseIsoDate(end);
    if (startDate > endDate) {
      throw new Error(`MarginTrading syncRange: start ${start} after end ${end}`);
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
        const existing = await MarginTradingBalance.count({ where: { trade_date: iso } });
        if (existing > 0) {
          logger.info(`MarginTrading: skip ${iso} (${existing} rows already present)`);
          details.push({
            trade_date: iso,
            fetched: 0,
            upserted: 0,
            szse_repay_imputed: 0,
            by_exchange: { SZSE: 0, SSE: 0 },
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
   * 查指定 codes 在 < tradeDate 的最近一日深交所 fin_balance, 供 day-to-day
   * diff 推算 fin_repay_amt 使用.
   *
   * 实现: 查 trade_date < target 的最近一日 (DESC limit 1 per code),
   * 但单 query 内 ORDER BY + GROUP BY 行为 dialect-dependent —— 用一次
   * findAll 拉满范围 + JS 端 reduce 取每个 code 最大 trade_date 行,
   * 简单且 dialect-independent.
   *
   * 实际跨日只查回 7 个自然日 (含周末) 缓冲, 避免长假后 diff 拉到太老的数据
   * 让推算 fin_repay_amt 失真.
   */
  private async loadPrevDayFinBalanceForCodes(
    targetDate: string,
    codes: string[]
  ): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (codes.length === 0) return out;

    // 计算 targetDate - 7 calendar days 作为查询起点
    const target = parseIsoDate(targetDate);
    const lower = new Date(target);
    lower.setUTCDate(lower.getUTCDate() - 7);
    const lowerIso = lower.toISOString().slice(0, 10);

    const rows = (await MarginTradingBalance.findAll({
      attributes: ['stock_code', 'trade_date', 'fin_balance'],
      where: {
        exchange: 'SZSE',
        stock_code: { [Op.in]: codes },
        trade_date: { [Op.gte]: lowerIso, [Op.lt]: targetDate },
      },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      trade_date: string;
      fin_balance: any;
    }>;

    // 每个 stock_code 取最大 trade_date 的 fin_balance
    const latestByCode = new Map<string, { trade_date: string; fin_balance: any }>();
    for (const r of rows) {
      const existing = latestByCode.get(r.stock_code);
      if (!existing || r.trade_date > existing.trade_date) {
        latestByCode.set(r.stock_code, { trade_date: r.trade_date, fin_balance: r.fin_balance });
      }
    }

    for (const [code, entry] of latestByCode.entries()) {
      const v =
        entry.fin_balance === null || entry.fin_balance === undefined
          ? null
          : Number(entry.fin_balance);
      out.set(code, v !== null && Number.isFinite(v) ? v : null);
    }

    return out;
  }
}

/** ISO YYYY-MM-DD → Date (UTC midnight) */
function parseIsoDate(iso: string): Date {
  if (!ISO_DATE_RE.test(iso)) {
    throw new Error(`Invalid ISO date (expected YYYY-MM-DD): ${iso}`);
  }
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(Date.UTC(y, m - 1, d));
}

export const marginTradingSyncService = new MarginTradingSyncService();
