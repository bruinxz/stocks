import { Router } from 'express';
import { factorController } from '../controllers/FactorController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * US-015 因子选股工作区后端路由。
 *
 * GET  /api/factors/overview   → 8 因子列表 + 最新计算日 + 横截面覆盖统计
 * POST /api/factors/preview    → 自定义权重 / 参数 预览 top-N 选股
 *
 * 注意：MFA 最新调仓结果 `GET /api/strategies/multi-factor/latest-picks` 是
 *      strategy.routes.ts 的路由（必须在 `/:strategyId` 通配之前注册），
 *      不在本文件。
 */

router.get(
  '/overview',
  authController.authenticate,
  factorController.getOverview.bind(factorController)
);

router.post(
  '/preview',
  authController.authenticate,
  factorController.previewSelection.bind(factorController)
);

export default router;
