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
 *     summary: 获取当前用户的风控告警列表
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 告警列表, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/', authController.authenticate, riskAlertController.getAlerts);

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

export default router;
