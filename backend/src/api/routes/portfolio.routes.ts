import { Router } from 'express';
import { body, query } from 'express-validator';
import { PortfolioController } from '../controllers/PortfolioController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const portfolioController = new PortfolioController();
const authController = new AuthController();

/**
 * @route POST /api/portfolio/simulate
 * @desc 运行投资组合收益模拟
 * @access Private
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
 * @route GET /api/portfolio/history
 * @desc 获取投资组合模拟历史记录
 * @access Private
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
 * @route GET /api/portfolio/recommended-config
 * @desc 获取推荐配置
 * @access Public
 */
router.get('/recommended-config', portfolioController.getRecommendedConfig);

/**
 * @route POST /api/portfolio/rebalance-industry
 * @desc 行业集中度一键再平衡（US-052）— 找到最严重的超 35% 阈值行业，
 *       按行业内涨幅 DESC 卖出 1-2 只让行业占比 < 30%。
 *       Body 字段：{ portfolio_id?: number, dry_run?: boolean }。
 *       走 IndustryConcentrationGuard.rebalanceIndustry 内部经
 *       paperTradingFacade.closePosition，保持 facade 收敛 + 不绕开 pre-trade
 *       guard 链路。
 *
 *       IMPORTANT: registered BEFORE the `/:id` catchall route per the
 *       US-015 ordering rule (Express matches top-down — `/:id` would
 *       otherwise consume "rebalance-industry" as a `:id` param).
 * @access Private
 */
router.post(
  '/rebalance-industry',
  authController.authenticate,
  [body('portfolio_id').optional().isInt({ min: 1 }), body('dry_run').optional().isBoolean()],
  validateRequest,
  portfolioController.rebalanceIndustry
);

/**
 * @route GET /api/portfolio/:id
 * @desc 获取投资组合模拟详情
 * @access Private
 */
router.get('/:id', authController.authenticate, portfolioController.getSimulationDetail);

/**
 * @route POST /api/portfolio/validate-stocks
 * @desc 批量验证股票
 * @access Private
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
