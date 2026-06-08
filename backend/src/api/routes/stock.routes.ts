import { Router } from 'express';
import { query } from 'express-validator';
import { StockController } from '../controllers/StockController';
import { validateRequest } from '../../middlewares/validateRequest';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const stockController = new StockController();
const authController = new AuthController();

/**
 * @openapi
 * /api/stocks:
 *   get:
 *     tags: [股票 Stocks]
 *     summary: 获取股票列表 (支持分页、筛选、搜索)
 *     security: []
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, minimum: 1 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100 } }
 *       - { in: query, name: market, schema: { type: string } }
 *       - { in: query, name: industry, schema: { type: string } }
 *       - { in: query, name: search, schema: { type: string } }
 *       - { in: query, name: listedOnly, schema: { type: boolean } }
 *     responses:
 *       200: { description: 股票列表, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
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
 * @openapi
 * /api/stocks/search/suggestions:
 *   get:
 *     tags: [股票 Stocks]
 *     summary: 获取股票搜索建议
 *     security: []
 *     parameters:
 *       - { in: query, name: q, required: true, schema: { type: string, minLength: 2 }, description: 搜索关键词 }
 *     responses:
 *       200: { description: 搜索建议, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/search/suggestions',
  [query('q').isString().isLength({ min: 2 })],
  validateRequest,
  stockController.getSearchSuggestions
);

/**
 * @openapi
 * /api/stocks/market-stats:
 *   get:
 *     tags: [股票 Stocks]
 *     summary: 获取市场统计信息
 *     security: []
 *     responses:
 *       200: { description: 市场统计, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/market-stats', stockController.getMarketStats);

/**
 * @openapi
 * /api/stocks/{symbol}:
 *   get:
 *     tags: [股票 Stocks]
 *     summary: 获取股票详情
 *     security: []
 *     parameters:
 *       - { in: path, name: symbol, required: true, schema: { type: string }, description: 股票代码 }
 *     responses:
 *       200: { description: 股票详情, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 股票不存在 }
 */
router.get('/:symbol', stockController.getStockDetail);

/**
 * @openapi
 * /api/stocks/{symbol}/daily-bars:
 *   get:
 *     tags: [股票 Stocks]
 *     summary: 获取股票日线数据
 *     security: []
 *     parameters:
 *       - { in: path, name: symbol, required: true, schema: { type: string }, description: 股票代码 }
 *       - { in: query, name: start_date, schema: { type: string, format: date } }
 *       - { in: query, name: end_date, schema: { type: string, format: date } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 5000 } }
 *     responses:
 *       200: { description: 日线数据, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
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
