import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';

export class StockController {
  /**
   * 获取股票列表
   */
  async getStockList(req: Request, res: Response, next: NextFunction) {
    try {
      const {
        page = '1',
        limit = '20',
        market,
        industry,
        search,
        listedOnly = 'true',
      } = req.query;

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const offset = (pageNum - 1) * limitNum;

      const where: any = {};

      if (market) {
        where.market = market;
      }

      if (industry) {
        where.industry = industry;
      }

      if (search) {
        where[Op.or] = [
          { symbol: { [Op.iLike]: `%${search}%` } },
          { name: { [Op.iLike]: `%${search}%` } },
        ];
      }

      if (listedOnly === 'true') {
        where.isListed = true;
      }

      const { count, rows } = await Stock.findAndCountAll({
        where,
        limit: limitNum,
        offset,
        order: [['symbol', 'ASC']],
      });

      res.json({
        success: true,
        data: {
          stocks: rows,
          pagination: {
            total: count,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(count / limitNum),
          },
        },
      });
    } catch (error) {
      logger.error('获取股票列表失败:', error);
      next(error);
    }
  }

  /**
   * 获取股票详情
   */
  async getStockDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const { symbol } = req.params;
      const stock = await Stock.findOne({
        where: { symbol },
      });

      if (!stock) {
        return res.status(404).json({
          success: false,
          message: '股票不存在',
        });
      }

      res.json({
        success: true,
        data: { stock },
      });
    } catch (error) {
      logger.error('获取股票详情失败:', error);
      next(error);
    }
  }

  /**
   * 获取股票日线数据
   */
  async getDailyBars(req: Request, res: Response, next: NextFunction) {
    try {
      const { symbol } = req.params;
      const { start_date, end_date, limit = '1000' } = req.query;

      // 验证股票存在
      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) {
        return res.status(404).json({
          success: false,
          message: '股票不存在',
        });
      }

      const where: any = { stockId: stock.id };

      if (start_date) {
        where.time = { ...where.time, [Op.gte]: new Date(start_date as string) };
      }

      if (end_date) {
        where.time = { ...where.time, [Op.lte]: new Date(end_date as string) };
      }

      const limitNum = parseInt(limit as string, 10);
      const bars = await DailyBar.findAll({
        where,
        limit: limitNum,
        order: [['time', 'ASC']],
      });

      res.json({
        success: true,
        data: {
          symbol,
          bars,
          count: bars.length,
        },
      });
    } catch (error) {
      logger.error('获取股票日线数据失败:', error);
      next(error);
    }
  }

  /**
   * 获取股票市场统计
   */
  async getMarketStats(req: Request, res: Response, next: NextFunction) {
    try {
      const marketStats = await Stock.findAll({
        attributes: [
          'market',
          [Stock.sequelize!.fn('COUNT', Stock.sequelize!.col('id')), 'count'],
        ],
        where: { isListed: true },
        group: ['market'],
      });

      const industryStats = await Stock.findAll({
        attributes: [
          'industry',
          [Stock.sequelize!.fn('COUNT', Stock.sequelize!.col('id')), 'count'],
        ],
        where: {
          isListed: true,
          industry: { [Op.not]: null },
        },
        group: ['industry'],
        order: [[Stock.sequelize!.fn('COUNT', Stock.sequelize!.col('id')), 'DESC']],
        limit: 10,
      });

      res.json({
        success: true,
        data: {
          marketStats,
          industryStats,
        },
      });
    } catch (error) {
      logger.error('获取市场统计失败:', error);
      next(error);
    }
  }

  /**
   * 获取股票搜索建议
   */
  async getSearchSuggestions(req: Request, res: Response, next: NextFunction) {
    try {
      const { q } = req.query;
      if (!q || (q as string).length < 2) {
        return res.json({
          success: true,
          data: { suggestions: [] },
        });
      }

      const suggestions = await Stock.findAll({
        where: {
          [Op.or]: [
            { symbol: { [Op.iLike]: `%${q}%` } },
            { name: { [Op.iLike]: `%${q}%` } },
          ],
          isListed: true,
        },
        attributes: ['symbol', 'name', 'market', 'industry'],
        limit: 10,
        order: [['symbol', 'ASC']],
      });

      res.json({
        success: true,
        data: { suggestions },
      });
    } catch (error) {
      logger.error('获取搜索建议失败:', error);
      next(error);
    }
  }
}