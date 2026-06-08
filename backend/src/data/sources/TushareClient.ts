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
      throw new Error(
        'Tushare is disabled. Set TUSHARE_ENABLED=true and TUSHARE_TOKEN to enable it.'
      );
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

  async getFactorSnapshots(symbols: string[], as_of?: string): Promise<any[]> {
    this.assertEnabled();
    const uniqueSymbols = [...new Set(symbols.filter(Boolean))];
    if (!uniqueSymbols.length) return [];
    logger.info(`Fetching ${uniqueSymbols.length} factor snapshots via Tushare`);
    return this.callPythonScript(
      'tushare_get_factor_snapshot',
      this.token || '',
      uniqueSymbols.join(','),
      as_of || ''
    );
  }

  async smokeTest(options: { symbol?: string; as_of?: string } = {}) {
    this.assertEnabled();
    const symbol = options.symbol || 'sh.600000';
    const started_at = new Date().toISOString();
    const snapshots = await this.getFactorSnapshots([symbol], options.as_of);
    const snapshot = snapshots[0] || null;
    return {
      started_at,
      finished_at: new Date().toISOString(),
      symbol,
      provider: 'tushare',
      enabled: true,
      has_token: Boolean(this.token),
      snapshot_found: Boolean(snapshot),
      snapshot,
      checks: {
        daily_basic: Boolean(snapshot?.daily_basic),
        moneyflow: Boolean(snapshot?.moneyflow),
        fina_indicator: Boolean(snapshot?.fina_indicator),
      },
      errors: Array.isArray(snapshot?.errors) ? snapshot.errors : [],
      conclusion: snapshot
        ? `Tushare 烟测成功，${symbol} 已返回 ${
            [snapshot?.daily_basic, snapshot?.moneyflow, snapshot?.fina_indicator].filter(Boolean)
              .length
          } 类因子切片。`
        : `Tushare 烟测未返回 ${symbol} 的有效快照。`,
    };
  }

  getStatus() {
    return {
      ...this.getBaseStatus(),
      isAvailable: this.isEnabled(),
      hasToken: Boolean(this.token),
    };
  }
}
