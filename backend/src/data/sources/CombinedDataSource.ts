import { EastMoneyClient } from './EastMoneyClient';
import {
  AKShareClient,
  StockBasicInfo as AKShareStockBasicInfo,
  DailyBar as AKShareDailyBar,
} from './AKShareClient';
import { SinaFinanceClient } from './SinaFinanceClient';
import { BaostockClient } from './BaostockClient';
import { TushareClient } from './TushareClient';
import { TencentFinanceClient } from './TencentFinanceClient';
import { logger } from '../../utils/logger';
import { toEastMoneyFormat, normalizeSymbol } from '../../utils/stockSymbol';
import {
  MarketDataFeature,
  MarketDataProviderDefinition,
  ProviderExecutionOptions,
} from './MarketDataProvider';
import {
  DataSourceHealthService,
  DEFAULT_DATA_PROVIDERS,
} from '../services/DataSourceHealthService';

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
  private baostockClient: BaostockClient;
  private tushareClient: TushareClient;
  private tencentFinanceClient: TencentFinanceClient;
  private providers: Record<string, MarketDataProviderDefinition>;

  constructor() {
    this.eastMoneyClient = new EastMoneyClient();
    this.akshareClient = new AKShareClient();
    this.sinaFinanceClient = new SinaFinanceClient();
    this.baostockClient = new BaostockClient();
    this.tushareClient = new TushareClient();
    this.tencentFinanceClient = new TencentFinanceClient();
    this.providers = Object.fromEntries(
      DEFAULT_DATA_PROVIDERS.map(provider => [provider.provider_name, provider])
    );
  }

  private getProvider(provider_name: string): MarketDataProviderDefinition {
    return this.providers[provider_name];
  }

  private isProviderEnabled(provider_name: string): boolean {
    const provider = this.getProvider(provider_name);
    return Boolean(provider?.is_enabled);
  }

  private getPreferredProviders(
    feature: MarketDataFeature,
    preferred_provider?: string
  ): string[] | null {
    const normalizedPreferredProvider = preferred_provider?.endsWith('_only')
      ? preferred_provider.replace(/_only$/, '')
      : preferred_provider;
    const configured =
      normalizedPreferredProvider && normalizedPreferredProvider !== 'auto'
        ? [normalizedPreferredProvider]
        : process.env.DATA_SOURCE_PREFERENCE?.split(',')
            .map(item => item.trim().toLowerCase())
            .filter(Boolean);

    if (!configured || configured.length === 0 || configured.includes('auto')) {
      return null;
    }

    return configured.filter(provider_name => {
      const provider = this.getProvider(provider_name);
      return provider?.supported_features.includes(feature);
    });
  }

  private async buildProviderChain<T>(
    providerChain: Array<[string, () => Promise<T>]>,
    feature: MarketDataFeature,
    preferred_provider?: string
  ): Promise<Array<[string, () => Promise<T>]>> {
    if (preferred_provider?.endsWith('_only')) {
      const provider_name = preferred_provider.replace(/_only$/, '');
      const strictProvider = providerChain.find(([name]) => name === provider_name);
      return strictProvider ? [strictProvider] : [];
    }

    const preferredProviders = this.getPreferredProviders(feature, preferred_provider);
    if (!preferredProviders || preferredProviders.length === 0) {
      try {
        return this.applyDynamicProviderRouting(providerChain, feature);
      } catch (error: any) {
        logger.warn(`动态数据源排序失败，回退默认顺序 (${feature}): ${error.message}`);
        return providerChain;
      }
    }

    const preferredSet = new Set(preferredProviders);
    const preferred = preferredProviders
      .map(provider_name => providerChain.find(([name]) => name === provider_name))
      .filter(Boolean) as Array<[string, () => Promise<T>]>;
    const fallback = providerChain.filter(([provider_name]) => !preferredSet.has(provider_name));
    return [...preferred, ...fallback];
  }

  private async applyDynamicProviderRouting<T>(
    providerChain: Array<[string, () => Promise<T>]>,
    feature: MarketDataFeature
  ): Promise<Array<[string, () => Promise<T>]>> {
    if (process.env.DATA_SOURCE_DYNAMIC_ROUTING === 'false') {
      return providerChain;
    }

    const chainMap = new Map(providerChain);
    const plan = await DataSourceHealthService.getRankedProviders(
      feature,
      providerChain.map(([provider_name]) => provider_name)
    );
    const ranked = plan
      .map(item => {
        const fetcher = chainMap.get(item.provider_name);
        return fetcher ? ([item.provider_name, fetcher] as [string, () => Promise<T>]) : null;
      })
      .filter(Boolean) as Array<[string, () => Promise<T>]>;
    const rankedSet = new Set(ranked.map(([provider_name]) => provider_name));
    const missing = providerChain.filter(([provider_name]) => !rankedSet.has(provider_name));
    const finalChain = [...ranked, ...missing];

    logger.info(
      `数据源动态路由(${feature}): ${plan
        .map(item => `${item.rank}.${item.provider_name}:${item.status}/${item.route_score}`)
        .join(' -> ')}`
    );

    return finalChain;
  }

  /**
   * 指数退避重试，并将每个数据源的成功/失败/空结果写入健康状态表。
   */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    optionsOrName: ProviderExecutionOptions | string,
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000
  ): Promise<T> {
    const options: ProviderExecutionOptions | null =
      typeof optionsOrName === 'string' ? null : optionsOrName;
    const operationName =
      typeof optionsOrName === 'string' ? optionsOrName : optionsOrName.operation_name;
    const retries = options?.max_retries ?? maxRetries;
    const initialDelayMs = options?.initial_delay_ms ?? initialDelay;
    const maxDelayMs = options?.max_delay_ms ?? maxDelay;
    let lastError: Error | null = null;
    const startedAt = Date.now();

    if (options && !options.is_enabled) {
      const reason = `${options.provider_label} is disabled`;
      await DataSourceHealthService.recordDisabled(options, options.feature, reason);
      throw new Error(reason);
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (attempt > 1) {
          logger.info(`重试 ${operationName}，尝试 ${attempt}/${retries}`);
        }
        const result = await operation();
        const latencyMs = Date.now() - startedAt;

        if (options) {
          const isEmptyResult = Array.isArray(result) && result.length === 0;
          if (isEmptyResult) {
            await DataSourceHealthService.recordEmptyResult(options, options.feature, latencyMs);
          } else {
            await DataSourceHealthService.recordSuccess(options, options.feature, latencyMs, {
              attempt,
              result_size: Array.isArray(result) ? result.length : undefined,
            });
          }
        }

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt >= retries) {
          break;
        }

        const delay = Math.min(initialDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
        const jitter = Math.random() * 0.3 * delay;
        const totalDelay = delay + jitter;

        logger.warn(
          `${operationName} 失败，${delay.toFixed(0)}ms 后重试 (尝试 ${attempt}/${retries}):`,
          lastError.message
        );

        await new Promise(resolve => setTimeout(resolve, totalDelay));
      }
    }

    const latencyMs = Date.now() - startedAt;
    if (options) {
      await DataSourceHealthService.recordFailure(
        options,
        options.feature,
        lastError || new Error(`${operationName} 失败`),
        latencyMs
      );
    }

    logger.error(`${operationName} 在 ${retries} 次重试后失败:`, lastError?.message);
    throw lastError || new Error(`${operationName} 失败`);
  }

  private buildProviderOptions(
    provider_name: string,
    feature: MarketDataFeature,
    operation_name: string,
    retryOverrides: Partial<
      Pick<ProviderExecutionOptions, 'max_retries' | 'initial_delay_ms' | 'max_delay_ms'>
    > = {}
  ): ProviderExecutionOptions {
    const provider = this.getProvider(provider_name);
    return {
      ...provider,
      feature,
      operation_name,
      ...retryOverrides,
    };
  }

  private normalizeStockList(stocks: StockBasicInfo[]): StockBasicInfo[] {
    return stocks.map(stock => ({
      ...stock,
      code: normalizeSymbol(stock.code),
      total_market_cap: (stock as any).total_market_cap ?? (stock as any).totalMarketCap,
      circulating_market_cap:
        (stock as any).circulating_market_cap ?? (stock as any).circulatingMarketCap,
      industry: (stock as any).industry,
      pe_dynamic: (stock as any).pe_dynamic ?? (stock as any).peDynamic,
      turnover_rate: (stock as any).turnover_rate ?? (stock as any).turnoverRate,
      change_percent: (stock as any).change_percent ?? (stock as any).changePercent,
    }));
  }

  private normalizeBars(bars: DailyBar[], normalizedCode: string): DailyBar[] {
    const dateMap = new Map<string, DailyBar>();

    for (const bar of bars || []) {
      if (!bar?.date) {
        continue;
      }
      const normalizedBar = {
        ...bar,
        code: normalizedCode,
        open: Number(bar.open) || 0,
        high: Number(bar.high) || 0,
        low: Number(bar.low) || 0,
        close: Number(bar.close) || 0,
        volume: Number(bar.volume) || 0,
        amount: Number(bar.amount) || 0,
        adjustflag: Number(bar.adjustflag || 3),
        turn: Number(bar.turn) || 0,
        tradestatus: Number(bar.tradestatus ?? 1),
        pctChg: Number((bar as any).pctChg ?? (bar as any).pct_chg ?? 0),
        peTTM: Number((bar as any).peTTM ?? (bar as any).pe_ttm ?? 0),
        psTTM: Number((bar as any).psTTM ?? (bar as any).ps_ttm ?? 0),
        pbMRQ: Number((bar as any).pbMRQ ?? (bar as any).pb_mrq ?? 0),
        total_market_cap: (bar as any).total_market_cap ?? (bar as any).totalMarketCap,
      } as DailyBar;

      if (!dateMap.has(normalizedBar.date)) {
        dateMap.set(normalizedBar.date, normalizedBar);
      }
    }

    return Array.from(dateMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  private async tryStockListProvider(
    provider_name: string,
    fetcher: () => Promise<StockBasicInfo[]>
  ): Promise<StockBasicInfo[] | null> {
    if (!this.isProviderEnabled(provider_name)) {
      await DataSourceHealthService.recordDisabled(
        this.getProvider(provider_name),
        'stock_list',
        `${provider_name} 未启用`
      );
      return null;
    }

    const provider = this.getProvider(provider_name);
    try {
      const stocks = await this.retryWithBackoff(
        fetcher,
        this.buildProviderOptions(
          provider_name,
          'stock_list',
          `getAllStocks from ${provider.provider_label}`,
          {
            max_retries: provider_name === 'akshare' ? 2 : 1,
          }
        )
      );

      if (stocks && stocks.length > 0) {
        logger.info(`Using ${stocks.length} real stocks from ${provider.provider_label}`);
        return this.normalizeStockList(stocks);
      }

      logger.info(`${provider.provider_label} returned empty stock list`);
      return null;
    } catch (error: any) {
      logger.warn(`Failed to fetch stocks from ${provider.provider_label}:`, error.message);
      return null;
    }
  }

  /**
   * 获取所有股票列表：可配置源优先，其后自动 fallback。
   */
  async getAllStocks(): Promise<StockBasicInfo[]> {
    const providerChain: Array<[string, () => Promise<StockBasicInfo[]>]> = [
      ['tushare', () => this.tushareClient.getAllStocks()],
      ['baostock', () => this.baostockClient.getAllStocks()],
      ['akshare', () => this.akshareClient.getAllStocks()],
      ['eastmoney', () => this.eastMoneyClient.getAllStocks()],
      ['sina', () => this.sinaFinanceClient.getAllStocks()],
    ];

    for (const [provider_name, fetcher] of await this.buildProviderChain(
      providerChain,
      'stock_list'
    )) {
      const result = await this.tryStockListProvider(provider_name, fetcher);
      if (result && result.length > 0) {
        return result;
      }
    }

    throw new Error('无法从任何数据源获取股票列表');
  }

  private async tryHistoryProvider(
    provider_name: string,
    normalizedCode: string,
    start_date: string,
    end_date: string,
    frequency: 'd' | 'w' | 'm',
    adjustflag: '1' | '2' | '3',
    fetcher: () => Promise<DailyBar[]>
  ): Promise<DailyBar[] | null> {
    if (!this.isProviderEnabled(provider_name)) {
      await DataSourceHealthService.recordDisabled(
        this.getProvider(provider_name),
        'history_k',
        `${provider_name} 未启用`
      );
      return null;
    }

    const provider = this.getProvider(provider_name);
    try {
      const bars = await this.retryWithBackoff(
        fetcher,
        this.buildProviderOptions(
          provider_name,
          'history_k',
          `queryHistoryKData from ${provider.provider_label} for ${normalizedCode}`,
          {
            max_retries: provider_name === 'akshare' ? 2 : 1,
          }
        )
      );

      if (bars && bars.length > 0) {
        const normalizedBars = this.normalizeBars(bars, normalizedCode).filter(
          bar => bar.date >= start_date && bar.date <= end_date
        );
        if (normalizedBars.length > 0) {
          logger.info(
            `Using ${normalizedBars.length} real data bars from ${provider.provider_label} for ${normalizedCode}`
          );
          return normalizedBars;
        }
      }

      logger.info(`${provider.provider_label} returned empty history data for ${normalizedCode}`);
      return null;
    } catch (error: any) {
      logger.warn(
        `Failed to fetch history data from ${provider.provider_label} for ${normalizedCode}:`,
        error.message
      );
      return null;
    }
  }

  /**
   * 查询股票日线数据：Tushare/Baostock 可选启用，AKShare、东方财富、新浪自动兜底。
   */
  async queryHistoryKData(
    code: string,
    start_date: string,
    end_date: string,
    frequency: 'd' | 'w' | 'm' = 'd',
    adjustflag: '1' | '2' | '3' = '3',
    preferred_provider: string = 'auto'
  ): Promise<DailyBar[]> {
    const normalizedCode = normalizeSymbol(code);
    const eastMoneyCode = toEastMoneyFormat(normalizedCode);
    const strictProviderOnly = preferred_provider.endsWith('_only');

    logger.info(
      `Querying history data for ${normalizedCode} (EastMoney: ${eastMoneyCode}, frequency=${frequency}, adjustflag=${adjustflag})`
    );

    const providerChain: Array<[string, () => Promise<DailyBar[]>]> = [
      [
        'tushare',
        () =>
          this.tushareClient.queryHistoryKData(
            normalizedCode,
            start_date,
            end_date,
            frequency,
            adjustflag
          ),
      ],
      [
        'baostock',
        () =>
          this.baostockClient.queryHistoryKData(
            normalizedCode,
            start_date,
            end_date,
            frequency,
            adjustflag
          ),
      ],
      [
        'akshare',
        () =>
          this.akshareClient.queryHistoryKData(
            normalizedCode,
            start_date,
            end_date,
            frequency,
            adjustflag
          ),
      ],
      [
        'eastmoney',
        () =>
          this.eastMoneyClient.queryHistoryKData(
            eastMoneyCode,
            start_date,
            end_date,
            frequency,
            adjustflag
          ),
      ],
      [
        'tencent',
        () =>
          this.tencentFinanceClient.queryHistoryKData(
            normalizedCode,
            start_date,
            end_date,
            frequency,
            adjustflag
          ),
      ],
      [
        'sina',
        () =>
          this.sinaFinanceClient.queryHistoryKData(
            normalizedCode,
            start_date,
            end_date,
            frequency,
            adjustflag
          ),
      ],
    ];

    for (const [provider_name, fetcher] of await this.buildProviderChain(
      providerChain,
      'history_k',
      preferred_provider
    )) {
      const result = await this.tryHistoryProvider(
        provider_name,
        normalizedCode,
        start_date,
        end_date,
        frequency,
        adjustflag,
        fetcher
      );
      if (result && result.length > 0) {
        return result;
      }
    }

    if (strictProviderOnly) {
      logger.info(
        `Strict history provider ${preferred_provider} returned no data for ${normalizedCode}, treating as empty result`
      );
      return [];
    }

    throw new Error(`无法获取股票 ${normalizedCode} 的历史数据：所有数据源均无可用结果`);
  }

  private async tryStockBasicProvider(
    provider_name: string,
    normalizedCode: string,
    fetcher: () => Promise<StockBasicInfo | null>
  ): Promise<StockBasicInfo | null> {
    if (!this.isProviderEnabled(provider_name)) {
      await DataSourceHealthService.recordDisabled(
        this.getProvider(provider_name),
        'stock_basic',
        `${provider_name} 未启用`
      );
      return null;
    }

    const provider = this.getProvider(provider_name);
    try {
      const stockInfo = await this.retryWithBackoff(
        fetcher,
        this.buildProviderOptions(
          provider_name,
          'stock_basic',
          `queryStockBasic from ${provider.provider_label} for ${normalizedCode}`,
          { max_retries: 1 }
        )
      );
      if (stockInfo) {
        return this.normalizeStockList([
          {
            ...stockInfo,
            code: normalizedCode,
          },
        ])[0];
      }
      return null;
    } catch (error: any) {
      logger.warn(
        `Failed to fetch stock basic info from ${provider.provider_label} for ${normalizedCode}:`,
        error.message
      );
      return null;
    }
  }

  /**
   * 查询股票基本信息
   */
  async queryStockBasic(code: string): Promise<StockBasicInfo | null> {
    const normalizedCode = normalizeSymbol(code);
    const eastMoneyCode = toEastMoneyFormat(normalizedCode);

    const providerChain: Array<[string, () => Promise<StockBasicInfo | null>]> = [
      ['tushare', () => this.tushareClient.queryStockBasic(normalizedCode)],
      ['baostock', () => this.baostockClient.queryStockBasic(normalizedCode)],
      ['akshare', () => this.akshareClient.queryStockBasic(normalizedCode)],
      ['eastmoney', () => this.eastMoneyClient.queryStockBasic(eastMoneyCode)],
    ];

    for (const [provider_name, fetcher] of await this.buildProviderChain(
      providerChain,
      'stock_basic'
    )) {
      const result = await this.tryStockBasicProvider(provider_name, normalizedCode, fetcher);
      if (result) {
        logger.info(
          `Using stock basic info from ${this.getProvider(provider_name).provider_label}`
        );
        return result;
      }
    }

    return null;
  }

  /**
   * 获取指数成分股（当前仅保留东方财富实现入口）
   */
  async getIndexStocks(indexCode: string): Promise<StockBasicInfo[]> {
    const normalizedIndexCode = normalizeSymbol(indexCode);

    if (!this.isProviderEnabled('eastmoney')) {
      return [];
    }

    try {
      const stocks = await this.retryWithBackoff(
        () => this.eastMoneyClient.getIndexStocks(normalizedIndexCode),
        this.buildProviderOptions(
          'eastmoney',
          'index_constituents',
          `getIndexStocks from 东方财富 for ${normalizedIndexCode}`,
          { max_retries: 1 }
        )
      );
      if (stocks && stocks.length > 0) {
        return this.normalizeStockList(stocks);
      }
      throw new Error(`无法从任何数据源获取指数 ${normalizedIndexCode} 的成分股`);
    } catch (error: any) {
      logger.error(
        `Failed to fetch index stocks for ${normalizedIndexCode} from all data sources:`,
        error.message
      );
      throw new Error(`无法获取指数 ${normalizedIndexCode} 的成分股: ${error.message}`);
    }
  }

  async getHS300Stocks(): Promise<StockBasicInfo[]> {
    return this.getIndexStocks('sh.000300');
  }

  async getSZ50Stocks(): Promise<StockBasicInfo[]> {
    return this.getIndexStocks('sh.000016');
  }

  async getZZ500Stocks(): Promise<StockBasicInfo[]> {
    return this.getIndexStocks('sh.000905');
  }

  async queryTradeDates(start_date: string, end_date: string): Promise<string[]> {
    if (!this.isProviderEnabled('baostock')) {
      logger.warn('Baostock trade calendar is disabled; returning empty trade dates');
      return [];
    }

    try {
      return await this.retryWithBackoff(
        () => this.baostockClient.queryTradeDates(start_date, end_date),
        this.buildProviderOptions('baostock', 'trade_calendar', 'queryTradeDates from Baostock', {
          max_retries: 1,
        })
      );
    } catch (error: any) {
      logger.warn(`Baostock trade calendar failed: ${error.message}`);
      return [];
    }
  }

  async login(username?: string, password?: string): Promise<boolean> {
    return true;
  }

  async logout(): Promise<boolean> {
    return true;
  }

  async getHealthSnapshots(): Promise<any[]> {
    return DataSourceHealthService.getHealthSnapshots();
  }

  getStatus() {
    return {
      tushare: this.tushareClient.getStatus(),
      baostock: this.baostockClient.getStatus(),
      eastMoney: this.eastMoneyClient.getStatus(),
      akshare: this.akshareClient.getStatus(),
      sina: this.sinaFinanceClient.getStatus(),
    };
  }
}
