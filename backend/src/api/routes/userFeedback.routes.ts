/**
 * userFeedback routes — Batch AL (2026-06-21) — SystemWorkspace 用户反馈闭环.
 *
 * Mount:
 *   - /api/me/feedbacks       (用户自服务)
 *   - /api/admin/feedbacks    (管理员 resolve)
 *
 * 鉴权: 全部走 AuthController.authenticate; admin 路由额外在 controller 内 role check
 * (与 user.routes 提前用 requireRole('admin') 守的方式等效, 但保留 controller 内
 * 检查给单测能不通过 mock middleware 直接测 controller).
 */

import { Router } from 'express';
import { userFeedbackController } from '../controllers/UserFeedbackController';
import { AuthController } from '../controllers/AuthController';
import { uploadFeedbackImagesMiddleware } from '../../middlewares/uploadFeedback';

const meRouter = Router();
const adminRouter = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/me/feedbacks:
 *   get:
 *     tags: [用户反馈 UserFeedback]
 *     summary: Batch AL — 列出当前用户的反馈
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, in_progress, resolved, dismissed, all] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *     responses:
 *       200: { description: 列表 }
 *       401: { description: 未登录 }
 */
meRouter.get('/', authController.authenticate, userFeedbackController.listMyFeedbacks);

/**
 * @openapi
 * /api/me/feedbacks:
 *   post:
 *     tags: [用户反馈 UserFeedback]
 *     summary: Batch AL — 提交反馈 (multipart/form-data 含图片)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string, maxLength: 200 }
 *               description: { type: string }
 *               images:
 *                 type: array
 *                 items: { type: string, format: binary }
 *     responses:
 *       200: { description: 创建成功 }
 *       400: { description: 参数非法 }
 *       401: { description: 未登录 }
 */
meRouter.post(
  '/',
  authController.authenticate,
  uploadFeedbackImagesMiddleware.array('images', 9),
  userFeedbackController.createMyFeedback
);

/**
 * @openapi
 * /api/admin/feedbacks/{id}/resolve:
 *   post:
 *     tags: [用户反馈 UserFeedback]
 *     summary: Batch AL — admin 解决反馈 (status='resolved' + resolution_note)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [resolution_note]
 *             properties:
 *               resolution_note: { type: string }
 *               resolution_commit_hash: { type: string }
 *               resolution_pr_number: { type: integer, minimum: 1 }
 *               status: { type: string, enum: [resolved, dismissed], default: resolved }
 *     responses:
 *       200: { description: 解决成功 }
 *       400: { description: 参数非法 }
 *       401: { description: 未登录 }
 *       403: { description: 非管理员 }
 *       404: { description: 不存在 }
 *       409: { description: 已解决 }
 */
adminRouter.post(
  '/:id/resolve',
  authController.authenticate,
  userFeedbackController.resolveFeedback
);

export { meRouter as userFeedbackMeRoutes, adminRouter as userFeedbackAdminRoutes };
