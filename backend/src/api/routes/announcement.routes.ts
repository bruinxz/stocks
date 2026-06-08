import { Router } from 'express';
import { announcementController } from '../controllers/AnnouncementController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * US-059 — 公司公告 NLP 抽取相关 endpoint.
 *
 * 路由前缀: /api/announcements
 *
 * NOTE: /by-date 与 /sync 必须在 /:stock_code 等 :param catchall 之前注册 (US-015 lesson)
 * —— 当前 controller 没有 :param 路由, 但显式 ordering 防未来加路由破坏匹配.
 */

/**
 * @openapi
 * /api/announcements:
 *   get:
 *     tags: [公告 Announcements]
 *     summary: 某只股票最近 N 天的公告 NLP 抽取列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: stock_code
 *         schema: { type: string }
 *         required: true
 *         description: 6 位股票代码
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 30, maximum: 365 }
 *         description: 回看天数
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 200, maximum: 1000 }
 *     responses:
 *       200: { description: 操作成功 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/', authController.authenticate, (req, res) => {
  void announcementController.listByStock(req, res);
});

/**
 * @openapi
 * /api/announcements/by-date:
 *   get:
 *     tags: [公告 Announcements]
 *     summary: 某交易日全市场公告列表
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: date
 *         schema: { type: string, format: date }
 *         required: true
 *         description: YYYY-MM-DD
 *       - in: query
 *         name: sentiment
 *         schema: { type: string, enum: ['正面', '中性', '负面'] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 200, maximum: 1000 }
 *     responses:
 *       200: { description: 操作成功 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/by-date', authController.authenticate, (req, res) => {
  void announcementController.listByDate(req, res);
});

/**
 * @openapi
 * /api/announcements/sync:
 *   post:
 *     tags: [公告 Announcements]
 *     summary: 手动触发某日同步 (admin)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               date: { type: string, format: date, description: 'YYYY-MM-DD (默认今日)' }
 *               symbol: { type: string, default: '全部', description: '全部/重大事项/...' }
 *               extract_with_ai: { type: boolean, default: false }
 *               dry_run: { type: boolean, default: false }
 *     responses:
 *       200: { description: 操作成功 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post('/sync', authController.authenticate, (req, res) => {
  void announcementController.triggerSync(req, res);
});

export default router;
