import { Router } from 'express';
import { LogController } from '../controllers/LogController';
import { AuthController } from '../controllers/AuthController';
import { requireRole } from '../../middlewares/auth';

const router = Router();
const logController = new LogController();
const authController = new AuthController();

/**
 * @swagger
 * tags:
 *   name: Logs
 *   description: 系统日志管理与查询
 */

/**
 * @swagger
 * /api/logs:
 *   get:
 *     tags: [Logs]
 *     summary: 分页获取系统日志
 *     description: 支持按日志级别(level)、关键词(keyword)和日志类型(type)筛选
 *     security:
 *       - bearerAuth: []
 */
// Batch U (2026-06-17, log-1 fix): 加 admin gate. combined.log 含其他用户的
// validateRequest 失败 body (含 password), portfolio simulate body 等, 普通登录
// 用户读到 = 跨用户数据泄露 + 密码泄露. 必须 admin only.
router.get('/', authController.authenticate, requireRole('admin'), logController.getLogs);

/**
 * @swagger
 * /api/logs/stats:
 *   get:
 *     tags: [Logs]
 *     summary: 获取日志级别统计
 *     description: 统计不同级别的日志数量(如info, warn, error)
 *     security:
 *       - bearerAuth: []
 */
router.get('/stats', authController.authenticate, requireRole('admin'), logController.getLogStats);

export default router;
