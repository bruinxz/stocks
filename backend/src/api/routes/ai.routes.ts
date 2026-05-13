import { Router } from 'express';
import { aiAdvisorController } from '../controllers/AIAdvisorController';
import { screenerController } from '../controllers/ScreenerController';
import { aiSignalController } from '../controllers/AISignalController';
import { quantRecommendationController } from '../controllers/QuantRecommendationController';
import { stockProfileController } from '../controllers/StockProfileController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/ai/health
 * @desc 获取 TradingAgents 服务健康与能力信息
 * @access Private
 */
router.get('/health', authController.authenticate, aiAdvisorController.getHealth);

/**
 * @route POST /api/ai/analyze
 * @desc 提交 AI 同步或异步分析任务
 * @access Private
 */
router.post('/analyze', authController.authenticate, aiAdvisorController.analyze);

/**
 * @route GET /api/ai/tasks/:taskId
 * @desc 获取 AI 分析异步任务的状态
 * @access Private
 */
router.get('/tasks/:taskId', authController.authenticate, aiAdvisorController.getTask);

/**
 * @route GET /api/ai/analyze/stream
 * @desc 实时 SSE 流式返回 AI 研报分析过程
 * @access Private
 */
router.get(
  '/analyze/stream',
  // authController.authenticate, // EventSource 无法方便传递 Bearer Header，可能需要通过 URL token 验证或者放开
  aiAdvisorController.streamAnalyze
);

/**
 * @route GET /api/ai/recommendations
 * @desc 获取本地多因子候选推荐
 * @access Private
 */
router.get(
  '/recommendations',
  authController.authenticate,
  quantRecommendationController.listRecommendations
);

/**
 * @route POST /api/ai/recommendations/analyze
 * @desc 将多因子候选批量提交 TradingAgents 深度研报
 * @access Private
 */
router.post(
  '/recommendations/analyze',
  authController.authenticate,
  quantRecommendationController.submitToTradingAgents
);

/**
 * @route POST /api/ai/recommendations/archive
 * @desc 将多因子候选归档为可后验验证的投研信号
 * @access Private
 */
router.post(
  '/recommendations/archive',
  authController.authenticate,
  quantRecommendationController.archiveRecommendations
);

/**
 * @route GET /api/ai/recommendations/loop-policy-snapshots
 * @desc 获取全市场荐股闭环策略参数快照与版本表现
 * @access Private
 */
router.get(
  '/recommendations/loop-policy-snapshots',
  authController.authenticate,
  quantRecommendationController.getLoopPolicySnapshots
);

/**
 * @route POST /api/ai/recommendations/loop-policy-snapshots/refresh-outcomes
 * @desc 用最新推荐交易收益回填策略参数版本表现
 * @access Private
 */
router.post(
  '/recommendations/loop-policy-snapshots/refresh-outcomes',
  authController.authenticate,
  quantRecommendationController.refreshLoopPolicySnapshotOutcomes
);

/**
 * @route POST /api/ai/recommendations/auto-loop
 * @desc 执行全市场自动荐股闭环：量化初筛、归档、Agent复核、后验验证与模拟盘预演/跟单
 * @access Private
 */
router.post(
  '/recommendations/auto-loop',
  authController.authenticate,
  quantRecommendationController.runAutomatedLoop
);

/**
 * @route POST /api/ai/recommendations/sync-profiles
 * @desc 为候选推荐批量补全股票画像/估值快照
 * @access Private
 */
router.post(
  '/recommendations/sync-profiles',
  authController.authenticate,
  stockProfileController.syncProfiles
);

/**
 * @route GET /api/ai/signals
 * @desc 获取已归档 AI 投研信号及后验收益
 * @access Private
 */
router.get('/signals', authController.authenticate, aiSignalController.listSignals);

/**
 * @route GET /api/ai/signals/stats
 * @desc 获取 AI 投研信号统计表现
 * @access Private
 */
router.get('/signals/stats', authController.authenticate, aiSignalController.getSignalStats);

/**
 * @route GET /api/ai/signals/performance
 * @desc 获取 AI/量化推荐后验绩效看板
 * @access Private
 */
router.get(
  '/signals/performance',
  authController.authenticate,
  aiSignalController.getPerformanceDashboard
);

/**
 * @route GET /api/ai/signals/quality-report
 * @desc 获取信号来源质量排行榜日报
 * @access Private
 */
router.get(
  '/signals/quality-report',
  authController.authenticate,
  aiSignalController.getSignalQualityReport
);

/**
 * @route POST /api/ai/signals/sync-screeners
 * @desc 从 AI 每日优选同步为可验证信号
 * @access Private
 */
router.post(
  '/signals/sync-screeners',
  authController.authenticate,
  aiSignalController.syncFromScreeners
);

/**
 * @route POST /api/ai/signals/verify
 * @desc 刷新 AI 信号后验收益验证
 * @access Private
 */
router.post('/signals/verify', authController.authenticate, aiSignalController.verifySignals);

/**
 * @route GET /api/ai/signals/verification/diagnose
 * @desc 诊断 AI 信号收益验证缺口（缺股票/缺行情/周期未完成）
 * @access Private
 */
router.get(
  '/signals/verification/diagnose',
  authController.authenticate,
  aiSignalController.diagnoseVerification
);

/**
 * @route POST /api/ai/signals/verification/repair
 * @desc 自动补齐缺失行情并重新验证 AI 信号收益
 * @access Private
 */
router.post(
  '/signals/verification/repair',
  authController.authenticate,
  aiSignalController.repairAndVerifySignals
);

/**
 * @route POST /api/ai/signals/performance/refresh
 * @desc 刷新 AI/量化推荐后验绩效并上报飞书
 * @access Private
 */
router.post(
  '/signals/performance/refresh',
  authController.authenticate,
  aiSignalController.refreshPerformance
);

/**
 * @route POST /api/ai/signals/quality-report
 * @desc 生成信号来源质量排行榜并上报飞书
 * @access Private
 */
router.post(
  '/signals/quality-report',
  authController.authenticate,
  aiSignalController.reportSignalQualityDaily
);

/**
 * @route GET /api/ai/screener
 * @desc 获取 AI 每日优选列表
 * @access Private
 */
router.get('/screener', authController.authenticate, screenerController.getDailyScreener);

/**
 * @route GET /api/ai/screener/:id
 * @desc 获取单条 AI 优选详情（包含 detail 大字段）
 * @access Private
 */
router.get('/screener/:id', authController.authenticate, screenerController.getDailyScreenerDetail);

export default router;
