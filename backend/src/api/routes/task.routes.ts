import { Router } from 'express';
import { taskController } from '../controllers/TaskController';
import { AuthController } from '../controllers/AuthController';
import { authenticateInternalApi } from '../../middlewares/internalAuth';
import { requireRole } from '../../middlewares/auth';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/tasks:
 *   get:
 *     tags: [任务 Tasks]
 *     summary: 获取定时任务列表
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 任务列表, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/', authController.authenticate, taskController.getTasks);

/**
 * @openapi
 * /api/tasks/automation-health:
 *   get:
 *     tags: [任务 Tasks]
 *     summary: 获取自动荐股闭环/定时任务链路健康状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 健康状态, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/automation-health', authController.authenticate, taskController.getAutomationHealth);

/**
 * @openapi
 * /api/tasks/runtime-schema-health:
 *   get:
 *     tags: [任务 Tasks]
 *     summary: 获取生产数据库运行时 schema owner/grant 健康状态
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: schema 健康状态, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/runtime-schema-health',
  authController.authenticate,
  taskController.getRuntimeSchemaHealth
);

/**
 * @openapi
 * /api/tasks/notification-deliveries/health:
 *   get:
 *     tags: [任务 Tasks]
 *     summary: 获取飞书通知 outbox 健康状态（管理员）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: outbox 状态计数、积压与死信 }
 */
router.get(
  '/notification-deliveries/health',
  authController.authenticate,
  requireRole('admin'),
  taskController.getFeishuNotificationHealth
);
/**
 * @openapi
 * /api/tasks/notification-deliveries:
 *   get:
 *     tags: [任务 Tasks]
 *     summary: 查询飞书通知投递明细（管理员）
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 最近投递明细 }
 */
router.get(
  '/notification-deliveries',
  authController.authenticate,
  requireRole('admin'),
  taskController.getFeishuNotificationDeliveries
);
/**
 * @openapi
 * /api/tasks/notification-deliveries/{id}/retry:
 *   post:
 *     tags: [任务 Tasks]
 *     summary: 重投 dead/suppressed 飞书通知（管理员）
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: 重投结果 }
 *       404: { description: outbox 记录不存在 }
 */
router.post(
  '/notification-deliveries/:id/retry',
  authController.authenticate,
  requireRole('admin'),
  taskController.retryFeishuNotification
);

/**
 * @openapi
 * /api/tasks/parameter-audits:
 *   get:
 *     tags: [任务 Tasks]
 *     summary: 获取任务参数变更审计记录
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 审计记录, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/parameter-audits', authController.authenticate, taskController.getTaskParameterAudits);

/**
 * @openapi
 * /api/tasks/deployment-smoke-report:
 *   post:
 *     tags: [任务 Tasks]
 *     summary: 记录部署后只读冒烟测试结果
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: 记录成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/deployment-smoke-report',
  (req, res, next) => {
    const hasInternalKey = Boolean(req.headers['x-api-key'] || req.query.api_key);
    if (hasInternalKey) return authenticateInternalApi(req, res, next);
    return authController.authenticate(req, res, next);
  },
  taskController.reportDeploymentSmoke
);

/**
 * @openapi
 * /api/tasks/risk-limit-suggestion/apply:
 *   post:
 *     tags: [任务 Tasks]
 *     summary: 预览或手动应用风险阈值建议
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               dry_run: { type: boolean }
 *     responses:
 *       200: { description: 应用结果, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/risk-limit-suggestion/apply',
  authController.authenticate,
  requireRole('admin'),
  taskController.applyRiskLimitSuggestion
);

/**
 * @openapi
 * /api/tasks/live-shadow-budget-suggestion/apply:
 *   post:
 *     tags: [任务 Tasks]
 *     summary: 预览或手动应用影子执行预算候选补丁
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               dry_run: { type: boolean }
 *     responses:
 *       200: { description: 应用结果, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/live-shadow-budget-suggestion/apply',
  authController.authenticate,
  requireRole('admin'),
  taskController.applyLiveShadowBudgetSuggestion
);

/**
 * @openapi
 * /api/tasks/{id}/logs:
 *   get:
 *     tags: [任务 Tasks]
 *     summary: 获取定时任务执行日志
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 任务 ID }
 *     responses:
 *       200: { description: 执行日志, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 任务不存在 }
 */
router.get('/:id/logs', authController.authenticate, taskController.getTaskLogs);

/**
 * @openapi
 * /api/tasks:
 *   post:
 *     tags: [任务 Tasks]
 *     summary: 创建定时任务
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: 创建成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
// Batch U (2026-06-17): mutating endpoints (create/update/run/delete) 加 admin gate.
// docs 写"管理员"但之前只 authenticate, 任何登录 user 可创建/改/跑/删 cron task.
router.post('/', authController.authenticate, requireRole('admin'), taskController.createTask);

/**
 * @openapi
 * /api/tasks/{id}:
 *   put:
 *     tags: [任务 Tasks]
 *     summary: 更新定时任务
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 任务 ID }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200: { description: 更新成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 任务不存在 }
 */
router.put('/:id', authController.authenticate, requireRole('admin'), taskController.updateTask);

/**
 * @openapi
 * /api/tasks/{id}/run:
 *   post:
 *     tags: [任务 Tasks]
 *     summary: 手动执行定时任务
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 任务 ID }
 *     responses:
 *       200: { description: 执行成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 任务不存在 }
 */
router.post(
  '/:id/run',
  authController.authenticate,
  requireRole('admin'),
  taskController.executeTask
);

/**
 * @openapi
 * /api/tasks/{id}:
 *   delete:
 *     tags: [任务 Tasks]
 *     summary: 删除定时任务
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string }, description: 任务 ID }
 *     responses:
 *       200: { description: 删除成功, content: { application/json: { schema: { $ref: '#/components/schemas/SuccessResponse' } } } }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 *       404: { description: 任务不存在 }
 */
router.delete('/:id', authController.authenticate, requireRole('admin'), taskController.deleteTask);

export default router;
