import { Router } from 'express';
import { body } from 'express-validator';
import { StrategyController } from '../controllers/StrategyController';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const strategyController = new StrategyController();

/**
 * @route GET /api/strategies
 * @desc 获取所有可用策略
 * @access Public
 */
router.get('/', strategyController.getStrategies.bind(strategyController));

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
