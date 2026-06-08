import { Router } from 'express';
import { body, query } from 'express-validator';
import { BacktestController } from '../controllers/BacktestController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const backtestController = new BacktestController();
const authController = new AuthController();

/**
 * @openapi
 * /api/backtests:
 *   post:
 *     tags: [回测 Backtests]
 *     summary: 创建并运行回测
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, symbols, start_date, end_date, initial_capital]
 *             properties:
 *               name: { type: string, minLength: 1, maxLength: 100 }
 *               description: { type: string, maxLength: 500 }
 *               symbols:
 *                 oneOf:
 *                   - { type: string }
 *                   - { type: array, items: { type: string } }
 *               start_date: { type: string, format: date }
 *               end_date: { type: string, format: date }
 *               initial_capital: { type: number, minimum: 1000 }
 *               strategyType: { type: string }
 *               strategyParams: { type: object }
 *               slippage: { type: number, minimum: 0, maximum: 0.1 }
 *               commissionRate: { type: number, minimum: 0, maximum: 0.1 }
 *               frequency: { type: string, enum: [daily, weekly, monthly] }
 *     responses:
 *       200: { description: 操作成功, content: { application/json: { schema: { $ref: '#/components/schemas/Backtest' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/',
  authController.authenticate,
  [
    body('name').isString().isLength({ min: 1, max: 100 }),
    body('description').optional().isString().isLength({ max: 500 }),
    body('symbols')
      .custom(value => {
        if (Array.isArray(value)) {
          return value.every(s => typeof s === 'string' && s.length > 0);
        }
        return typeof value === 'string' && value.length > 0;
      })
      .withMessage('symbols必须是字符串或字符串数组'),
    body('start_date').isISO8601(),
    body('end_date').isISO8601(),
    body('initial_capital').isFloat({ min: 1000 }),
    body('strategyType').optional().isString(),
    body('strategyParams').optional().isObject(),
    body('slippage').optional().isFloat({ min: 0, max: 0.1 }),
    body('commissionRate').optional().isFloat({ min: 0, max: 0.1 }),
    body('frequency').optional().isIn(['daily', 'weekly', 'monthly']),
  ],
  validateRequest,
  backtestController.createBacktest
);

/**
 * @openapi
 * /api/backtests:
 *   get:
 *     tags: [回测 Backtests]
 *     summary: 获取回测列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: start_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: end_date
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: 操作成功 }
 *       401: { description: 未授权 }
 */
router.get(
  '/',
  authController.authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isString(),
    query('start_date').optional().isISO8601(),
    query('end_date').optional().isISO8601(),
  ],
  validateRequest,
  backtestController.getBacktestList
);

/**
 * @openapi
 * /api/backtests/stats:
 *   get:
 *     tags: [回测 Backtests]
 *     summary: 获取回测统计数据
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 操作成功 }
 *       401: { description: 未授权 }
 */
router.get(
  '/stats',
  authController.authenticate,
  backtestController.getBacktestStats.bind(backtestController)
);

/**
 * @openapi
 * /api/backtests/{id}:
 *   get:
 *     tags: [回测 Backtests]
 *     summary: 获取指定回测的详细结果
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       200: { description: 操作成功 }
 *       401: { description: 未授权 }
 *       404: { description: 回测不存在 }
 */
router.get(
  '/:id',
  authController.authenticate,
  backtestController.getBacktestDetail.bind(backtestController)
);

/**
 * @openapi
 * /api/backtests/{id}/results:
 *   get:
 *     tags: [回测 Backtests]
 *     summary: 获取指定回测的结果 (兼容旧版 API)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       200: { description: 操作成功 }
 *       401: { description: 未授权 }
 *       404: { description: 回测不存在 }
 */
router.get(
  '/:id/results',
  authController.authenticate,
  backtestController.getBacktestDetail.bind(backtestController)
);

/**
 * @openapi
 * /api/backtests/{id}/trades:
 *   get:
 *     tags: [回测 Backtests]
 *     summary: 获取指定回测的交易明细 (兼容旧版 API)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       200: { description: 操作成功 }
 *       401: { description: 未授权 }
 *       404: { description: 回测不存在 }
 */
router.get(
  '/:id/trades',
  authController.authenticate,
  backtestController.getBacktestDetail.bind(backtestController)
);

/**
 * @openapi
 * /api/backtests/{id}:
 *   delete:
 *     tags: [回测 Backtests]
 *     summary: 删除回测
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: string }
 *         required: true
 *     responses:
 *       200: { description: 操作成功 }
 *       401: { description: 未授权 }
 *       404: { description: 回测不存在 }
 */
router.delete(
  '/:id',
  authController.authenticate,
  backtestController.deleteBacktest.bind(backtestController)
);

export default router;
