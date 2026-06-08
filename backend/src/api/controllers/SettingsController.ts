import { Request, Response, NextFunction } from 'express';
import { dailyTradingDigestService } from '../../services/DailyTradingDigestService';
import { earningsForecastWatcher } from '../../services/EarningsForecastWatcher';
import { weeklyReviewReportService } from '../../services/WeeklyReviewReportService';
import { logger } from '../../utils/logger';

/**
 * SettingsController — US-063 / US-064 / US-065 通知通道配置
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
 *   POST /api/settings/daily-digest/preview — dry-run preview 当日日报
 *   POST /api/settings/daily-digest/send — 立即推送当日日报
 *   POST /api/settings/earnings-forecast/scan — 立即扫描持仓 + 自选股推送 (US-064)
 *   POST /api/settings/earnings-forecast/preview — dry-run preview 业绩预告推送 (US-064)
 *   POST /api/settings/email-config — 更新邮件通道开关 / 接收地址 / weekly_review 开关 (US-065)
 *   POST /api/settings/weekly-review/preview — dry-run preview 上周复盘邮件 payload (US-065)
 *   POST /api/settings/weekly-review/send — 立即发上周复盘邮件 (US-065)
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

  /**
   * POST /api/settings/earnings-forecast/preview (US-064)
   * dry_run 预演当前用户当日的业绩预告推送 payload：
   *   - 扫持仓股 (held path) — 返回每条 forecast 的 single-card payload；
   *   - 扫自选股 (watchlist path) — 返回合并的 digest payload；
   * 不实际推送 webhook + 不写 dedup buffer，让用户多次预演。
   */
  async previewEarningsForecast(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const heldResult = await earningsForecastWatcher.scanHeldStocks({
        user_id,
        dry_run: true,
        trade_date: body.trade_date,
        recent_days: body.recent_days,
        frontend_base_url: body.frontend_base_url,
      });
      const watchlistResult = await earningsForecastWatcher.scanWatchlistStocks({
        user_id,
        dry_run: true,
        trade_date: body.trade_date,
        recent_days: body.recent_days,
        frontend_base_url: body.frontend_base_url,
      });
      res.json({
        success: true,
        data: {
          held: heldResult,
          watchlist: watchlistResult,
        },
      });
    } catch (error: any) {
      logger.error('预览业绩预告推送失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/earnings-forecast/scan (US-064)
   * 立即扫描当前用户的持仓 + 自选股业绩预告并实际推送（同 scheduler cron 流程）。
   * dedup buffer 会被更新避免下次重发；适用于手动触发或冒烟测试。
   */
  async scanEarningsForecastNow(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const heldResult = await earningsForecastWatcher.scanHeldStocks({
        user_id,
        dry_run: false,
        trade_date: body.trade_date,
        recent_days: body.recent_days,
        frontend_base_url: body.frontend_base_url,
      });
      const watchlistResult = await earningsForecastWatcher.scanWatchlistStocks({
        user_id,
        dry_run: false,
        trade_date: body.trade_date,
        recent_days: body.recent_days,
        frontend_base_url: body.frontend_base_url,
      });
      res.json({
        success: true,
        data: { held: heldResult, watchlist: watchlistResult },
        message: '业绩预告扫描完成',
      });
    } catch (error: any) {
      logger.error('手动触发业绩预告扫描失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/email-config (US-065)
   * 更新当前用户的邮件通道开关 / 接收地址 / weekly_review 开关。
   *
   * Body: { enabled?: boolean, address?: string, weekly_review?: boolean }
   *
   * AC 字面要求："新增 endpoint：POST /api/settings/email-config"。
   * 与 POST /api/settings/notification-channels 互补 —— 后者支持任意 channel 的
   * 批量 patch；本 endpoint 是 email channel 的专用语义化 endpoint，让前端 UI
   * 表单代码更紧凑。
   */
  async updateEmailConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const patch: any = {};
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.address !== undefined) patch.address = body.address;
      if (body.weekly_review !== undefined) patch.weekly_review = body.weekly_review;
      const saved = await weeklyReviewReportService.updateEmailConfig(user_id, patch);
      res.json({ success: true, data: saved, message: '邮件通道配置已保存' });
    } catch (error: any) {
      logger.error('更新邮件通道配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/weekly-review/preview (US-065)
   * dry_run 预演当前用户上周复盘邮件 payload（不实际发邮件）。
   * 让用户在 SettingsWorkspace 点 "预览上周周报" 即时验证 SMTP + 配置正确。
   */
  async previewWeeklyReview(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const result = await weeklyReviewReportService.sendWeeklyReviewReports({
        user_id,
        dry_run: true,
        reference_date: body.reference_date,
        upcoming_lookahead_days: body.upcoming_lookahead_days,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('预览周报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/weekly-review/send (US-065)
   * 立即给当前用户发一次上周复盘邮件（非 dry_run），用于手动触发或冒烟测试。
   */
  async sendWeeklyReviewNow(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const result = await weeklyReviewReportService.sendWeeklyReviewReports({
        user_id,
        dry_run: false,
        reference_date: body.reference_date,
        upcoming_lookahead_days: body.upcoming_lookahead_days,
      });
      res.json({ success: true, data: result, message: '上周复盘邮件已触发推送' });
    } catch (error: any) {
      logger.error('手动触发周报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const settingsController = new SettingsController();
