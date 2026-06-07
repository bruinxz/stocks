import { StockSentiment } from '../../models/StockSentiment';
import { logger } from '../../utils/logger';
import {
  EastMoneyQAClient,
  StockSentimentRow,
  eastMoneyQAClient,
} from '../sources/EastMoneyQAClient';

/**
 * 个股情绪入库服务 — US-034.
 *
 * 与按 trade_date 批量同步（北向 / 龙虎榜 / 涨停 / 行业流）不同，本服务按
 * **股票** 同步：每只股票一次拉全部历史人气数据（~365 条），与 US-022
 * DividendHistory / US-024 FinancialReport / US-030 AnalystForecast 同款
 * per-stock pattern：
 *
 *   - `syncStock(stockCode)`     — 拉一只股票全部 sentiment rows + upsert
 *   - `syncStocks(stockCodes[])` — 批量；支持 skip-existing 检查点 + friendly throttle
 *
 * **同股同日多条 dedup**：AKShare 偶尔在 hot_rank_detail 返回 duplicate trade_date
 * 行（数据修复 / 重复抓取）；Python helper 已用 `seen_dates: set` 在源端去重保留
 * 首条。TS 服务层无需额外 dedup —— PK (trade_date, stock_code) 复合主键 + bulkCreate
 * updateOnDuplicate 在同一 batch 内的 PK 冲突行为下，所有主流 dialect (Postgres
 * INSERT ... ON CONFLICT / MySQL ON DUPLICATE KEY UPDATE) 都保留"最后一条 wins"
 * 而非 error，与 Python 端"首条 wins"组合后整体保留"AKShare 最早出现的版本"，
 * 满足 sentiment 数据"日级单一快照"语义。
 *
 * **本服务不计算业务派生字段**：所有代理 (post_count / view_count / heat_score)
 * 由 Python helper 一次性算好直接落库 —— 与 DividendHistory 的 yield_pct (TS 端
 * 跨表 join DailyBar) 不同，因为本因子的代理只依赖 (rank, fans) 同张表内字段，
 * Python 一次到位避免重复 IO。
 */
export interface SyncStockResult {
  stock_code: string;
  fetched: number;
  upserted: number;
  skipped: boolean;
  error?: string;
}

export interface SyncStocksOptions {
  /** 已有任意一条 sentiment 行的股票跳过整批，默认 true */
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

export class StockSentimentSyncService {
  private client: EastMoneyQAClient;

  constructor(client: EastMoneyQAClient = eastMoneyQAClient) {
    this.client = client;
  }

  /**
   * 同步单只股票的全部历史人气数据。
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
          `StockSentiment: no data returned for stock=${stockCode}, marking as empty success`
        );
        return {
          stock_code: stockCode,
          fetched: 0,
          upserted: 0,
          skipped: false,
        };
      }

      const records = rows.map((row: StockSentimentRow) => ({
        trade_date: row.trade_date,
        stock_code: row.stock_code,
        post_count: row.post_count ?? undefined,
        view_count: row.view_count ?? undefined,
        heat_score: row.heat_score ?? undefined,
        rank: row.rank ?? undefined,
        new_fan_ratio: row.new_fan_ratio ?? undefined,
        hardcore_fan_ratio: row.hardcore_fan_ratio ?? undefined,
        source: 'akshare',
        raw_payload: row.raw_payload ?? {},
      }));

      await StockSentiment.bulkCreate(records, {
        updateOnDuplicate: [
          'post_count',
          'view_count',
          'heat_score',
          'rank',
          'new_fan_ratio',
          'hardcore_fan_ratio',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(`StockSentiment: upserted ${records.length} rows for stock=${stockCode}`);
      return {
        stock_code: stockCode,
        fetched: rows.length,
        upserted: records.length,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`StockSentiment syncStock(${stockCode}) failed: ${message}`);
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
   * 批量同步多只股票；遇到已有数据可跳过（断点续传）。
   */
  async syncStocks(
    stockCodes: string[],
    options: SyncStocksOptions = {}
  ): Promise<SyncStocksResult> {
    const skipExisting = options.skipExisting ?? process.env.STOCK_SENTIMENT_SKIP_EXISTING !== '0';
    const intervalMs = options.intervalMs ?? 200;

    const details: SyncStockResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < stockCodes.length; i++) {
      const code = stockCodes[i];
      if (skipExisting) {
        const existing = await StockSentiment.count({ where: { stock_code: code } });
        if (existing > 0) {
          logger.info(`StockSentiment: skip stock=${code} (${existing} rows already present)`);
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

export const stockSentimentSyncService = new StockSentimentSyncService();
