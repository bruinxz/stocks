import { FinancialReport } from '../../models/FinancialReport';
import { logger } from '../../utils/logger';
import {
  FinancialReportClient,
  FinancialReportRow,
  financialReportClient,
} from '../sources/FinancialReportClient';

/**
 * 财务报告入库服务 — US-024 数据层。
 *
 * 与按 trade_date 批量同步（北向 / 龙虎榜 / 涨停 / 行业流）不同，财务报告
 * 是 **按股票** 同步的：每只股票一次性拉全部历史报告。Sync 服务提供：
 *
 *   - `syncStock(stockCode)`     — 拉一只股票全部 financial_report rows + upsert
 *   - `syncStocks(stockCodes[])` — 批量；支持 skip-existing 检查点
 *
 * 该模式与 DividendHistorySyncService (US-022) 完全同款 — per-stock historical
 * timeline sync 的标准实现。
 *
 * **stock_name 字段**：当前 Python helper 不返回 stock_name（AKShare 的
 * `stock_financial_analysis_indicator` 不带名称列），所以 stock_name 不写入。
 * 下游策略需要名称时从 Stock 表 join。
 *
 * **upsert 字段语义**：composite PK (report_date, stock_code) — 同一报告期
 * 同一股票的修订（罕见，公司发现错误重新公布）通过 updateOnDuplicate 覆盖原行。
 */
export interface SyncStockResult {
  stock_code: string;
  fetched: number;
  upserted: number;
  annual_count: number;
  skipped: boolean;
  error?: string;
}

export interface SyncStocksOptions {
  /** 已有任意一条 financial report 的股票跳过整批，默认 true */
  skipExisting?: boolean;
  /** 同步间 sleep 毫秒（友好 AKShare 限流），默认 300（比 dividend 慢，因 Python 跑两个端点） */
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

export class FinancialReportSyncService {
  private client: FinancialReportClient;

  constructor(client: FinancialReportClient = financialReportClient) {
    this.client = client;
  }

  /**
   * 同步单只股票的全部历史财务报告。
   *
   * @param stockCode 6 位无市场后缀代码，例如 '600519'
   */
  async syncStock(stockCode: string): Promise<SyncStockResult> {
    if (!/^\d{6}$/.test(stockCode)) {
      return {
        stock_code: stockCode,
        fetched: 0,
        upserted: 0,
        annual_count: 0,
        skipped: false,
        error: `Invalid stock_code format (expected 6 digits): ${stockCode}`,
      };
    }

    try {
      const rows = await this.client.fetchForStock(stockCode);
      if (rows.length === 0) {
        logger.warn(
          `FinancialReport: no data returned for stock=${stockCode}, marking as empty success`
        );
        return {
          stock_code: stockCode,
          fetched: 0,
          upserted: 0,
          annual_count: 0,
          skipped: false,
        };
      }

      let annualCount = 0;
      const records = rows.map((row: FinancialReportRow) => {
        if (row.report_type === '年报') annualCount += 1;
        return {
          report_date: row.report_date,
          stock_code: row.stock_code,
          report_type: row.report_type ?? undefined,
          net_profit: row.net_profit ?? undefined,
          net_profit_yoy: row.net_profit_yoy ?? undefined,
          revenue: row.revenue ?? undefined,
          revenue_yoy: row.revenue_yoy ?? undefined,
          roe: row.roe ?? undefined,
          debt_ratio: row.debt_ratio ?? undefined,
          source: 'akshare',
          raw_payload: row.raw_payload ?? {},
        };
      });

      await FinancialReport.bulkCreate(records, {
        updateOnDuplicate: [
          'report_type',
          'net_profit',
          'net_profit_yoy',
          'revenue',
          'revenue_yoy',
          'roe',
          'debt_ratio',
          'source',
          'raw_payload',
          'updated_at',
        ],
      });

      logger.info(
        `FinancialReport: upserted ${records.length} rows for stock=${stockCode} ` +
          `(annual=${annualCount})`
      );
      return {
        stock_code: stockCode,
        fetched: rows.length,
        upserted: records.length,
        annual_count: annualCount,
        skipped: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`FinancialReport syncStock(${stockCode}) failed: ${message}`);
      return {
        stock_code: stockCode,
        fetched: 0,
        upserted: 0,
        annual_count: 0,
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
    const skipExisting = options.skipExisting ?? process.env.FINANCIAL_REPORT_SKIP_EXISTING !== '0';
    const intervalMs = options.intervalMs ?? 300;

    const details: SyncStockResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < stockCodes.length; i++) {
      const code = stockCodes[i];
      if (skipExisting) {
        const existing = await FinancialReport.count({ where: { stock_code: code } });
        if (existing > 0) {
          logger.info(`FinancialReport: skip stock=${code} (${existing} rows already present)`);
          details.push({
            stock_code: code,
            fetched: 0,
            upserted: 0,
            annual_count: 0,
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

export const financialReportSyncService = new FinancialReportSyncService();
