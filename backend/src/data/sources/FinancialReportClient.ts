import path from 'path';

import { logger } from '../../utils/logger';
import { PythonMarketDataClient } from './PythonMarketDataClient';

export interface FinancialReportRow {
  report_date: string;
  stock_code: string;
  stock_name?: string | null;
  report_type: string | null;
  net_profit: number | null;
  net_profit_yoy: number | null;
  revenue: number | null;
  revenue_yoy: number | null;
  roe: number | null;
  debt_ratio: number | null;
  raw_payload: Record<string, unknown>;
}

/** Per-stock financial history backed by akshare_helper.py get_financial_report. */
export class FinancialReportClient extends PythonMarketDataClient {
  constructor(pythonPath?: string) {
    super('FinancialReport', pythonPath);
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
  }

  async fetchForStock(stock_code: string): Promise<FinancialReportRow[]> {
    const code = String(stock_code).trim();
    if (!/^\d{6}$/.test(code)) {
      throw new Error(`Invalid stock_code format (expected 6 digits): ${stock_code}`);
    }
    const rows = await this.callPythonScript('get_financial_report', code);
    if (!Array.isArray(rows)) {
      logger.warn(`FinancialReportClient returned a non-array payload for ${code}`);
      return [];
    }
    return rows as FinancialReportRow[];
  }

  async fetchMarketPeriod(report_period: string): Promise<FinancialReportRow[]> {
    const compact = String(report_period).trim().replace(/-/g, '');
    if (!/^\d{4}(0331|0630|0930|1231)$/.test(compact)) {
      throw new Error(`Invalid report_period (expected quarter end): ${report_period}`);
    }
    const rows = await this.callPythonScript('get_market_financial_report', compact);
    if (!Array.isArray(rows)) {
      logger.warn(`FinancialReportClient returned a non-array market payload for ${compact}`);
      return [];
    }
    return rows as FinancialReportRow[];
  }
}

export const financialReportClient = new FinancialReportClient();
