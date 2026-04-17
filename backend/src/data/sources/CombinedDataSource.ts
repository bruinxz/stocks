import {
  EastMoneyClient,
  StockBasicInfo as EastMoneyStockBasicInfo,
  DailyBar as EastMoneyDailyBar,
} from './EastMoneyClient';
import {
  AKShareClient,
  StockBasicInfo as AKShareStockBasicInfo,
  DailyBar as AKShareDailyBar,
} from './AKShareClient';
import {
  SinaFinanceClient,
  StockBasicInfo as SinaStockBasicInfo,
  DailyBar as SinaDailyBar,
} from './SinaFinanceClient';
import { logger } from '../../utils/logger';
import { toAKSharePureCode, toEastMoneyFormat, normalizeSymbol } from '../../utils/stockSymbol';

// 使用AKShare的接口定义（兼容其他数据源）
export type StockBasicInfo = AKShareStockBasicInfo;
export type DailyBar = AKShareDailyBar;
export type QueryParams = {
  code?: string;
  start_date?: string;
  end_date?: string;
  fields?: string;
  frequency?: 'd' | 'w' | 'm';
  adjustflag?: '1' | '2' | '3';
};

export class CombinedDataSource {
  private eastMoneyClient: EastMoneyClient;
  private akshareClient: AKShareClient;
  private sinaFinanceClient: SinaFinanceClient;

  constructor() {
    this.eastMoneyClient = new EastMoneyClient();
    this.akshareClient = new AKShareClient();
    this.sinaFinanceClient = new SinaFinanceClient();
  }

  /**
   * 指数退避重试
   * @param operation 要执行的操作
   * @param operationName 操作名称，用于日志
   * @param maxRetries 最大重试次数
   * @param initialDelay 初始延迟（毫秒）
   * @param maxDelay 最大延迟（毫秒）
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) {
          logger.info(`重试 ${operationName}，尝试 ${attempt}/${maxRetries}`);
        }
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt >= maxRetries) {
          break;
        }

        // 计算延迟时间（指数退避）
        const delay = Math.min(initialDelay * Math.pow(2, attempt - 1), maxDelay);
        const jitter = Math.random() * 0.3 * delay; // 添加30%的随机抖动
        const totalDelay = delay + jitter;

        logger.warn(
          `${operationName} 失败，${delay.toFixed(0)}ms 后重试 (尝试 ${attempt}/${maxRetries}):`,
          lastError.message
        );

        await new Promise(resolve => setTimeout(resolve, totalDelay));
      }
    }

    logger.error(`${operationName} 在 ${maxRetries} 次重试后失败:`, lastError?.message);
    throw lastError || new Error(`${operationName} 失败`);
  }

  /**
   * 获取所有股票列表（优先使用AKShare，失败时使用东方财富）
   */
  async getAllStocks(): Promise<StockBasicInfo[]> {
    // 优先使用AKShare
    try {
      const stocks = await this.retryWithBackoff(
        () => this.akshareClient.getAllStocks(),
        'getAllStocks from AKShare',
        3,
        1000,
        10000
      );
      if (stocks && stocks.length > 0) {
        logger.info(`Using ${stocks.length} real stocks from AKShare`);
        // AKShare返回的代码已经是标准化格式，但确保一下
        return stocks.map(stock => ({
          ...stock,
          code: normalizeSymbol(stock.code),
        }));
      }
      logger.info('AKShare returned empty stock list, trying EastMoney');
    } catch (error) {
      logger.warn('Failed to fetch stocks from AKShare, trying EastMoney:', error.message);
    }

    // 回退到东方财富
    try {
      const stocks = await this.retryWithBackoff(
        () => this.eastMoneyClient.getAllStocks(),
        'getAllStocks from EastMoney',
        3,
        1000,
        10000
      );
      if (stocks && stocks.length > 0) {
        logger.info(`Using ${stocks.length} real stocks from EastMoney`);
        // 标准化返回的股票代码
        return stocks.map(stock => ({
          ...stock,
          code: normalizeSymbol(stock.code),
        }));
      }
      logger.info('EastMoney returned empty stock list, trying Sina Finance');
    } catch (error) {
      logger.warn('Failed to fetch stocks from EastMoney, trying Sina Finance:', error.message);
    }

    // 最终回退到新浪财经
    try {
      const stocks = await this.retryWithBackoff(
        () => this.sinaFinanceClient.getAllStocks(),
        'getAllStocks from Sina Finance',
        3,
        1000,
        10000
      );
      if (stocks && stocks.length > 0) {
        logger.info(`Using ${stocks.length} real stocks from Sina Finance`);
        // 标准化返回的股票代码
        return stocks.map(stock => ({
          ...stock,
          code: normalizeSymbol(stock.code),
        }));
      }
      // 如果返回空数组，抛出错误
      logger.error('All data sources returned empty stock list');
      throw new Error('无法从任何数据源获取股票列表');
    } catch (error) {
      // 如果失败，抛出错误
      logger.error('Failed to fetch stocks from all data sources:', error.message);
      throw new Error(`无法获取股票列表: ${error.message}`);
    }
  }

  /**
   * 查询股票日线数据（优先使用AKShare，失败时使用东方财富）
   */
  async queryHistoryKData(
    code: string,
    startDate: string,
    endDate: string,
    frequency: 'd' | 'w' | 'm' = 'd',
    adjustflag: '1' | '2' | '3' = '3'
  ): Promise<DailyBar[]> {
    // 标准化股票代码
    const normalizedCode = normalizeSymbol(code);
    const akshareCode = normalizedCode; // AKShare客户端期望标准化格式
    const eastMoneyCode = toEastMoneyFormat(normalizedCode);

    logger.info(
      `Querying history data for ${normalizedCode} (AKShare: ${akshareCode}, EastMoney: ${eastMoneyCode})`
    );

    // 优先使用AKShare
    try {
      const akshareBars = await this.retryWithBackoff(
        () =>
          this.akshareClient.queryHistoryKData(
            akshareCode,
            startDate,
            endDate,
            frequency,
            adjustflag
          ),
        `queryHistoryKData from AKShare for ${normalizedCode}`,
        3,
        1000,
        10000
      );

      // 如果AKShare返回了数据，使用它
      if (akshareBars && akshareBars.length > 0) {
        logger.info(
          `Using ${akshareBars.length} real data bars from AKShare for ${normalizedCode}`
        );
        return akshareBars;
      }

      // 否则尝试东方财富
      logger.info(`AKShare returned empty data for ${normalizedCode}, trying EastMoney`);
    } catch (error) {
      logger.warn(
        `Failed to fetch data from AKShare for ${normalizedCode}, trying EastMoney:`,
        error.message
      );
    }

    // 回退到东方财富
    try {
      const eastMoneyBars = await this.retryWithBackoff(
        () =>
          this.eastMoneyClient.queryHistoryKData(
            eastMoneyCode,
            startDate,
            endDate,
            frequency,
            adjustflag
          ),
        `queryHistoryKData from EastMoney for ${normalizedCode}`,
        3,
        1000,
        10000
      );

      if (eastMoneyBars && eastMoneyBars.length > 0) {
        logger.info(
          `Using ${eastMoneyBars.length} real data bars from EastMoney for ${normalizedCode}`
        );
        // 将东方财富返回的数据中的代码转换为标准化格式
        return eastMoneyBars.map(bar => ({
          ...bar,
          code: normalizedCode,
        }));
      }

      // 如果所有数据源都返回空数组，抛出错误
      logger.error(`No real data available for ${normalizedCode} from any data source`);
      throw new Error(`无法获取股票 ${normalizedCode} 的历史数据`);
    } catch (error) {
      // 如果所有数据源接口都出错，抛出错误
      logger.error(
        `Failed to fetch data for ${normalizedCode} from all data sources:`,
        error.message
      );
      throw new Error(`无法获取股票 ${normalizedCode} 的历史数据: ${error.message}`);
    }
  }

  /**
   * 查询股票基本信息（优先使用Tushare，失败时使用东方财富）
   */
  async queryStockBasic(code: string): Promise<StockBasicInfo | null> {
    // 标准化股票代码
    const normalizedCode = normalizeSymbol(code);
    const akshareCode = normalizedCode; // AKShare客户端期望标准化格式
    const eastMoneyCode = toEastMoneyFormat(normalizedCode);

    logger.info(
      `Querying stock basic info for ${normalizedCode} (AKShare: ${akshareCode}, EastMoney: ${eastMoneyCode})`
    );

    // 优先使用AKShare
    try {
      const stockInfo = await this.retryWithBackoff(
        () => this.akshareClient.queryStockBasic(akshareCode),
        `queryStockBasic from AKShare for ${normalizedCode}`,
        3,
        1000,
        10000
      );
      if (stockInfo) {
        logger.info(`Using stock basic info from AKShare for ${normalizedCode}`);
        return stockInfo;
      }
      logger.info(`AKShare returned no stock basic info for ${normalizedCode}, trying EastMoney`);
    } catch (error) {
      logger.warn(
        `Failed to fetch stock basic info from AKShare for ${normalizedCode}, trying EastMoney:`,
        error.message
      );
    }

    // 回退到东方财富
    const eastMoneyInfo = await this.retryWithBackoff(
      () => this.eastMoneyClient.queryStockBasic(eastMoneyCode),
      `queryStockBasic from EastMoney for ${normalizedCode}`,
      3,
      1000,
      10000
    );

    if (eastMoneyInfo) {
      // 将东方财富返回的数据中的代码转换为标准化格式
      return {
        ...eastMoneyInfo,
        code: normalizedCode,
      };
    }

    return null;
  }

  /**
   * 获取指数成分股（优先使用Tushare，失败时使用东方财富）
   */
  async getIndexStocks(indexCode: string): Promise<StockBasicInfo[]> {
    // 标准化指数代码（如果有需要）
    const normalizedIndexCode = normalizeSymbol(indexCode);

    // 使用东方财富（AKShare不支持指数成分股）
    try {
      const stocks = await this.retryWithBackoff(
        () => this.eastMoneyClient.getIndexStocks(normalizedIndexCode),
        `getIndexStocks from EastMoney for ${normalizedIndexCode}`,
        3,
        1000,
        10000
      );
      if (stocks && stocks.length > 0) {
        logger.info(
          `Using ${stocks.length} real index stocks from EastMoney for ${normalizedIndexCode}`
        );
        // 标准化返回的股票代码
        return stocks.map(stock => ({
          ...stock,
          code: normalizeSymbol(stock.code),
        }));
      }
      // 如果返回空数组，抛出错误
      logger.error(`All data sources returned empty index stocks for ${normalizedIndexCode}`);
      throw new Error(`无法从任何数据源获取指数 ${normalizedIndexCode} 的成分股`);
    } catch (error) {
      logger.error(
        `Failed to fetch index stocks for ${normalizedIndexCode} from all data sources:`,
        error.message
      );
      throw new Error(`无法获取指数 ${normalizedIndexCode} 的成分股: ${error.message}`);
    }
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
  async queryTradeDates(startDate: string, endDate: string): Promise<string[]> {
    logger.warn('CombinedDataSource.queryTradeDates not implemented');
    return [];
  }

  /**
   * 登录（不需要）
   */
  async login(username?: string, password?: string): Promise<boolean> {
    // 两个客户端都无需登录
    return true;
  }

  /**
   * 登出（不需要）
   */
  async logout(): Promise<boolean> {
    return true;
  }

  /**
   * 获取客户端状态
   */
  getStatus() {
    return {
      eastMoney: this.eastMoneyClient.getStatus(),
      akshare: this.akshareClient.getStatus(),
    };
  }
}
