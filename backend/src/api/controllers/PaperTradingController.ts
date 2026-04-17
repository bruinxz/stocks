import { Request, Response, NextFunction } from 'express';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { logger } from '../../utils/logger';

export class PaperTradingController {
  // 获取当前用户的模拟盘及持仓
  async getPortfolio(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;

      let portfolio = await PaperTradingPortfolio.findOne({
        where: { userId: user.id },
      });

      // 如果用户没有模拟盘，自动创建一个默认的 100W 模拟盘
      if (!portfolio) {
        const username = user.nickname || user.username || 'User';
        portfolio = await PaperTradingPortfolio.create({
          userId: user.id,
          name: `${username}的模拟盘`,
          initialCapital: 1000000,
          currentCash: 1000000,
          totalValue: 1000000,
          isActive: true,
        });
      }

      const positions = await PaperTradingPosition.findAll({
        where: { portfolioId: portfolio.id },
      });

      res.json({
        success: true,
        data: {
          portfolio,
          positions,
        },
      });
    } catch (error: any) {
      logger.error('获取模拟盘数据失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const paperTradingController = new PaperTradingController();
