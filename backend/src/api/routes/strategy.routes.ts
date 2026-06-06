import { Router } from 'express';
import { body } from 'express-validator';
import { StrategyController } from '../controllers/StrategyController';
import { factorController } from '../controllers/FactorController';
import { AuthController } from '../controllers/AuthController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const strategyController = new StrategyController();
const authController = new AuthController();

/**
 * @route GET /api/strategies
 * @desc 获取所有可用策略
 * @access Public
 */
router.get('/', strategyController.getStrategies.bind(strategyController));

/**
 * @route GET /api/strategies/multi-factor/latest-picks
 * @desc US-015 多因子策略最近一次调仓结果（target_portfolio + per-stock signal）
 * @access Authenticated
 * @note  **Must be registered before /:strategyId** — otherwise Express's
 *        catchall would consume "multi-factor" as the strategyId param.
 */
router.get(
  '/multi-factor/latest-picks',
  authController.authenticate,
  factorController.getMultiFactorLatestPicks.bind(factorController)
);

/**
 * @route GET /api/strategies/:strategyId
 * @desc 获取策略详情
 * @access Public
 */
router.get('/:strategyId', strategyController.getStrategyDetail.bind(strategyController));

/**
 * @route POST /api/strategies/validate
 * @desc 验证策略参数
 * @access Public
 */
router.post(
  '/validate',
  [body('strategyId').isString(), body('params').isObject()],
  validateRequest,
  strategyController.validateStrategyParams.bind(strategyController)
);

/**
 * @route GET /api/strategies/:strategyId/stats
 * @desc 获取策略性能统计
 * @access Public
 */
router.get('/:strategyId/stats', strategyController.getStrategyStats.bind(strategyController));

export default router;
