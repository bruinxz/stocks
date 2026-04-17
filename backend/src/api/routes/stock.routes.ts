import { Router } from 'express';
import { query } from 'express-validator';
import { StockController } from '../controllers/StockController';
import { validateRequest } from '../../middlewares/validateRequest';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const stockController = new StockController();
const authController = new AuthController();

/**
 * @route GET /api/stocks
 * @desc 获取股票列表（支持分页、筛选、搜索）
 * @access Public
 */
router.get(
  '/',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('market').optional().isString(),
    query('industry').optional().isString(),
    query('search').optional().isString(),
    query('listedOnly').optional().isBoolean(),
  ],
  validateRequest,
  stockController.getStockList
);

/**
 * @route GET /api/stocks/search/suggestions
 * @desc 获取股票搜索建议
 * @access Public
 */
router.get(
  '/search/suggestions',
  [query('q').isString().isLength({ min: 2 })],
  validateRequest,
  stockController.getSearchSuggestions
);

/**
 * @route GET /api/stocks/market-stats
 * @desc 获取市场统计信息
 * @access Public
 */
router.get('/market-stats', stockController.getMarketStats);

/**
 * @route GET /api/stocks/:symbol
 * @desc 获取股票详情
 * @access Public
 */
router.get('/:symbol', stockController.getStockDetail);

/**
 * @route GET /api/stocks/:symbol/daily-bars
 * @desc 获取股票日线数据
 * @access Public
 */
router.get(
  '/:symbol/daily-bars',
  [
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
    query('limit').optional().isInt({ min: 1, max: 5000 }),
  ],
  validateRequest,
  stockController.getDailyBars
);

export default router;
