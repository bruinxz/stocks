import { Router } from 'express';
import { AuthController } from '../../api/controllers/AuthController';
import { liveTradingController } from '../controllers/LiveTradingController';

const router = Router();
const authController = new AuthController();

router.use(authController.authenticate);

/**
 * @openapi
 * /api/live-trading/readiness:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取实盘准备度状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 准备度状态, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/readiness', liveTradingController.getReadiness.bind(liveTradingController));

/**
 * @openapi
 * /api/live-trading/safety:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取实盘安全护栏状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 安全护栏状态, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/safety', liveTradingController.getSafety.bind(liveTradingController));

/**
 * @openapi
 * /api/live-trading/overview:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取实盘账户总览
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 账户总览, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/overview', liveTradingController.getOverview.bind(liveTradingController));

/**
 * @openapi
 * /api/live-trading/reconciliation:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取实盘对账状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 对账状态, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/reconciliation', liveTradingController.getReconciliation.bind(liveTradingController));

/**
 * @openapi
 * /api/live-trading/quotes:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取实盘实时行情
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: symbols, schema: { type: string }, description: 股票代码列表 (逗号分隔) }
 *     responses:
 *       200: { description: 实时行情, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/quotes', liveTradingController.getQuotes.bind(liveTradingController));

/**
 * @openapi
 * /api/live-trading/order-drafts:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取订单草稿列表
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 订单草稿列表, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/order-drafts', liveTradingController.listDrafts.bind(liveTradingController));

/**
 * @openapi
 * /api/live-trading/order-draft-candidates:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取订单草稿候选
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 候选列表, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/order-draft-candidates',
  liveTradingController.getDraftCandidates.bind(liveTradingController)
);

/**
 * @openapi
 * /api/live-trading/shadow-outcomes:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取影子执行结果
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 影子执行结果, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/shadow-outcomes', liveTradingController.getShadowOutcomes.bind(liveTradingController));

/**
 * @openapi
 * /api/live-trading/shadow-trend:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取影子执行趋势
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 影子执行趋势, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/shadow-trend', liveTradingController.getShadowTrend.bind(liveTradingController));

/**
 * @openapi
 * /api/live-trading/shadow-budget-attribution:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取影子执行预算归因
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 预算归因, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/shadow-budget-attribution',
  liveTradingController.getShadowBudgetAttribution.bind(liveTradingController)
);

/**
 * @openapi
 * /api/live-trading/order-drafts:
 *   post:
 *     tags: [实盘 LiveTrading]
 *     summary: 创建订单草稿
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: 创建成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/order-drafts', liveTradingController.createDraft.bind(liveTradingController));

/**
 * @openapi
 * /api/live-trading/order-drafts/from-candidate:
 *   post:
 *     tags: [实盘 LiveTrading]
 *     summary: 从候选创建订单草稿
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: 创建成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/order-drafts/from-candidate',
  liveTradingController.createDraftFromCandidate.bind(liveTradingController)
);

/**
 * @openapi
 * /api/live-trading/order-drafts/shadow-autopilot:
 *   post:
 *     tags: [实盘 LiveTrading]
 *     summary: 触发影子自动执行
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: 执行结果, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/order-drafts/shadow-autopilot',
  liveTradingController.runShadowAutopilot.bind(liveTradingController)
);

/**
 * @openapi
 * /api/live-trading/order-drafts/{id}/shadow-execute:
 *   post:
 *     tags: [实盘 LiveTrading]
 *     summary: 触发指定草稿的影子执行
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 订单草稿 ID }
 *     responses:
 *       200: { description: 执行结果, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 草稿不存在 }
 */
router.post(
  '/order-drafts/:id/shadow-execute',
  liveTradingController.runDraftShadowExecution.bind(liveTradingController)
);

/**
 * @openapi
 * /api/live-trading/order-drafts/{id}/approve:
 *   post:
 *     tags: [实盘 LiveTrading]
 *     summary: 审批通过订单草稿
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 订单草稿 ID }
 *     responses:
 *       200: { description: 审批成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 草稿不存在 }
 */
router.post(
  '/order-drafts/:id/approve',
  liveTradingController.approveDraft.bind(liveTradingController)
);

/**
 * @openapi
 * /api/live-trading/order-drafts/{id}/reject:
 *   post:
 *     tags: [实盘 LiveTrading]
 *     summary: 驳回订单草稿
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 订单草稿 ID }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200: { description: 驳回成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 草稿不存在 }
 */
router.post(
  '/order-drafts/:id/reject',
  liveTradingController.rejectDraft.bind(liveTradingController)
);

/**
 * @openapi
 * /api/live-trading/accounts/sync-readonly:
 *   post:
 *     tags: [实盘 LiveTrading]
 *     summary: 触发只读账户同步
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 同步成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/accounts/sync-readonly',
  liveTradingController.syncReadonly.bind(liveTradingController)
);

/**
 * @openapi
 * /api/live-trading/audit-logs:
 *   get:
 *     tags: [实盘 LiveTrading]
 *     summary: 获取实盘操作审计日志
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 审计日志, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/audit-logs', liveTradingController.getAuditLogs.bind(liveTradingController));

export default router;
