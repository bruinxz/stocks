import { Request, Response, NextFunction } from 'express';
import { DailyScreener } from '../../models/DailyScreener';
import { DailyBar } from '../../models/DailyBar';
import { Stock } from '../../models/Stock';
import { logger } from '../../utils/logger';

export class ScreenerController {
  async getDailyScreener(req: Request, res: Response, next: NextFunction) {
    try {
      const { date } = req.query;

      let whereClause = {};
      if (date) {
        whereClause = { date: date as string };
      } else {
        // 如果没有传日期，默认返回最新一天的所有优选记录
        const latestScreener = await DailyScreener.findOne({
          order: [['date', 'DESC']],
          attributes: ['date'],
        });

        if (latestScreener) {
          whereClause = { date: latestScreener.date };
        } else {
          return res.json({ success: true, data: [] });
        }
      }

      const screeners = await DailyScreener.findAll({
        where: whereClause,
        order: [['score', 'DESC']],
        raw: true,
      });

      // 为每个推荐股票获取最近30天的K线收盘价数据 (用于前端 Sparkline 渲染)
      const enrichedScreeners = await Promise.all(
        screeners.map(async (screener: any) => {
          try {
            const stock = await Stock.findOne({ where: { symbol: screener.symbol } });
            if (stock) {
              const bars = await DailyBar.findAll({
                where: { stock_id: stock.id },
                order: [['time', 'DESC']],
                limit: 30,
                attributes: ['time', 'close'],
                raw: true,
              });
              
              // 保证时间升序，符合图表从左到右的时间轴
              bars.reverse();
              screener.recentTrend = bars;
            } else {
              screener.recentTrend = [];
            }
          } catch (e) {
            logger.error(`Failed to fetch trend for ${screener.symbol}`, e);
            screener.recentTrend = [];
          }
          return screener;
        })
      );

      res.json({
        success: true,
        data: enrichedScreeners,
      });
    } catch (error: any) {
      logger.error('获取 AI 每日优选失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const screenerController = new ScreenerController();
