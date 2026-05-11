import axios, { AxiosInstance } from 'axios';
import { logger } from '../../utils/logger';
import { normalizeSymbol } from '../../utils/stockSymbol';

export interface StockBasicInfo {
  code: string;
  code_name: string;
  ipoDate: string;
  outDate?: string;
  type: number;
  status: number;
}

export interface DailyBar {
  date: string;
  code: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  adjustflag: number;
  turn: number;
  tradestatus: number;
  pctChg: number;
  peTTM: number;
  psTTM: number;
  pcfNcfTTM: number;
  pbMRQ: number;
  total_market_cap?: number;
}

/**
 * 腾讯行情轻量 K 线源。
 *
 * 当前线上环境东方财富历史接口经常被远端断开，AKShare 又会启动 Python 并可能阻塞数分钟。
 * 腾讯 fqkline 接口对最近日线响应稳定，适合作为每日增量同步的快速主源。
 */
export class TencentFinanceClient {
  private client: AxiosInstance;

  constructor(timeoutMs = 12000) {
    this.client = axios.create({
      baseURL: 'https://web.ifzq.gtimg.cn',
      timeout: timeoutMs,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Referer: 'https://gu.qq.com/',
        Accept: 'application/json, text/plain, */*',
      },
    });
  }

  async getAllStocks(): Promise<StockBasicInfo[]> {
    logger.info('TencentFinanceClient.getAllStocks not implemented, returning empty array');
    return [];
  }

  async queryStockBasic(code: string): Promise<StockBasicInfo | null> {
    const normalizedCode = normalizeSymbol(code);
    logger.info(`TencentFinanceClient.queryStockBasic not implemented for ${normalizedCode}`);
    return null;
  }

  async queryHistoryKData(
    code: string,
    start_date: string,
    end_date: string,
    frequency: 'd' | 'w' | 'm' = 'd',
    adjustflag: '1' | '2' | '3' = '3'
  ): Promise<DailyBar[]> {
    const normalizedCode = normalizeSymbol(code);
    if (frequency !== 'd') {
      logger.warn(`Tencent Finance only supports daily bars, but frequency ${frequency} requested`);
      return [];
    }

    const tencentCode = normalizedCode.replace('.', '');
    const adjustName = this.getAdjustName(adjustflag);

    try {
      const response = await this.client.get('/appstock/app/fqkline/get', {
        params: {
          param: `${tencentCode},day,${start_date},${end_date},640,${adjustName}`,
        },
      });

      const payload = response.data;
      if (payload?.code !== 0) {
        throw new Error(`Tencent Finance API error: code=${payload?.code}, msg=${payload?.msg || ''}`);
      }

      const node = payload?.data?.[tencentCode];
      const rows = node?.[this.getRowKey(adjustflag)] || node?.day || node?.qfqday || node?.hfqday;
      if (!Array.isArray(rows) || rows.length === 0) return [];

      const bars = rows
        .map((row: any[]) => this.parseRow(row, normalizedCode, adjustflag))
        .filter((bar: DailyBar | null): bar is DailyBar => Boolean(bar))
        .filter(bar => bar.date >= start_date && bar.date <= end_date)
        .sort((a, b) => a.date.localeCompare(b.date));

      logger.info(`Fetched ${bars.length} daily bars for ${normalizedCode} from Tencent Finance`);
      return bars;
    } catch (error) {
      logger.error(`Failed to fetch history k data for ${normalizedCode} from Tencent Finance:`, error);
      throw error;
    }
  }

  private parseRow(row: any[], code: string, adjustflag: '1' | '2' | '3'): DailyBar | null {
    if (!Array.isArray(row) || row.length < 6) return null;

    const [date, open, close, high, low, volume] = row;
    if (!date) return null;

    const openPrice = Number(open) || 0;
    const closePrice = Number(close) || 0;
    const volumeInLots = Number(volume) || 0;

    return {
      date: String(date).slice(0, 10),
      code,
      open: openPrice,
      high: Number(high) || 0,
      low: Number(low) || 0,
      close: closePrice,
      // 腾讯 K 线成交量单位为手，统一转换成股。
      volume: Math.round(volumeInLots * 100),
      amount: 0,
      adjustflag: adjustflag === '1' ? 1 : adjustflag === '2' ? 2 : 3,
      turn: 0,
      tradestatus: 1,
      pctChg: openPrice ? ((closePrice - openPrice) / openPrice) * 100 : 0,
      peTTM: 0,
      psTTM: 0,
      pcfNcfTTM: 0,
      pbMRQ: 0,
    };
  }

  private getAdjustName(adjustflag: '1' | '2' | '3'): 'hfq' | 'qfq' | 'bfq' {
    if (adjustflag === '1') return 'hfq';
    if (adjustflag === '2') return 'qfq';
    return 'bfq';
  }

  private getRowKey(adjustflag: '1' | '2' | '3'): 'hfqday' | 'qfqday' | 'day' {
    if (adjustflag === '1') return 'hfqday';
    if (adjustflag === '2') return 'qfqday';
    return 'day';
  }
}
