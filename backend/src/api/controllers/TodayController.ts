import { Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { todayCommandCenterService } from '../../services/TodayCommandCenterService';
import { logger } from '../../utils/logger';

class TodayController {
  async getCommandCenter(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await todayCommandCenterService.getCommandCenter({
        user_id: req.user?.id,
        username: req.user?.username,
        trade_date: req.query.trade_date as string,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取今日作战台失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取今日作战台失败' });
    }
  }
}

export const todayController = new TodayController();
