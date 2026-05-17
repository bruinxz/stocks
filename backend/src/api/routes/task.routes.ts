import { Router } from 'express';
import { taskController } from '../controllers/TaskController';
import { AuthController } from '../controllers/AuthController';
import { authenticateInternalApi } from '../../middlewares/internalAuth';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/tasks
 * @desc 获取定时任务列表
 * @access Private
 */
router.get('/', authController.authenticate, taskController.getTasks);

/**
 * @route GET /api/tasks/automation-health
 * @desc 获取自动荐股闭环/定时任务链路健康状态
 * @access Private
 */
router.get('/automation-health', authController.authenticate, taskController.getAutomationHealth);

/**
 * @route GET /api/tasks/parameter-audits
 * @desc 获取任务参数变更审计记录
 * @access Private
 */
router.get('/parameter-audits', authController.authenticate, taskController.getTaskParameterAudits);

/**
 * @route POST /api/tasks/deployment-smoke-report
 * @desc 记录部署后只读冒烟测试结果
 * @access Private/Internal
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
 * @route POST /api/tasks/risk-limit-suggestion/apply
 * @desc 预览或手动应用风险阈值建议到关键自动化任务
 * @access Private
 */
router.post(
  '/risk-limit-suggestion/apply',
  authController.authenticate,
  taskController.applyRiskLimitSuggestion
);

/**
 * @route GET /api/tasks/:id/logs
 * @desc 获取定时任务执行日志
 * @access Private
 */
router.get('/:id/logs', authController.authenticate, taskController.getTaskLogs);

/**
 * @route POST /api/tasks
 * @desc 创建定时任务
 * @access Private
 */
router.post('/', authController.authenticate, taskController.createTask);

/**
 * @route PUT /api/tasks/:id
 * @desc 更新定时任务
 * @access Private
 */
router.put('/:id', authController.authenticate, taskController.updateTask);

/**
 * @route POST /api/tasks/:id/run
 * @desc 手动执行定时任务
 * @access Private
 */
router.post('/:id/run', authController.authenticate, taskController.executeTask);

/**
 * @route DELETE /api/tasks/:id
 * @desc 删除定时任务
 * @access Private
 */
router.delete('/:id', authController.authenticate, taskController.deleteTask);

export default router;
