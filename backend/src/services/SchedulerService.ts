import cron, { ScheduledTask as CronScheduledTask } from 'node-cron';
import { ScheduledTask } from '../models/ScheduledTask';
import { logger } from '../utils/logger';
import { dataUpdateQueue } from '../jobs/dataUpdateQueue';

class SchedulerService {
  private activeTasks: Map<number, CronScheduledTask> = new Map();

  async initialize() {
    try {
      const tasks = await ScheduledTask.findAll({ where: { is_active: true } });
      logger.info(`Found ${tasks.length} active scheduled tasks`);

      for (const task of tasks) {
        this.scheduleTask(task);
      }
    } catch (error) {
      logger.error('Failed to initialize scheduler:', error);
    }
  }

  private scheduleTask(task: ScheduledTask) {
    // 停止已有的任务
    if (this.activeTasks.has(task.id)) {
      this.activeTasks.get(task.id)?.stop();
      this.activeTasks.delete(task.id);
    }

    if (!cron.validate(task.cron_expression)) {
      logger.error(`Invalid cron expression for task ${task.id}: ${task.cron_expression}`);
      return;
    }

    const scheduledJob = cron.schedule(task.cron_expression, async () => {
      logger.info(`Executing scheduled task: ${task.name} (${task.type})`);
      try {
        await task.update({ last_run_at: new Date(), last_run_status: 'RUNNING' });

        // 调度具体的任务
        if (task.type === 'SYNC_ALL_STOCKS') {
          await dataUpdateQueue.add(
            'bulk_sync_custom',
            {
              type: 'bulk_sync_custom',
              date: new Date().toISOString().split('T')[0],
              syncAllStocks: true,
              concurrency: 2, // 使用低并发保护服务器资源
            },
            {
              jobId: `syncAllStocks-${Date.now()}`,
              attempts: 3,
              backoff: { type: 'exponential', delay: 60000 },
            }
          );
        } else if (task.type === 'SYNC_HISTORY') {
          // 从参数中提取需要同步的股票或全量
          const symbols = task.parameters?.symbols || [];
          await dataUpdateQueue.add(
            'bulk_sync_custom',
            {
              type: 'bulk_sync_custom',
              date: new Date().toISOString().split('T')[0],
              symbols: symbols,
              concurrency: 2, // 使用低并发保护服务器资源
            },
            {
              jobId: `syncHistory-${Date.now()}`,
            }
          );
        } else if (task.type === 'AI_DAILY_SCREENER') {
          // 这里将来可以实现自动选股逻辑
          logger.info('AI_DAILY_SCREENER executed');
        }

        await task.update({ last_run_status: 'SUCCESS' });
      } catch (error: any) {
        logger.error(`Error executing scheduled task ${task.name}:`, error);
        await task.update({ last_run_status: 'FAILED' });
      }
    });

    this.activeTasks.set(task.id, scheduledJob);
    logger.info(
      `Scheduled task ${task.id} (${task.name}) registered with cron: ${task.cron_expression}`
    );
  }

  async reloadTask(taskId: number) {
    const task = await ScheduledTask.findByPk(taskId);
    if (!task) return;

    if (task.is_active) {
      this.scheduleTask(task);
    } else {
      if (this.activeTasks.has(task.id)) {
        this.activeTasks.get(task.id)?.stop();
        this.activeTasks.delete(task.id);
        logger.info(`Stopped scheduled task ${task.id}`);
      }
    }
  }

  async getAllTasks() {
    return await ScheduledTask.findAll({ order: [['id', 'ASC']] });
  }

  async createTask(data: any) {
    const task = await ScheduledTask.create(data);
    if (task.is_active) {
      this.scheduleTask(task);
    }
    return task;
  }

  async updateTask(id: number, data: any) {
    const task = await ScheduledTask.findByPk(id);
    if (!task) throw new Error('Task not found');

    await task.update(data);
    await this.reloadTask(id);
    return task;
  }

  async deleteTask(id: number) {
    const task = await ScheduledTask.findByPk(id);
    if (task) {
      if (this.activeTasks.has(id)) {
        this.activeTasks.get(id)?.stop();
        this.activeTasks.delete(id);
      }
      await task.destroy();
    }
  }
}

export const schedulerService = new SchedulerService();
