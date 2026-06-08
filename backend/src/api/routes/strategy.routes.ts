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
 * @openapi
 * /api/strategies:
 *   get:
 *     tags: [策略 Strategies]
 *     summary: 获取所有可用策略
 *     security: []
 *     responses:
 *       200: { description: 策略列表, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/', strategyController.getStrategies.bind(strategyController));

/**
 * @openapi
 * /api/strategies/multi-factor/latest-picks:
 *   get:
 *     tags: [策略 Strategies]
 *     summary: 多因子策略最近一次调仓结果 (US-015)
 *     description: Must be registered before /:strategyId — otherwise Express's catchall would consume "multi-factor" as the strategyId param.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: target_portfolio 与 per-stock signal, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/multi-factor/latest-picks',
  authController.authenticate,
  factorController.getMultiFactorLatestPicks.bind(factorController)
);

/**
 * @openapi
 * /api/strategies/{strategyId}:
 *   get:
 *     tags: [策略 Strategies]
 *     summary: 获取策略详情
 *     security: []
 *     parameters:
 *       - { in: path, name: strategyId, required: true, schema: { type: string }, description: 策略 ID }
 *     responses:
 *       200: { description: 策略详情, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 策略不存在 }
 */
router.get('/:strategyId', strategyController.getStrategyDetail.bind(strategyController));

/**
 * @openapi
 * /api/strategies/validate:
 *   post:
 *     tags: [策略 Strategies]
 *     summary: 验证策略参数
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [strategyId, params]
 *             properties:
 *               strategyId: { type: string }
 *               params: { type: object }
 *     responses:
 *       200: { description: 验证结果, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/validate',
  [body('strategyId').isString(), body('params').isObject()],
  validateRequest,
  strategyController.validateStrategyParams.bind(strategyController)
);

/**
 * @openapi
 * /api/strategies/{strategyId}/stats:
 *   get:
 *     tags: [策略 Strategies]
 *     summary: 获取策略性能统计
 *     security: []
 *     parameters:
 *       - { in: path, name: strategyId, required: true, schema: { type: string }, description: 策略 ID }
 *     responses:
 *       200: { description: 性能统计, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/:strategyId/stats', strategyController.getStrategyStats.bind(strategyController));

export default router;
