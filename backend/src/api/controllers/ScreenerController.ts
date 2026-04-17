import { Request, Response, NextFunction } from 'express';
import { DailyScreener } from '../../models/DailyScreener';
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
      });

      res.json({
        success: true,
        data: screeners,
      });
    } catch (error: any) {
      logger.error('获取 AI 每日优选失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const screenerController = new ScreenerController();
