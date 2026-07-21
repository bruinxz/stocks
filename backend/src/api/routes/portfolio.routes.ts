import { Router } from 'express';
import { body, query } from 'express-validator';
import { PortfolioController } from '../controllers/PortfolioController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const portfolioController = new PortfolioController();
const authController = new AuthController();

/**
 * @openapi
 * /api/portfolio/simulate:
 *   post:
 *     tags: [组合 Portfolio]
 *     summary: 运行投资组合收益模拟
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [symbols, buyDate, days]
 *             properties:
 *               name: { type: string, maxLength: 100 }
 *               description: { type: string, maxLength: 500 }
 *               symbols: { type: array, minItems: 1, maxItems: 10, items: { type: string } }
 *               buyDate: { type: string, format: date }
 *               days: { type: integer, minimum: 1, maximum: 1825 }
 *               initial_capital: { type: number, minimum: 1000, maximum: 10000000 }
 *               allocationStrategy: { type: string, enum: [equal, weighted] }
 *               includeDividends: { type: boolean }
 *               reinvest: { type: boolean }
 *     responses:
 *       200: { description: 模拟结果, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/simulate',
  authController.authenticate,
  [
    body('name').optional().isString().isLength({ max: 100 }),
    body('description').optional().isString().isLength({ max: 500 }),
    body('symbols').isArray({ min: 1, max: 10 }).withMessage('请选择1-10只股票'),
    body('symbols.*')
      .isString()
      .matches(/^((sh|sz|bj)\.)?\d{6}$|^(sh|sz|bj)\d{6}$|^\d{6}\.(SH|SZ|BJ)$/i)
      .withMessage('股票代码格式不正确，应为 sh.600000、600000 或 600000.SH 格式'),
    body('buyDate').isISO8601().withMessage('买入日期格式不正确，应为 YYYY-MM-DD 格式'),
    body('days')
      .isInt({ min: 1, max: 365 * 5 })
      .withMessage('持有天数应在1-1825天范围内'),
    body('initial_capital')
      .optional()
      .isFloat({ min: 1000, max: 10000000 })
      .withMessage('初始资金应在1000-10000000范围内'),
    body('allocationStrategy')
      .optional()
      .isIn(['equal', 'weighted'])
      .withMessage('资金分配策略应为 equal 或 weighted'),
    body('includeDividends').optional().isBoolean().withMessage('是否包含分红应为布尔值'),
    body('reinvest').optional().isBoolean().withMessage('是否再投资应为布尔值'),
  ],
  validateRequest,
  portfolioController.simulatePortfolio
);

/**
 * @openapi
 * /api/portfolio/history:
 *   get:
 *     tags: [组合 Portfolio]
 *     summary: 获取投资组合模拟历史记录
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: start_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: end_date
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: 历史记录列表 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/history',
  authController.authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
  ],
  validateRequest,
  portfolioController.getSimulationHistory
);

/**
 * @openapi
 * /api/portfolio/recommended-config:
 *   get:
 *     tags: [组合 Portfolio]
 *     summary: 获取推荐配置
 *     security: []
 *     responses:
 *       200: { description: 推荐配置 }
 *       400: { description: 参数错误 }
 */
router.get('/recommended-config', portfolioController.getRecommendedConfig);

/**
 * @openapi
 * /api/portfolio/rebalance-industry:
 *   post:
 *     tags: [组合 Portfolio]
 *     summary: 行业集中度一键再平衡 (US-052)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [portfolio_id]
 *             properties:
 *               portfolio_id: { type: integer, minimum: 1 }
 *               dry_run: { type: boolean }
 *     responses:
 *       200: { description: 再平衡结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/rebalance-industry',
  authController.authenticate,
  [body('portfolio_id').isInt({ min: 1 }), body('dry_run').optional().isBoolean()],
  validateRequest,
  portfolioController.rebalanceIndustry
);

/**
 * @openapi
 * /api/portfolio/{id}:
 *   get:
 *     tags: [组合 Portfolio]
 *     summary: 获取投资组合模拟详情
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 模拟详情 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 未找到 }
 */
// IMPORTANT: /correlation 必须在 /:id 之前注册 (Express 顺序匹配，否则被 catchall 拦)
router.get('/correlation', authController.authenticate, portfolioController.getCorrelation);

// IMPORTANT: /exposure 同理
router.get('/exposure', authController.authenticate, portfolioController.getExposure);

/**
 * @openapi
 * /api/portfolio/industry-concentration-summary:
 *   get:
 *     tags: [组合 Portfolio]
 *     summary: 行业集中度 KPI 快照 (US-012)
 *     description: |
 *       PortfolioWorkspace 顶部 KPI 卡专用 — 返回当前 user 的最大行业占比、
 *       是否超 alert_pct（默认 0.35）以及完整 industry breakdown。复用 US-052
 *       IndustryConcentrationGuard.aggregateByIndustry（同款分母：持仓不含
 *       cash），不写 RiskAlert，UI 可任意频率轮询。
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: KPI 快照 }
 *       401: { description: 未授权 }
 */
// IMPORTANT: /industry-concentration-summary 必须在 /:id 之前注册（同上）
router.get(
  '/industry-concentration-summary',
  authController.authenticate,
  portfolioController.getIndustryConcentrationSummary
);

// Batch BD (2026-06-23): 限制 :id 必须是 UUID 格式, 防止 /api/portfolio/list 等路径被错误匹配
// 真因: 前端调 /api/portfolio/list (期望列表) 时 express 把 "list" 当作 :id → controller 查 UUID
// → PG 报 'invalid input syntax for type uuid: "list"' → 500. UUID regex 不匹配 → 自然 404.
// 同样保护 /api/portfolio/33 等数字 ID 被误判为 simulation portfolio (这些是 paper-trading 数字 ID,
// 应走 /api/paper-trading/portfolios/:id 路由).
router.get(
  '/:id([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
  authController.authenticate,
  portfolioController.getSimulationDetail
);

/**
 * @openapi
 * /api/portfolio/{id}/attribution/daily:
 *   get:
 *     tags: [组合 Portfolio]
 *     summary: 获取单 portfolio 当日归因报告 (US-084 / PM-007)
 *     description: |
 *       读取 daily_attribution_reports 表 (PM-003 schema), 由 cron
 *       DAILY_ATTRIBUTION_GENERATE (US-083 / PM-006) 在 17:00 工作日 upsert.
 *       owner check — portfolio.user_id 必须等于请求 user, 否则 403.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: date
 *         required: false
 *         schema: { type: string, format: date }
 *         description: YYYY-MM-DD, 默认今日 (Asia/Shanghai)
 *     responses:
 *       200: { description: 报告内容 }
 *       400: { description: portfolio id 非法 }
 *       401: { description: 未登录 }
 *       403: { description: 非本人 portfolio }
 *       404: { description: portfolio / 当日报告不存在 }
 */
router.get(
  // BJ-3 (2026-06-23): /attribution/daily 走 PaperTradingPortfolio (integer id),
  // 不是 PortfolioSimulation (UUID). 接 integer 或 UUID 都行 — 让 controller 内部
  // parseInt 自己判 (非法 → 400).
  '/:id(\\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/attribution/daily',
  authController.authenticate,
  portfolioController.getDailyAttribution
);

/**
 * @openapi
 * /api/portfolio/validate-stocks:
 *   post:
 *     tags: [组合 Portfolio]
 *     summary: 批量验证股票
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [symbols]
 *             properties:
 *               symbols: { type: array, minItems: 1, maxItems: 20, items: { type: string } }
 *     responses:
 *       200: { description: 验证结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/validate-stocks',
  authController.authenticate,
  [
    body('symbols').isArray({ min: 1, max: 20 }).withMessage('请选择1-20只股票'),
    body('symbols.*')
      .isString()
      .matches(/^((sh|sz|bj)\.)?\d{6}$|^(sh|sz|bj)\d{6}$|^\d{6}\.(SH|SZ|BJ)$/i)
      .withMessage('股票代码格式不正确，应为 sh.600000、600000 或 600000.SH 格式'),
  ],
  validateRequest,
  portfolioController.validateStocks
);

export default router;
