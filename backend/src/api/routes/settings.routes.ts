import { Router } from 'express';
import { settingsController } from '../controllers/SettingsController';
import { AuthController } from '../controllers/AuthController';

/**
 * Settings routes — mounted at `/api/settings` from index.ts.
 *
 * US-063: notification-channels CRUD + daily digest dry-run + manual send.
 *
 * Sub-resource order rule (US-015): /daily-digest/* MUST be registered BEFORE
 * /:param routes if any future :param routes get added under this prefix.
 */
const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/settings/notification-channels
 * @desc 获取当前用户的通知通道配置（飞书 / 邮件 / 微信公众号）(US-063)
 * @access Private
 */
router.get(
  '/notification-channels',
  authController.authenticate,
  settingsController.getNotificationChannels
);

/**
 * @route POST /api/settings/notification-channels
 * @desc 更新当前用户的通知通道配置 (US-063)
 * @access Private
 */
router.post(
  '/notification-channels',
  authController.authenticate,
  settingsController.updateNotificationChannels
);

/**
 * @route POST /api/settings/daily-digest/preview
 * @desc dry-run 预览当前用户当日的飞书日报 payload，不实际推送 (US-063)
 * @access Private
 */
router.post(
  '/daily-digest/preview',
  authController.authenticate,
  settingsController.previewDailyDigest
);

/**
 * @route POST /api/settings/daily-digest/send
 * @desc 立即触发推送当前用户当日的飞书日报 (US-063)
 * @access Private
 */
router.post(
  '/daily-digest/send',
  authController.authenticate,
  settingsController.sendDailyDigestNow
);

/**
 * @route POST /api/settings/earnings-forecast/preview
 * @desc dry-run 预览当日业绩预告推送 payload（持仓 + 自选两组），不实际推送 (US-064)
 * @access Private
 */
router.post(
  '/earnings-forecast/preview',
  authController.authenticate,
  settingsController.previewEarningsForecast
);

/**
 * @route POST /api/settings/earnings-forecast/scan
 * @desc 立即扫描当前用户持仓 + 自选股业绩预告并实际推送 (US-064)
 * @access Private
 */
router.post(
  '/earnings-forecast/scan',
  authController.authenticate,
  settingsController.scanEarningsForecastNow
);

/**
 * @route POST /api/settings/email-config
 * @desc 更新邮件通道开关 / 接收地址 / weekly_review 开关 (US-065)
 * @access Private
 */
router.post('/email-config', authController.authenticate, settingsController.updateEmailConfig);

/**
 * @route POST /api/settings/weekly-review/preview
 * @desc dry-run 预演上周复盘邮件 payload，不实际发送 (US-065)
 * @access Private
 */
router.post(
  '/weekly-review/preview',
  authController.authenticate,
  settingsController.previewWeeklyReview
);

/**
 * @route POST /api/settings/weekly-review/send
 * @desc 立即触发推送上周复盘邮件 (US-065)
 * @access Private
 */
router.post(
  '/weekly-review/send',
  authController.authenticate,
  settingsController.sendWeeklyReviewNow
);

export default router;
