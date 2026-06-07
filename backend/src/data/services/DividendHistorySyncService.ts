import { Op } from 'sequelize';
import { DividendHistory } from '../../models/DividendHistory';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';
import {
  DividendHistoryClient,
  DividendHistoryRow,
  dividendHistoryClient,
} from '../sources/DividendHistoryClient';

/**
 * 分红派息历史入库服务 — US-022 数据层。
 *
 * 与按 trade_date 批量同步（北向 / 龙虎榜 / 涨停 / 行业流）不同，dividend
 * history 是 **按股票** 同步的：每只股票一次性拉全部历史分红记录。Sync
 * 服务提供：
 *
 *   - `syncStock(stockCode)`     — 拉一只股票全部 dividend rows + upsert
 *   - `syncStocks(stockCodes[])` — 批量；支持 skip-existing 检查点
 *
 * **派息率 (yield_pct) 在 TS 服务里计算**（codebase pattern: cross-table
 * join belongs in TS service）：
 *
 *   yield_pct = dividend_per_share / ex_date 前一日 close * 100
 *
 * 计算时机：每次 `syncStock` 拉到新的 dividend rows 后，批量查 DailyBar
 * 对应 ex_date 前 N 天的 close 价（取 ex_date 最近且 < ex_date 的 close
 * 作为基准价；缺数据则 yield_pct = null）。Lookback 取 10 天足够覆盖
 * 春节/十一假期 + 停牌。
 *
 * 注意：dividend_per_share 是 "每股派息金额"（元），不是 "每 10 股派息"
 * （即 Python helper 已经做了 / 10 的转换）。
 */
export interface SyncStockResult {
  stock_code: string;
  fetched: number;
  upserted: number;
  yield_filled: number;
  skipped: boolean;
  error?: string;
}

export interface SyncStocksOptions {
  /** 已有任意一条 dividend record 的股票跳过整批，默认 true */
  skipExisting?: boolean;
  /** 同步间 sleep 毫秒（友好 AKShare 限流），默认 200 */
  intervalMs?: number;
}

export interface SyncStocksResult {
  stock_codes: string[];
  total_stocks: number;
  succeeded: number;
  skipped: number;
  failed: number;
  details: SyncStockResult[];
}

export class DividendHistorySyncService {
  private client: DividendHistoryClient;

  constructor(client: DividendHistoryClient = dividendHistoryClient) {
    this.client = client;
  }

  /**
   * 同步单只股票的全部历史分红记录。
   *
   * @param stockCode 6 位无市场后缀代码，例如 '600519'
   */
  async syncStock(stockCode: string): Promise<SyncStockResult> {
    if (!/^\d{6}$/.test(stockCode)) {
      return {
        stock_code: stockCode,
        fetched: 0,
        upserted: 0,
        yield_filled: 0,
        skipped: false,
        error: `Invalid stock_code format (expected 6 digits): ${stockCode}`,
      };
    }

    try {
      const rows = await this.client.fetchForStock(stockCode);
      if (rows.length === 0) {
        logger.warn(
          `DividendHistory: no data returned for stock=${stockCode}, marking as empty success`
        );
        return {
          stock_code: stockCode,
          fetched: 0,
          upserted: 0,
          yield_filled: 0,
          skipped: false,
        };
      }

      // === 计算 yield_pct（基于 ex_date 前一日 close）===
      const yieldMap = await this.computeYieldPctMap(stockCode, rows);
      let yieldFilled = 0;

      const records = rows.map((row: DividendHistoryRow) => {
        const yieldPct = yieldMap.get(row.ex_date) ?? null;
        if (yieldPct != null) yieldFilled += 1;
        return {
          announce_date: row.announce_date,
          stock_code: row.stock_code,
          ex_date: row.ex_date,
          stock_name: undefined,
          dividend_per_share: row.dividend_per_share ?? undefined,
          bonus_per_10: row.bonus_per_10 ?? undefined,
          transfer_per_10: row.transfer_per_10 ?? undefined,
          yield_pct: yieldPct ?? undefined,
          progress: row.progress ?? undefined,
          record_date: row.record_date ?? undefined,
          pay_date: row.pay_date ?? undefined,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      await DividendHistory.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'dividend_per_share',
          'bonus_per_10',
          'transfer_per_10',
          'yield_pct',
          'progress',
          'record_date',
          'pay_date',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `DividendHistory: upserted ${records.length} rows for stock=${stockCode} ` +
          `(yield_filled=${yieldFilled})`
      );
      return {
        stock_code: stockCode,
        fetched: rows.length,
        upserted: records.length,
        yield_filled: yieldFilled,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`DividendHistory syncStock(${stockCode}) failed: ${message}`);
      return {
        stock_code: stockCode,
        fetched: 0,
        upserted: 0,
        yield_filled: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 批量同步多只股票；遇到已有数据可跳过（断点续传）
   */
  async syncStocks(
    stockCodes: string[],
    options: SyncStocksOptions = {}
  ): Promise<SyncStocksResult> {
    const skipExisting = options.skipExisting ?? process.env.DIVIDEND_HISTORY_SKIP_EXISTING !== '0';
    const intervalMs = options.intervalMs ?? 200;

    const details: SyncStockResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < stockCodes.length; i++) {
      const code = stockCodes[i];
      if (skipExisting) {
        const existing = await DividendHistory.count({ where: { stock_code: code } });
        if (existing > 0) {
          logger.info(`DividendHistory: skip stock=${code} (${existing} rows already present)`);
          details.push({
            stock_code: code,
            fetched: 0,
            upserted: 0,
            yield_filled: 0,
            skipped: true,
          });
          skipped += 1;
          continue;
        }
      }
      const r = await this.syncStock(code);
      details.push(r);
      if (r.error) failed += 1;
      else succeeded += 1;

      // friendly throttle for AKShare
      if (intervalMs > 0 && i < stockCodes.length - 1) {
        await new Promise(res => setTimeout(res, intervalMs));
      }
    }

    return {
      stock_codes: stockCodes,
      total_stocks: stockCodes.length,
      succeeded,
      skipped,
      failed,
      details,
    };
  }

  // -------------------------------------------------------------------------
  // 内部：基于 ex_date 前一日 close 计算 yield_pct
  // -------------------------------------------------------------------------

  /**
   * 给定一只股票的若干 dividend rows，批量查 DailyBar 找每条 ex_date 之前
   * 最近的 close，计算 yield_pct = dividend_per_share / close * 100。
   *
   * 跳过：dividend_per_share == null / 0；缺 DailyBar 数据；找不到 Stock 行。
   */
  private async computeYieldPctMap(
    stockCode: string,
    rows: DividendHistoryRow[]
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();

    // 只对有派息的行计算 yield_pct
    const interesting = rows.filter(
      r => r.dividend_per_share != null && r.dividend_per_share > 0 && r.ex_date
    );
    if (interesting.length === 0) return out;

    // 找 Stock 行
    const symbol = guessStockSymbol(stockCode);
    const stock = await Stock.findOne({
      attributes: ['id', 'symbol'],
      where: { symbol },
      raw: true,
    });
    if (!stock || !stock.id) {
      logger.warn(
        `DividendHistory: stock symbol=${symbol} not found in stocks table; ` +
          `yield_pct will be NULL for ${interesting.length} ex_dates`
      );
      return out;
    }
    const stockId = (stock as { id: number }).id;

    // 一次性拉全部 ex_date 窗口的 DailyBar：[min ex_date - 10d, max ex_date]
    const exDates = interesting.map(r => r.ex_date).sort();
    const minExDate = exDates[0];
    const maxExDate = exDates[exDates.length - 1];
    const lookbackStart = new Date(`${minExDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 10);

    const bars = (await DailyBar.findAll({
      attributes: ['time', 'close'],
      where: {
        stock_id: stockId,
        time: {
          [Op.gte]: lookbackStart.toISOString(),
          [Op.lte]: `${maxExDate}T23:59:59Z`,
        },
      },
      raw: true,
    })) as unknown as Array<{ time: Date | string; close: number | string }>;

    if (bars.length === 0) return out;

    // 按 ISO date 索引
    const closeByDate = new Map<string, number>();
    for (const b of bars) {
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      const close = Number(b.close);
      if (Number.isFinite(close)) closeByDate.set(tIso, close);
    }
    if (closeByDate.size === 0) return out;

    // 排序的 trade_date 列表，便于找 ex_date 之前最近的 close
    const tradeDates = Array.from(closeByDate.keys()).sort();

    for (const row of interesting) {
      const dps = row.dividend_per_share!;
      // 找 ex_date 之前最近的 trade_date
      const baseDate = findLatestBeforeDate(tradeDates, row.ex_date);
      if (!baseDate) continue;
      const close = closeByDate.get(baseDate);
      if (close == null || close <= 0) continue;
      const yieldPct = (dps / close) * 100;
      if (Number.isFinite(yieldPct)) out.set(row.ex_date, Number(yieldPct.toFixed(4)));
    }

    return out;
  }
}

// ---------------------------------------------------------------------------
// 内部 helpers
// ---------------------------------------------------------------------------

/**
 * 在升序的 ISO date 列表里找 strictly less than targetDate 的最大元素。
 * 用 simple linear scan（dividend rows 通常 < 50 条，性能不是瓶颈）。
 *
 * 返回 null 表示 targetDate 之前没有任何 trade_date 数据（股票太新 / 停牌）。
 */
export function findLatestBeforeDate(
  sortedTradeDates: string[],
  targetDate: string
): string | null {
  let result: string | null = null;
  for (const d of sortedTradeDates) {
    if (d >= targetDate) break;
    result = d;
  }
  return result;
}

/**
 * 6 位 stock_code → Stock.symbol（带 .SH/.SZ/.BJ 后缀）。
 * 与 EarningsSurpriseStrategy 的 guessStockSymbol 同款逻辑（首字符分发）。
 */
export function guessStockSymbol(stockCode: string): string {
  if (!stockCode) return '';
  if (stockCode.includes('.')) return stockCode;
  const head = stockCode[0];
  if (head === '6') return `${stockCode}.SH`;
  if (head === '0' || head === '3') return `${stockCode}.SZ`;
  if (head === '4' || head === '8') return `${stockCode}.BJ`;
  return `${stockCode}.SZ`;
}

export const dividendHistorySyncService = new DividendHistorySyncService();
