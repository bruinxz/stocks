import { Router } from 'express';
import { DocsController } from '../controllers/DocsController';
import { DocumentCommentsController } from '../controllers/DocumentCommentsController';
import { AuthController } from '../controllers/AuthController';
import { requireRole } from '../../middlewares/auth';

const router = Router();
const docsController = new DocsController();
const commentsController = new DocumentCommentsController();
const authController = new AuthController();

/**
 * @swagger
 * tags:
 *   name: Docs
 *   description: 运行时文档浏览 + 评论 (admin only, 支持热更新)
 */

// ==================== 文档读取 ====================
router.get('/tree', authController.authenticate, requireRole('admin'), docsController.getTree);
router.get('/file', authController.authenticate, requireRole('admin'), docsController.getFile);

// ==================== 评论 (飞书式, admin + AI 协作) ====================
router.get('/comments', authController.authenticate, requireRole('admin'), commentsController.list);
router.get(
  '/comments/stats',
  authController.authenticate,
  requireRole('admin'),
  commentsController.stats
);
router.post(
  '/comments',
  authController.authenticate,
  requireRole('admin'),
  commentsController.create
);
router.patch(
  '/comments/:id',
  authController.authenticate,
  requireRole('admin'),
  commentsController.update
);
router.delete(
  '/comments/:id',
  authController.authenticate,
  requireRole('admin'),
  commentsController.destroy
);

export default router;
