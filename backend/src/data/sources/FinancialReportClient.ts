import path from 'path';

import { logger } from '../../utils/logger';
import { PythonMarketDataClient } from './PythonMarketDataClient';

export interface FinancialReportRow {
  report_date: string;
  stock_code: string;
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
}

export const financialReportClient = new FinancialReportClient();
