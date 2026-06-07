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

export default router;
