import { PythonMarketDataClient } from './PythonMarketDataClient';
import { StockBasicInfo, DailyBar } from './AKShareClient';
import { logger } from '../../utils/logger';

export class BaostockClient extends PythonMarketDataClient {
  constructor(pythonPath?: string) {
    super('Baostock', pythonPath);
  }

  async getAllStocks(): Promise<StockBasicInfo[]> {
    logger.info('Fetching all stocks from Baostock...');
    return this.callPythonScript('baostock_get_all_stocks');
  }

  async queryHistoryKData(
    code: string,
    start_date: string,
    end_date: string,
    frequency: 'd' | 'w' | 'm' = 'd',
    adjustflag: '1' | '2' | '3' = '3'
  ): Promise<DailyBar[]> {
    logger.info(`Fetching history data for ${code} from ${start_date} to ${end_date} via Baostock`);
    return this.callPythonScript(
      'baostock_get_daily_data',
      code,
      start_date,
      end_date,
      frequency,
      adjustflag
    );
  }

  async queryStockBasic(code: string): Promise<StockBasicInfo | null> {
    logger.info(`Fetching stock basic info for ${code} from Baostock`);
    return this.callPythonScript('baostock_get_stock_basic', code);
  }

  async queryTradeDates(start_date: string, end_date: string): Promise<string[]> {
    return this.callPythonScript('baostock_get_trade_dates', start_date, end_date);
  }

  /**
   * Batch BB (2026-07-03): 批量取核心宽基成分股真实 PE/PB/PS(+可选 ROE).
   * 东方财富服务器边缘 IP 被封 (502) 时的可持续免登录替代源.
   * @param codes  任意格式股票代码数组 (600000 / sh.600000 / 600000.SH)
   * @param asOf   因子日期 YYYY-MM-DD, 默认今日
   * @param withRoe 是否附带 roeAvg (季度频率, 慢一倍)
   */
  async getValuationBatch(
    codes: string[],
    asOf?: string,
    withRoe = false
  ): Promise<
    Array<{
      symbol: string;
      factor_date: string;
      pe_ttm: number;
      pb: number;
      ps_ttm: number;
      roe: number | null;
      roe_stat_date?: string;
    }>
  > {
    if (!codes.length) return [];
    logger.info(`Fetching baostock valuation batch for ${codes.length} codes (withRoe=${withRoe})`);
    return this.callPythonScript(
      'baostock_get_valuation_batch',
      codes.join(','),
      asOf || '',
      withRoe ? '1' : '0'
    );
  }

  getStatus() {
    return {
      ...this.getBaseStatus(),
      isAvailable: process.env.BAOSTOCK_ENABLED !== 'false',
    };
  }
}
