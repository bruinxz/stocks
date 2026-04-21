import axios, { AxiosInstance } from 'axios';
import { logger } from '../../utils/logger';

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

export class EastMoneyClient {
  private client: AxiosInstance;
  private baseURL: string;

  constructor(baseURL?: string) {
    this.baseURL = baseURL || 'https://push2.eastmoney.com';
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 60000,
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

      const szUrl = `/api/qt/clist/get?pn=1&pz=10000&po=1&np=1&fs=m:0+t:6,m:0+t:80&fields=f12,f13,f14,f118,f26`;
      const szResponse = await this.client.get(szUrl);

      const stocks: StockBasicInfo[] = [];

      // 处理上海股票
      if (shResponse.data.data && shResponse.data.data.diff) {
        for (const item of shResponse.data.data.diff) {
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
      if (szResponse.data.data && szResponse.data.data.diff) {
        for (const item of szResponse.data.data.diff) {
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
   * 查询股票日线数据（通过新浪财经接口）
   * 注意：东方财富的历史K线接口较复杂，这里暂不实现
   * 实际使用时可以组合SinaFinanceClient
   */
  async queryHistoryKData(
    code: string,
    start_date: string,
    end_date: string,
    frequency: 'd' | 'w' | 'm' = 'd',
    adjustflag: '1' | '2' | '3' = '3'
  ): Promise<DailyBar[]> {
    // 东方财富的历史K线接口参数复杂，这里返回空数组
    // 实际实现应该使用SinaFinanceClient
    logger.warn('EastMoneyClient.queryHistoryKData not implemented, use SinaFinanceClient instead');
    return [];
  }

  /**
   * 查询股票基本信息
   */
  async queryStockBasic(code: string): Promise<StockBasicInfo | null> {
    try {
      // 解析市场前缀
      let market = '1'; // 默认上海
      let stockCode = code;
      if (code.startsWith('sh.')) {
        market = '1';
        stockCode = code.substring(3);
      } else if (code.startsWith('sz.')) {
        market = '0';
        stockCode = code.substring(3);
      }

      const response = await this.client.get('/api/qt/stock/get', {
        params: {
          secid: `${market}.${stockCode}`,
          fields: 'f12,f13,f14,f118,f26',
        },
      });

      if (response.data.data) {
        const item = response.data.data;
        return {
          code,
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
