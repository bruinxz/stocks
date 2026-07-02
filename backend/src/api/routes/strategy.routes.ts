import { Router } from 'express';
import { factorController } from '../controllers/FactorController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/strategies/multi-factor/latest-picks:
 *   get:
 *     tags: [策略 Strategies]
 *     summary: 多因子策略最近一次调仓结果 (US-015)
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

export default router;
