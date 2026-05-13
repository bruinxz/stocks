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
 * @route GET /api/paper-trading/attribution
 * @desc 获取模拟盘信号收益归因与策略反哺
 * @access Private
 */
router.get('/attribution', authController.authenticate, paperTradingController.getAttribution);

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
