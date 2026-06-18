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
 * GET  /api/factors/industry-board    → 行业资金决策面板 (Batch AF 2026-06-18)
 * GET  /api/factors/:name/detail      → 单因子 IC 历史 + 5 等分组合净值 (US-094)
 *
 * 路由顺序约束（与 US-015 strategy.routes.ts 同款 lesson）：
 *   - `/overview`, `/preview`, `/industry-heatmap`, `/industry-board` 必须在
 *     `/:name/detail` 之前注册，否则 :name 通配会吞这些静态路径变成 404。本文
 *     件按 static-first / :param-last 物理顺序排列；新增静态路径必须保留在
 *     :name/detail 之上。
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

/**
 * @openapi
 * /api/factors/industry-board:
 *   get:
 *     tags: [因子 Factors]
 *     summary: 行业决策面板 (Batch AF 2026-06-18) — 板块资金流 + 龙头 + 热门概念
 *     description: |
 *       基于 IndustryFlow / LimitUpStock / SnowballHotKeyword 真实盘口数据, 替代
 *       因子 z_score 抽象热力图, 让用户直接看到 "今天哪个板块在涨 + 主力流入"
 *       + "板块龙头股" + "近 N 日序列" + "今日热门概念"。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: date, required: false, schema: { type: string, format: date } }
 *       - { in: query, name: top, required: false, schema: { type: integer, minimum: 1, maximum: 100, default: 30 } }
 *       - { in: query, name: lookback, required: false, schema: { type: integer, minimum: 1, maximum: 20, default: 5 } }
 *     responses:
 *       200: { description: 行业决策面板数据 }
 *       400: { description: date 格式错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/industry-board',
  authController.authenticate,
  factorController.getIndustryBoard.bind(factorController)
);

/**
 * @openapi
 * /api/factors/stock/{stock_code}:
 *   get:
 *     tags: [因子 Factors]
 *     summary: 单股横截面因子分数 (z_score + percentile, 最新一天)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: stock_code
 *         required: true
 *         schema: { type: string, pattern: '^\d{6}$' }
 *     responses:
 *       200: { description: 该股票当日所有因子的 z_score / percentile }
 *       400: { description: stock_code 必须是 6 位数字 }
 */
router.get(
  '/stock/:stock_code',
  authController.authenticate,
  factorController.getStockFactors.bind(factorController)
);

/**
 * @openapi
 * /api/factors/{name}/detail:
 *   get:
 *     tags: [因子 Factors]
 *     summary: 单因子详情 — IC 曲线 + 5 等分组合净值 (US-094)
 *     description: |
 *       Must be registered AFTER /overview / /preview / /industry-heatmap — otherwise
 *       Express's :name catchall would consume those static paths.
 *
 *       返回 3 段：因子元信息 + IC 历史曲线（按 period_end ASC）+ 5 等分组合累计净值
 *       曲线 Q1..Q5（按 trade_date ASC，起点 1.0）。
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: name, required: true, schema: { type: string }, description: 因子名（snake_case） }
 *       - { in: query, name: limit_days, required: false, schema: { type: integer, minimum: 1, maximum: 250, default: 120 }, description: 抓取最近 N 个交易日 }
 *       - { in: query, name: ic_limit, required: false, schema: { type: integer, minimum: 1, maximum: 200, default: 60 }, description: 抓取最近 N 条 IC 历史 }
 *     responses:
 *       200: { description: 因子详情, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 因子名非法 }
 *       401: { description: 未授权 }
 *       404: { description: 因子未注册 }
 */
router.get(
  '/:name/detail',
  authController.authenticate,
  factorController.getFactorDetail.bind(factorController)
);

export default router;
