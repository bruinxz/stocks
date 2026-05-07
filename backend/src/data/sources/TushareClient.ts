import { PythonMarketDataClient } from './PythonMarketDataClient';
import { StockBasicInfo, DailyBar } from './AKShareClient';
import { logger } from '../../utils/logger';

export class TushareClient extends PythonMarketDataClient {
  private token?: string;

  constructor(token?: string, pythonPath?: string) {
    super('Tushare', pythonPath);
    this.token = token || process.env.TUSHARE_TOKEN || process.env.TUSHARE_PRO_TOKEN;
  }

  isEnabled(): boolean {
    return process.env.TUSHARE_ENABLED === 'true' && Boolean(this.token);
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) {
      throw new Error('Tushare is disabled. Set TUSHARE_ENABLED=true and TUSHARE_TOKEN to enable it.');
    }
  }

  async getAllStocks(): Promise<StockBasicInfo[]> {
    this.assertEnabled();
    logger.info('Fetching all stocks from Tushare...');
    return this.callPythonScript('tushare_get_all_stocks', this.token || '');
  }

  async queryHistoryKData(
    code: string,
    start_date: string,
    end_date: string,
    frequency: 'd' | 'w' | 'm' = 'd',
    adjustflag: '1' | '2' | '3' = '3'
  ): Promise<DailyBar[]> {
    this.assertEnabled();
    logger.info(`Fetching history data for ${code} from ${start_date} to ${end_date} via Tushare`);
    return this.callPythonScript(
      'tushare_get_daily_data',
      this.token || '',
      code,
      start_date,
      end_date,
      frequency,
      adjustflag
    );
  }

  async queryStockBasic(code: string): Promise<StockBasicInfo | null> {
    this.assertEnabled();
    logger.info(`Fetching stock basic info for ${code} from Tushare`);
    return this.callPythonScript('tushare_get_stock_basic', this.token || '', code);
  }

  getStatus() {
    return {
      ...this.getBaseStatus(),
      isAvailable: this.isEnabled(),
      hasToken: Boolean(this.token),
    };
  }
}
