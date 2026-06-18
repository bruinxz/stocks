import { Router } from 'express';
import { AuthController } from '../../api/controllers/AuthController';
import { requireRole } from '../../middlewares/auth';
import { liveTradingController } from '../controllers/LiveTradingController';
import { LIVE_TRADING_RATE_LIMITS } from '../middlewares/liveTradingRateLimit';

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
// Batch V (2026-06-17, lt-6 fix): 此处旧无 rate-limit 注册被删除. 真生效的注册
// 在下面 line 290+, 带 LIVE_TRADING_RATE_LIMITS. 之前 Express 取最早注册, 让所有
// rate limit 静默失效, 配合 approveDraft 双下单 bug 是真金白银帮凶.
// (旧 router.post('/order-drafts', ...) 不带 rate limit 被移除)

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
// Batch V: 同上, 旧无 rate limit 注册被删, 真生效在 line 290+.

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
// Batch V: 同上.

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
// Batch V: 同上.

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
// Batch V: 同上.

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
 */ router.get(
  '/shadow-budget-attribution',
  liveTradingController.getShadowBudgetAttribution.bind(liveTradingController)
);

// 写接口加 rate limit（灰度阶段；阈值见 liveTradingRateLimit.ts）
router.post(
  '/order-drafts',
  LIVE_TRADING_RATE_LIMITS.createDraft1m,
  liveTradingController.createDraft.bind(liveTradingController)
);
router.post(
  '/order-drafts/from-candidate',
  LIVE_TRADING_RATE_LIMITS.createDraft1m,
  liveTradingController.createDraftFromCandidate.bind(liveTradingController)
);
router.post(
  '/order-drafts/shadow-autopilot',
  LIVE_TRADING_RATE_LIMITS.runShadowAutopilot1m,
  liveTradingController.runShadowAutopilot.bind(liveTradingController)
);
router.post(
  '/order-drafts/:id/shadow-execute',
  LIVE_TRADING_RATE_LIMITS.createDraft1m,
  liveTradingController.runDraftShadowExecution.bind(liveTradingController)
);
router.post(
  '/order-drafts/:id/approve',
  // 双层限流：1 分钟尖峰 + 1 小时累计；都过才放行真实下单
  LIVE_TRADING_RATE_LIMITS.approveDraft1m,
  LIVE_TRADING_RATE_LIMITS.approveDraft1h,
  liveTradingController.approveDraft.bind(liveTradingController)
);
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
// Batch V (2026-06-17, lt-6 fix): 同上, 旧 sync-readonly 无 rate limit 注册已删,
// 真生效注册见下面 line 350+ 带 syncReadonly1m.

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
 */ router.post(
  '/accounts/sync-readonly',
  LIVE_TRADING_RATE_LIMITS.syncReadonly1m,
  liveTradingController.syncReadonly.bind(liveTradingController)
);
router.get('/audit-logs', liveTradingController.getAuditLogs.bind(liveTradingController));

// 服务端 kill switch：查询 / 手动触发 / 人工解除
// review P1：触发/解除是进程全局影响（一个用户能熔断/恢复所有人的下单），
// 必须收敛到 admin；普通用户仍可 GET 查询当前状态用于风控展示
router.get('/kill-switch', liveTradingController.getKillSwitch.bind(liveTradingController));
router.post(
  '/kill-switch/trigger',
  requireRole('admin'),
  LIVE_TRADING_RATE_LIMITS.killSwitchTrigger1m,
  liveTradingController.triggerKillSwitch.bind(liveTradingController)
);
router.post(
  '/kill-switch/resolve',
  requireRole('admin'),
  LIVE_TRADING_RATE_LIMITS.killSwitchResolve1m,
  liveTradingController.resolveKillSwitch.bind(liveTradingController)
);

// 用户撤单：服务端不直连券商，写一条 cancel_order command 等 bridge 拉取
router.post(
  '/orders/:id/cancel',
  LIVE_TRADING_RATE_LIMITS.cancelOrder1m,
  liveTradingController.cancelOrder.bind(liveTradingController)
);
// 实盘委托列表（前端撤单 UI 使用）
router.get('/orders', liveTradingController.listLiveOrders.bind(liveTradingController));

export default router;
