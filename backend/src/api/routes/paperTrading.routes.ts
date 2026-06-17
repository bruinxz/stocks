import { Router } from 'express';
import { paperTradingController } from '../controllers/PaperTradingController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/paper-trading:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取当前用户的模拟盘数据及持仓明细
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 组合与持仓数据, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/', authController.authenticate, paperTradingController.getPortfolio);

/**
 * @openapi
 * /api/paper-trading/portfolios:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 列出当前用户名下所有 active portfolio (供前端选盘下拉)
 *     description: 多账户多盘场景下解决"每次刷新切到不同盘"的串盘问题. 前端拿到
 *                  portfolio list 后展示选盘下拉, 选完用 ?portfolio_id=X 拉具体盘.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: portfolio 列表 }
 */
router.get('/portfolios', authController.authenticate, paperTradingController.listPortfolios);

/**
 * @openapi
 * /api/paper-trading/trade:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 在模拟盘中进行买入或卖出交易
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               symbol: { type: string }
 *               action: { type: string, enum: [buy, sell] }
 *               quantity: { type: number }
 *               price: { type: number }
 *     responses:
 *       200: { description: 成交结果, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/trade', authController.authenticate, paperTradingController.placeTrade);

/**
 * @openapi
 * /api/paper-trading/auto-from-signals:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 从已归档 AI/量化推荐信号自动生成模拟盘交易
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 自动建仓结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/auto-from-signals',
  authController.authenticate,
  paperTradingController.autoTradeFromSignals
);

/**
 * @openapi
 * /api/paper-trading/auto-sync-recommendations:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 刷新候选推荐、归档为投研信号并自动进入模拟盘
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 同步结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/auto-sync-recommendations',
  authController.authenticate,
  paperTradingController.autoSyncFromRecommendations
);

/**
 * @openapi
 * /api/paper-trading/refresh-snapshot:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 刷新模拟盘最新价格与资金快照
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 最新快照 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/refresh-snapshot',
  authController.authenticate,
  paperTradingController.refreshSnapshot
);

/**
 * @openapi
 * /api/paper-trading/risk-check:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 按止损/止盈/卖出信号/最长持有期检查并自动退出
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 风控检查结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/risk-check', authController.authenticate, paperTradingController.runRiskCheck);

/**
 * @openapi
 * /api/paper-trading/autonomous-dashboard:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取自主荐股模拟盘收益驾驶舱
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 驾驶舱数据 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/autonomous-dashboard',
  authController.authenticate,
  paperTradingController.getAutonomousDashboard
);

/**
 * @openapi
 * /api/paper-trading/autonomous-auto-sync:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 自主荐股闭环 - 推荐、归档信号并进入 20W 自主模拟盘
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 闭环结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/autonomous-auto-sync',
  authController.authenticate,
  paperTradingController.runAutonomousAutoSync
);

/**
 * @openapi
 * /api/paper-trading/autonomous-risk-check:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 自主荐股闭环 - 按卖出信号/止损/止盈/持有期结算 20W 自主模拟盘
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 结算结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/autonomous-risk-check',
  authController.authenticate,
  paperTradingController.runAutonomousRiskCheck
);

/**
 * @openapi
 * /api/paper-trading/recommendation-tracking:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取每日推荐股票追踪与模拟收益
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 推荐追踪数据 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/recommendation-tracking',
  authController.authenticate,
  paperTradingController.getRecommendationTracking
);

/**
 * @openapi
 * /api/paper-trading/autonomous-optimization:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取自主荐股闭环优化台（策略晋级/收益路径/降权放大片段）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 优化台数据 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/autonomous-optimization',
  authController.authenticate,
  paperTradingController.getAutonomousOptimization
);

/**
 * @openapi
 * /api/paper-trading/attribution:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取模拟盘信号收益归因与策略反哺
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 归因数据 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/attribution', authController.authenticate, paperTradingController.getAttribution);

/**
 * @openapi
 * /api/paper-trading/risk-profile:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取模拟盘组合风险画像（现金水位/总仓位/回撤/集中度/相关性/VaR）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 风险画像数据 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/risk-profile', authController.authenticate, paperTradingController.getRiskProfile);

/**
 * @openapi
 * /api/paper-trading/order-intents:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取模拟交易订单意图与拒单归因
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 订单意图列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/order-intents', authController.authenticate, paperTradingController.getOrderIntents);

/**
 * @openapi
 * /api/paper-trading/order-intents/family-hindsight:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取全部策略账户拒单后验汇总（错杀/有效拦截/账户级规则建议）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 后验汇总 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/order-intents/family-hindsight',
  authController.authenticate,
  paperTradingController.getOrderIntentFamilyHindsight
);

/**
 * @openapi
 * /api/paper-trading/order-intents/{id}/trace:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取单条订单意图链路（信号/拒单原因/后验收益/规则建议/参数影响）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 链路详情 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 未找到 }
 */
router.get(
  '/order-intents/:id/trace',
  authController.authenticate,
  paperTradingController.getOrderIntentTrace
);

/**
 * @openapi
 * /api/paper-trading/order-intents/hindsight/refresh:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 主动刷新订单意图后验快照
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 刷新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/order-intents/hindsight/refresh',
  authController.authenticate,
  paperTradingController.refreshOrderIntentHindsight
);

/**
 * @openapi
 * /api/paper-trading/recommendation-outcomes:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取推荐信号到模拟交易收益的闭环看板
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 闭环看板 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/recommendation-outcomes',
  authController.authenticate,
  paperTradingController.getRecommendationOutcomes
);

/**
 * @openapi
 * /api/paper-trading/recommendation-outcomes/{id}/trace:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取单笔推荐链路详情（信号/复核/风控/模拟交易/收益）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 链路详情 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 未找到 }
 */
router.get(
  '/recommendation-outcomes/:id/trace',
  authController.authenticate,
  paperTradingController.getRecommendationOutcomeTrace
);

/**
 * @openapi
 * /api/paper-trading/recommendation-outcomes/refresh:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 刷新推荐信号到模拟交易收益的闭环结果
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 刷新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/recommendation-outcomes/refresh',
  authController.authenticate,
  paperTradingController.refreshRecommendationOutcomes
);

/**
 * @openapi
 * /api/paper-trading/recommendation-outcomes/report:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 将推荐交易收益闭环报告写入飞书多维表格
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 写入结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/recommendation-outcomes/report',
  authController.authenticate,
  paperTradingController.reportRecommendationOutcomes
);

/**
 * @openapi
 * /api/paper-trading/activation-summary:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: L1-L8 决策链激活汇总 (Sprint 27)
 *     description: |
 *       聚合最近 N 天的 paper_trading_order_intents.metadata.l8_activation,
 *       返回 8 层每层 reached/blocked/contributed 计数 + Top block reasons +
 *       最近 10 笔 trade 的逐层激活快照. 用于 ActivationDashboard 前端面板.
 *     parameters:
 *       - in: query
 *         name: portfolio_id
 *         schema: { type: integer }
 *         description: 可选; 缺省 = 当前 user 全部 portfolio 聚合
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 7, minimum: 1, maximum: 90 }
 *         description: 回看天数 (default 7, max 90)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 激活汇总 }
 *       401: { description: 未登录 }
 *       403: { description: 显式 portfolio_id 不属当前 user }
 */
router.get(
  '/activation-summary',
  authController.authenticate,
  paperTradingController.getActivationSummary
);

/**
 * @openapi
 * /api/paper-trading/portfolio-construction-config:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 读取 PortfolioConstruction 配置 (Sprint 29)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 配置 + 默认值 }
 *   put:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 更新 PortfolioConstruction 模式 (Sprint 29; off/shadow/hard)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 已保存 }
 */
router.get(
  '/portfolio-construction-config',
  authController.authenticate,
  paperTradingController.getPortfolioConstructionConfig
);
router.put(
  '/portfolio-construction-config',
  authController.authenticate,
  paperTradingController.updatePortfolioConstructionConfig
);

/**
 * @openapi
 * /api/paper-trading/attribution/report:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 生成模拟盘收益归因并写入飞书多维表格
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 写入结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/attribution/report',
  authController.authenticate,
  paperTradingController.reportAttribution
);

/**
 * @openapi
 * /api/paper-trading/plan:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 生成模拟盘盘前/盘后交易计划
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 交易计划 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/plan', authController.authenticate, paperTradingController.getTradingPlan);

/**
 * @openapi
 * /api/paper-trading/plan/report:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 生成模拟盘交易计划并写入飞书多维表格
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 写入结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/plan/report', authController.authenticate, paperTradingController.reportTradingPlan);

/**
 * @openapi
 * /api/paper-trading/order-intent-tuning/apply:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 预览或手动应用订单意图稳定窗口给出的调参建议
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 应用结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/order-intent-tuning/apply',
  authController.authenticate,
  paperTradingController.applyOrderIntentTuning
);

/**
 * @openapi
 * /api/paper-trading/order-intent-tuning/candidates:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取订单意图调参只读候选（稳定窗口 + 多账户拒单后验）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 候选列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/order-intent-tuning/candidates',
  authController.authenticate,
  paperTradingController.getOrderIntentTuningCandidates
);

/**
 * @openapi
 * /api/paper-trading/order-intent-tuning/canary/snapshots:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取订单意图 Canary 评审快照时间线
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 快照时间线 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/order-intent-tuning/canary/snapshots',
  authController.authenticate,
  paperTradingController.getOrderIntentTuningCanarySnapshots
);

/**
 * @openapi
 * /api/paper-trading/order-intent-tuning/canary:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取订单意图 Canary 小流量调参观察状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 观察状态 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/order-intent-tuning/canary',
  authController.authenticate,
  paperTradingController.getOrderIntentTuningCanary
);

/**
 * @openapi
 * /api/paper-trading/order-intent-tuning/canary/rollback:
 *   post:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 预览或强确认回滚订单意图 Canary 小流量调参
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 回滚结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/order-intent-tuning/canary/rollback',
  authController.authenticate,
  paperTradingController.rollbackOrderIntentTuningCanary
);

/**
 * @openapi
 * /api/paper-trading/history:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取模拟盘的交易流水
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 交易流水列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/history', authController.authenticate, paperTradingController.getTradeHistory);

/**
 * @openapi
 * /api/paper-trading/snapshots:
 *   get:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 获取模拟盘的资金曲线快照
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 资金曲线快照 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/snapshots', authController.authenticate, paperTradingController.getSnapshots);

/**
 * @openapi
 * /api/paper-trading/positions/{id}/stop-loss:
 *   put:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 设置/清除指定持仓的硬止损价 (US-017)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               stop_loss_price: { type: number, nullable: true }
 *     responses:
 *       200: { description: 设置结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 未找到持仓 }
 */
router.put(
  '/positions/:id/stop-loss',
  authController.authenticate,
  paperTradingController.setPositionStopLoss
);

/**
 * @openapi
 * /api/paper-trading/positions/{id}/take-profit:
 *   put:
 *     tags: [模拟交易 PaperTrading]
 *     summary: 设置/清除指定持仓的硬止盈价 (US-076)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               take_profit_price: { type: number, nullable: true }
 *     responses:
 *       200: { description: 设置结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 未找到持仓 }
 */
router.put(
  '/positions/:id/take-profit',
  authController.authenticate,
  paperTradingController.setPositionTakeProfit
);

export default router;
