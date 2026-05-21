import axios, { AxiosInstance } from 'axios';
import { logger } from '../../utils/logger';
import { normalizeSymbol } from '../../utils/stockSymbol';

export interface StockBasicInfo {
  code: string; // 股票代码，如 'sh.600000'
  code_name: string; // 股票名称，如 '浦发银行'
  ipoDate: string; // 上市日期
  outDate?: string; // 退市日期
  type: number; // 类型：1-股票，2-指数，3-其他
  status: number; // 状态：1-上市，0-退市
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
  pcfNcfTTM: number; // 市现率TTM
  pbMRQ: number; // 市净率MRQ
}

export interface QueryParams {
  code?: string; // 股票代码
  start_date?: string; // 开始日期
  end_date?: string; // 结束日期
  fields?: string; // 返回字段
  frequency?: 'd' | 'w' | 'm'; // 频率：日、周、月
  adjustflag?: '1' | '2' | '3'; // 复权类型
}

export interface EastMoneyQuoteSnapshot {
  symbol: string;
  name?: string;
  quote_time: string;
  quote_date: string;
  current_price?: number;
  previous_close?: number;
  open?: number;
  high?: number;
  low?: number;
  change_amount?: number;
  change_percent?: number;
  volume?: number;
  turnover?: number;
  turnover_rate?: number;
  pe_ttm?: number;
  pb?: number;
  total_market_cap?: number;
  circulating_market_cap?: number;
  total_share?: number;
  circulating_share?: number;
  main_net_inflow?: number;
  roe?: number;
  gross_margin?: number;
  raw_payload: Record<string, any>;
}

export class EastMoneyClient {
  private client: AxiosInstance;
  private baseURL: string;

  constructor(baseURL?: string, timeoutMs = 60000) {
    this.baseURL = baseURL || 'https://push2.eastmoney.com';
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: timeoutMs,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Referer: 'https://quote.eastmoney.com/',
        Accept: 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Connection: 'keep-alive',
      },
    });

    // 添加响应拦截器处理错误
    this.client.interceptors.response.use(
      response => {
        const data = response.data;
        if (data.rc !== 0) {
          throw new Error(`EastMoney API error: rc=${data.rc}`);
        }
        return data;
      },
      error => {
        logger.error('EastMoney API request failed:', error.message);
        throw error;
      }
    );
  }

  private unwrapResponse(response: any): any {
    return response?.data?.rc !== undefined ? response.data : response;
  }

  /**
   * 获取所有股票列表
   */
  async getAllStocks(): Promise<StockBasicInfo[]> {
    try {
      // 东方财富股票列表接口，分页获取所有A股
      // fs参数: m:1+t:2,m:1+t:23 上海A股+科创板, m:0+t:6,m:0+t:80 深圳A股+创业板
      // 使用字符串拼接避免 axios 将 + 号进行 URL 编码 (%2B) 导致 rc=102 错误
      const shUrl = `/api/qt/clist/get?pn=1&pz=10000&po=1&np=1&fs=m:1+t:2,m:1+t:23&fields=f12,f13,f14,f118,f26`;
      const shResponse = await this.client.get(shUrl);
      const shData = this.unwrapResponse(shResponse);

      const szUrl = `/api/qt/clist/get?pn=1&pz=10000&po=1&np=1&fs=m:0+t:6,m:0+t:80&fields=f12,f13,f14,f118,f26`;
      const szResponse = await this.client.get(szUrl);
      const szData = this.unwrapResponse(szResponse);

      const stocks: StockBasicInfo[] = [];

      // 处理上海股票
      if (shData.data && shData.data.diff) {
        for (const item of shData.data.diff) {
          stocks.push({
            code: `sh.${item.f12}`,
            code_name: item.f14,
            ipoDate: item.f26 || '', // 上市日期字段可能需要调整
            type: 1, // 股票
            status: 1, // 假设都是上市状态
          });
        }
      }

      // 处理深圳股票
      if (szData.data && szData.data.diff) {
        for (const item of szData.data.diff) {
          stocks.push({
            code: `sz.${item.f12}`,
            code_name: item.f14,
            ipoDate: item.f26 || '',
            type: 1,
            status: 1,
          });
        }
      }

      logger.info(`Fetched ${stocks.length} stocks from EastMoney`);
      return stocks;
    } catch (error) {
      logger.error('Failed to fetch all stocks from EastMoney:', error);
      throw error;
    }
  }

  /**
   * 查询股票历史K线数据
   * 东方财富接口返回格式：日期,开盘,收盘,最高,最低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
   */
  async queryHistoryKData(
    code: string,
    start_date: string,
    end_date: string,
    frequency: 'd' | 'w' | 'm' = 'd',
    adjustflag: '1' | '2' | '3' = '3'
  ): Promise<DailyBar[]> {
    try {
      const normalizedCode = normalizeSymbol(code);
      const { market, stockCode } = this.parseSecId(normalizedCode);
      const kltMap: Record<string, number> = { d: 101, w: 102, m: 103 };
      // 东方财富 fqt: 0=不复权, 1=前复权, 2=后复权；项目 adjustflag: 1=后复权, 2=前复权, 3=不复权
      const fqtMap: Record<string, number> = { '1': 2, '2': 1, '3': 0 };

      const response = await this.client.get('/api/qt/stock/kline/get', {
        baseURL: 'https://push2his.eastmoney.com',
        params: {
          secid: `${market}.${stockCode}`,
          klt: kltMap[frequency] || 101,
          fqt: fqtMap[adjustflag] ?? 0,
          beg: start_date.replace(/-/g, ''),
          end: end_date.replace(/-/g, ''),
          fields1: 'f1,f2,f3,f4,f5,f6',
          fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61',
        },
      });

      const responseData = this.unwrapResponse(response);
      const klines = responseData.data?.klines || [];
      if (!Array.isArray(klines) || klines.length === 0) {
        return [];
      }

      const bars: DailyBar[] = klines
        .map((line: string) => {
          const [date, open, close, high, low, volume, amount, _amplitude, pctChg, _change, turn] =
            String(line).split(',');
          return {
            date,
            code: normalizedCode,
            open: parseFloat(open) || 0,
            high: parseFloat(high) || 0,
            low: parseFloat(low) || 0,
            close: parseFloat(close) || 0,
            volume: parseFloat(volume) * 100 || 0, // 东方财富成交量单位为手，统一转换成股
            amount: parseFloat(amount) || 0,
            adjustflag: adjustflag === '1' ? 1 : adjustflag === '2' ? 2 : 3,
            turn: parseFloat(turn) || 0,
            tradestatus: 1,
            pctChg: parseFloat(pctChg) || 0,
            peTTM: 0,
            psTTM: 0,
            pcfNcfTTM: 0,
            pbMRQ: 0,
          };
        })
        .filter(bar => bar.date >= start_date && bar.date <= end_date)
        .sort((a, b) => a.date.localeCompare(b.date));

      logger.info(`Fetched ${bars.length} daily bars for ${normalizedCode} from EastMoney`);
      return bars;
    } catch (error) {
      logger.error(`Failed to fetch history k data for ${code} from EastMoney:`, error);
      throw error;
    }
  }

  private parseSecId(code: string): { market: string; stockCode: string } {
    const normalizedCode = normalizeSymbol(code);
    if (normalizedCode.includes('.')) {
      const [marketPrefix, stockCode] = normalizedCode.split('.');
      if (marketPrefix.toLowerCase() === 'sh') {
        return { market: '1', stockCode };
      }
      if (marketPrefix.toLowerCase() === 'bj') {
        return { market: '0', stockCode };
      }
      return { market: '0', stockCode };
    }

    if (normalizedCode.startsWith('6')) {
      return { market: '1', stockCode: normalizedCode };
    }
    return { market: '0', stockCode: normalizedCode };
  }

  private toNumber(value: any): number | undefined {
    if (value === null || value === undefined || value === '' || value === '-') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private scaled(value: any, divisor = 100): number | undefined {
    const parsed = this.toNumber(value);
    return parsed === undefined ? undefined : parsed / divisor;
  }

  private compactDate(value = new Date()): string {
    const date = value instanceof Date ? value : new Date(value);
    const normalized = Number.isNaN(date.getTime()) ? new Date() : date;
    return normalized.toISOString().slice(0, 10);
  }

  private buildQuoteSnapshot(symbol: string, payload: Record<string, any>): EastMoneyQuoteSnapshot {
    const quoteTime = new Date().toISOString();
    return {
      symbol,
      name: payload.f58,
      quote_time: quoteTime,
      quote_date: this.compactDate(new Date()),
      current_price: this.scaled(payload.f43),
      previous_close: this.scaled(payload.f60),
      open: this.scaled(payload.f46),
      high: this.scaled(payload.f44),
      low: this.scaled(payload.f45),
      change_amount: this.scaled(payload.f169),
      change_percent: this.scaled(payload.f170),
      volume:
        this.toNumber(payload.f47) === undefined ? undefined : Number(this.toNumber(payload.f47)) * 100,
      turnover: this.toNumber(payload.f48),
      turnover_rate: this.scaled(payload.f168),
      pe_ttm: this.scaled(payload.f162),
      pb: this.scaled(payload.f167),
      total_market_cap: this.toNumber(payload.f116),
      circulating_market_cap: this.toNumber(payload.f117),
      total_share: this.toNumber(payload.f84),
      circulating_share: this.toNumber(payload.f85),
      main_net_inflow: this.toNumber(payload.f62),
      roe: this.toNumber(payload.f173),
      gross_margin: this.scaled(payload.f174),
      raw_payload: payload,
    };
  }

  /**
   * 获取东方财富免费实时快照。
   *
   * 该接口不需要 token，适合作为 Tushare 未配置时的“真实行情/估值”轻量增强：
   * - 价格、涨跌幅、成交额、换手率、PE/PB、市值来自东方财富实时接口；
   * - 财务字段只作为弱代理，不替代正式财报源。
   */
  async getQuoteSnapshot(code: string): Promise<EastMoneyQuoteSnapshot | null> {
    try {
      const normalizedCode = normalizeSymbol(code);
      const { market, stockCode } = this.parseSecId(normalizedCode);
      const response = await this.client.get('/api/qt/stock/get', {
        params: {
          secid: `${market}.${stockCode}`,
          fields:
            'f43,f44,f45,f46,f47,f48,f57,f58,f60,f62,f84,f85,f116,f117,f162,f167,f168,f169,f170,f173,f174',
        },
      });

      const responseData = this.unwrapResponse(response);
      if (!responseData.data) return null;
      return this.buildQuoteSnapshot(normalizedCode, responseData.data);
    } catch (error) {
      logger.warn(`Failed to fetch EastMoney quote snapshot for ${code}: ${(error as any)?.message || error}`);
      return null;
    }
  }

  async getQuoteSnapshots(
    codes: string[],
    options: { concurrency?: number; limit?: number } = {}
  ): Promise<EastMoneyQuoteSnapshot[]> {
    const normalizedCodes = [...new Set((codes || []).map(normalizeSymbol).filter(Boolean))];
    const limit = Math.min(Math.max(Number(options.limit || normalizedCodes.length), 1), 1000);
    const queue = normalizedCodes.slice(0, limit);
    const concurrency = Math.min(Math.max(Number(options.concurrency || 6), 1), 12);
    const results: EastMoneyQuoteSnapshot[] = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        const symbol = queue[cursor++];
        const snapshot = await this.getQuoteSnapshot(symbol);
        if (snapshot) results.push(snapshot);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return results;
  }

  /**
   * 查询股票基本信息
   */
  async queryStockBasic(code: string): Promise<StockBasicInfo | null> {
    try {
      const normalizedCode = normalizeSymbol(code);
      const { market, stockCode } = this.parseSecId(normalizedCode);

      const response = await this.client.get('/api/qt/stock/get', {
        params: {
          secid: `${market}.${stockCode}`,
          fields: 'f12,f13,f14,f118,f26',
        },
      });

      const responseData = this.unwrapResponse(response);
      if (responseData.data) {
        const item = responseData.data;
        return {
          code: normalizedCode,
          code_name: item.f14 || '',
          ipoDate: item.f26 || '',
          type: 1,
          status: 1,
        };
      }
      return null;
    } catch (error) {
      logger.error(`Failed to fetch stock basic for ${code}:`, error);
      throw error;
    }
  }

  /**
   * 获取指数成分股
   */
  async getIndexStocks(indexCode: string): Promise<StockBasicInfo[]> {
    // 东方财富指数成分股接口较复杂，这里返回空数组
    // 常见指数：sh.000300 (沪深300), sh.000016 (上证50), sh.000905 (中证500)
    logger.warn(`EastMoneyClient.getIndexStocks not implemented for ${indexCode}`);
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
    logger.warn('EastMoneyClient.queryTradeDates not implemented');
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
   * 确保已登录（不需要）
   */
  private async ensureLogin(): Promise<void> {
    // 无需登录
  }

  /**
   * 获取客户端状态
   */
  getStatus() {
    return {
      baseURL: this.baseURL,
      isLoggedIn: true,
    };
  }
}
