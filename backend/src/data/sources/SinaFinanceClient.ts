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

export class SinaFinanceClient {
  private client: AxiosInstance;
  private baseURL: string;

  constructor(baseURL?: string, timeoutMs = 30000) {
    this.baseURL = baseURL || 'http://money.finance.sina.com.cn';
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: 'http://finance.sina.com.cn/',
      },
    });

    // 添加响应拦截器处理错误
    this.client.interceptors.response.use(
      response => {
        // 新浪API返回JSON数组或错误字符串
        const data = response.data;
        if (typeof data === 'string' && data.includes('error')) {
          throw new Error(`Sina Finance API error: ${data}`);
        }
        return data;
      },
      error => {
        logger.error('Sina Finance API request failed:', error.message);
        throw error;
      }
    );
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
      // 转换股票代码格式：sh.600000 -> sh600000
      let sinaCode = code;
      if (code.includes('.')) {
        const parts = code.split('.');
        sinaCode = `${parts[0]}${parts[1]}`;
      }

      // 新浪API参数
      // scale: 240=日线, 60=60分钟, 30=30分钟, 15=15分钟, 5=5分钟
      // 周线和月线可能需要不同scale，这里只实现日线
      let scale = 240;
      if (frequency === 'w') {
        scale = 120; // 周线，实际可能需要其他参数
      } else if (frequency === 'm') {
        scale = 60; // 月线
      }

      // 计算需要的数据条数（保守估计）
      // 新浪API最多可能返回1000条数据，我们分页获取
      const start = new Date(start_date);
      const end = new Date(end_date);
      const daysDiff = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
      const maxBars = Math.min(daysDiff + 100, 1000); // 最多1000条

      const params: any = {
        symbol: sinaCode,
        scale,
        ma: 'no',
        datalen: maxBars,
        end: end_date,
      };

      // 尝试添加begin参数，但新浪API可能不支持
      // params.begin = start_date;

      logger.info(`Fetching history data for ${code} from ${start_date} to ${end_date}`);

      const responseData = await this.client.get(
        '/quotes_service/api/json_v2.php/CN_MarketData.getKLineData',
        { params }
      );

      const bars: DailyBar[] = [];
      const data = responseData;

      if (Array.isArray(data)) {
        for (const item of data) {
          const barDate = item.day;
          // 过滤在开始日期之前的数据
          if (barDate < start_date) {
            continue;
          }
          if (barDate > end_date) {
            continue;
          }

          // 计算涨跌幅
          const open = parseFloat(item.open);
          const close = parseFloat(item.close);
          const pctChg = open !== 0 ? ((close - open) / open) * 100 : 0;

          bars.push({
            date: barDate,
            code,
            open,
            high: parseFloat(item.high),
            low: parseFloat(item.low),
            close,
            volume: parseFloat(item.volume),
            amount: 0, // 新浪接口不提供成交额
            adjustflag: adjustflag === '1' ? 1 : adjustflag === '2' ? 2 : 3,
            turn: 0, // 换手率未知
            tradestatus: 1, // 假设正常交易
            pctChg,
            peTTM: 0,
            psTTM: 0,
            pcfNcfTTM: 0,
            pbMRQ: 0,
          });
        }
      }

      // 按日期升序排序
      bars.sort((a, b) => a.date.localeCompare(b.date));

      logger.info(`Fetched ${bars.length} daily bars for ${code}`);
      return bars;
    } catch (error: any) {
      // Batch AR (2026-06-21): warn instead of error — CombinedDataSource
      // already does provider fallback; single-source failure doesn't merit
      // error.log noise (delisted stocks would flood thousands of lines/day).
      const msg = error?.message || String(error);
      logger.warn(`Failed to fetch history k data for ${code}: ${msg}`);
      throw error;
    }
  }

  /**
   * 获取所有股票列表
   */
  async getAllStocks(): Promise<StockBasicInfo[]> {
    logger.info('Fetching all stocks from Sina Finance...');
    const stocks: StockBasicInfo[] = [];
    const maxRetries = 3;
    let page = 1;
    const num = 100;

    while (true) {
      let success = false;
      let data: any = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const responseData = await this.client.get(
            '/quotes_service/api/json_v2.php/Market_Center.getHQNodeData',
            {
              params: {
                page,
                num,
                sort: 'symbol',
                asc: 1,
                node: 'hs_a', // 沪深A股
                symbol: '',
                _s_r_a: 'page',
              },
            }
          );

          // SinaFinanceClient has a response interceptor that returns response.data directly
          data = responseData;

          // Sina API might return string "null" when page is out of bounds
          if (data === 'null' || data === null) {
            data = [];
          }

          // Try to parse if it's a string
          if (typeof data === 'string') {
            try {
              data = JSON.parse(data);
            } catch (e) {
              logger.warn(`Failed to parse Sina JSON string: ${e.message}`);
              data = [];
            }
          }

          success = true;
          break;
        } catch (error) {
          logger.warn(`Sina getAllStocks page ${page} attempt ${attempt} failed: ${error.message}`);
          if (attempt === maxRetries) {
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }

      if (!success || !Array.isArray(data) || data.length === 0) {
        break; // No more data
      }

      for (const item of data) {
        // symbol format: "sh600000" or "sz000001" or "bj832000"
        const symbol = item.symbol;
        if (!symbol || symbol.length < 6) continue;

        const prefix = symbol.substring(0, 2).toLowerCase();
        const stockCode = symbol.substring(2);

        // Map to our standard format: "sh.600000"
        const standardCode = `${prefix}.${stockCode}`;

        stocks.push({
          code: standardCode,
          code_name: item.name || '',
          ipoDate: '', // Sina doesn't provide IPO date in this endpoint
          type: 1,
          status: 1,
        });
      }

      if (data.length < num) {
        break; // Last page
      }

      page++;

      // Add a tiny delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    logger.info(`Fetched ${stocks.length} stocks from Sina Finance`);
    return stocks;
  }

  /**
   * 查询股票基本信息（新浪不支持）
   */
  async queryStockBasic(code: string): Promise<StockBasicInfo | null> {
    logger.warn(`SinaFinanceClient.queryStockBasic not implemented for ${code}`);
    return null;
  }

  /**
   * 获取指数成分股（新浪不支持）
   */
  async getIndexStocks(indexCode: string): Promise<StockBasicInfo[]> {
    logger.warn(`SinaFinanceClient.getIndexStocks not implemented for ${indexCode}`);
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
    logger.warn('SinaFinanceClient.queryTradeDates not implemented');
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
