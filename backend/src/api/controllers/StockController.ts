import { Request, Response, NextFunction } from 'express';
import { Op, QueryTypes } from 'sequelize';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { sequelize } from '../../config/database';
import { logger } from '../../utils/logger';
import { assessAShareFreshness } from '../../services/PageFreshnessService';

export class StockController {
  /**
   * 获取股票列表
   */
  async getStockList(req: Request, res: Response, next: NextFunction) {
    try {
      const { page = '1', limit = '20', market, industry, search, listedOnly = 'true' } = req.query;

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
        where.is_listed = true;
      }

      const { count, rows } = await Stock.findAndCountAll({
        where,
        limit: limitNum,
        offset,
        order: [['symbol', 'ASC']],
      });

      const quoteRows = rows.length
        ? await sequelize.query<{
            stock_id: number;
            quote_date: string;
            close: string | number;
            change_percent: string | number | null;
            turnover_rate: string | number | null;
            pe: string | number | null;
            pb: string | number | null;
            market_cap: string | number | null;
            quote_updated_at: string;
          }>(
            `
              WITH ranked AS (
                SELECT
                  bar.stock_id,
                  bar.time::date AS quote_date,
                  bar.close,
                  bar.change_percent,
                  bar.turnover_rate,
                  bar.pe,
                  bar.pb,
                  bar.market_cap,
                  bar.updated_at AS quote_updated_at,
                  LAG(bar.close) OVER (
                    PARTITION BY bar.stock_id ORDER BY bar.time
                  ) AS previous_close,
                  ROW_NUMBER() OVER (
                    PARTITION BY bar.stock_id ORDER BY bar.time DESC
                  ) AS recency
                FROM daily_bars bar
                WHERE bar.stock_id IN (:stock_ids)
                  AND bar.is_trading_day = TRUE
              )
              SELECT
                stock_id,
                quote_date::text,
                close,
                COALESCE(
                  change_percent,
                  ROUND(((close / NULLIF(previous_close, 0)) - 1) * 100, 4)
                ) AS change_percent,
                turnover_rate,
                pe,
                pb,
                market_cap,
                quote_updated_at
              FROM ranked
              WHERE recency = 1
            `,
            {
              replacements: { stock_ids: rows.map(row => row.id) },
              type: QueryTypes.SELECT,
            }
          )
        : [];
      const quoteByStockId = new Map(quoteRows.map(quote => [Number(quote.stock_id), quote]));
      const quoteAssessmentNow = new Date();
      const stocks = rows.map(row => {
        const stock = row.toJSON() as Record<string, unknown>;
        const quote = quoteByStockId.get(row.id);
        if (!quote) {
          const freshness = assessAShareFreshness(null, quoteAssessmentNow);
          return {
            ...stock,
            quote_date: null,
            quote_reference_date: freshness.reference_trade_date,
            quote_lag_days: freshness.lag_days,
            quote_status: freshness.status,
          };
        }
        const freshness = assessAShareFreshness(quote.quote_date, quoteAssessmentNow);
        return {
          ...stock,
          price: quote.close,
          change_percent: quote.change_percent,
          turnover_rate: quote.turnover_rate ?? stock.turnover_rate,
          pe_dynamic: quote.pe ?? stock.pe_dynamic,
          pb: quote.pb ?? stock.pb,
          total_market_cap: quote.market_cap ?? stock.total_market_cap,
          quote_date: quote.quote_date,
          quote_updated_at: quote.quote_updated_at,
          quote_source: 'daily_bars',
          quote_reference_date: freshness.reference_trade_date,
          quote_lag_days: freshness.lag_days,
          quote_status: freshness.status,
        };
      });

      res.json({
        success: true,
        data: {
          stocks,
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

      const where: any = { stock_id: stock.id };

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
        attributes: ['market', [Stock.sequelize!.fn('COUNT', Stock.sequelize!.col('id')), 'count']],
        where: { is_listed: true },
        group: ['market'],
      });

      const industryStats = await Stock.findAll({
        attributes: [
          'industry',
          [Stock.sequelize!.fn('COUNT', Stock.sequelize!.col('id')), 'count'],
        ],
        where: {
          is_listed: true,
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
          [Op.or]: [{ symbol: { [Op.iLike]: `%${q}%` } }, { name: { [Op.iLike]: `%${q}%` } }],
          is_listed: true,
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
