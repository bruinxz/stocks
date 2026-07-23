import { Request, Response } from 'express';
import {
  ResearchTradingLoopNotReadyError,
  researchTradingLoopService,
} from '../../services/ResearchTradingLoopService';
import { logger } from '../../utils/logger';

export class ResearchTradingLoopController {
  getDashboard = async (req: Request, res: Response) => {
    try {
      const user_id = Number((req as any).user?.id);
      const data = await researchTradingLoopService.getDashboard(user_id);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error(`[ResearchTradingLoopController.getDashboard] ${error?.message || error}`);
      if (error instanceof ResearchTradingLoopNotReadyError) {
        res.status(503).json({
          success: false,
          code: error.code,
          message: '研究交易闭环尚未完成初始化，已暂停自动模拟交易',
          missing_tables: error.missing_tables,
        });
        return;
      }
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
      if (error instanceof ResearchTradingLoopNotReadyError) {
        res.status(503).json({
          success: false,
          code: error.code,
          message: '研究交易闭环尚未完成初始化，未执行任何模拟交易',
          missing_tables: error.missing_tables,
        });
        return;
      }
      res.status(500).json({ success: false, message: '运行研究交易闭环失败' });
    }
  };
}

export const researchTradingLoopController = new ResearchTradingLoopController();
