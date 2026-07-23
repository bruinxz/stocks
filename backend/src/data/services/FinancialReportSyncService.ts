import { FinancialReport } from '../../models/FinancialReport';
import { logger } from '../../utils/logger';
import {
  FinancialReportClient,
  FinancialReportRow,
  financialReportClient,
} from '../sources/FinancialReportClient';

export interface FinancialReportSyncStockResult {
  stock_code: string;
  fetched: number;
  upserted: number;
  skipped: boolean;
  empty: boolean;
  error?: string;
}

export interface FinancialReportSyncResult {
  total_stocks: number;
  succeeded: number;
  skipped: number;
  empty: number;
  failed: number;
  total_upserted: number;
  details: FinancialReportSyncStockResult[];
}

export class FinancialReportSyncService {
  constructor(private readonly client: FinancialReportClient = financialReportClient) {}

  async syncStock(stock_code: string): Promise<FinancialReportSyncStockResult> {
    if (!/^\d{6}$/.test(stock_code)) {
      return {
        stock_code,
        fetched: 0,
        upserted: 0,
        skipped: false,
        empty: false,
        error: `Invalid stock_code format (expected 6 digits): ${stock_code}`,
      };
    }
    try {
      const rows = await this.client.fetchForStock(stock_code);
      const deduped = dedupFinancialReports(rows);
      if (deduped.length === 0) {
        return { stock_code, fetched: 0, upserted: 0, skipped: false, empty: true };
      }
      await FinancialReport.bulkCreate(
        deduped.map(row => ({
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
          raw_payload: row.raw_payload || {},
        })),
        {
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
        }
      );
      return {
        stock_code,
        fetched: rows.length,
        upserted: deduped.length,
        skipped: false,
        empty: false,
      };
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`FinancialReport syncStock(${stock_code}) failed: ${message}`);
      return {
        stock_code,
        fetched: 0,
        upserted: 0,
        skipped: false,
        empty: false,
        error: message,
      };
    }
  }

  async syncStocks(
    stock_codes: string[],
    options: { skip_existing?: boolean; interval_ms?: number; refresh_after_days?: number } = {}
  ): Promise<FinancialReportSyncResult> {
    const details: FinancialReportSyncStockResult[] = [];
    let succeeded = 0;
    let skipped = 0;
    let empty = 0;
    let failed = 0;
    let total_upserted = 0;
    const skipExisting = options.skip_existing !== false;
    const intervalMs = Math.max(0, Number(options.interval_ms ?? 500));
    const refreshAfterMs = Math.max(1, Number(options.refresh_after_days ?? 21)) * 86_400_000;

    for (let index = 0; index < stock_codes.length; index += 1) {
      const stock_code = stock_codes[index];
      if (skipExisting) {
        const latest = await FinancialReport.findOne({
          attributes: ['updated_at'],
          where: { stock_code },
          order: [['updated_at', 'DESC']],
        });
        if (latest?.updated_at && Date.now() - latest.updated_at.getTime() < refreshAfterMs) {
          details.push({
            stock_code,
            fetched: 0,
            upserted: 0,
            skipped: true,
            empty: false,
          });
          skipped += 1;
          continue;
        }
      }
      const result = await this.syncStock(stock_code);
      details.push(result);
      total_upserted += result.upserted;
      if (result.error) failed += 1;
      else if (result.empty) empty += 1;
      else succeeded += 1;
      if (intervalMs > 0 && index < stock_codes.length - 1) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    return {
      total_stocks: stock_codes.length,
      succeeded,
      skipped,
      empty,
      failed,
      total_upserted,
      details,
    };
  }
}

export function dedupFinancialReports(rows: FinancialReportRow[]): FinancialReportRow[] {
  const byKey = new Map<string, FinancialReportRow>();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.report_date)) || !/^\d{6}$/.test(row.stock_code)) {
      continue;
    }
    byKey.set(`${row.report_date}|${row.stock_code}`, row);
  }
  return [...byKey.values()];
}

export const financialReportSyncService = new FinancialReportSyncService();
