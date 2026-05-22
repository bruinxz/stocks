import { Router } from 'express';
import { paperTradingController } from '../controllers/PaperTradingController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/paper-trading
 * @desc 获取当前用户的模拟盘数据及持仓明细
 * @access Private
 */
router.get('/', authController.authenticate, paperTradingController.getPortfolio);

/**
 * @route POST /api/paper-trading/trade
 * @desc 在模拟盘中进行买入或卖出交易
 * @access Private
 */
router.post('/trade', authController.authenticate, paperTradingController.placeTrade);

/**
 * @route POST /api/paper-trading/auto-from-signals
 * @desc 从已归档 AI/量化推荐信号自动生成模拟盘交易
 * @access Private
 */
router.post(
  '/auto-from-signals',
  authController.authenticate,
  paperTradingController.autoTradeFromSignals
);

/**
 * @route POST /api/paper-trading/auto-sync-recommendations
 * @desc 刷新候选推荐、归档为投研信号，并自动进入模拟盘
 * @access Private
 */
router.post(
  '/auto-sync-recommendations',
  authController.authenticate,
  paperTradingController.autoSyncFromRecommendations
);

/**
 * @route POST /api/paper-trading/refresh-snapshot
 * @desc 刷新模拟盘最新价格与资金快照
 * @access Private
 */
router.post(
  '/refresh-snapshot',
  authController.authenticate,
  paperTradingController.refreshSnapshot
);

/**
 * @route POST /api/paper-trading/risk-check
 * @desc 按止损/止盈/卖出信号/最长持有期检查并自动退出
 * @access Private
 */
router.post('/risk-check', authController.authenticate, paperTradingController.runRiskCheck);

/**
 * @route GET /api/paper-trading/autonomous-dashboard
 * @desc 获取自主荐股模拟盘收益驾驶舱
 * @access Private
 */
router.get(
  '/autonomous-dashboard',
  authController.authenticate,
  paperTradingController.getAutonomousDashboard
);

/**
 * @route POST /api/paper-trading/autonomous-auto-sync
 * @desc 自主荐股闭环专用：全市场推荐、归档信号并固定进入 20W 自主模拟盘
 * @access Private
 */
router.post(
  '/autonomous-auto-sync',
  authController.authenticate,
  paperTradingController.runAutonomousAutoSync
);

/**
 * @route POST /api/paper-trading/autonomous-risk-check
 * @desc 自主荐股闭环专用：按卖出信号、止损、止盈和持有期结算 20W 自主模拟盘
 * @access Private
 */
router.post(
  '/autonomous-risk-check',
  authController.authenticate,
  paperTradingController.runAutonomousRiskCheck
);

/**
 * @route GET /api/paper-trading/recommendation-tracking
 * @desc 获取每日推荐股票追踪与模拟收益
 * @access Private
 */
router.get(
  '/recommendation-tracking',
  authController.authenticate,
  paperTradingController.getRecommendationTracking
);

/**
 * @route GET /api/paper-trading/autonomous-optimization
 * @desc 获取自主荐股闭环优化台：策略晋级、收益路径、降权/放大片段
 * @access Private
 */
router.get(
  '/autonomous-optimization',
  authController.authenticate,
  paperTradingController.getAutonomousOptimization
);

/**
 * @route GET /api/paper-trading/attribution
 * @desc 获取模拟盘信号收益归因与策略反哺
 * @access Private
 */
router.get('/attribution', authController.authenticate, paperTradingController.getAttribution);

/**
 * @route GET /api/paper-trading/risk-profile
 * @desc 获取模拟盘组合风险画像：现金水位、总仓位、回撤、集中度、相关性与 VaR 代理值
 * @access Private
 */
router.get('/risk-profile', authController.authenticate, paperTradingController.getRiskProfile);

/**
 * @route GET /api/paper-trading/order-intents
 * @desc 获取模拟交易订单意图与拒单归因：记录买入/卖出为什么成交、计划、跳过或继续持有
 * @access Private
 */
router.get('/order-intents', authController.authenticate, paperTradingController.getOrderIntents);

/**
 * @route GET /api/paper-trading/order-intents/family-hindsight
 * @desc 获取全部策略账户拒单后验汇总：错杀、有效拦截与账户级规则建议
 * @access Private
 */
router.get(
  '/order-intents/family-hindsight',
  authController.authenticate,
  paperTradingController.getOrderIntentFamilyHindsight
);

/**
 * @route GET /api/paper-trading/order-intents/:id/trace
 * @desc 获取单条订单意图链路：信号、拒单原因、后验收益、同类规则建议和参数影响
 * @access Private
 */
router.get(
  '/order-intents/:id/trace',
  authController.authenticate,
  paperTradingController.getOrderIntentTrace
);

/**
 * @route POST /api/paper-trading/order-intents/hindsight/refresh
 * @desc 主动刷新订单意图后验快照，供看板/链路复用缓存
 * @access Private
 */
router.post(
  '/order-intents/hindsight/refresh',
  authController.authenticate,
  paperTradingController.refreshOrderIntentHindsight
);

/**
 * @route GET /api/paper-trading/recommendation-outcomes
 * @desc 获取推荐信号到模拟交易收益的闭环看板
 * @access Private
 */
router.get(
  '/recommendation-outcomes',
  authController.authenticate,
  paperTradingController.getRecommendationOutcomes
);

/**
 * @route GET /api/paper-trading/recommendation-outcomes/:id/trace
 * @desc 获取单笔推荐链路详情：信号、量化/Agent复核、风控、模拟交易和收益
 * @access Private
 */
router.get(
  '/recommendation-outcomes/:id/trace',
  authController.authenticate,
  paperTradingController.getRecommendationOutcomeTrace
);

/**
 * @route POST /api/paper-trading/recommendation-outcomes/refresh
 * @desc 刷新推荐信号到模拟交易收益的闭环结果
 * @access Private
 */
router.post(
  '/recommendation-outcomes/refresh',
  authController.authenticate,
  paperTradingController.refreshRecommendationOutcomes
);

/**
 * @route POST /api/paper-trading/recommendation-outcomes/report
 * @desc 将推荐交易收益闭环报告写入飞书多维表格
 * @access Private
 */
router.post(
  '/recommendation-outcomes/report',
  authController.authenticate,
  paperTradingController.reportRecommendationOutcomes
);

/**
 * @route POST /api/paper-trading/attribution/report
 * @desc 生成模拟盘收益归因并写入飞书多维表格
 * @access Private
 */
router.post(
  '/attribution/report',
  authController.authenticate,
  paperTradingController.reportAttribution
);

/**
 * @route GET /api/paper-trading/plan
 * @desc 生成模拟盘盘前/盘后交易计划
 * @access Private
 */
router.get('/plan', authController.authenticate, paperTradingController.getTradingPlan);

/**
 * @route POST /api/paper-trading/plan/report
 * @desc 生成模拟盘交易计划并写入飞书多维表格
 * @access Private
 */
router.post('/plan/report', authController.authenticate, paperTradingController.reportTradingPlan);

/**
 * @route POST /api/paper-trading/order-intent-tuning/apply
 * @desc 预览或手动应用订单意图稳定窗口给出的调参建议到自动跟单/交易计划任务
 * @access Private
 */
router.post(
  '/order-intent-tuning/apply',
  authController.authenticate,
  paperTradingController.applyOrderIntentTuning
);

/**
 * @route GET /api/paper-trading/order-intent-tuning/canary
 * @desc 获取订单意图 Canary 小流量调参观察状态
 * @access Private
 */
router.get(
  '/order-intent-tuning/canary',
  authController.authenticate,
  paperTradingController.getOrderIntentTuningCanary
);

/**
 * @route POST /api/paper-trading/order-intent-tuning/canary/rollback
 * @desc 预览或强确认回滚订单意图 Canary 小流量调参
 * @access Private
 */
router.post(
  '/order-intent-tuning/canary/rollback',
  authController.authenticate,
  paperTradingController.rollbackOrderIntentTuningCanary
);

/**
 * @route GET /api/paper-trading/history
 * @desc 获取模拟盘的交易流水
 * @access Private
 */
router.get('/history', authController.authenticate, paperTradingController.getTradeHistory);

/**
 * @route GET /api/paper-trading/snapshots
 * @desc 获取模拟盘的资金曲线快照
 * @access Private
 */
router.get('/snapshots', authController.authenticate, paperTradingController.getSnapshots);

export default router;
