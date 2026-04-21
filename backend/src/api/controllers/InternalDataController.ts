import { Request, Response } from 'express';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { Op } from 'sequelize';
import { logger } from '../../utils/logger';

export class InternalDataController {
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
      const startDate = req.query.start_date as string;
      const endDate = req.query.end_date as string;

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
      if (startDate || endDate) {
        whereClause.trade_date = {};
        if (startDate) whereClause.trade_date[Op.gte] = startDate;
        if (endDate) whereClause.trade_date[Op.lte] = endDate;
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
      const startDate = req.body.start_date as string;
      const endDate = req.body.end_date as string;

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
      if (startDate || endDate) {
        whereClause.trade_date = {};
        if (startDate) whereClause.trade_date[Op.gte] = startDate;
        if (endDate) whereClause.trade_date[Op.lte] = endDate;
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
}
