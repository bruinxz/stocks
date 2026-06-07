import { Request, Response, NextFunction } from 'express';
import { positionLimitGuard } from '../../portfolio/risk/PositionLimitGuard';
import { logger } from '../../utils/logger';

/**
 * RiskController — US-047
 *
 * Exposes the position-limit (and future risk-policy) configuration to the
 * client.  Mounted at `/api/risk/*` from `index.ts`.
 *
 * Why not folded into `RiskAlertController`?  That controller is concerned
 * with consuming/clearing already-emitted alerts (the bell view).  Position
 * limits are a separate, *pre*-trade policy surface — keeping them in their
 * own controller makes the route map (`/api/risk-alerts` vs `/api/risk`)
 * easy to scan.
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
}

export const riskController = new RiskController();
