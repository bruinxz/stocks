import { Router } from 'express';
import { sentimentController } from '../controllers/SentimentController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/sentiment/index/latest:
 *   get:
 *     tags: [情绪 Sentiment]
 *     summary: 获取最新一日市场情绪指数
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 最新情绪指数, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/index/latest', authController.authenticate, (req, res) => {
  void sentimentController.getLatestIndex(req, res);
});

/**
 * @openapi
 * /api/sentiment/index/compute:
 *   post:
 *     tags: [情绪 Sentiment]
 *     summary: 触发情绪指数计算
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               date: { type: string, format: date }
 *     responses:
 *       200: { description: 计算完成, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/index/compute', authController.authenticate, (req, res) => {
  void sentimentController.compute(req, res);
});

/**
 * @openapi
 * /api/sentiment/index:
 *   get:
 *     tags: [情绪 Sentiment]
 *     summary: 获取最近 N 天市场情绪指数时序 (US-057)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: days, schema: { type: integer, default: 30, maximum: 365 }, description: 回看天数 }
 *     responses:
 *       200: { description: 情绪指数时序, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/index', authController.authenticate, (req, res) => {
  void sentimentController.getIndexSeries(req, res);
});

/**
 * @openapi
 * /api/sentiment/snowball-keywords:
 *   get:
 *     tags: [情绪 Sentiment]
 *     summary: 获取某交易日的雪球热词榜 (US-058)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: date, schema: { type: string, format: date }, description: 'YYYY-MM-DD (默认: 最近一日有数据)' }
 *       - { in: query, name: only_new, schema: { type: boolean }, description: 只返回相对前一日 baseline 的新进关键词 }
 *       - { in: query, name: limit, schema: { type: integer, default: 200, maximum: 1000 }, description: 返回上限 }
 *     responses:
 *       200: { description: 热词榜, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/snowball-keywords', authController.authenticate, (req, res) => {
  void sentimentController.getSnowballKeywords(req, res);
});

/**
 * @openapi
 * /api/sentiment/qa-topics:
 *   get:
 *     tags: [情绪 Sentiment]
 *     summary: 某股票最近 N 周的投资者问答 NLP 聚合 (US-060)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: stock_code, required: true, schema: { type: string }, description: 6 位股票代码 }
 *       - { in: query, name: weeks, schema: { type: integer, default: 26, maximum: 104 }, description: 回看周数 }
 *     responses:
 *       200: { description: QA 话题聚合, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/qa-topics', authController.authenticate, (req, res) => {
  void sentimentController.getQATopics(req, res);
});

/**
 * @openapi
 * /api/sentiment/qa-industry-heat:
 *   get:
 *     tags: [情绪 Sentiment]
 *     summary: 行业 QA 热度榜 — 某行业内最近 N 天最活跃的 top N 股票 (US-121 QA-004)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: industry, required: true, schema: { type: string }, description: 行业名 (与 Stock.industry 一致) }
 *       - { in: query, name: lookback_days, schema: { type: integer, default: 7, maximum: 365 }, description: 回看天数 }
 *       - { in: query, name: top, schema: { type: integer, default: 10, maximum: 100 }, description: top N 上限 }
 *     responses:
 *       200: { description: 行业 QA 热度榜, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/qa-industry-heat', authController.authenticate, (req, res) => {
  void sentimentController.getIndustryQAHeat(req, res);
});

export default router;
