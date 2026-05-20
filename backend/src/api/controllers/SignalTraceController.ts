import { Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { recommendationTradeOutcomeService } from '../../services/RecommendationTradeOutcomeService';
import { logger } from '../../utils/logger';

class SignalTraceController {
  async getTrace(req: AuthenticatedRequest, res: Response) {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ success: false, message: '未登录或登录已失效' });
      }

      const data = await recommendationTradeOutcomeService.getTrace(req.params.id, {
        ...req.query,
        user_id: req.user.id,
        username: req.user.username,
      });

      if (!data) {
        return res.status(404).json({ success: false, message: '未找到推荐链路详情' });
      }

      res.json({
        success: true,
        data,
        message: data.conclusion,
      });
    } catch (error: any) {
      logger.error('获取信号链路详情失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取信号链路详情失败' });
    }
  }
}

export const signalTraceController = new SignalTraceController();
