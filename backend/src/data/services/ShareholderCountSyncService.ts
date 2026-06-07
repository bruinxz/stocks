import { ShareholderCount } from '../../models/ShareholderCount';
import { logger } from '../../utils/logger';
import {
  ShareholderCountClient,
  ShareholderCountRow,
  shareholderCountClient,
} from '../sources/ShareholderCountClient';

/**
 * 股东户数入库服务 — US-035 数据层.
 *
 * 与按 trade_date 批量同步（北向 / 龙虎榜 / 涨停 / 行业流）不同，股东户数是
 * **按股票** 同步的：每只股票一次拉全部历史快照（50-70 条），与 US-022
 * DividendHistory / US-024 FinancialReport / US-030 AnalystForecast 同款
 * per-stock 模式：
 *
 *   - `syncStock(stockCode)`     — 拉一只股票全部 holder_count 历史 + upsert
 *   - `syncStocks(stockCodes[])` — 批量；支持 skip-existing 检查点 + friendly throttle
 *
 * **本服务不计算业务派生字段**：
 *   - 不在这里算 "最新一期 vs 上一期环比变化"——这是因子语义，留给
 *     ShareholderConcentrationFactor 在 compute() 时跨 row 实时计算。
 *   - 不过滤 share_change != 0 的"含噪音"行——dumb fetcher 模式，规则留 TS 因子层
 *     (同 US-006 famous_seat / US-007 is_one_word_board / US-013 is_surprise)。
 */
export interface SyncStockResult {
  stock_code: string;
  fetched: number;
  upserted: number;
  skipped: boolean;
  error?: string;
}

export interface SyncStocksOptions {
  /** 已有任意一条 holder_count 的股票跳过整批，默认 true */
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

export class ShareholderCountSyncService {
  private client: ShareholderCountClient;

  constructor(client: ShareholderCountClient = shareholderCountClient) {
    this.client = client;
  }

  /**
   * 同步单只股票的全部历史股东户数。
   *
   * @param stockCode 6 位无市场后缀代码，例如 '600519'
   */
  async syncStock(stockCode: string): Promise<SyncStockResult> {
    if (!/^\d{6}$/.test(stockCode)) {
      return {
        stock_code: stockCode,
        fetched: 0,
        upserted: 0,
        skipped: false,
        error: `Invalid stock_code format (expected 6 digits): ${stockCode}`,
      };
    }

    try {
      const rows = await this.client.fetchForStock(stockCode);
      if (rows.length === 0) {
        logger.warn(
          `ShareholderCount: no data returned for stock=${stockCode}, marking as empty success`
        );
        return {
          stock_code: stockCode,
          fetched: 0,
          upserted: 0,
          skipped: false,
        };
      }

      const records = rows.map((row: ShareholderCountRow) => ({
        report_date: row.report_date,
        stock_code: row.stock_code,
        stock_name: row.stock_name ?? undefined,
        holder_count: row.holder_count,
        holder_count_prev: row.holder_count_prev ?? undefined,
        holder_count_change: row.holder_count_change ?? undefined,
        holder_count_change_pct: row.holder_count_change_pct ?? undefined,
        interval_change_pct: row.interval_change_pct ?? undefined,
        avg_holder_market_cap: row.avg_holder_market_cap ?? undefined,
        avg_holder_shares: row.avg_holder_shares ?? undefined,
        total_market_cap: row.total_market_cap ?? undefined,
        total_shares: row.total_shares ?? undefined,
        share_change: row.share_change ?? undefined,
        share_change_reason: row.share_change_reason ?? undefined,
        announce_date: row.announce_date ?? undefined,
        source: 'akshare',
        raw_payload: row.raw_payload ?? {},
      }));

      await ShareholderCount.bulkCreate(records, {
        updateOnDuplicate: [
          'stock_name',
          'holder_count',
          'holder_count_prev',
          'holder_count_change',
          'holder_count_change_pct',
          'interval_change_pct',
          'avg_holder_market_cap',
          'avg_holder_shares',
          'total_market_cap',
          'total_shares',
          'share_change',
          'share_change_reason',
          'announce_date',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(`ShareholderCount: upserted ${records.length} rows for stock=${stockCode}`);
      return {
        stock_code: stockCode,
        fetched: rows.length,
        upserted: records.length,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`ShareholderCount syncStock(${stockCode}) failed: ${message}`);
      return {
        stock_code: stockCode,
        fetched: 0,
        upserted: 0,
        skipped: false,
        error: message,
      };
    }
  }

  /**
   * 批量同步多只股票；遇到已有数据可跳过（断点续传）.
   */
  async syncStocks(
    stockCodes: string[],
    options: SyncStocksOptions = {}
  ): Promise<SyncStocksResult> {
    const skipExisting =
      options.skipExisting ?? process.env.SHAREHOLDER_COUNT_SKIP_EXISTING !== '0';
    const intervalMs = options.intervalMs ?? 200;

    const details: SyncStockResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < stockCodes.length; i++) {
      const code = stockCodes[i];
      if (skipExisting) {
        const existing = await ShareholderCount.count({ where: { stock_code: code } });
        if (existing > 0) {
          logger.info(`ShareholderCount: skip stock=${code} (${existing} rows already present)`);
          details.push({
            stock_code: code,
            fetched: 0,
            upserted: 0,
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
}

export const shareholderCountSyncService = new ShareholderCountSyncService();
