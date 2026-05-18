import { Request, Response } from 'express';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { createClient, RedisClientType } from 'redis';
import { AKShareClient } from '../../data/sources/AKShareClient';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { realtimeQuoteService } from '../../data/services/RealtimeQuoteService';

const redisUrl = process.env.REDIS_PASSWORD
  ? `redis://:${process.env.REDIS_PASSWORD}@${process.env.REDIS_HOST || '127.0.0.1'}:${
      process.env.REDIS_PORT || '6379'
    }`
  : `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || '6379'}`;

const redisClient: RedisClientType = createClient({
  url: redisUrl,
  database: parseInt(process.env.REDIS_DB || '0'),
});

redisClient.on('error', error => {
  logger.error('Internal API Redis Client Error:', error);
});

redisClient.connect().catch(error => {
  logger.error('Internal API Redis Connection Failed:', error);
});

const normalizeDateInput = (value?: string): string | undefined => {
  if (!value) return undefined;
  const raw = String(value).trim();
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : undefined;
};

const toDayStart = (value?: string): Date | undefined => {
  const normalized = normalizeDateInput(value);
  return normalized ? new Date(`${normalized}T00:00:00.000Z`) : undefined;
};

const toDayEnd = (value?: string): Date | undefined => {
  const normalized = normalizeDateInput(value);
  return normalized ? new Date(`${normalized}T23:59:59.999Z`) : undefined;
};

const formatTradeDate = (value: Date | string): string =>
  new Date(value).toISOString().slice(0, 10);

const toNumber = (value: any): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeRequestedSymbol = (symbol: string): string =>
  normalizeSymbol(String(symbol || '').trim());

const mapDailyBarForAgent = (barLike: any, includeStockId = false): Record<string, any> => {
  const bar = typeof barLike?.toJSON === 'function' ? barLike.toJSON() : barLike;
  const trade_date = formatTradeDate(bar.time);
  const turnover = toNumber(bar.turnover);
  const changePercent = toNumber(bar.change_percent);
  const volume = toNumber(bar.volume);

  return {
    ...(includeStockId ? { stock_id: bar.stock_id } : {}),
    trade_date,
    date: trade_date,
    open: toNumber(bar.open),
    high: toNumber(bar.high),
    low: toNumber(bar.low),
    close: toNumber(bar.close),
    volume,
    vol: volume,
    turnover,
    amount: turnover,
    adj_close: toNumber(bar.adj_close) ?? toNumber(bar.close),
    turnover_rate: toNumber(bar.turnover_rate),
    change_percent: changePercent,
    pct_chg: changePercent,
    amplitude: toNumber(bar.amplitude),
    pe: toNumber(bar.pe),
    pb: toNumber(bar.pb),
    ps: toNumber(bar.ps),
    market_cap: toNumber(bar.market_cap),
    is_trading_day: Boolean(bar.is_trading_day),
    is_suspended: Boolean(bar.is_suspended),
  };
};

export class InternalDataController {
  private akshareClient = new AKShareClient();

  private buildDailyBarWhere(
    stockIdOrIds: number | number[],
    start_date?: string,
    end_date?: string
  ) {
    const whereClause: any = Array.isArray(stockIdOrIds)
      ? { stock_id: { [Op.in]: stockIdOrIds } }
      : { stock_id: stockIdOrIds };

    const start = toDayStart(start_date);
    const end = toDayEnd(end_date);
    if (start || end) {
      whereClause.time = {};
      if (start) whereClause.time[Op.gte] = start;
      if (end) whereClause.time[Op.lte] = end;
    }

    return whereClause;
  }

  /**
   * @desc 获取全市场所有上市股票的基础信息列表
   */
  getAllStocks = async (req: Request, res: Response): Promise<void> => {
    try {
      const stocks = await Stock.findAll({
        where: {
          is_listed: true, // 只返回正常上市的
        },
        attributes: [
          'symbol',
          'name',
          'market',
          'industry',
          'listing_date',
          'price',
          'change_percent',
        ],
      });

      res.json({
        success: true,
        count: stocks.length,
        data: stocks,
      });
    } catch (error: any) {
      logger.error('Failed to fetch all stocks for internal API:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  /**
   * @desc 批量获取日线历史数据
   * @query symbol - 单个股票代码 (例如: sh.600000)
   * @query start_date - 开始日期 (YYYY-MM-DD)
   * @query end_date - 结束日期 (YYYY-MM-DD)
   */
  getHistoricalData = async (req: Request, res: Response): Promise<void> => {
    try {
      const symbol = req.query.symbol as string;
      const start_date = req.query.start_date as string;
      const end_date = req.query.end_date as string;

      if (!symbol) {
        res.status(400).json({ success: false, message: 'Symbol parameter is required' });
        return;
      }

      // Find the stock id first. 兼容 sh.600000 / 600000.SH / 600000 等常见写法。
      const normalizedSymbol = normalizeRequestedSymbol(symbol);
      const stock = await Stock.findOne({
        where: { symbol: normalizedSymbol },
        attributes: ['id', 'symbol', 'name'],
      });

      if (!stock) {
        res.status(404).json({ success: false, message: `Stock ${symbol} not found` });
        return;
      }

      const whereClause = this.buildDailyBarWhere(stock.id, start_date, end_date);

      // Fetch daily bars, ordered by date ascending. daily_bars 实际日期字段是 time；
      // 对 TradingAgents 仍输出 trade_date，保持 Python 侧兼容。
      const bars = await DailyBar.findAll({
        where: whereClause,
        order: [['time', 'ASC']],
        attributes: [
          'time',
          'open',
          'high',
          'low',
          'close',
          'volume',
          'turnover',
          'adj_close',
          'turnover_rate',
          'change_percent',
          'amplitude',
          'pe',
          'pb',
          'ps',
          'market_cap',
          'is_trading_day',
          'is_suspended',
        ],
      });

      const normalizedBars = bars.map(bar => mapDailyBarForAgent(bar));

      // 为了在传输大数据时降低 JSON 序列化和网络带宽开销，可以考虑使用更紧凑的数据结构，或者让 Python Agent 更好用 Pandas 解析
      // 这里直接返回标准 JSON 对象数组，配合 Pandas pd.DataFrame(data) 最为丝滑
      res.json({
        success: true,
        symbol: stock.symbol,
        name: stock.name,
        count: normalizedBars.length,
        start_date: normalizedBars[0]?.trade_date || null,
        end_date: normalizedBars[normalizedBars.length - 1]?.trade_date || null,
        data: normalizedBars,
      });
    } catch (error: any) {
      logger.error(`Failed to fetch historical data for internal API:`, error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  /**
   * @desc 多只股票历史数据一次性批量打包接口 (用于初始化 Agent)
   * @body symbols - string[] 股票列表
   */
  getBatchHistoricalData = async (req: Request, res: Response): Promise<void> => {
    try {
      const symbols = req.body.symbols as string[];
      const start_date = req.body.start_date as string;
      const end_date = req.body.end_date as string;

      if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        res.status(400).json({ success: false, message: 'Array of symbols is required in body' });
        return;
      }

      // 为了防止内存溢出，限制一次性查询的数量
      if (symbols.length > 50) {
        res
          .status(400)
          .json({ success: false, message: 'Maximum 50 symbols allowed per batch request' });
        return;
      }

      const requestedSymbols = symbols.map(symbol => String(symbol).trim()).filter(Boolean);
      const normalizedSymbolByRequested = new Map<string, string>(
        requestedSymbols.map(symbol => [symbol, normalizeRequestedSymbol(symbol)])
      );
      const normalizedSymbols = Array.from(new Set(normalizedSymbolByRequested.values())).filter(
        Boolean
      );

      const stocks = await Stock.findAll({
        where: { symbol: { [Op.in]: normalizedSymbols } },
        attributes: ['id', 'symbol'],
      });

      const stockIds = stocks.map(s => s.id);
      const idToSymbolMap = new Map(stocks.map(s => [s.id, s.symbol]));
      const canonicalToRequestedSymbol = new Map<string, string>();
      for (const requested of requestedSymbols) {
        canonicalToRequestedSymbol.set(
          normalizedSymbolByRequested.get(requested) || requested,
          requested
        );
      }
      const whereClause = this.buildDailyBarWhere(stockIds, start_date, end_date);

      const bars = await DailyBar.findAll({
        where: whereClause,
        order: [
          ['stock_id', 'ASC'],
          ['time', 'ASC'],
        ],
        attributes: [
          'stock_id',
          'time',
          'open',
          'high',
          'low',
          'close',
          'volume',
          'turnover',
          'adj_close',
          'turnover_rate',
          'change_percent',
          'amplitude',
          'pe',
          'pb',
          'ps',
          'market_cap',
          'is_trading_day',
          'is_suspended',
        ],
      });

      // 将结果按 symbol 分组
      const groupedData: Record<string, any[]> = {};
      requestedSymbols.forEach(sym => {
        groupedData[sym] = [];
      });

      bars.forEach((bar: any) => {
        const stockIdStr = bar.stock_id as number;
        const canonicalSymbol = idToSymbolMap.get(stockIdStr);
        const requestedSymbol = canonicalSymbol
          ? canonicalToRequestedSymbol.get(canonicalSymbol)
          : undefined;
        if (requestedSymbol) {
          // Exclude stock_id from final output to save bandwidth
          const { stock_id, ...barData } = mapDailyBarForAgent(bar, true);
          groupedData[requestedSymbol].push(barData);
        }
      });

      res.json({
        success: true,
        data: groupedData,
      });
    } catch (error: any) {
      logger.error(`Failed to fetch batch historical data for internal API:`, error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  /**
   * @desc 获取多只股票的实时切片数据
   * @query symbols - 逗号分隔的股票代码列表 (例如: sh.600000,sz.000001)
   */
  getRealtimeQuotes = async (req: Request, res: Response): Promise<void> => {
    try {
      const symbolsStr = req.query.symbols as string;
      if (!symbolsStr) {
        res.status(400).json({ success: false, message: 'symbols parameter is required' });
        return;
      }

      const symbols = symbolsStr
        .split(',')
        .map(symbol => String(symbol || '').trim())
        .filter(Boolean);
      if (symbols.length === 0) {
        res.status(400).json({ success: false, message: 'invalid symbols parameter' });
        return;
      }

      if (symbols.length > 50) {
        res.status(400).json({ success: false, message: 'Maximum 50 symbols allowed per request' });
        return;
      }

      const resultData: Record<string, any> = {};
      const missingSymbols: string[] = [];

      // 1. Try to get from Redis cache
      for (const sym of symbols) {
        const cacheKey = `quote:${sym}`;
        try {
          const cachedData = await redisClient.get(cacheKey);
          if (cachedData) {
            resultData[sym] = JSON.parse(cachedData);
          } else {
            missingSymbols.push(sym);
          }
        } catch (err) {
          logger.error(`Redis get error for ${cacheKey}:`, err);
          missingSymbols.push(sym); // Fallback to fetch if Redis fails
        }
      }

      // 2. Fetch missing symbols from AKShare
      let persistence: any = null;
      if (missingSymbols.length > 0) {
        const missingSymbolsStr = missingSymbols.join(',');
        try {
          const quotes = await this.akshareClient.getRealtimeQuotes(missingSymbolsStr);
          persistence = await realtimeQuoteService
            .persistQuotes(quotes, missingSymbols, { source: 'akshare' })
            .catch(error => {
              logger.warn(`实时行情落盘失败: ${error?.message || error}`);
              return {
                persisted_count: 0,
                updated_stock_count: 0,
                error: error?.message || String(error),
              };
            });

          // Add to result and set cache
          for (const sym of missingSymbols) {
            if (quotes[sym]) {
              resultData[sym] = quotes[sym];
              try {
                // TTL = 3 seconds for extremely fresh real-time data
                await redisClient.setEx(`quote:${sym}`, 3, JSON.stringify(quotes[sym]));
              } catch (err) {
                logger.error(`Redis setEx error for quote:${sym}:`, err);
              }
            }
          }
        } catch (err) {
          logger.error('Error fetching realtime quotes from AKShare:', err);
        }
      }

      res.json({
        success: true,
        persistence,
        data: resultData,
      });
    } catch (error: any) {
      logger.error('Failed to get realtime quotes:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  /**
   * @desc 获取单只股票日内分时 K 线
   * @query symbol - 单个股票代码 (例如: sh.600000)
   * @query period - 周期: 1m, 5m, 15m, 30m, 60m
   * @query limit - 获取数量
   */
  getIntradayBars = async (req: Request, res: Response): Promise<void> => {
    try {
      const symbol = req.query.symbol as string;
      const period = (req.query.period as string) || '1m';
      const limitStr = req.query.limit as string;
      const limit = limitStr ? parseInt(limitStr, 10) : 240;

      if (!symbol) {
        res.status(400).json({ success: false, message: 'symbol parameter is required' });
        return;
      }

      const validPeriods = ['1m', '5m', '15m', '30m', '60m'];
      if (!validPeriods.includes(period)) {
        res.status(400).json({
          success: false,
          message: `invalid period. valid values: ${validPeriods.join(', ')}`,
        });
        return;
      }

      const cacheKey = `intraday:${symbol}:${period}:${limit}`;

      // 1. Try to get from Redis cache
      try {
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          res.json({
            success: true,
            symbol,
            period,
            cached: true,
            data: JSON.parse(cachedData),
          });
          return;
        }
      } catch (err) {
        logger.error(`Redis get error for ${cacheKey}:`, err);
      }

      // 2. Fetch from AKShare
      const bars = await this.akshareClient.getIntradayBars(symbol, period, limit);

      // 3. Set Cache
      if (bars && bars.length > 0) {
        try {
          // TTL = 60 seconds for minute bars
          await redisClient.setEx(cacheKey, 60, JSON.stringify(bars));
        } catch (err) {
          logger.error(`Redis setEx error for ${cacheKey}:`, err);
        }
      }

      res.json({
        success: true,
        symbol,
        period,
        cached: false,
        data: bars,
      });
    } catch (error: any) {
      logger.error(`Failed to get intraday bars for ${req.query.symbol}:`, error);
      res.status(500).json({ success: false, message: error.message });
    }
  };
}
