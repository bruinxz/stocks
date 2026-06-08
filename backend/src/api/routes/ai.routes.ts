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
 * @route POST /api/ai/analyze-stock
 * @desc US-055 单股深度分析（5 大维度：基本面/技术面/资金面/新闻面/情绪面）
 * @access Private
 */
router.post('/analyze-stock', authController.authenticate, aiAdvisorController.analyzeSingleStock);

/**
 * @route GET /api/ai/analyze-stock/stream
 * @desc US-055 单股深度分析 SSE 流式返回
 * @access Public（EventSource 无法方便传 Bearer Header）
 */
router.get('/analyze-stock/stream', aiAdvisorController.streamSingleStockAnalysis);

/**
 * @route GET /api/ai/analyze-stock/reports/:reportId
 * @desc US-055 单条 AI 分析报告详情
 * @access Private
 * **NOTE**: 必须在 /reports（list）之前注册，否则 :reportId 会吃掉 "reports" 路径段。
 */
router.get(
  '/analyze-stock/reports/:reportId',
  authController.authenticate,
  aiAdvisorController.getReportById
);

/**
 * @route GET /api/ai/analyze-stock/reports
 * @desc US-055 AI 分析报告列表（按 stock_code 过滤、时间倒序）
 * @access Private
 */
router.get('/analyze-stock/reports', authController.authenticate, aiAdvisorController.listReports);

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
 * @route GET /api/ai/recommendations/strategy-experiment
 * @desc 并行比较多种荐股策略风格与参数组合
 * @access Private
 */
router.get(
  '/recommendations/strategy-experiment',
  authController.authenticate,
  quantRecommendationController.runStrategyExperiment
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
 * @route GET /api/ai/signals/agent-tail-ledger
 * @desc 获取 TradingAgents 尾盘建议收益账本与 Alpha 归因
 * @access Private
 */
router.get(
  '/signals/agent-tail-ledger',
  authController.authenticate,
  aiSignalController.getAgentTailAlphaLedger
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

/**
 * @route GET /api/ai/kol-opinions
 * @desc US-056 — 行业大 V / 券商 / 媒体 / 集体市场对某只股票的最新观点聚合
 *       (券商研报 + 个股新闻 + 热门概念代理 3 来源)。
 *       Query: stock_code (必填), limit (1-50, 默认 10), refresh ('true' 主动刷新)
 * @access Private
 */
router.get('/kol-opinions', authController.authenticate, aiAdvisorController.getKOLOpinions);

/**
 * @route POST /api/ai/technical-analysis
 * @desc US-061 — 大模型技术面 K 线解读
 *       Body: { stock_code (必填), lookback_days (默认 60, 20-250),
 *               force_refresh (默认 false), dry_run (默认 false), task_label }
 *       Returns: { trend, support_levels, resistance_levels, buy_zone,
 *                  sell_zone, summary, confidence, ... 24h 缓存 TTL }
 * @access Private
 */
router.post(
  '/technical-analysis',
  authController.authenticate,
  aiAdvisorController.getTechnicalAnalysis
);

/**
 * @route POST /api/ai/strategy-copilot
 * @desc US-062 — AI 策略人机协同 (Copilot) 同步聊天
 *       Body: { prompt (必填), strategy_key, intent_override, dry_run,
 *               task_label, conversation_id }
 *       Returns: CopilotResponse (reply, suggested_params, strategy_draft, ...)
 * @access Private
 */
router.post(
  '/strategy-copilot',
  authController.authenticate,
  aiAdvisorController.askStrategyCopilot
);

/**
 * @route GET /api/ai/strategy-copilot/stream
 * @desc US-062 — AI Copilot SSE 流式返回
 *       Query: prompt (必填), strategy_key, intent_override, task_label, conversation_id
 *       SSE events: status / context / payload (上游透传) / completed / error
 * @access Public (EventSource 无法方便传 Bearer Header, 同 /analyze/stream)
 *
 * NOTE: 必须在 /strategy-copilot/context 之前注册，否则 EventSource 会被 :param
 * 风格 catchall 消费。（顺序无 catchall 路由也不冲突，但保持一致避免日后被搬乱。）
 */
router.get('/strategy-copilot/stream', aiAdvisorController.streamStrategyCopilot);

/**
 * @route GET /api/ai/strategy-copilot/context?strategy_key=...&lookback=5
 * @desc US-062 — 仅返回策略元 + 最近 N 次回测，不调远端 AI
 * @access Private
 */
router.get(
  '/strategy-copilot/context',
  authController.authenticate,
  aiAdvisorController.getStrategyCopilotContext
);

/**
 * @route GET /api/ai/market-brief/today
 * @desc US-073 今日大盘 AI 速读卡片（TodayWorkspace 顶部）
 * @access Private
 *
 * 查询参数：
 *   - date=YYYY-MM-DD: 可选，覆盖默认"今日 Asia/Shanghai"
 *   - refresh=true: 强制重新生成绕过 cache
 */
router.get(
  '/market-brief/today',
  authController.authenticate,
  aiAdvisorController.getMarketBriefToday
);

export default router;
