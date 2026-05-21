import { Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { strategyResearchCenterService } from '../../services/StrategyResearchCenterService';
import { quantOpeningPreflightService } from '../../services/QuantOpeningPreflightService';
import { logger } from '../../utils/logger';

class StrategyResearchController {
  async getCenter(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await strategyResearchCenterService.getCenter({
        user_id: req.user?.id,
        username: req.user?.username,
        lookback_days: req.query.lookback_days ? Number(req.query.lookback_days) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({
        success: true,
        data,
        message: data.conclusion?.headline || '策略研究中心已生成',
      });
    } catch (error: any) {
      logger.error('获取策略研究中心失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取策略研究中心失败' });
    }
  }

  async getOpeningPreflight(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await quantOpeningPreflightService.check({
        user_id: req.user?.id,
        factor_limit: req.query.factor_limit ? Number(req.query.factor_limit) : undefined,
      });
      res.json({
        success: true,
        data,
        message: data.summary.conclusion,
      });
    } catch (error: any) {
      logger.error('获取量化开盘自检失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取量化开盘自检失败' });
    }
  }

  async runOpeningDryRun(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await quantOpeningPreflightService.runDryRun({
        user_id: req.user?.id,
        username: req.user?.username,
        trade_date: req.body?.trade_date || req.body?.tradeDate,
        limit: Number(req.body?.limit || 80),
        min_score: req.body?.min_score !== undefined ? Number(req.body.min_score) : undefined,
        factor_provider: req.body?.factor_provider || req.body?.factorProvider || 'auto',
      });
      res.json({
        success: true,
        data,
        message: data.summary.conclusion,
      });
    } catch (error: any) {
      logger.error('执行量化开盘安全演练失败:', error);
      res.status(500).json({ success: false, message: error.message || '执行量化开盘安全演练失败' });
    }
  }
}

export const strategyResearchController = new StrategyResearchController();
