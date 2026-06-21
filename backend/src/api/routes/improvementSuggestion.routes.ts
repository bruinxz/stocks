import { Router } from 'express';
import { improvementSuggestionController } from '../controllers/ImprovementSuggestionController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * US-126 [PM-024] — ImprovementSuggestion apply route
 *
 * Mount: /api/me/improvement-suggestions
 *   (与 [[ImprovementSuggestion]] model jsdoc / [[ImprovementSuggestionService]] jsdoc
 *   声明的 PM-024 路径对齐)
 *
 * 本 story 仅 1 个 endpoint (apply). 后续 story (list / dismiss / bulk apply)
 * 在同 router 增量挂.
 */

/**
 * @openapi
 * /api/me/improvement-suggestions:
 *   get:
 *     tags: [改进建议 ImprovementSuggestion]
 *     summary: Macro 串联补丁 (2026-06-21) — 列出当前用户的改进建议
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, applied, dismissed, expired], default: open }
 *         description: 过滤状态; 默认 open
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *     responses:
 *       200:
 *         description: 列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     items:
 *                       type: array
 *                       items: { type: object }
 *       401: { description: 未登录 }
 */
router.get(
  '/',
  authController.authenticate,
  improvementSuggestionController.listImprovementSuggestions
);

/**
 * @openapi
 * /api/me/improvement-suggestions/{id}/apply:
 *   post:
 *     tags: [改进建议 ImprovementSuggestion]
 *     summary: US-126 PM-024 — 应用一条改进建议 (status='open' → 'applied' + 写 applied_at)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *         description: improvement_suggestions.id
 *     responses:
 *       200:
 *         description: 应用成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: integer }
 *                     status: { type: string, enum: [applied] }
 *                     applied_at: { type: string, format: date-time }
 *                     action_type:
 *                       type: string
 *                       enum: [noop, tune_risk_param, enable_kill_switch, open_workspace_tab]
 *                     action: { type: object }
 *       400: { description: id 非法 }
 *       401: { description: 未登录 }
 *       404: { description: 建议不存在 (亦兼容跨用户访问) }
 *       409: { description: 建议非 'open' 状态 (已 applied / dismissed / expired) }
 */
router.post(
  '/:id/apply',
  authController.authenticate,
  improvementSuggestionController.applyImprovementSuggestion
);

export default router;
