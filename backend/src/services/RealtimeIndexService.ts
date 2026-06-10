/**
 * RealtimeIndexService — 用新浪/腾讯免代理实时接口拉指数实时报价。
 *
 * 为什么不用 AKShare:
 *   AKShare 大部分实时接口走 push2.eastmoney.com，从我们这台服务器看
 *   稳定 502。但新浪 hq.sinajs.cn 和腾讯 qt.gtimg.cn 完全可用 (实测)。
 *
 * 接口返回新浪格式（参考实测）：
 *   var hq_str_sh000300="沪深300,4753.11,4801.81,4748.12,4786.52,4718.99,...,2026-06-10,14:49:14,00,"
 *   字段顺序: 名称, 今开, 昨收, 现价, 今高, 今低, 买价, 卖价, 成交量, 成交额, ..., 日期, 时间
 *
 * 5 秒 in-memory 缓存（实测一次调用 ~80ms，不要每次刷都拉）。
 */

import axios from 'axios';
import iconv from 'iconv-lite';
import { logger } from '../utils/logger';

export interface IndexRealtime {
  symbol: string;        // sh.000300
  code: string;          // 000300
  name: string;          // 沪深300
  current: number;       // 现价
  open: number;          // 今开
  prev_close: number;    // 昨收
  high: number;          // 今高
  low: number;           // 今低
  volume: number;        // 成交量
  amount: number;        // 成交额
  change_pct: number;    // 涨跌幅 %
  change: number;        // 涨跌点数
  date: string;          // 2026-06-10
  time: string;          // 14:49:14
  source: 'sina' | 'tencent';
  fetched_at: string;    // ISO
}

const CACHE_TTL_MS = 5_000;

class RealtimeIndexService {
  private cache = new Map<string, { expiresAt: number; data: IndexRealtime }>();

  /**
   * 把 sh.000300 / sh000300 / 000300 统一规整成新浪格式 sh000300
   */
  private toSinaSymbol(symbol: string): string {
    const s = symbol.toLowerCase().replace('.', '');
    if (/^(sh|sz|bj)\d+$/.test(s)) return s;
    // bare 数字
    if (s.startsWith('6')) return `sh${s}`;
    if (s.startsWith('0') || s.startsWith('3')) return `sz${s}`;
    return s;
  }

  /**
   * Parse 新浪 hq_str_sh000300="...,..." 单只行情。
   * 指数 schema (新浪 sh000300 实测): 名称,今开,昨收,现价,今高,今低,买价,卖价,成交量,成交额,...,日期,时间,...
   */
  private parseSinaIndex(raw: string, symbol: string): IndexRealtime | null {
    const m = raw.match(/="([^"]*)"/);
    if (!m || !m[1]) return null;
    const fields = m[1].split(',');
    if (fields.length < 13) return null;

    const name = fields[0];
    const open = Number(fields[1]);
    const prevClose = Number(fields[2]);
    const current = Number(fields[3]);
    const high = Number(fields[4]);
    const low = Number(fields[5]);
    const volume = Number(fields[8]);
    const amount = Number(fields[9]);
    // 新浪指数：date 在倒数第 3 (有可能尾部有 "00,")，time 倒数第 2
    // 实测格式 "...,2026-06-10,14:49:14,00,"
    const trailing = fields.slice(-4);
    const date = trailing[1] || '';
    const time = trailing[2] || '';

    if (!Number.isFinite(current) || !Number.isFinite(prevClose) || prevClose === 0) {
      return null;
    }

    const change = current - prevClose;
    const change_pct = (change / prevClose) * 100;

    const code = symbol.toLowerCase().replace(/^(sh|sz|bj)\.?/, '');

    return {
      symbol: symbol.includes('.') ? symbol : `${symbol.slice(0, 2)}.${code}`,
      code,
      name,
      current,
      open,
      prev_close: prevClose,
      high,
      low,
      volume,
      amount,
      change,
      change_pct,
      date,
      time,
      source: 'sina',
      fetched_at: new Date().toISOString(),
    };
  }

  /**
   * 拉单个或多个指数实时报价
   * @param symbols 形如 ['sh.000300', 'sh.000001', 'sz.399001']，至多 20 个
   */
  async fetchIndexes(symbols: string[]): Promise<IndexRealtime[]> {
    if (!symbols.length) return [];
    const sinaSymbols = symbols.map(s => this.toSinaSymbol(s));

    // 缓存命中（按 symbol 单独 cache，部分命中部分拉）
    const now = Date.now();
    const cached: Map<string, IndexRealtime> = new Map();
    const toFetch: string[] = [];
    for (const sym of sinaSymbols) {
      const hit = this.cache.get(sym);
      if (hit && hit.expiresAt > now) {
        cached.set(sym, hit.data);
      } else {
        toFetch.push(sym);
      }
    }

    if (toFetch.length === 0) {
      return sinaSymbols.map(s => cached.get(s)!).filter(Boolean);
    }

    try {
      // 新浪批量接口：list=sh000300,sh000001,sz399001
      const url = `https://hq.sinajs.cn/list=${toFetch.join(',')}`;
      const resp = await axios.get(url, {
        timeout: 5_000,
        headers: { Referer: 'https://finance.sina.com.cn' },
        responseType: 'arraybuffer', // 新浪用 GBK 编码
      });
      const text = iconv.decode(Buffer.from(resp.data), 'gbk');
      const lines = text.split('\n').filter(l => l.includes('hq_str_'));

      for (const line of lines) {
        const sym = line.match(/hq_str_(\w+)=/)?.[1];
        if (!sym) continue;
        const parsed = this.parseSinaIndex(line, sym);
        if (parsed) {
          this.cache.set(sym, { expiresAt: now + CACHE_TTL_MS, data: parsed });
          cached.set(sym, parsed);
        }
      }
    } catch (err: any) {
      logger.warn(`[RealtimeIndex] sina fetch failed: ${err.message}`);
    }

    return sinaSymbols.map(s => cached.get(s)).filter(Boolean) as IndexRealtime[];
  }

  /** 单个指数的快捷方法 */
  async fetchIndex(symbol: string): Promise<IndexRealtime | null> {
    const arr = await this.fetchIndexes([symbol]);
    return arr[0] || null;
  }
}

export const realtimeIndexService = new RealtimeIndexService();
