import { Request, Response, NextFunction } from 'express';
import { TradingJournal } from '../../models/TradingJournal';
import { logger } from '../../utils/logger';

export class JournalController {
  // 获取当前用户的复盘日记列表
  async getJournals(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;

      const journals = await TradingJournal.findAll({
        where: { userId: user.id },
        order: [['date', 'DESC']],
      });

      res.json({
        success: true,
        data: journals,
      });
    } catch (error: any) {
      logger.error('获取复盘日记失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // 获取某一日期的详情
  async getJournalDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const { date } = req.params;
      const user = (req as any).user;

      const journal = await TradingJournal.findOne({
        where: { date, userId: user.id },
      });

      if (!journal) {
        return res.status(404).json({ success: false, message: '未找到该日期的复盘记录' });
      }

      res.json({ success: true, data: journal });
    } catch (error: any) {
      logger.error('获取日记详情失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const journalController = new JournalController();
