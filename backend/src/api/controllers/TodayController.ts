import { Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { todayCommandCenterService } from '../../services/TodayCommandCenterService';
import { openingReadinessService } from '../../services/OpeningReadinessService';
import { todaySignalsService } from '../../services/TodaySignalsService';
import { logger } from '../../utils/logger';

function optionalNumber(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalInt(value: any): number | undefined {
  const n = optionalNumber(value);
  if (n === undefined) return undefined;
  return Number.isInteger(n) ? n : undefined;
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

  /**
   * GET /api/today/signals
   *
   * US-018 今日作战工作区聚合接口：3 个策略当日信号 + 账户摘要 +
   * 风险告警 + 关键事件。详见 TodaySignalsService。
   */
  async getTodaySignals(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await todaySignalsService.getTodaySignals({
        user_id: req.user?.id,
        username: req.user?.username,
        trade_date: req.query.trade_date as string | undefined,
        dragon_head_limit: optionalInt(req.query.dragon_head_limit),
        earnings_limit: optionalInt(req.query.earnings_limit),
        alerts_limit: optionalInt(req.query.alerts_limit),
      });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取今日作战信号失败:', error);
      res.status(500).json({
        success: false,
        message: error.message || '获取今日作战信号失败',
      });
    }
  }

  /**
   * POST /api/today/apply-signals
   *
   * 把三策略当日 BUY 信号一键下到模拟盘。详见 TodaySignalsService.applySignals。
   */
  async applyTodaySignals(req: AuthenticatedRequest, res: Response) {
    try {
      if (!req.user?.id) {
        res.status(401).json({ success: false, message: '用户未登录' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const data = await todaySignalsService.applySignals({
        user_id: req.user.id,
        username: req.user.username,
        trade_date: typeof body.trade_date === 'string' ? (body.trade_date as string) : undefined,
        per_order_amount: optionalInt(body.per_order_amount),
        max_orders: optionalInt(body.max_orders),
      });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('一键应用今日信号失败:', error);
      res.status(500).json({
        success: false,
        message: error.message || '一键应用今日信号失败',
      });
    }
  }
}

export const todayController = new TodayController();
