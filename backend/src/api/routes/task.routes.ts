import { Router } from 'express';
import { taskController } from '../controllers/TaskController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/tasks
 * @desc 获取定时任务列表
 * @access Private
 */
router.get('/', authController.authenticate, taskController.getTasks);

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
