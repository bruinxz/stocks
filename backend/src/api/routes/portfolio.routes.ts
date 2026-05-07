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
