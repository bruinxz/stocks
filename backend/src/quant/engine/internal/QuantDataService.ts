import { Op, literal } from 'sequelize';
import { Stock } from '../../../models/Stock';
import { DailyBar } from '../../../models/DailyBar';
import { FavoriteStock } from '../../../models/FavoriteStock';
import { RealtimeQuote } from '../../../models/RealtimeQuote';
import { StockFundamentalFactor } from '../../../models/StockFundamentalFactor';
import { StockMoneyFlowFactor } from '../../../models/StockMoneyFlowFactor';
import { StockValuationFactor } from '../../../models/StockValuationFactor';
import { normalizeSymbol } from '../../../utils/stockSymbol';
import { QuantBar, QuantStockContext, QuantUniverse } from '../../types/QuantTypes';

function toDateOnly(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function factorSourcePriority(row: any): number {
  const source = String(row?.source || '').toLowerCase();
  if (source === 'tushare') return 30;
  if (source === 'eastmoney') return 22;
  if (source === 'akshare') return 20;
  if (source === 'local_derived') return 10;
  return 0;
}

/**
 * audit S-7 修复: 构造一个 where 条件让"当时上市但今天已退市"的标的也能
 * 进入回测 universe (历史回测必须包含退市股, 否则跨年回测系统性高估收益)。
 *
 * 规则：
 *   - is_listed=true (今天仍在市)
 *   - OR delisting_date 在 as_of_date 之后 (历史时点仍在市)
 *
 * as_of_date 不传 → 默认 today, 行为等价旧的 `is_listed=true`。
 *
 * 抽出为 export pure function 便于单测断言 where 形状。
 */
export function buildListedSurvivalWhere(as_of_date?: string): any {
  const asOf = as_of_date || new Date().toISOString().slice(0, 10);
  return {
    [Op.or]: [
      { is_listed: true },
      {
        delisting_date: { [Op.ne]: null, [Op.gt]: asOf } as any,
      },
    ],
  };
}

export class QuantDataService {
  private buildMarketOrder(): any[] {
    return [
      ['change_percent', 'DESC NULLS LAST'],
      ['turnover_rate', 'DESC NULLS LAST'],
      [
        literal(`CASE
          WHEN "Stock"."symbol" LIKE 'sh.60%' THEN 1
          WHEN "Stock"."symbol" LIKE 'sz.00%' THEN 2
          WHEN "Stock"."symbol" LIKE 'sz.30%' THEN 3
          WHEN "Stock"."symbol" LIKE 'sh.68%' THEN 4
          WHEN "Stock"."symbol" LIKE 'bj.%' THEN 5
          ELSE 9
        END`),
        'ASC',
      ],
      ['symbol', 'ASC'],
    ] as any;
  }

  /** @deprecated audit S-7: use exported `buildListedSurvivalWhere` instead. */
  private buildListedSurvivalWhere(as_of_date?: string): any {
    return buildListedSurvivalWhere(as_of_date);
  }

  async getStocks(options: {
    universe?: QuantUniverse;
    user_id?: number;
    symbols?: string[];
    limit?: number;
    /**
     * audit S-7 修复: 历史回测的时点日; 不传 → 默认 today, 行为等价旧 `is_listed=true`。
     * 传入回测的 trade_date 可以正确包含"当时上市但今天已退市"的标的, 避免
     * 生存者偏差。
     */
    as_of_date?: string;
  }): Promise<Stock[]> {
    const limit = Math.min(Number(options.limit || 120), 1000);
    const listedSurvivalWhere = this.buildListedSurvivalWhere(options.as_of_date);
    if (options.symbols?.length) {
      const symbols = options.symbols.map(normalizeSymbol).filter(Boolean);
      return Stock.findAll({
        where: { symbol: { [Op.in]: symbols }, ...listedSurvivalWhere },
        limit,
      });
    }
    if (options.universe === 'favorites' && options.user_id) {
      const favorites = await FavoriteStock.findAll({
        where: { user_id: options.user_id },
        include: [{ model: Stock }],
        limit,
      });
      const stocks = favorites.map(item => item.stock).filter(Boolean) as Stock[];
      if (stocks.length) return stocks;
    }
    return Stock.findAll({
      where: {
        ...listedSurvivalWhere,
        [Op.or]: [{ type: 'stock' }, { type: null }],
        name: { [Op.and]: [{ [Op.notILike]: '%ST%' }, { [Op.notILike]: '%退%' }] },
      },
      order: this.buildMarketOrder(),
      limit,
    });
  }

  async getContexts(options: {
    universe?: QuantUniverse;
    user_id?: number;
    symbols?: string[];
    start_date: string;
    end_date: string;
    warmup_days?: number;
    limit?: number;
    include_realtime_quote?: boolean;
    /** audit S-7 修复: 历史回测 as-of 日期, 默认 end_date 防生存者偏差 */
    as_of_date?: string;
  }): Promise<QuantStockContext[]> {
    const stocks = await this.getStocks({
      ...options,
      as_of_date: options.as_of_date || options.end_date,
    });
    const latestQuotes =
      options.include_realtime_quote === false
        ? []
        : await RealtimeQuote.findAll({
            where: { symbol: { [Op.in]: stocks.map(stock => stock.symbol) } },
            order: [
              ['symbol', 'ASC'],
              ['quote_time', 'DESC'],
            ],
            limit: Math.max(stocks.length * 3, 50),
          }).catch(() => [] as RealtimeQuote[]);
    const latestQuoteBySymbol = new Map<string, RealtimeQuote>();
    for (const quote of latestQuotes) {
      if (!latestQuoteBySymbol.has(quote.symbol)) latestQuoteBySymbol.set(quote.symbol, quote);
    }
    const [valuationRows, moneyFlowRows, fundamentalRows] = await Promise.all([
      StockValuationFactor.findAll({
        where: { symbol: { [Op.in]: stocks.map(stock => stock.symbol) } },
        order: [
          ['symbol', 'ASC'],
          ['factor_date', 'DESC'],
        ],
        limit: Math.max(stocks.length * 3, 50),
      }).catch(() => [] as StockValuationFactor[]),
      StockMoneyFlowFactor.findAll({
        where: { symbol: { [Op.in]: stocks.map(stock => stock.symbol) } },
        order: [
          ['symbol', 'ASC'],
          ['factor_date', 'DESC'],
        ],
        limit: Math.max(stocks.length * 3, 50),
      }).catch(() => [] as StockMoneyFlowFactor[]),
      StockFundamentalFactor.findAll({
        where: { symbol: { [Op.in]: stocks.map(stock => stock.symbol) } },
        order: [
          ['symbol', 'ASC'],
          ['factor_date', 'DESC'],
        ],
        limit: Math.max(stocks.length * 3, 50),
      }).catch(() => [] as StockFundamentalFactor[]),
    ]);
    const latestBySymbol = <T extends { symbol: string; factor_date?: string; source?: string }>(
      rows: T[]
    ) => {
      const map = new Map<string, T>();
      for (const row of rows) {
        const existing = map.get(row.symbol);
        if (!existing) {
          map.set(row.symbol, row);
          continue;
        }
        const dateCompare = String(row.factor_date || '').localeCompare(
          String(existing.factor_date || '')
        );
        if (dateCompare > 0) {
          map.set(row.symbol, row);
          continue;
        }
        if (dateCompare === 0 && factorSourcePriority(row) > factorSourcePriority(existing)) {
          map.set(row.symbol, row);
        }
      }
      return map;
    };
    const valuationBySymbol = latestBySymbol(valuationRows);
    const moneyFlowBySymbol = latestBySymbol(moneyFlowRows);
    const fundamentalBySymbol = latestBySymbol(fundamentalRows);
    const warmupStart = new Date(options.start_date);
    warmupStart.setDate(warmupStart.getDate() - Number(options.warmup_days || 120));
    const contexts: QuantStockContext[] = [];
    for (const stock of stocks) {
      const bars = await DailyBar.findAll({
        where: {
          stock_id: stock.id,
          time: { [Op.between]: [warmupStart, new Date(`${options.end_date}T23:59:59.999Z`)] },
        },
        order: [['time', 'ASC']],
      });
      const quantBars: QuantBar[] = bars.map(bar => ({
        time: bar.time,
        open: Number(bar.open),
        high: Number(bar.high),
        low: Number(bar.low),
        close: Number(bar.close),
        volume: Number(bar.volume || 0),
        turnover: bar.turnover === undefined ? null : Number(bar.turnover),
        turnover_rate: bar.turnover_rate === undefined ? null : Number(bar.turnover_rate),
        change_percent: bar.change_percent === undefined ? null : Number(bar.change_percent),
      }));
      if (quantBars.length < 30) continue;
      const latestQuote = latestQuoteBySymbol.get(stock.symbol);
      const valuationFactor = valuationBySymbol.get(stock.symbol);
      const moneyFlowFactor = moneyFlowBySymbol.get(stock.symbol);
      const fundamentalFactor = fundamentalBySymbol.get(stock.symbol);
      const mergedBars = this.mergeRealtimeQuoteIntoBars(quantBars, latestQuote, options.end_date);
      const latest = mergedBars[mergedBars.length - 1];
      const realtimePrice = latestQuote?.current_price ? Number(latestQuote.current_price) : null;
      const stockPrice = stock.price ? Number(stock.price) : null;
      const priceSource = realtimePrice
        ? 'realtime_quote'
        : stockPrice
        ? 'stock_snapshot'
        : 'daily_bar';
      const realtimeChangePercent =
        latestQuote?.change_percent === undefined ? null : Number(latestQuote.change_percent);
      contexts.push({
        stock_id: stock.id,
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        industry: stock.industry,
        bars: mergedBars,
        as_of: toDateOnly(latest.time),
        latest_price: Number(realtimePrice || stockPrice || latest.close),
        latest_quote_time: latestQuote?.quote_time?.toISOString?.() || null,
        price_source: priceSource,
        change_percent:
          realtimeChangePercent ??
          (stock.change_percent === undefined
            ? latest.change_percent
            : Number(stock.change_percent)),
        total_market_cap:
          valuationFactor?.total_market_cap !== undefined
            ? Number(valuationFactor.total_market_cap)
            : stock.total_market_cap === undefined
            ? null
            : Number(stock.total_market_cap),
        pe_dynamic:
          valuationFactor?.pe_ttm !== undefined
            ? Number(valuationFactor.pe_ttm)
            : stock.pe_dynamic === undefined
            ? null
            : Number(stock.pe_dynamic),
        pb:
          valuationFactor?.pb !== undefined
            ? Number(valuationFactor.pb)
            : stock.pb === undefined
            ? null
            : Number(stock.pb),
        factor_snapshot: {
          valuation: valuationFactor?.toJSON?.() || null,
          money_flow: moneyFlowFactor?.toJSON?.() || null,
          fundamental: fundamentalFactor?.toJSON?.() || null,
          factor_date:
            valuationFactor?.factor_date ||
            moneyFlowFactor?.factor_date ||
            fundamentalFactor?.factor_date ||
            null,
        },
      });
    }
    return contexts;
  }

  private mergeRealtimeQuoteIntoBars(
    bars: QuantBar[],
    quote?: RealtimeQuote,
    end_date?: string
  ): QuantBar[] {
    const currentPrice = quote?.current_price ? Number(quote.current_price) : 0;
    if (!quote || !currentPrice || !Number.isFinite(currentPrice) || !bars.length) return bars;

    const quoteDate = quote.trade_date || toDateOnly(quote.quote_time);
    const normalizedEndDate = end_date ? toDateOnly(end_date) : quoteDate;
    if (quoteDate > normalizedEndDate) return bars;

    const latestBar = bars[bars.length - 1];
    const latestDate = toDateOnly(latestBar.time);
    const open = quote.open ? Number(quote.open) : latestBar.close;
    const high = quote.high ? Number(quote.high) : Math.max(open, currentPrice, latestBar.close);
    const low = quote.low ? Number(quote.low) : Math.min(open, currentPrice, latestBar.close);
    const volume = quote.volume ? Number(quote.volume) : latestBar.volume;
    const turnover = quote.turnover ? Number(quote.turnover) : latestBar.turnover;
    const changePercent =
      quote.change_percent === undefined ? latestBar.change_percent : Number(quote.change_percent);
    const realtimeBar: QuantBar = {
      time: quote.quote_time || new Date(`${quoteDate}T15:00:00.000Z`),
      open,
      high: Math.max(high, currentPrice),
      low: Math.min(low, currentPrice),
      close: currentPrice,
      volume,
      turnover,
      turnover_rate: latestBar.turnover_rate,
      change_percent: changePercent,
    };

    if (quoteDate === latestDate) {
      return [...bars.slice(0, -1), realtimeBar];
    }
    if (quoteDate > latestDate) {
      return [...bars, realtimeBar];
    }
    return bars;
  }
}

export const quantDataService = new QuantDataService();
