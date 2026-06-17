import { Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { reviewPerformanceCenterService } from '../../services/ReviewPerformanceCenterService';
import { logger } from '../../utils/logger';

class ReviewController {
  async getPerformanceCenter(req: AuthenticatedRequest, res: Response) {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ success: false, message: '未登录或登录已失效' });
      }

      const data = await reviewPerformanceCenterService.getPerformanceCenter({
        user_id: req.user.id,
        username: req.user.username,
        horizon: (req.query.horizon as string) || undefined,
        lookback_days: req.query.lookback_days ? Number(req.query.lookback_days) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });

      res.json({
        success: true,
        data,
        message: data.conclusion?.headline || '收益复盘中心已生成',
      });
    } catch (error: any) {
      logger.error('获取收益复盘中心失败:', error);
      res.status((error as any)?.statusCode || 500).json({ success: false, message: error.message || '获取收益复盘中心失败' });
    }
  }
}

export const reviewController = new ReviewController();
