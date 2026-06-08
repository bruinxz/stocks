import { Router } from 'express';
import { factorController } from '../controllers/FactorController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * US-015 因子选股工作区后端路由。
 *
 * GET  /api/factors/overview          → 8 因子列表 + 最新计算日 + 横截面覆盖统计
 * POST /api/factors/preview           → 自定义权重 / 参数 预览 top-N 选股
 * GET  /api/factors/industry-heatmap  → 行业 × 因子 z_score 平均值矩阵 (US-074)
 *
 * 注意：MFA 最新调仓结果 `GET /api/strategies/multi-factor/latest-picks` 是
 *      strategy.routes.ts 的路由（必须在 `/:strategyId` 通配之前注册），
 *      不在本文件。
 */

/**
 * @openapi
 * /api/factors/overview:
 *   get:
 *     tags: [因子 Factors]
 *     summary: 8 因子列表 + 最新计算日 + 横截面覆盖统计
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 操作成功 }
 *       401: { description: 未授权 }
 */
router.get(
  '/overview',
  authController.authenticate,
  factorController.getOverview.bind(factorController)
);

/**
 * @openapi
 * /api/factors/preview:
 *   post:
 *     tags: [因子 Factors]
 *     summary: 自定义权重/参数预览 top-N 选股
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               weights: { type: object, description: 因子名 -> 权重 }
 *               top_n: { type: integer, default: 50 }
 *               date: { type: string, format: date }
 *     responses:
 *       200: { description: 操作成功 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/preview',
  authController.authenticate,
  factorController.previewSelection.bind(factorController)
);

/**
 * @openapi
 * /api/factors/industry-heatmap:
 *   get:
 *     tags: [因子 Factors]
 *     summary: 行业 × 因子 z_score 平均值热力图 (US-074)
 *     description: 给定 trade_date（缺省 = factor_scores 最新一日），返回每个 (industry, factor) 组合的平均 z_score 与样本数，前端用 echarts heatmap 渲染。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: date
 *         required: false
 *         schema: { type: string, format: date }
 *         description: 截面交易日 YYYY-MM-DD；不传则用 factor_scores 表最新一日
 *     responses:
 *       200: { description: 行业 × 因子 cells, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: date 格式错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/industry-heatmap',
  authController.authenticate,
  factorController.getIndustryHeatmap.bind(factorController)
);

export default router;
