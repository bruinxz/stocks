import { Request, Response, NextFunction } from 'express';
import { dailyTradingDigestService } from '../../services/DailyTradingDigestService';
import { logger } from '../../utils/logger';

/**
 * SettingsController — US-063 通知通道配置
 *
 * Mounted at `/api/settings/*`. 与 `RiskController`（/api/risk）平行：风控配置
 * 是 pre-trade policy 关于*交易决策*；通知通道是 *消息触达* 维度，分开命名空间。
 *
 * 共用 `User.risk_config` JSONB 列下的 `notification_channels` namespace
 * （与 position_limits / trailing_stop 等并列），免去新表，遵循 US-047 模式。
 *
 * Endpoints:
 *   GET /api/settings/notification-channels — 取当前用户的 normalized 配置
 *   POST /api/settings/notification-channels — merge + 落盘（normalize 静默丢非法字段）
 */
export class SettingsController {
  /**
   * GET /api/settings/notification-channels
   * Return the user's effective notification-channel config (defaults if never customized).
   */
  async getNotificationChannels(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await dailyTradingDigestService.getNotificationConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取通知通道配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/notification-channels
   * Merge the supplied patch into the user's notification-channels config.
   * Input is normalized — invalid fields silently revert to defaults
   * (US-047..US-055 convention).
   */
  async updateNotificationChannels(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await dailyTradingDigestService.updateNotificationConfig(
        user_id,
        req.body || {}
      );
      res.json({ success: true, data: saved, message: '通知通道配置已保存' });
    } catch (error: any) {
      logger.error('更新通知通道配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/daily-digest/preview
   * dry_run 预演当前用户当日的日报 payload —— 不实际推 webhook，只返回 payload。
   * 让用户在 SettingsWorkspace 点 "预览今日日报" 即时验证 webhook URL + 配置正确。
   */
  async previewDailyDigest(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const result = await dailyTradingDigestService.sendDigests({
        user_id,
        dry_run: true,
        trade_date: (req.body || {}).trade_date,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('预览当日日报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/daily-digest/send
   * 立即给当前用户发一次日报（非 dry_run），用于手动触发或冒烟测试。
   */
  async sendDailyDigestNow(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const result = await dailyTradingDigestService.sendDigests({
        user_id,
        dry_run: false,
        trade_date: (req.body || {}).trade_date,
      });
      res.json({ success: true, data: result, message: '当日日报已触发推送' });
    } catch (error: any) {
      logger.error('手动触发日报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const settingsController = new SettingsController();
