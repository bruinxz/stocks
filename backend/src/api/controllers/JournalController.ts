import { Request, Response, NextFunction } from 'express';
import { TradingJournal } from '../../models/TradingJournal';
import { logger } from '../../utils/logger';

export class JournalController {
  // 获取当前用户的复盘日记列表
  async getJournals(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;

      const journals = await TradingJournal.findAll({
        where: { user_id: user.id },
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
        where: { date, user_id: user.id },
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

  // 创建复盘日记
  async createJournal(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      const { date, market_summary, portfolio_analysis, action_plan, tags, mood } = req.body;

      if (!date || !market_summary || !portfolio_analysis) {
        return res.status(400).json({ success: false, message: '请填写完整的必填项(日期、大盘总结、持仓分析)' });
      }

      // 检查该日期是否已经有记录
      const existing = await TradingJournal.findOne({
        where: { date, user_id: user.id }
      });

      if (existing) {
        return res.status(400).json({ success: false, message: '该日期已存在复盘日记，请使用更新功能' });
      }

      const newJournal = await TradingJournal.create({
        user_id: user.id,
        date,
        market_summary,
        portfolio_analysis,
        action_plan,
        tags: tags || [],
        mood: mood || '平静',
      });

      res.json({ success: true, data: newJournal });
    } catch (error: any) {
      logger.error('创建复盘日记失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // 更新复盘日记
  async updateJournal(req: Request, res: Response, next: NextFunction) {
    try {
      const { date } = req.params;
      const user = (req as any).user;
      const { market_summary, portfolio_analysis, action_plan, tags, mood } = req.body;

      const journal = await TradingJournal.findOne({
        where: { date, user_id: user.id },
      });

      if (!journal) {
        return res.status(404).json({ success: false, message: '未找到该日期的复盘记录' });
      }

      if (market_summary !== undefined) journal.market_summary = market_summary;
      if (portfolio_analysis !== undefined) journal.portfolio_analysis = portfolio_analysis;
      if (action_plan !== undefined) journal.action_plan = action_plan;
      if (tags !== undefined) journal.tags = tags;
      if (mood !== undefined) journal.mood = mood;

      await journal.save();

      res.json({ success: true, data: journal });
    } catch (error: any) {
      logger.error('更新复盘日记失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // 删除复盘日记
  async deleteJournal(req: Request, res: Response, next: NextFunction) {
    try {
      const { date } = req.params;
      const user = (req as any).user;

      const journal = await TradingJournal.findOne({
        where: { date, user_id: user.id },
      });

      if (!journal) {
        return res.status(404).json({ success: false, message: '未找到该日期的复盘记录' });
      }

      await journal.destroy();

      res.json({ success: true, message: '删除成功' });
    } catch (error: any) {
      logger.error('删除复盘日记失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const journalController = new JournalController();
