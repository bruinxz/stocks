import { Request, Response, NextFunction } from 'express';
import { positionLimitGuard } from '../../portfolio/risk/PositionLimitGuard';
import { trailingStopGuard } from '../../portfolio/risk/TrailingStopGuard';
import { drawdownCircuitBreaker } from '../../portfolio/risk/DrawdownCircuitBreaker';
import { logger } from '../../utils/logger';

/**
 * RiskController — US-047 (position limits) + US-048 (trailing stop)
 *   + US-049 (drawdown circuit breaker)
 *
 * Exposes the pre-trade risk-policy configuration to the client.  Mounted at
 * `/api/risk/*` from `index.ts`.
 *
 * Why not folded into `RiskAlertController`?  That controller is concerned
 * with consuming/clearing already-emitted alerts (the bell view).  Position
 * limits + trailing stop + drawdown breaker are separate, *pre*-trade policy
 * surfaces — keeping them in their own controller makes the route map
 * (`/api/risk-alerts` vs `/api/risk`) easy to scan.
 */
export class RiskController {
  /**
   * GET /api/risk/position-limits
   * Returns the user's effective position-limit config (defaults if the
   * user has never customized it).
   */
  async getPositionLimits(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await positionLimitGuard.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取仓位限制配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/position-limits
   * Persist user's new position-limit thresholds.  Input is normalized
   * (`normalizePositionLimitsConfig`) so invalid fields silently revert to
   * defaults rather than poisoning the persistent state.
   */
  async updatePositionLimits(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await positionLimitGuard.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '仓位限制已保存' });
    } catch (error: any) {
      logger.error('更新仓位限制配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/trailing-stop  (US-048)
   * Return the user's effective trailing-stop config (defaults: enabled=true,
   * pct=0.10 when not customized).
   */
  async getTrailingStop(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await trailingStopGuard.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取追踪止损配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/trailing-stop  (US-048)
   * Persist user's trailing-stop config — input normalized
   * (`normalizeTrailingStopConfig`) so invalid `pct`/`enabled` silently
   * revert to defaults instead of corrupting `User.risk_config`.
   */
  async updateTrailingStop(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await trailingStopGuard.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '追踪止损配置已保存' });
    } catch (error: any) {
      logger.error('更新追踪止损配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/drawdown-breaker  (US-049)
   * Return the user's effective drawdown-circuit-breaker config (defaults:
   * enabled=true, level1=0.10 / level2=0.15 / level3=0.20, pause_ms=24h
   * when not customized).
   */
  async getDrawdownBreaker(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await drawdownCircuitBreaker.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取组合回撤熔断配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/drawdown-breaker  (US-049)
   * Persist user's drawdown-breaker config — input normalized
   * (`normalizeDrawdownBreakerConfig`) so invalid pct/pause_ms silently
   * revert to defaults instead of corrupting `User.risk_config`.
   */
  async updateDrawdownBreaker(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await drawdownCircuitBreaker.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '组合回撤熔断配置已保存' });
    } catch (error: any) {
      logger.error('更新组合回撤熔断配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/risk/drawdown-breaker/clear-pause  (US-049)
   * Manually clear an active LEVEL_1 pause (admin override / risk reset).
   */
  async clearDrawdownBreakerPause(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      await drawdownCircuitBreaker.clearPause(user_id);
      res.json({ success: true, message: '已解除组合回撤熔断暂停状态' });
    } catch (error: any) {
      logger.error('清除组合回撤熔断暂停失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const riskController = new RiskController();
