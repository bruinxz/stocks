import { Router } from 'express';
import { blackSwanEventController } from '../controllers/BlackSwanEventController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * US-133 [PR-018] — 黑天鹅事件历史 read-only 路由.
 *
 * Mount: /api/black-swan
 *
 * 仅 2 个 read-only endpoint:
 *   - GET /events     — 分页列表 + 过滤
 *   - GET /events/:id — 单事件详情 + 关联 postmortem
 *
 * 任何"写"语义 (强 resolve / 调 severity / 标 expired) 走未来 PR 单独定义.
 */

/**
 * @openapi
 * /api/black-swan/events:
 *   get:
 *     tags: [黑天鹅 BlackSwan]
 *     summary: US-133 PR-018 — 黑天鹅事件分页列表 (按 detected_at DESC)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: event_type
 *         schema: { type: string, enum: [ST, SUSPENDED, NEWS_KEYWORD, SHAREHOLDER_REDUCTION, MARKET_REGIME, OTHER] }
 *       - in: query
 *         name: severity
 *         schema: { type: string, enum: [low, medium, high, critical] }
 *       - in: query
 *         name: scope
 *         schema: { type: string, enum: [symbol, sector, market, portfolio] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, resolved, expired] }
 *       - in: query
 *         name: symbol
 *         schema: { type: string }
 *         description: 模糊匹配 symbol
 *       - in: query
 *         name: date_from
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: date_to
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 30, minimum: 1, maximum: 200 }
 *     responses:
 *       200:
 *         description: 分页事件列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items: { type: array, items: { type: object } }
 *                     total: { type: integer }
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *       401: { description: 未授权 }
 */
router.get('/events', authController.authenticate, blackSwanEventController.listEvents);

/**
 * @openapi
 * /api/black-swan/events/{id}:
 *   get:
 *     tags: [黑天鹅 BlackSwan]
 *     summary: US-133 PR-018 — 黑天鹅事件详情 + 关联 postmortem 报告 (可能 null)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: 事件详情 + postmortem 4 段 JSONB (可能 null 表示待生成)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     event: { type: object }
 *                     postmortem: { type: object, nullable: true }
 *       400: { description: id 非法 }
 *       401: { description: 未授权 }
 *       404: { description: 事件不存在 }
 */
router.get('/events/:id', authController.authenticate, blackSwanEventController.getEvent);

export default router;
