import { Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { todayCommandCenterService } from '../../services/TodayCommandCenterService';
import { openingReadinessService } from '../../services/OpeningReadinessService';
import { logger } from '../../utils/logger';

function optionalNumber(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

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

  async getOpeningReadiness(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await openingReadinessService.getReadiness({
        user_id: req.user?.id,
        username: req.user?.username,
        trade_date: req.query.trade_date as string,
        factor_limit: optionalNumber(req.query.factor_limit),
        use_cache: req.query.use_cache !== 'false',
        cache_ttl_ms: optionalNumber(req.query.cache_ttl_ms),
        force_refresh: req.query.force_refresh === 'true',
      });
      res.json({ success: true, data, message: data.conclusion });
    } catch (error: any) {
      logger.error('获取开盘可信运行检查失败:', error);
      res.status(500).json({
        success: false,
        message: error.message || '获取开盘可信运行检查失败',
      });
    }
  }
}

export const todayController = new TodayController();
