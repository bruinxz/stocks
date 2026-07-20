import { Router } from 'express';
import { aiAdvisorController } from '../controllers/AIAdvisorController';
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
 * @openapi
 * /api/ai/price-decision:
 *   post:
 *     tags: [AI 智能分析]
 *     summary: 基于 TradingAgents 与当前价格生成买卖测算
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [stock_code]
 *             properties:
 *               stock_code: { type: string, example: sh.600519 }
 *               stock_name: { type: string }
 *               dimensions:
 *                 type: array
 *                 items: { type: string, enum: [fundamental, technical, capital, news, sentiment] }
 *               position_state: { type: string, enum: [watching, holding], default: watching }
 *               planned_capital: { type: number, description: 计划资金，用于估算 A 股整手数量 }
 *               holding_cost: { type: number, description: 已持仓成本，用于测算浮动盈亏 }
 *               refresh_quote: { type: boolean, default: true }
 *     responses:
 *       200: { description: TradingAgents 报告、行情快照与价格计划 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 股票不存在 }
 */
router.post(
  '/price-decision',
  authController.authenticate,
  aiAdvisorController.analyzePriceDecision
);

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
