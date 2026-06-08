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
 * @openapi
 * /api/settings/notification-channels:
 *   get:
 *     tags: [设置 Settings]
 *     summary: 获取当前用户的通知通道配置 (US-063)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 通知通道配置, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/notification-channels',
  authController.authenticate,
  settingsController.getNotificationChannels
);

/**
 * @openapi
 * /api/settings/notification-channels:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 更新当前用户的通知通道配置 (US-063)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: 通知通道配置 (飞书 / 邮件 / 微信)
 *     responses:
 *       200: { description: 更新成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/notification-channels',
  authController.authenticate,
  settingsController.updateNotificationChannels
);

/**
 * @openapi
 * /api/settings/notification-config:
 *   get:
 *     tags: [设置 Settings]
 *     summary: 获取推送渠道矩阵视图 (US-080)
 *     description: |
 *       返回 channels 顶部摘要（启用 / 绑定 / 配置）+ matrix 4×4 (event × channel)。
 *       与 GET /notification-channels 共用底层 JSONB 存储，只是视图形态不同。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 矩阵视图, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       401: { description: 未授权 }
 */
router.get(
  '/notification-config',
  authController.authenticate,
  settingsController.getNotificationConfig
);

/**
 * @openapi
 * /api/settings/notification-config:
 *   put:
 *     tags: [设置 Settings]
 *     summary: 批量保存推送渠道矩阵 + 渠道字段 (US-080)
 *     description: |
 *       Body 同时支持两种 patch 形态：
 *         - matrix_updates: { event: { channel: bool } } —— 矩阵格反向 patch；
 *         - channels_updates: { feishu?: { enabled?, webhook_url? }, email?: { ... }, wechat?: { ... }, sms?: { ... } }
 *       两份 patch 合并后走 dailyTradingDigestService.updateNotificationConfig。
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               matrix_updates: { type: object }
 *               channels_updates: { type: object }
 *     responses:
 *       200: { description: 保存成功 + 返回最新矩阵视图, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put(
  '/notification-config',
  authController.authenticate,
  settingsController.updateNotificationConfig
);

/**
 * @openapi
 * /api/settings/daily-digest/preview:
 *   post:
 *     tags: [设置 Settings]
 *     summary: dry-run 预览当日飞书日报 payload (US-063)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 预览成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/daily-digest/preview',
  authController.authenticate,
  settingsController.previewDailyDigest
);

/**
 * @openapi
 * /api/settings/daily-digest/send:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 立即触发推送当日飞书日报 (US-063)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 推送成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/daily-digest/send',
  authController.authenticate,
  settingsController.sendDailyDigestNow
);

/**
 * @openapi
 * /api/settings/earnings-forecast/preview:
 *   post:
 *     tags: [设置 Settings]
 *     summary: dry-run 预览当日业绩预告推送 payload (US-064)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 预览成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/earnings-forecast/preview',
  authController.authenticate,
  settingsController.previewEarningsForecast
);

/**
 * @openapi
 * /api/settings/earnings-forecast/scan:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 扫描持仓与自选股业绩预告并推送 (US-064)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 推送成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/earnings-forecast/scan',
  authController.authenticate,
  settingsController.scanEarningsForecastNow
);

/**
 * @openapi
 * /api/settings/email-config:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 更新邮件通道开关与接收地址 (US-065)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled: { type: boolean }
 *               email: { type: string, format: email }
 *               weekly_review: { type: boolean }
 *     responses:
 *       200: { description: 更新成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/email-config', authController.authenticate, settingsController.updateEmailConfig);

/**
 * @openapi
 * /api/settings/weekly-review/preview:
 *   post:
 *     tags: [设置 Settings]
 *     summary: dry-run 预演上周复盘邮件 payload (US-065)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 预览成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/weekly-review/preview',
  authController.authenticate,
  settingsController.previewWeeklyReview
);

/**
 * @openapi
 * /api/settings/weekly-review/send:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 立即触发推送上周复盘邮件 (US-065)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 发送成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/weekly-review/send',
  authController.authenticate,
  settingsController.sendWeeklyReviewNow
);

/**
 * @openapi
 * /api/settings/wechat-bind-qrcode:
 *   get:
 *     tags: [设置 Settings]
 *     summary: 生成微信公众号绑定参数二维码 (US-066)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 二维码 URL 与 scene_str, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/wechat-bind-qrcode',
  authController.authenticate,
  settingsController.getWeChatBindQrCode
);

/**
 * @openapi
 * /api/settings/wechat-bind-confirm:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 轮询确认微信绑定状态 (US-066)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 绑定状态, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/wechat-bind-confirm',
  authController.authenticate,
  settingsController.confirmWeChatBind
);

/**
 * @openapi
 * /api/settings/wechat-config:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 更新微信通道开关与订阅消息开关 (US-066)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: 更新成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/wechat-config', authController.authenticate, settingsController.updateWeChatConfig);

/**
 * @openapi
 * /api/settings/wechat-unbind:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 解除微信绑定 (US-066)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 解绑成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/wechat-unbind', authController.authenticate, settingsController.unbindWeChat);

/**
 * @openapi
 * /api/settings/wechat-test:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 发送测试微信订阅消息 (US-066)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 发送成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/wechat-test', authController.authenticate, settingsController.testWeChatMessage);

/**
 * @openapi
 * /api/settings/wechat-bind-simulate:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 本地开发用 - 模拟微信扫码 SCAN 事件 (US-066)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 模拟成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/wechat-bind-simulate',
  authController.authenticate,
  settingsController.simulateWeChatBindEvent
);

/**
 * @openapi
 * /api/settings/sms-config:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 更新 SMS 通道开关与手机号 (US-067)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled: { type: boolean }
 *               phone: { type: string }
 *               risk_alert: { type: boolean }
 *     responses:
 *       200: { description: 更新成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/sms-config', authController.authenticate, settingsController.updateSmsConfig);

/**
 * @openapi
 * /api/settings/sms-test:
 *   post:
 *     tags: [设置 Settings]
 *     summary: 发送测试短信 (US-067)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 发送成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/sms-test', authController.authenticate, settingsController.testSmsMessage);

export default router;
