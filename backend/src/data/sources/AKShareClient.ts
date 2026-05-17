import { spawn } from 'child_process';
import { logger } from '../../utils/logger';
import path from 'path';

export interface StockBasicInfo {
  code: string; // 股票代码，如 'sh.600000'
  code_name: string; // 股票名称，如 '浦发银行'
  ipoDate: string; // 上市日期
  industry?: string; // 行业
  outDate?: string; // 退市日期
  type: number; // 类型：1-股票，2-指数，3-其他
  status: number; // 状态：1-上市，0-退市
  total_market_cap?: number; // 总市值
  circulating_market_cap?: number; // 流通市值
  pe_dynamic?: number; // 动态市盈率
  pb?: number; // 市净率
  ps?: number; // 市销率
  turnover_rate?: number; // 换手率
  price?: number; // 最新价
  change_percent?: number; // 涨跌幅
}

export interface DailyBar {
  date: string; // 交易日期，格式：'2023-06-01'
  code: string; // 股票代码
  open: number; // 开盘价
  high: number; // 最高价
  low: number; // 最低价
  close: number; // 收盘价
  volume: number; // 成交量（股）
  amount: number; // 成交额（元）
  adjustflag: number; // 复权类型：1-后复权，2-前复权，3-不复权
  turn: number; // 换手率
  tradestatus: number; // 交易状态：1-正常，0-停牌
  pctChg: number; // 涨跌幅
  peTTM: number; // 市盈率TTM
  psTTM: number; // 市销率TTM
  pbMRQ: number; // 市净率MRQ
  total_share?: number; // 总股本
  float_share?: number; // 流通股本
  free_share?: number; // 自由流通股本
  total_mv?: number; // 总市值（万元）
  circ_mv?: number; // 流通市值（万元）
  total_market_cap?: number; // 总市值(历史)
}

export interface QueryParams {
  code?: string; // 股票代码
  start_date?: string; // 开始日期
  end_date?: string; // 结束日期
  fields?: string; // 返回字段
  frequency?: 'd' | 'w' | 'm'; // 频率：日、周、月
  adjustflag?: '1' | '2' | '3'; // 复权类型
}

export class AKShareClient {
  private pythonPath: string;
  private scriptPath: string;

  constructor(pythonPath?: string) {
    // 如果设置了环境变量 PYTHON_PATH，则使用它；否则优先尝试 python3
    this.pythonPath = pythonPath || process.env.PYTHON_PATH || 'python3';
    this.scriptPath = path.join(__dirname, '../../../python/akshare_helper.py');
    logger.info(
      `AKShareClient initialized with python path: ${this.pythonPath}, script: ${this.scriptPath}`
    );
  }

  /**
   * 调用Python助手脚本
   */
  private async callPythonScript(
    command: string,
    ...args: Array<string | { timeoutMs?: number }>
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const lastArg = args[args.length - 1];
      const options =
        typeof lastArg === 'object' && lastArg !== null && !Array.isArray(lastArg)
          ? (args.pop() as { timeoutMs?: number })
          : {};
      const processArgs = [this.scriptPath, command, ...(args as string[])];
      logger.debug(`Executing Python: ${this.pythonPath} ${processArgs.join(' ')}`);

      const child = spawn(this.pythonPath, processArgs);
      let stdout = '';
      let stderr = '';

      const timeoutMs = options.timeoutMs || 300000;
      const timeout = setTimeout(() => {
        logger.error(`Python script timeout for command: ${command}`);
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, 1000);
        reject(new Error(`Python script timeout (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      child.stdout.on('data', data => {
        stdout += data.toString();
      });

      child.stderr.on('data', data => {
        stderr += data.toString();
      });

      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0) {
          logger.error(`Python script failed with code ${code}: ${stderr}`);
          reject(new Error(`Python script failed: ${stderr}`));
          return;
        }

        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            resolve(result.data);
          } else {
            reject(new Error(result.error || 'Unknown error from Python script'));
          }
        } catch (error) {
          logger.error(`Failed to parse Python output: ${stdout}`);
          reject(new Error(`Invalid JSON from Python script: ${error.message}`));
        }
      });

      child.on('error', error => {
        clearTimeout(timeout);
        logger.error(`Failed to spawn Python process: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * 获取所有股票列表
   */
  async getAllStocks(): Promise<StockBasicInfo[]> {
    try {
      logger.info('Fetching all stocks from AKShare...');
      const stocks = await this.callPythonScript('get_all_stocks');
      logger.info(`Fetched ${stocks.length} stocks from AKShare`);
      return stocks;
    } catch (error) {
      logger.error('Failed to fetch all stocks from AKShare:', error);
      throw error;
    }
  }

  /**
   * 查询股票日线数据
   * @param code 股票代码，格式如 'sh.600000' 或 'sz.000001'
   * @param start_date 开始日期，格式：'2023-01-01'
   * @param end_date 结束日期，格式：'2023-12-31'
   * @param frequency 频率：'d'日线，'w'周线，'m'月线
   * @param adjustflag 复权类型：'1'后复权，'2'前复权，'3'不复权
   */
  async queryHistoryKData(
    code: string,
    start_date: string,
    end_date: string,
    frequency: 'd' | 'w' | 'm' = 'd',
    adjustflag: '1' | '2' | '3' = '3'
  ): Promise<DailyBar[]> {
    try {
      logger.info(
        `Fetching history data for ${code} from ${start_date} to ${end_date} via AKShare`
      );

      // AKShare目前只支持日线数据
      if (frequency !== 'd') {
        logger.warn(`AKShare only supports daily data, but frequency ${frequency} requested`);
        return [];
      }

      const bars = await this.callPythonScript(
        'get_daily_data',
        code,
        start_date,
        end_date,
        adjustflag
      );
      logger.info(`Fetched ${bars.length} daily bars for ${code} from AKShare`);
      return bars;
    } catch (error) {
      logger.error(`Failed to fetch history k data for ${code} from AKShare:`, error);
      throw error;
    }
  }

  /**
   * 查询股票基本信息
   */
  async queryStockBasic(code: string): Promise<StockBasicInfo | null> {
    try {
      logger.info(`Fetching stock basic info for ${code} from AKShare`);
      const basicInfo = await this.callPythonScript('get_stock_basic', code);
      return basicInfo;
    } catch (error) {
      logger.error(`Failed to fetch stock basic for ${code} from AKShare:`, error);
      return null;
    }
  }

  /**
   * 轻量健康探测：优先使用历史K线，不调用全市场列表，避免刷新数据源状态时过重。
   */
  async healthCheck(
    code: string = 'sh.600000',
    start_date?: string,
    end_date?: string
  ): Promise<{ ok: boolean; bar_count: number; latest_date?: string }> {
    const end = end_date || new Date().toISOString().split('T')[0];
    const start =
      start_date || new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const bars = await this.callPythonScript('health_check', code, start, end, {
      timeoutMs: Number(process.env.AKSHARE_HEALTH_TIMEOUT_MS || 12000),
    });
    return {
      ok: Number(bars?.bar_count || 0) > 0,
      bar_count: Number(bars?.bar_count || 0),
      latest_date: bars?.latest_date,
    };
  }

  /**
   * 获取指数成分股（暂不支持）
   */
  async getIndexStocks(indexCode: string): Promise<StockBasicInfo[]> {
    logger.warn(
      `AKShareClient.getIndexStocks not implemented for ${indexCode}, returning empty array`
    );
    return [];
  }

  /**
   * 获取沪深300成分股
   */
  async getHS300Stocks(): Promise<StockBasicInfo[]> {
    return this.getIndexStocks('sh.000300');
  }

  /**
   * 获取上证50成分股
   */
  async getSZ50Stocks(): Promise<StockBasicInfo[]> {
    return this.getIndexStocks('sh.000016');
  }

  /**
   * 获取中证500成分股
   */
  async getZZ500Stocks(): Promise<StockBasicInfo[]> {
    return this.getIndexStocks('sh.000905');
  }

  /**
   * 查询交易日历（暂不支持）
   */
  async queryTradeDates(start_date: string, end_date: string): Promise<string[]> {
    logger.warn('AKShareClient.queryTradeDates not implemented');
    return [];
  }

  /**
   * 登录（不需要）
   */
  async login(username?: string, password?: string): Promise<boolean> {
    return true;
  }

  /**
   * 登出（不需要）
   */
  async logout(): Promise<boolean> {
    return true;
  }

  /**
   * 获取多只股票的实时切片数据
   * @param symbols 股票代码列表（如 'sh.600000,sz.000001'）
   */
  async getRealtimeQuotes(symbols: string): Promise<Record<string, any>> {
    try {
      logger.info(`Fetching real-time quotes for ${symbols} from AKShare`);
      const quotes = await this.callPythonScript('get_realtime_quotes', symbols);
      return quotes;
    } catch (error) {
      logger.error(`Failed to fetch real-time quotes from AKShare:`, error);
      throw error;
    }
  }

  /**
   * 获取单只股票日内分时K线数据
   * @param code 股票代码（如 'sh.600000'）
   * @param period K线周期（如 '1m', '5m', '15m'）
   * @param limit 获取的K线数量（默认 240）
   */
  async getIntradayBars(code: string, period: string = '1m', limit: number = 240): Promise<any[]> {
    try {
      logger.info(`Fetching intraday bars for ${code} (${period}) from AKShare`);
      const bars = await this.callPythonScript('get_intraday_bars', code, period, limit.toString());
      return bars;
    } catch (error) {
      logger.error(`Failed to fetch intraday bars for ${code} from AKShare:`, error);
      throw error;
    }
  }

  /**
   * 获取客户端状态
   */
  getStatus() {
    return {
      pythonPath: this.pythonPath,
      scriptPath: this.scriptPath,
      isAvailable: true,
    };
  }
}
