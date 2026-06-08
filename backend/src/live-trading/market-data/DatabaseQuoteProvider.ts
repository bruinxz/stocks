import { Op } from 'sequelize';
import { RealtimeQuote } from '../../models/RealtimeQuote';
import { Stock } from '../../models/Stock';
import { LiveMarketDataProvider, LiveQuoteSnapshot } from './LiveMarketDataProvider';

function normalizeSymbol(symbol: string): string {
  const value = String(symbol || '')
    .trim()
    .toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(value)) return value;
  if (/^(SH|SZ|BJ)\.\d{6}$/.test(value)) {
    const [market, code] = value.split('.');
    return `${code}.${market}`;
  }
  if (/^(SH|SZ|BJ)\d{6}$/.test(value)) return `${value.slice(2)}.${value.slice(0, 2)}`;
  if (/^\d{6}$/.test(value)) {
    const prefix = value.startsWith('6')
      ? 'SH'
      : value.startsWith('8') || value.startsWith('4')
      ? 'BJ'
      : 'SZ';
    return `${value}.${prefix}`;
  }
  return value;
}

function toNumber(value: any): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function diffSeconds(date?: Date): number | undefined {
  if (!date) return undefined;
  const time = new Date(date).getTime();
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Math.round((Date.now() - time) / 1000));
}

export class DatabaseQuoteProvider implements LiveMarketDataProvider {
  getProviderInfo() {
    return {
      provider_key: 'database_realtime_quotes',
      provider_name: '本地实时行情缓存',
      realtime_supported: true,
      licensed_for_external_use: false,
      notes: [
        '读取 realtime_quotes / stocks 中已有行情快照。',
        '该 provider 不直接拉取外部行情，适合作为实盘前安全只读入口。',
        '对外商业化前必须替换为授权明确的数据源。',
      ],
    };
  }

  async getQuote(symbol: string): Promise<LiveQuoteSnapshot | null> {
    const normalized = normalizeSymbol(symbol);
    const quote = await RealtimeQuote.findOne({
      where: { symbol: normalized },
      order: [['quote_time', 'DESC']],
    });

    if (quote) {
      const plain: any = quote.toJSON();
      const quoteTime = plain.quote_time ? new Date(plain.quote_time) : undefined;
      return {
        symbol: plain.symbol,
        name: plain.name,
        current_price: toNumber(plain.current_price),
        change_percent: toNumber(plain.change_percent),
        turnover: toNumber(plain.turnover),
        volume: toNumber(plain.volume),
        quote_time: quoteTime,
        source: plain.source || 'database',
        latency_seconds: diffSeconds(quoteTime),
        is_realtime: Boolean(quoteTime && diffSeconds(quoteTime)! <= 15 * 60),
        raw_payload: plain.raw_payload || {},
      };
    }

    const stock = await Stock.findOne({
      where: { symbol: { [Op.in]: [normalized, normalized.replace('.', '')] } },
    });
    if (!stock) return null;
    const plain: any = stock.toJSON();
    const quoteTime = plain.updated_at ? new Date(plain.updated_at) : undefined;
    return {
      symbol: plain.symbol,
      name: plain.name,
      current_price: toNumber(plain.price),
      change_percent: toNumber(plain.change_percent),
      quote_time: quoteTime,
      source: 'stocks_snapshot',
      latency_seconds: diffSeconds(quoteTime),
      is_realtime: false,
      raw_payload: { fallback: true },
    };
  }

  async getQuotes(symbols: string[]): Promise<LiveQuoteSnapshot[]> {
    const unique = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))].slice(0, 80);
    const results: LiveQuoteSnapshot[] = [];
    for (const symbol of unique) {
      const quote = await this.getQuote(symbol);
      if (quote) results.push(quote);
    }
    return results;
  }
}
