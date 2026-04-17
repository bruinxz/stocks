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
 * @route DELETE /api/tasks/:id
 * @desc 删除定时任务
 * @access Private
 */
router.delete('/:id', authController.authenticate, taskController.deleteTask);

export default router;
