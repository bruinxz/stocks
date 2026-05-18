import moment from 'moment-timezone';
import { Op } from 'sequelize';
import { RealtimeQuote } from '../../models/RealtimeQuote';
import { Stock } from '../../models/Stock';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { logger } from '../../utils/logger';
import { AKShareClient } from '../sources/AKShareClient';

function toNumber(value: any): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseQuoteTime(value: any): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function dateOnly(value: Date): string {
  return moment(value).tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function pickQuote(quotes: Record<string, any>, requested: string, normalized: string) {
  return (
    quotes[requested] ||
    quotes[normalized] ||
    quotes[normalized.replace('.', '')] ||
    quotes[normalized.split('.')[1]] ||
    null
  );
}

export interface PersistRealtimeQuotesResult {
  persisted_count: number;
  updated_stock_count: number;
  latest_quote_time?: string;
  symbols: string[];
}

export class RealtimeQuoteService {
  private akshareClient = new AKShareClient();

  async syncQuotesForSymbols(
    symbols: string[],
    options: { source?: string; batch_size?: number } = {}
  ): Promise<PersistRealtimeQuotesResult & { requested_count: number; batch_count: number }> {
    const normalizedSymbols = [...new Set((symbols || []).map(normalizeSymbol).filter(Boolean))];
    if (!normalizedSymbols.length) {
      return {
        requested_count: 0,
        batch_count: 0,
        persisted_count: 0,
        updated_stock_count: 0,
        symbols: [],
      };
    }
    const batchSize = Math.min(Math.max(Number(options.batch_size || 300), 1), 500);
    const batches: string[][] = [];
    for (let i = 0; i < normalizedSymbols.length; i += batchSize) {
      batches.push(normalizedSymbols.slice(i, i + batchSize));
    }
    const aggregate: PersistRealtimeQuotesResult = {
      persisted_count: 0,
      updated_stock_count: 0,
      symbols: [],
    };
    let latestQuoteTime: string | undefined;
    for (const batch of batches) {
      const quotes = await this.akshareClient.getRealtimeQuotes(batch.join(','));
      const persisted = await this.persistQuotes(quotes, batch, {
        source: options.source || 'akshare',
      });
      aggregate.persisted_count += persisted.persisted_count;
      aggregate.updated_stock_count += persisted.updated_stock_count;
      aggregate.symbols.push(...persisted.symbols);
      if (
        persisted.latest_quote_time &&
        (!latestQuoteTime || new Date(persisted.latest_quote_time) > new Date(latestQuoteTime))
      ) {
        latestQuoteTime = persisted.latest_quote_time;
      }
    }
    return {
      ...aggregate,
      requested_count: normalizedSymbols.length,
      batch_count: batches.length,
      latest_quote_time: latestQuoteTime,
      symbols: [...new Set(aggregate.symbols)],
    };
  }

  async persistQuotes(
    quotes: Record<string, any>,
    requestedSymbols?: string[],
    options: { source?: string } = {}
  ): Promise<PersistRealtimeQuotesResult> {
    const requested = (requestedSymbols?.length ? requestedSymbols : Object.keys(quotes || {}))
      .map(symbol => String(symbol || '').trim())
      .filter(Boolean);
    const normalizedSymbols = [...new Set(requested.map(normalizeSymbol).filter(Boolean))];
    if (!normalizedSymbols.length) {
      return { persisted_count: 0, updated_stock_count: 0, symbols: [] };
    }

    const stocks = await Stock.findAll({ where: { symbol: { [Op.in]: normalizedSymbols } } });
    const stockBySymbol = new Map(stocks.map(stock => [stock.symbol, stock]));
    const rows: any[] = [];
    let latestQuoteTime: Date | undefined;

    for (const rawSymbol of requested) {
      const symbol = normalizeSymbol(rawSymbol);
      if (!symbol) continue;
      const quote = pickQuote(quotes || {}, rawSymbol, symbol);
      if (!quote || typeof quote !== 'object') continue;
      const currentPrice = toNumber(
        quote.current_price ?? quote.latest_price ?? quote.price ?? quote.close
      );
      const changePercent = toNumber(quote.change_percent ?? quote.pct_chg ?? quote.change);
      const open = toNumber(quote.open);
      const high = toNumber(quote.high);
      const low = toNumber(quote.low);
      const volume = toNumber(quote.volume ?? quote.vol);
      const turnover = toNumber(quote.turnover ?? quote.amount);
      if (
        currentPrice === undefined &&
        changePercent === undefined &&
        open === undefined &&
        high === undefined &&
        low === undefined &&
        volume === undefined &&
        turnover === undefined
      ) {
        continue;
      }
      const quoteTime = parseQuoteTime(quote.timestamp ?? quote.quote_time ?? quote.time);
      if (!latestQuoteTime || quoteTime.getTime() > latestQuoteTime.getTime()) {
        latestQuoteTime = quoteTime;
      }
      const stock = stockBySymbol.get(symbol);
      rows.push({
        stock_id: stock?.id,
        symbol,
        name: quote.name || stock?.name,
        quote_time: quoteTime,
        trade_date: dateOnly(quoteTime),
        current_price: currentPrice,
        change_percent: changePercent,
        open,
        high,
        low,
        volume,
        turnover,
        source: options.source || quote.source || 'akshare',
        raw_payload: quote,
      });
    }

    if (!rows.length) {
      return { persisted_count: 0, updated_stock_count: 0, symbols: normalizedSymbols };
    }

    await RealtimeQuote.bulkCreate(rows);
    let updatedStockCount = 0;
    for (const row of rows) {
      const stock = stockBySymbol.get(row.symbol);
      if (!stock) continue;
      const updatePayload: Record<string, any> = {};
      if (row.current_price !== undefined) updatePayload.price = row.current_price;
      if (row.change_percent !== undefined) updatePayload.change_percent = row.change_percent;
      if (!Object.keys(updatePayload).length) continue;
      try {
        await stock.update(updatePayload);
        updatedStockCount++;
      } catch (error: any) {
        logger.warn(`实时行情更新股票快照失败 ${row.symbol}: ${error?.message || error}`);
      }
    }

    return {
      persisted_count: rows.length,
      updated_stock_count: updatedStockCount,
      latest_quote_time: latestQuoteTime?.toISOString(),
      symbols: [...new Set(rows.map(row => row.symbol))],
    };
  }

  async getLatestQuotes(symbols?: string[]): Promise<RealtimeQuote[]> {
    const normalizedSymbols = symbols?.map(normalizeSymbol).filter(Boolean) || [];
    const where: any = {};
    if (normalizedSymbols.length) where.symbol = { [Op.in]: normalizedSymbols };
    const rows = await RealtimeQuote.findAll({
      where,
      order: [
        ['symbol', 'ASC'],
        ['quote_time', 'DESC'],
      ],
      limit: normalizedSymbols.length ? Math.max(normalizedSymbols.length * 3, 20) : 500,
    });
    const seen = new Set<string>();
    const latest: RealtimeQuote[] = [];
    for (const row of rows) {
      if (seen.has(row.symbol)) continue;
      seen.add(row.symbol);
      latest.push(row);
    }
    return latest;
  }

  async getPersistenceSummary(options: { trade_date?: string } = {}) {
    const latest = await RealtimeQuote.findOne({ order: [['quote_time', 'DESC']] });
    const tradeDate = options.trade_date || (latest ? dateOnly(latest.quote_time) : undefined);
    const todayCount = tradeDate
      ? await RealtimeQuote.count({ where: { trade_date: tradeDate } })
      : 0;
    const latestSymbols = tradeDate
      ? await RealtimeQuote.count({
          where: { trade_date: tradeDate },
          distinct: true,
          col: 'symbol',
        })
      : 0;
    const ageMinutes = latest
      ? Math.max(0, Math.round((Date.now() - latest.quote_time.getTime()) / 60000))
      : null;
    const freshnessThresholdMinutes = Math.max(
      Number(process.env.REALTIME_QUOTE_FRESHNESS_MINUTES || 30),
      1
    );
    const isFresh = ageMinutes !== null && ageMinutes <= freshnessThresholdMinutes;
    return {
      persisted: Boolean(latest),
      latest_quote_time: latest?.quote_time?.toISOString() || null,
      latest_trade_date: tradeDate || null,
      latest_trade_date_snapshot_count: todayCount,
      latest_trade_date_symbol_count: latestSymbols,
      age_minutes: ageMinutes,
      freshness_threshold_minutes: freshnessThresholdMinutes,
      is_fresh: isFresh,
      freshness_status: !latest ? 'missing' : isFresh ? 'fresh' : 'stale',
    };
  }
}

export const realtimeQuoteService = new RealtimeQuoteService();
