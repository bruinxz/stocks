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

  getStatus() {
    return {
      ...this.getBaseStatus(),
      isAvailable: process.env.BAOSTOCK_ENABLED !== 'false',
    };
  }
}
