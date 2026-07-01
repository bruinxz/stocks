import { Router } from 'express';
import { DocsController } from '../controllers/DocsController';
import { AuthController } from '../controllers/AuthController';
import { requireRole } from '../../middlewares/auth';

const router = Router();
const docsController = new DocsController();
const authController = new AuthController();

/**
 * @swagger
 * tags:
 *   name: Docs
 *   description: 运行时文档浏览 (docs/ 目录, 支持热更新, 无需 rebuild)
 */

/**
 * @swagger
 * /api/docs/tree:
 *   get:
 *     tags: [Docs]
 *     summary: 获取 docs/ 目录树
 *     description: 递归列出所有 .md 文件和子目录, 只允许 admin 访问
 *     security:
 *       - bearerAuth: []
 */
// Admin gate: 文档可能含敏感设计信息 (SIGNAL_FIRST_PLAN 有 prod DB 数据等)
router.get('/tree', authController.authenticate, requireRole('admin'), docsController.getTree);

/**
 * @swagger
 * /api/docs/file:
 *   get:
 *     tags: [Docs]
 *     summary: 读取单个 markdown 文件
 *     parameters:
 *       - name: path
 *         in: query
 *         required: true
 *         schema: { type: string }
 *         description: docs/ 内的相对路径, 例如 "SIGNAL_FIRST_PLAN.md"
 *     security:
 *       - bearerAuth: []
 */
router.get('/file', authController.authenticate, requireRole('admin'), docsController.getFile);

export default router;
