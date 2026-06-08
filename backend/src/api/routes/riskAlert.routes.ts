import { Router } from 'express';
import { riskAlertController } from '../controllers/RiskAlertController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/risk-alerts:
 *   get:
 *     tags: [告警 RiskAlert]
 *     summary: 获取当前用户的风控告警列表（最近 50 条 + risk_config 兼容老页面）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 告警列表, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/', authController.authenticate, riskAlertController.getAlerts);

/**
 * @openapi
 * /api/risk-alerts/list:
 *   get:
 *     tags: [告警 RiskAlert]
 *     summary: US-077 风控中心列表 — 支持 level / type / 日期范围 / is_read / 模糊搜索 / 分页
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: level
 *         schema: { type: string, enum: [HIGH, MEDIUM, LOW] }
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [position, market, individual] }
 *         description: 告警类别 — position (持仓相关) / market (市场系统级) / individual (单股)
 *       - in: query
 *         name: date_from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: date_to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: is_read
 *         schema: { type: boolean }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: 模糊匹配 symbol / name
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30, minimum: 1, maximum: 200 }
 *     responses:
 *       200:
 *         description: 分页告警列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items: { type: array, items: { type: object } }
 *                     total: { type: integer }
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     unread_count: { type: integer }
 *       401: { description: 未授权 }
 */
router.get('/list', authController.authenticate, riskAlertController.listAlerts);

/**
 * @openapi
 * /api/risk-alerts/read-all:
 *   put:
 *     tags: [告警 RiskAlert]
 *     summary: 将所有告警标记为已读
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 标记结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put('/read-all', authController.authenticate, riskAlertController.markAllAsRead);

/**
 * @openapi
 * /api/risk-alerts/mark-read:
 *   put:
 *     tags: [告警 RiskAlert]
 *     summary: US-077 按 ID 数组批量标记已读（单次最多 200 个）
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: integer }
 *                 maxItems: 200
 *     responses:
 *       200:
 *         description: 标记结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     updated: { type: integer }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
// Must be registered before /:id/read — Express path-to-regexp 按段精确匹配但
// `/mark-read` 与 `/:id/read` 都是 2 段，若顺序反了 "mark-read" 会被吃成 `:id` 参数
router.put('/mark-read', authController.authenticate, riskAlertController.markIdsAsRead);

/**
 * @openapi
 * /api/risk-alerts/config:
 *   put:
 *     tags: [告警 RiskAlert]
 *     summary: 更新风控阈值配置
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put('/config', authController.authenticate, riskAlertController.updateRiskConfig);

/**
 * @openapi
 * /api/risk-alerts/{id}/read:
 *   put:
 *     tags: [告警 RiskAlert]
 *     summary: 将单个告警标记为已读
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 标记结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 未找到告警 }
 */
router.put('/:id/read', authController.authenticate, riskAlertController.markAsRead);

export default router;
