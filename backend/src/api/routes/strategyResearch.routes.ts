import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { strategyResearchController } from '../controllers/StrategyResearchController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/strategy-research/center:
 *   get:
 *     tags: [研究 StrategyResearch]
 *     summary: 获取研究中心首页聚合数据
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 研究中心数据, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/center',
  authController.authenticate,
  strategyResearchController.getCenter.bind(strategyResearchController)
);

/**
 * @openapi
 * /api/strategy-research/opening-preflight:
 *   get:
 *     tags: [研究 StrategyResearch]
 *     summary: 获取开盘前 Preflight 报告
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Preflight 报告, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/opening-preflight',
  authController.authenticate,
  strategyResearchController.getOpeningPreflight.bind(strategyResearchController)
);

/**
 * @openapi
 * /api/strategy-research/opening-preflight/dry-run:
 *   post:
 *     tags: [研究 StrategyResearch]
 *     summary: 触发一次开盘前 Preflight dry-run
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: dry-run 结果, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/opening-preflight/dry-run',
  authController.authenticate,
  strategyResearchController.runOpeningDryRun.bind(strategyResearchController)
);

export default router;
