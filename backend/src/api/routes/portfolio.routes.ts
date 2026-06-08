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
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
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
  [body('portfolio_id').optional().isInt({ min: 1 }), body('dry_run').optional().isBoolean()],
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
router.get('/:id', authController.authenticate, portfolioController.getSimulationDetail);

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
