import { Router } from 'express';
import { body, query } from 'express-validator';
import { BacktestController } from '../controllers/BacktestController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const backtestController = new BacktestController();
const authController = new AuthController();

/**
 * @route POST /api/backtests
 * @desc 创建并运行回测
 * @access Private
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
    body('startDate').isISO8601(),
    body('endDate').isISO8601(),
    body('initialCapital').isFloat({ min: 1000 }),
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
 * @route GET /api/backtests
 * @desc 获取回测列表
 * @access Private
 */
router.get(
  '/',
  authController.authenticate,
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isString(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
  ],
  validateRequest,
  backtestController.getBacktestList
);

/**
 * @route GET /api/backtests/stats
 * @desc 获取回测统计信息
 * @access Private
 */
router.get(
  '/stats',
  authController.authenticate,
  backtestController.getBacktestStats
);

/**
 * @route GET /api/backtests/:id
 * @desc 获取回测详情
 * @access Private
 */
router.get(
  '/:id',
  authController.authenticate,
  backtestController.getBacktestDetail
);

/**
 * @route DELETE /api/backtests/:id
 * @desc 删除回测
 * @access Private
 */
router.delete(
  '/:id',
  authController.authenticate,
  backtestController.deleteBacktest
);

export default router;
