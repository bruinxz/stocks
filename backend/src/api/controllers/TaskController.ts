import { Request, Response, NextFunction } from 'express';
import { schedulerService } from '../../services/SchedulerService';
import { TaskExecutionLog } from '../../models/TaskExecutionLog';
import { logger } from '../../utils/logger';

export class TaskController {
  async getTasks(req: Request, res: Response, next: NextFunction) {
    try {
      const tasks = await schedulerService.getAllTasks();
      res.json({ success: true, data: tasks });
    } catch (error: any) {
      logger.error('获取定时任务列表失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getTaskLogs(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const logs = await TaskExecutionLog.findAll({
        where: { task_id: parseInt(id) },
        order: [['created_at', 'DESC']],
        limit: 50, // 只返回最近50条
      });
      res.json({ success: true, data: logs });
    } catch (error: any) {
      logger.error('获取定时任务日志失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createTask(req: Request, res: Response, next: NextFunction) {
    try {
      const task = await schedulerService.createTask(req.body);
      res.json({ success: true, data: task });
    } catch (error: any) {
      logger.error('创建定时任务失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async updateTask(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const task = await schedulerService.updateTask(parseInt(id), req.body);
      res.json({ success: true, data: task });
    } catch (error: any) {
      logger.error('更新定时任务失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async executeTask(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const result = await schedulerService.executeTask(parseInt(id));
      res.json({ success: true, message: result.message });
    } catch (error: any) {
      logger.error('手动执行定时任务失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async deleteTask(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      await schedulerService.deleteTask(parseInt(id));
      res.json({ success: true, message: '定时任务已删除' });
    } catch (error: any) {
      logger.error('删除定时任务失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const taskController = new TaskController();
