import { Request, Response } from 'express';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { createClient, RedisClientType } from 'redis';
import { AKShareClient } from '../../data/sources/AKShareClient';

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

export class InternalDataController {
  private akshareClient = new AKShareClient();
  /**
   * @desc 获取全市场所有上市股票的基础信息列表
   */
  getAllStocks = async (req: Request, res: Response): Promise<void> => {
    try {
      const stocks = await Stock.findAll({
        where: {
          is_listed: true, // 只返回正常上市的
        },
        attributes: ['symbol', 'name', 'market', 'industry', 'listing_date', 'price', 'change_percent'],
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

      // Find the stock id first
      const stock = await Stock.findOne({
        where: { symbol },
        attributes: ['id', 'symbol', 'name'],
      });

      if (!stock) {
        res.status(404).json({ success: false, message: `Stock ${symbol} not found` });
        return;
      }

      // Build date filter
      const whereClause: any = { stock_id: stock.id };
      if (start_date || end_date) {
        whereClause.trade_date = {};
        if (start_date) whereClause.trade_date[Op.gte] = start_date;
        if (end_date) whereClause.trade_date[Op.lte] = end_date;
      }

      // Fetch daily bars, ordered by date ascending
      const bars = await DailyBar.findAll({
        where: whereClause,
        order: [['trade_date', 'ASC']],
        attributes: [
          'trade_date',
          'open',
          'high',
          'low',
          'close',
          'volume',
          'turnover',
          'adj_close',
          'turnover_rate',
          'is_suspended',
        ],
      });

      // 为了在传输大数据时降低 JSON 序列化和网络带宽开销，可以考虑使用更紧凑的数据结构，或者让 Python Agent 更好用 Pandas 解析
      // 这里直接返回标准 JSON 对象数组，配合 Pandas pd.DataFrame(data) 最为丝滑
      res.json({
        success: true,
        symbol: stock.symbol,
        name: stock.name,
        count: bars.length,
        data: bars,
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
        res.status(400).json({ success: false, message: 'Maximum 50 symbols allowed per batch request' });
        return;
      }

      const stocks = await Stock.findAll({
        where: { symbol: { [Op.in]: symbols } },
        attributes: ['id', 'symbol'],
      });

      const stockIds = stocks.map((s) => s.id);
      const idToSymbolMap = new Map(stocks.map((s) => [s.id, s.symbol]));

      const whereClause: any = { stock_id: { [Op.in]: stockIds } };
      if (start_date || end_date) {
        whereClause.trade_date = {};
        if (start_date) whereClause.trade_date[Op.gte] = start_date;
        if (end_date) whereClause.trade_date[Op.lte] = end_date;
      }

      const bars = await DailyBar.findAll({
        where: whereClause,
        order: [['trade_date', 'ASC']],
        attributes: [
          'stock_id',
          'trade_date',
          'open',
          'high',
          'low',
          'close',
          'volume',
          'turnover',
          'adj_close',
          'turnover_rate',
        ],
      });

      // 将结果按 symbol 分组
      const groupedData: Record<string, any[]> = {};
      symbols.forEach((sym) => { groupedData[sym] = []; });

      bars.forEach((bar: any) => {
        const stockIdStr = bar.stock_id as number;
        const symbol = idToSymbolMap.get(stockIdStr);
        if (symbol) {
          // Exclude stock_id from final output to save bandwidth
          const { stock_id, ...barData } = bar.toJSON();
          groupedData[symbol].push(barData);
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

      const symbols = symbolsStr.split(',').filter(Boolean);
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
      if (missingSymbols.length > 0) {
        const missingSymbolsStr = missingSymbols.join(',');
        try {
          const quotes = await this.akshareClient.getRealtimeQuotes(missingSymbolsStr);
          
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
        res.status(400).json({ success: false, message: `invalid period. valid values: ${validPeriods.join(', ')}` });
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
