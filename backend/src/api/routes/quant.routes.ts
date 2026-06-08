import { Router } from 'express';
import { quantController } from '../controllers/QuantController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/quant/strategies:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取量化策略列表与启用状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 策略列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/strategies',
  authController.authenticate,
  quantController.getStrategies.bind(quantController)
);

/**
 * @openapi
 * /api/quant/strategies/{strategy_key}/detail:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 单只策略详情（US-078）— 元数据 + 近 10 次回测 + 最新 IC + 实盘绑定状态
 *     description: |
 *       聚合返回 4 类数据：(1) strategy 行（含 default_params / execution_policy 等），
 *       (2) backtests 近 10 次包含该策略的回测（含该策略自身 KPI 与冠军 KPI），
 *       (3) latest_ic 最近一次因子 IC 报告（按 factor_name=strategy_key 匹配），
 *       (4) live_binding 简化版实盘绑定（enabled flag + 近 7 日是否有信号）。
 *       任一子查询失败用 fallback 不阻塞。
 *
 *       Must be registered before PATCH /strategies/:strategy_key — Express 同方法优先，
 *       但加 GET 子资源在 catchall 之前是更通用的安全做法。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: strategy_key
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 策略详情 }
 *       400: { description: 缺少 strategy_key }
 *       401: { description: 未授权 }
 *       404: { description: 策略不存在 }
 */
router.get(
  '/strategies/:strategy_key/detail',
  authController.authenticate,
  quantController.getStrategyDetail.bind(quantController)
);

/**
 * @openapi
 * /api/quant/strategies/{strategy_key}:
 *   patch:
 *     tags: [量化 Quant]
 *     summary: 更新指定策略配置
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: strategy_key
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 未找到策略 }
 */
router.patch(
  '/strategies/:strategy_key',
  authController.authenticate,
  quantController.updateStrategyConfig.bind(quantController)
);

/**
 * @openapi
 * /api/quant/indicators:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取技术指标目录
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 指标目录 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/indicators',
  authController.authenticate,
  quantController.getIndicatorCatalog.bind(quantController)
);

/**
 * @openapi
 * /api/quant/performance-dashboard:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取策略绩效驾驶舱
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 绩效数据 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/performance-dashboard',
  authController.authenticate,
  quantController.getPerformanceDashboard.bind(quantController)
);

/**
 * @openapi
 * /api/quant/open-watchdog:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取开仓信号监控状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 监控状态 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/open-watchdog',
  authController.authenticate,
  quantController.getOpenWatchdog.bind(quantController)
);

/**
 * @openapi
 * /api/quant/data-freshness:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取数据新鲜度状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 数据新鲜度 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/data-freshness',
  authController.authenticate,
  quantController.getDataFreshness.bind(quantController)
);

/**
 * @openapi
 * /api/quant/runtime-health:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取量化运行时健康状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 运行时健康 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/runtime-health',
  authController.authenticate,
  quantController.getRuntimeHealth.bind(quantController)
);

/**
 * @openapi
 * /api/quant/strategy-experiments:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取策略实验列表
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 实验列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/strategy-experiments',
  authController.authenticate,
  quantController.listStrategyExperiments.bind(quantController)
);

/**
 * @openapi
 * /api/quant/strategy-experiments/param-suggestions:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取策略实验参数建议
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 参数建议 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/strategy-experiments/param-suggestions',
  authController.authenticate,
  quantController.getExperimentParamSuggestions.bind(quantController)
);

/**
 * @openapi
 * /api/quant/param-versions:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取参数版本列表
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 参数版本列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/param-versions',
  authController.authenticate,
  quantController.listParamVersions.bind(quantController)
);

/**
 * @openapi
 * /api/quant/param-versions/active-scan:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取当前用于扫描的活跃参数
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 活跃参数 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/param-versions/active-scan',
  authController.authenticate,
  quantController.getActiveScanParams.bind(quantController)
);

/**
 * @openapi
 * /api/quant/param-validations:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取参数校验记录
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 校验记录 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/param-validations',
  authController.authenticate,
  quantController.listParamVersions.bind(quantController)
);

/**
 * @openapi
 * /api/quant/param-versions/refresh:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 刷新参数版本
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 刷新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/param-versions/refresh',
  authController.authenticate,
  quantController.refreshParamVersions.bind(quantController)
);

/**
 * @openapi
 * /api/quant/param-validations/refresh:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 刷新参数校验
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 刷新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/param-validations/refresh',
  authController.authenticate,
  quantController.refreshParamValidations.bind(quantController)
);

/**
 * @openapi
 * /api/quant/param-lifecycle/refresh:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 刷新参数生命周期
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 刷新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/param-lifecycle/refresh',
  authController.authenticate,
  quantController.refreshParamLifecycle.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 创建回测任务
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 创建结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/backtests',
  authController.authenticate,
  quantController.createBacktest.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/walk-forward:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 创建滚动窗口（walk-forward）回测
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 创建结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/backtests/walk-forward',
  authController.authenticate,
  quantController.createWalkForwardBacktests.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/grid-search:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 创建参数网格回测
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 创建结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/backtests/grid-search',
  authController.authenticate,
  quantController.createParameterGridBacktests.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/grid-search/summary:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取参数网格回测汇总
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 汇总结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/backtests/grid-search/summary',
  authController.authenticate,
  quantController.getParameterGridSummary.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/compare:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 比较多次回测结果
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 对比结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
// Must be registered before /backtests/:id — Express matches top-down and
// would otherwise consume "compare" as the :id param.
router.post(
  '/backtests/compare',
  authController.authenticate,
  quantController.compareBacktests.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取回测任务列表
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 回测列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/backtests',
  authController.authenticate,
  quantController.listBacktests.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/{id}:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取单个回测任务详情
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 回测详情 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 未找到 }
 */
router.get(
  '/backtests/:id',
  authController.authenticate,
  quantController.getBacktest.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/{id}/retry:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 重试失败的回测任务
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 重试结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 未找到 }
 */
router.post(
  '/backtests/:id/retry',
  authController.authenticate,
  quantController.retryBacktest.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/{id}/drawdown-series:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 回测冠军策略每日回撤序列（US-075）
 *     description: |
 *       返回冠军策略 (按 total_return_pct 取最高) 每个交易日的回撤百分比与权益价值。
 *       优先复用 equity_curve_json 中预存的 drawdown_pct；缺失时现场用 running peak 算。
 *       供前端 LabWorkspace 回测对比 tab 的回撤曲线叠加图使用。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 回撤序列 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 任务不存在或暂无结果 }
 */
router.get(
  '/backtests/:id/drawdown-series',
  authController.authenticate,
  quantController.getBacktestDrawdownSeries.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/{id}/monthly-returns:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 回测冠军策略月度收益矩阵（US-075）
 *     description: |
 *       按 YYYY-MM 聚合冠军策略月末权益，输出 (year × month) 形式的收益率矩阵，
 *       供前端 LabWorkspace 渲染月度热力图。返回 years[] / months[] / cells[] 三个维度
 *       便于前端构建矩阵。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: 月度收益矩阵 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 任务不存在或暂无结果 }
 */
router.get(
  '/backtests/:id/monthly-returns',
  authController.authenticate,
  quantController.getBacktestMonthlyReturns.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/{id}/rolling-sharpe-series:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 回测冠军策略滚动夏普序列（US-075）
 *     description: |
 *       从冠军策略权益曲线推每日 pct 收益，对每个交易日取过去 window 天 (默认 90，
 *       通过 ?window=N 调，范围 2-252) 的收益序列算 (mean / sd) * sqrt(252) 得滚动夏普。
 *       供前端 LabWorkspace 渲染滚动夏普曲线，window 不足时该日返回 null（前端 connectNulls 跳过）。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: window
 *         required: false
 *         schema: { type: integer, default: 90, minimum: 2, maximum: 252 }
 *     responses:
 *       200: { description: 滚动夏普序列 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 任务不存在或暂无结果 }
 */
router.get(
  '/backtests/:id/rolling-sharpe-series',
  authController.authenticate,
  quantController.getBacktestRollingSharpe.bind(quantController)
);

/**
 * @openapi
 * /api/quant/backtests/{id}/cost-sensitivity:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 交易成本敏感性分析（US-085）
 *     description: |
 *       对一次已完成的回测，按 3 档佣金费率（万 1.5 / 万 2.5 / 万 5）逐档重跑回测引擎，
 *       将每档的 annual_return / sharpe / turnover / total_return / max_drawdown / win_rate
 *       / trade_count 落到 cost_sensitivity_results 表。请求体可选 dry_run=true 仅返回不落库；
 *       cost_levels=['万2.5'] 仅跑指定档；metadata 任意 JSON 写入 row.metadata_json。
 *
 *       同 (base_run_id, strategy_key, cost_level) 重跑会自动 upsert（destroy + bulkCreate）。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               dry_run: { type: boolean, default: false }
 *               cost_levels:
 *                 type: array
 *                 items: { type: string, enum: [万1.5, 万2.5, 万5] }
 *               metadata: { type: object }
 *     responses:
 *       200: { description: 分析结果（含 rows + summary + persisted） }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 任务不存在或无 per-strategy 结果 }
 */
router.post(
  '/backtests/:id/cost-sensitivity',
  authController.authenticate,
  quantController.runCostSensitivityAnalysis.bind(quantController)
);

/**
 * @openapi
 * /api/quant/signals/generate:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 生成量化信号
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 生成结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/signals/generate',
  authController.authenticate,
  quantController.generateSignals.bind(quantController)
);

/**
 * @openapi
 * /api/quant/signals:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取量化信号列表
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 信号列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/signals',
  authController.authenticate,
  quantController.listSignals.bind(quantController)
);

/**
 * @openapi
 * /api/quant/daily-pipeline/run:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 执行日度量化流水线
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 执行结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/daily-pipeline/run',
  authController.authenticate,
  quantController.runDailyPipeline.bind(quantController)
);

/**
 * @openapi
 * /api/quant/strategy-weights:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取策略权重列表
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 权重列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/strategy-weights',
  authController.authenticate,
  quantController.listStrategyWeights.bind(quantController)
);

/**
 * @openapi
 * /api/quant/strategy-weights/refresh:
 *   post:
 *     tags: [量化 Quant]
 *     summary: 刷新策略权重
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 刷新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/strategy-weights/refresh',
  authController.authenticate,
  quantController.refreshStrategyWeights.bind(quantController)
);

/**
 * @openapi
 * /api/quant/allocation-policy:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取仓位分配策略
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 分配策略 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/allocation-policy',
  authController.authenticate,
  quantController.getAllocationPolicy.bind(quantController)
);

/**
 * @openapi
 * /api/quant/fusion-audits:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取融合审计记录
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 审计记录 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/fusion-audits',
  authController.authenticate,
  quantController.listFusionAudits.bind(quantController)
);

/**
 * @openapi
 * /api/quant/rankings:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 获取量化排名
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 排名列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/rankings',
  authController.authenticate,
  quantController.getRankings.bind(quantController)
);

export default router;
