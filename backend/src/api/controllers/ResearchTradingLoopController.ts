import { Request, Response } from 'express';
import { researchTradingLoopService } from '../../services/ResearchTradingLoopService';
import { logger } from '../../utils/logger';

export class ResearchTradingLoopController {
  getDashboard = async (req: Request, res: Response) => {
    try {
      const user_id = Number((req as any).user?.id);
      const data = await researchTradingLoopService.getDashboard(user_id);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error(`[ResearchTradingLoopController.getDashboard] ${error?.message || error}`);
      res.status(500).json({ success: false, message: '获取研究交易闭环失败' });
    }
  };

  runNow = async (req: Request, res: Response) => {
    try {
      const user_id = Number((req as any).user?.id);
      const data = await researchTradingLoopService.run({ user_id });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error(`[ResearchTradingLoopController.runNow] ${error?.message || error}`);
      res.status(500).json({ success: false, message: '运行研究交易闭环失败' });
    }
  };
}

export const researchTradingLoopController = new ResearchTradingLoopController();
