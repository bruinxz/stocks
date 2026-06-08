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

/**
 * @route GET /api/settings/wechat-bind-qrcode
 * @desc 生成微信公众号参数二维码 + 落 scene_str 到用户 wechat config (US-066)
 * @access Private
 */
router.get(
  '/wechat-bind-qrcode',
  authController.authenticate,
  settingsController.getWeChatBindQrCode
);

/**
 * @route POST /api/settings/wechat-bind-confirm
 * @desc 前端轮询：检查 wechat.openid 是否已被 webhook SCAN 事件填好 (US-066)
 * @access Private
 */
router.post(
  '/wechat-bind-confirm',
  authController.authenticate,
  settingsController.confirmWeChatBind
);

/**
 * @route POST /api/settings/wechat-config
 * @desc 更新 wechat 通道开关 / 3 类订阅消息开关 (US-066)
 * @access Private
 */
router.post('/wechat-config', authController.authenticate, settingsController.updateWeChatConfig);

/**
 * @route POST /api/settings/wechat-unbind
 * @desc 解除微信绑定（清空 openid / bind_scene_str / bound_at）(US-066)
 * @access Private
 */
router.post('/wechat-unbind', authController.authenticate, settingsController.unbindWeChat);

/**
 * @route POST /api/settings/wechat-test
 * @desc 给当前用户发一条测试订阅消息（冒烟测试 access_token + template_id + openid 是否畅通）(US-066)
 * @access Private
 */
router.post('/wechat-test', authController.authenticate, settingsController.testWeChatMessage);

/**
 * @route POST /api/settings/wechat-bind-simulate
 * @desc 本地开发用：模拟微信扫码 SCAN 事件落 openid（生产由 WechatEventController XML 解析）(US-066)
 * @access Private
 */
router.post(
  '/wechat-bind-simulate',
  authController.authenticate,
  settingsController.simulateWeChatBindEvent
);

export default router;
