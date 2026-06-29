import { NextFunction, Request, Response, Router } from 'express';
import { body } from 'express-validator';
import { quantController } from '../controllers/QuantController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';
import { getQuantWorkflowPresetKeys } from '../../quant/workflow/QuantWorkflowReadinessService';

const router = Router();
const authController = new AuthController();
const workflowPresetKeys = getQuantWorkflowPresetKeys();
const WORKFLOW_READINESS_BODY_LIMIT_BYTES = 100 * 1024;

const optionalNumber = (field: string, min: number, max: number) =>
  body(field).optional({ nullable: true }).isFloat({ min, max });
const optionalBoolean = (field: string) => body(field).optional({ nullable: true }).isBoolean();
const workflowReadinessBodySizeGuard = (req: Request, res: Response, next: NextFunction) => {
  const contentLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > WORKFLOW_READINESS_BODY_LIMIT_BYTES) {
    return res.status(413).json({
      success: false,
      message: 'workflow readiness 请求体过大',
    });
  }
  return next();
};

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
 * /api/quant/strategies/{strategy_key}/source:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 策略源码（US-093）— 返回 backend/src/quant/strategies/*.ts 内容，供 Monaco 只读展示
 *     description: |
 *       前端在策略详情页 "代码视图" tab 加载 Monaco 编辑器后调用本接口拉取源码。
 *       严格校验 strategy_key（仅允许 `^[a-z][a-z0-9_]*$`），并通过预扫描建立的
 *       key→filename 缓存查找，杜绝 path traversal。源文件硬上限 256KB。
 *
 *       Must be registered before PATCH /strategies/:strategy_key — 与 /detail 同款
 *       ordering 规则，避免 Express 把 'source' 错配成 PATCH catchall 的 :strategy_key。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: strategy_key
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 源码内容 + 文件元数据 }
 *       400: { description: strategy_key 格式非法或缺失 }
 *       401: { description: 未授权 }
 *       404: { description: 找不到对应源文件 }
 *       413: { description: 源文件过大 }
 */
router.get(
  '/strategies/:strategy_key/source',
  authController.authenticate,
  quantController.getStrategySource.bind(quantController)
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

router.get(
  '/workflow-presets',
  authController.authenticate,
  quantController.getWorkflowPresets.bind(quantController)
);

router.post(
  '/workflow-readiness/evaluate',
  authController.authenticate,
  workflowReadinessBodySizeGuard,
  [
    body()
      .custom(value => value === undefined || (typeof value === 'object' && !Array.isArray(value)))
      .withMessage('请求体必须为对象'),
    body('strategy').optional({ nullable: true }).isObject().withMessage('strategy 必须为对象'),
    body('strategy.preset_key')
      .optional({ nullable: true, checkFalsy: true })
      .isIn(workflowPresetKeys)
      .withMessage(`preset_key 必须是以下之一: ${workflowPresetKeys.join(', ')}`),
    body('strategy.strategy_key')
      .optional({ nullable: true, checkFalsy: true })
      .isString()
      .isLength({ min: 1, max: 80 })
      .matches(/^[a-z][a-z0-9_]*$/)
      .withMessage('strategy_key 仅支持 snake_case 策略 key'),
    body('strategy.edge_hypothesis')
      .optional({ nullable: true })
      .isObject()
      .withMessage('edge_hypothesis 必须为对象'),
    body('data').optional({ nullable: true }).isObject().withMessage('data 必须为对象'),
    body('backtest').optional({ nullable: true }).isObject().withMessage('backtest 必须为对象'),
    body('paper').optional({ nullable: true }).isObject().withMessage('paper 必须为对象'),
    body('data.latest_trade_date')
      .optional({ nullable: true, checkFalsy: true })
      .isISO8601({ strict: true })
      .withMessage('latest_trade_date 必须为 YYYY-MM-DD 日期'),
    optionalNumber('data.daily_bar_coverage_pct', 0, 100),
    optionalNumber('data.factor_coverage_pct', 0, 100),
    optionalNumber('data.stale_symbol_count', 0, 100000),
    optionalBoolean('data.point_in_time_ready'),
    optionalBoolean('data.corporate_action_adjusted'),
    optionalBoolean('data.benchmark_ready'),
    optionalNumber('strategy.edge_hypothesis.expected_holding_days', 0, 10000),
    optionalNumber('backtest.trading_days', 0, 10000),
    optionalNumber('backtest.trade_count', 0, 100000),
    optionalNumber('backtest.sharpe_ratio', -20, 20),
    optionalNumber('backtest.max_drawdown_pct', 0, 100),
    optionalNumber('backtest.benchmark_excess_return_pct', -1000, 1000),
    optionalBoolean('backtest.validation_split'),
    body('backtest.walk_forward_verdict')
      .optional({ nullable: true, checkFalsy: true })
      .isIn(['pass', 'warn', 'warning', 'fail'])
      .withMessage('walk_forward_verdict 必须为 pass/warn/warning/fail'),
    optionalNumber('backtest.overfit_score', 0, 1),
    optionalNumber('paper.trading_days', 0, 10000),
    optionalNumber('paper.completed_trades', 0, 100000),
    optionalNumber('paper.win_rate', 0, 1),
    optionalNumber('paper.profit_loss_ratio', 0, 100),
    optionalNumber('paper.max_drawdown_pct', 0, 100),
    optionalNumber('paper.average_slippage_bps', 0, 10000),
    optionalNumber('paper.backtest_to_paper_correlation', -1, 1),
    optionalNumber('paper.risk_guard_breaches', 0, 100000),
    optionalNumber('paper.manual_override_count', 0, 100000),
  ],
  validateRequest,
  quantController.evaluateWorkflowReadiness.bind(quantController)
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

router.get(
  '/research-experiments',
  authController.authenticate,
  quantController.listResearchExperiments.bind(quantController)
);

router.post(
  '/research-experiments',
  authController.authenticate,
  quantController.createResearchExperiment.bind(quantController)
);

router.get(
  '/research-experiments/:id',
  authController.authenticate,
  quantController.getResearchExperiment.bind(quantController)
);

router.post(
  '/research-experiments/:id/run-audit',
  authController.authenticate,
  quantController.runResearchExperimentAudit.bind(quantController)
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

// ============================================================
// Phase 1: Walk-Forward Validation (in-process, with DSR/PBO)
// ============================================================

/**
 * @openapi
 * /api/quant/walk-forward:
 *   post:
 *     tags: [量化 Quant]
 *     summary: (Phase 1) 触发 walk-forward 验证 — in-process 实现 + DSR/PBO 过拟合检测
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               strategy_key: { type: string }
 *               param_grid: { type: object, description: 'grid_search 模式用' }
 *               param_bounds: { type: object, description: 'bayesian 模式用' }
 *               base_config: { type: object }
 *               train_months: { type: integer, default: 12 }
 *               test_months: { type: integer, default: 3 }
 *               start_date: { type: string, format: date }
 *               end_date: { type: string, format: date }
 *               scheme: { type: string, enum: [rolling, cpcv], default: rolling }
 *               optimizer_type: { type: string, enum: [grid_search, bayesian], default: grid_search }
 *               purging:
 *                 type: object
 *                 properties:
 *                   label_horizon_days: { type: integer }
 *                   embargo_days: { type: integer }
 *               cpcv:
 *                 type: object
 *                 properties:
 *                   n_groups: { type: integer, default: 6 }
 *                   k_test_groups: { type: integer, default: 2 }
 *     responses:
 *       200: { description: 验证完成 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/walk-forward',
  authController.authenticate,
  quantController.runWalkForwardValidation.bind(quantController)
);

/**
 * @openapi
 * /api/quant/walk-forward/runs:
 *   get:
 *     tags: [量化 Quant]
 *     summary: (Phase 1) 列出最近的 walk-forward run
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: strategy_name, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, default: 30 } }
 *     responses:
 *       200: { description: run 列表 }
 */
router.get(
  '/walk-forward/runs',
  authController.authenticate,
  quantController.listWalkForwardRuns.bind(quantController)
);

/**
 * @openapi
 * /api/quant/optimization-runs:
 *   get:
 *     tags: [量化 Quant]
 *     summary: (Phase 7+) 统一列出所有 OptimizationRun (grid_search / bayesian / walk_forward)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: optimizer_type
 *         schema: { type: string, enum: [grid_search, bayesian, walk_forward, all] }
 *       - in: query
 *         name: strategy_name
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30, maximum: 200 }
 *     responses:
 *       200: { description: OptimizationRun 列表 (统一形态) }
 */
router.get(
  '/optimization-runs',
  authController.authenticate,
  quantController.listOptimizationRuns.bind(quantController)
);

/**
 * @openapi
 * /api/quant/walk-forward/runs/{id}/windows:
 *   get:
 *     tags: [量化 Quant]
 *     summary: (Phase 1) 拿一个 walk-forward run 的所有 windows
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: windows 列表 }
 *       400: { description: 参数错误 }
 */
router.get(
  '/walk-forward/runs/:id/windows',
  authController.authenticate,
  quantController.getWalkForwardWindows.bind(quantController)
);

/**
 * @openapi
 * /api/quant/walk-forward/runs/{id}:
 *   delete:
 *     tags: [量化 Quant]
 *     summary: (Phase 1) 删除一个 walk-forward run
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: 删除成功 }
 *       400: { description: 参数错误 }
 */
router.delete(
  '/walk-forward/runs/:id',
  authController.authenticate,
  quantController.deleteWalkForwardRun.bind(quantController)
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

router.get(
  '/backtests/:id/research-audit',
  authController.authenticate,
  quantController.getBacktestResearchAudit.bind(quantController)
);

router.get(
  '/backtests/:id/execution-constraint-audit',
  authController.authenticate,
  quantController.getBacktestExecutionConstraintAudit.bind(quantController)
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

/**
 * @openapi
 * /api/quant/strategy-leaderboard:
 *   get:
 *     tags: [量化 Quant]
 *     summary: 策略排行榜（按 sharpe / annual / total 排序，每策略最新一次回测）
 *     parameters:
 *       - in: query
 *         name: sort_by
 *         schema: { type: string, enum: [sharpe, annual, total] }
 *     responses:
 *       200: { description: 排序后的策略列表 }
 */
router.get(
  '/strategy-leaderboard',
  authController.authenticate,
  quantController.getStrategyLeaderboard.bind(quantController)
);

export default router;
