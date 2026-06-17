import axios from 'axios';
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

function getAshareSession(now = moment().tz('Asia/Shanghai')) {
  const minutes = now.hour() * 60 + now.minute();
  const weekday = now.isoWeekday();
  const isWeekday = weekday >= 1 && weekday <= 5;
  const tradeDate = now.format('YYYY-MM-DD');
  const morningOpen = 9 * 60 + 30;
  const morningClose = 11 * 60 + 30;
  const afternoonOpen = 13 * 60;
  const afternoonClose = 15 * 60;
  const isContinuousTrading =
    isWeekday &&
    ((minutes >= morningOpen && minutes <= morningClose) ||
      (minutes >= afternoonOpen && minutes <= afternoonClose));
  const isTradingDayWindow = isWeekday && minutes >= morningOpen && minutes <= afternoonClose;
  const session =
    !isWeekday || minutes < morningOpen
      ? 'pre_open'
      : minutes <= morningClose
      ? 'morning'
      : minutes < afternoonOpen
      ? 'lunch_break'
      : minutes <= afternoonClose
      ? 'afternoon'
      : 'after_close';

  return {
    trade_date: tradeDate,
    session,
    is_weekday: isWeekday,
    is_continuous_trading: isContinuousTrading,
    is_trading_day_window: isTradingDayWindow,
  };
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

function toTencentSymbol(symbol: string): string {
  return normalizeSymbol(symbol).replace('.', '');
}

function parseTencentQuoteTimestamp(value: string): Date {
  const text = String(value || '').trim();
  if (/^\d{14}$/.test(text)) {
    const formatted = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(
      8,
      10
    )}:${text.slice(10, 12)}:${text.slice(12, 14)}+08:00`;
    const parsed = new Date(formatted);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function parseTencentRealtimePayload(
  payload: string,
  requestedSymbols: string[]
): Record<string, any> {
  const result: Record<string, any> = {};
  const requestedByTencent = new Map(
    requestedSymbols.map(symbol => [toTencentSymbol(symbol), normalizeSymbol(symbol)])
  );
  const lines = String(payload || '').split(';');
  for (const line of lines) {
    const match = line.match(/v_([a-z]{2}\d{6})="([^"]*)"/i);
    if (!match) continue;
    const tencentSymbol = match[1].toLowerCase();
    const normalized = requestedByTencent.get(tencentSymbol);
    if (!normalized) continue;
    const parts = match[2].split('~');
    const currentPrice = toNumber(parts[3]);
    const previousClose = toNumber(parts[4]);
    const open = toNumber(parts[5]);
    const volumeLots = toNumber(parts[6]);
    const amountWan = toNumber(parts[37]);
    // Sprint 34 (短板 #3b): Tencent 实时行情盘口 — 5档买卖
    // parts[9]=bid1_price, parts[10]=bid1_volume, parts[11]=bid2_price, ..., parts[18]=bid5_volume
    // parts[19]=ask1_price, parts[20]=ask1_volume, ..., parts[28]=ask5_volume
    const bid1 = toNumber(parts[9]);
    const ask1 = toNumber(parts[19]);
    result[normalized] = {
      // 不依赖腾讯 GBK 股票名解码，落盘时优先使用 stocks 表里的标准名称。
      current_price: currentPrice,
      previous_close: previousClose,
      open,
      high: toNumber(parts[33]),
      low: toNumber(parts[34]),
      change_amount: toNumber(parts[31]),
      change_percent: toNumber(parts[32]),
      volume: volumeLots === undefined ? undefined : volumeLots * 100,
      turnover: amountWan === undefined ? undefined : amountWan * 10000,
      // Sprint 34: 盘口 bid/ask (1档), 后续 Feasibility spread 评分用
      bid1_price: bid1 && bid1 > 0 ? bid1 : undefined,
      ask1_price: ask1 && ask1 > 0 ? ask1 : undefined,
      bid1_volume: toNumber(parts[10]),
      ask1_volume: toNumber(parts[20]),
      timestamp: parseTencentQuoteTimestamp(parts[30]).toISOString(),
      source: 'tencent',
      raw: parts,
    };
  }
  return result;
}

export interface PersistRealtimeQuotesResult {
  persisted_count: number;
  updated_stock_count: number;
  latest_quote_time?: string;
  symbols: string[];
}

export class RealtimeQuoteService {
  private akshareClient = new AKShareClient();

  private async fetchTencentQuotes(symbols: string[]): Promise<Record<string, any>> {
    const normalizedSymbols = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
    if (!normalizedSymbols.length) return {};
    const url = `https://qt.gtimg.cn/q=${normalizedSymbols.map(toTencentSymbol).join(',')}`;
    const response = await axios.get(url, {
      timeout: Number(process.env.TENCENT_REALTIME_TIMEOUT_MS || 12000),
      responseType: 'arraybuffer',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Referer: 'https://gu.qq.com/',
      },
    });
    const text = Buffer.from(response.data).toString('latin1');
    // 腾讯接口主体是 GBK，但股票名不是落盘必需字段；使用 binary 文本解析数值字段即可。
    return parseTencentRealtimePayload(text, normalizedSymbols);
  }

  private async fetchRealtimeQuotesWithFallback(
    symbols: string[],
    options: { source?: string } = {}
  ): Promise<{ quotes: Record<string, any>; source: string }> {
    const requestedSource = String(options.source || 'auto').toLowerCase();
    const useAkshare = requestedSource === 'auto' || requestedSource === 'akshare';
    const useTencent =
      requestedSource === 'auto' || requestedSource === 'akshare' || requestedSource === 'tencent';

    if (useAkshare) {
      try {
        const quotes = await this.akshareClient.getRealtimeQuotes(symbols.join(','));
        if (quotes && Object.keys(quotes).length > 0) {
          return { quotes, source: 'akshare' };
        }
        logger.warn(`AKShare 实时行情返回空结果，降级腾讯实时源: symbols=${symbols.length}`);
      } catch (error: any) {
        logger.warn(`AKShare 实时行情失败，降级腾讯实时源: ${error?.message || error}`);
      }
    }

    if (useTencent) {
      try {
        const quotes = await this.fetchTencentQuotes(symbols);
        if (quotes && Object.keys(quotes).length > 0) {
          return { quotes, source: 'tencent' };
        }
        logger.warn(`腾讯实时行情返回空结果: symbols=${symbols.length}`);
      } catch (error: any) {
        logger.warn(`腾讯实时行情失败: ${error?.message || error}`);
      }
    }

    return { quotes: {}, source: requestedSource === 'auto' ? 'unavailable' : requestedSource };
  }

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
      const { quotes, source } = await this.fetchRealtimeQuotesWithFallback(batch, {
        source: options.source,
      });
      const persisted = await this.persistQuotes(quotes, batch, {
        source,
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

    // Batch R (2026-06-17, P1-9 fix): ignoreDuplicates 配合 model 上的 UNIQUE
    // (symbol, quote_time) 索引, 防 cron 高频重复 insert 让表膨胀.
    await RealtimeQuote.bulkCreate(rows, { ignoreDuplicates: true });
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
    const marketSession = getAshareSession();
    const tradeDate =
      options.trade_date ||
      (latest ? dateOnly(latest.quote_time) : undefined) ||
      marketSession.trade_date;
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
    const latestTradeDateMatchesSession = latest
      ? dateOnly(latest.quote_time) === tradeDate
      : false;
    const hasEnoughSameDaySymbols =
      latestSymbols >= Number(process.env.REALTIME_QUOTE_MIN_SYMBOLS || 50);
    const isIntradayFresh = ageMinutes !== null && ageMinutes <= freshnessThresholdMinutes;
    const isSameDaySnapshotUsable =
      Boolean(latest) &&
      latestTradeDateMatchesSession &&
      hasEnoughSameDaySymbols &&
      !marketSession.is_continuous_trading;
    const isFresh = isIntradayFresh || isSameDaySnapshotUsable;
    const freshnessStatus = !latest
      ? 'missing'
      : isIntradayFresh
      ? 'fresh'
      : isSameDaySnapshotUsable
      ? 'same_day_snapshot'
      : 'stale';
    return {
      persisted: Boolean(latest),
      latest_quote_time: latest?.quote_time?.toISOString() || null,
      latest_trade_date: tradeDate || null,
      latest_trade_date_snapshot_count: todayCount,
      latest_trade_date_symbol_count: latestSymbols,
      age_minutes: ageMinutes,
      freshness_threshold_minutes: freshnessThresholdMinutes,
      market_session: marketSession.session,
      is_continuous_trading: marketSession.is_continuous_trading,
      same_day_snapshot_usable: isSameDaySnapshotUsable,
      is_fresh: isFresh,
      freshness_status: freshnessStatus,
    };
  }
}

export const realtimeQuoteService = new RealtimeQuoteService();
