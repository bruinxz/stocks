import cron, { ScheduledTask as CronScheduledTask } from 'node-cron';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { FavoriteStock } from '../models/FavoriteStock';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';
import { dataUpdateQueue } from '../jobs/dataUpdateQueue';
import { aiPollingQueue } from '../jobs/aiPollingQueue';
import { aiAdvisorService } from './AIAdvisorService';
import { quantRecommendationService } from './QuantRecommendationService';
import moment from 'moment-timezone';

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
      await this._executeTaskLogic(task, false);
    }, {
      timezone: 'Asia/Shanghai'
    });

    this.activeTasks.set(task.id, scheduledJob);
    logger.info(`Scheduled task ${task.id} (${task.name}) registered with cron: ${task.cron_expression}`);
  }

  private async _executeTaskLogic(task: ScheduledTask, isManual: boolean = false) {
    const timestamp = new Date();
    await task.update({ last_run_at: timestamp, last_run_status: 'RUNNING' });
    
    const executionLog = await TaskExecutionLog.create({
      task_id: task.id,
      task_name: task.name + (isManual ? ' (手动执行)' : ''),
      status: 'IN_PROGRESS',
      started_at: timestamp,
    });

    try {
      if (task.type === 'SYNC_ALL_STOCKS') {
        await dataUpdateQueue.add(
          'new_stocks_sync',
          {
            type: 'new_stocks_sync',
            date: new Date().toISOString().split('T')[0],
            syncAllStocks: true,
            concurrency: 2,
          },
          {
            jobId: `syncAllStocks-${isManual ? 'manual-' : ''}${Date.now()}`,
          }
        );
        
        await executionLog.update({ 
          status: 'COMPLETED', 
          completed_at: new Date(),
          total_items: 1,
          completed_items: 1
        });
      } else if (task.type === 'SYNC_HISTORY') {
        const symbols = task.parameters?.symbols || [];
        await dataUpdateQueue.add(
          'bulk_sync_custom',
          {
            type: 'bulk_sync_custom',
            date: new Date().toISOString().split('T')[0],
            symbols: symbols,
            concurrency: 2,
          },
          {
            jobId: `syncHistory-${isManual ? 'manual-' : ''}${Date.now()}`,
          }
        );
        
        await executionLog.update({ 
          status: 'COMPLETED', 
          completed_at: new Date(),
          total_items: 1,
          completed_items: 1
        });
      } else if (task.type === 'AI_DAILY_SCREENER') {
        logger.info('触发 AI_DAILY_SCREENER 任务，使用多因子候选池进行 TradingAgents 深度分析...');

        const today = moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
        const parameters = task.parameters || {};
        const candidateLimit = Math.min(Number(parameters.candidate_limit || parameters.limit || 10), 30);
        const universe = parameters.universe === 'market' ? 'market' : 'favorites';
        const style = ['balanced', 'momentum', 'value', 'low_risk'].includes(parameters.style)
          ? parameters.style
          : 'balanced';
        const targetDate = parameters.target_date || today;

        const candidateResult = await quantRecommendationService.generateRecommendations({
          universe,
          style,
          limit: candidateLimit,
          lookback_days: Number(parameters.lookback_days || 120),
          include_trend: false,
        });

        const candidates = candidateResult.recommendations;
        let count = 0;
        let failed = 0;

        await executionLog.update({ total_items: candidates.length });

        for (const candidate of candidates) {
          try {
            const res = await aiAdvisorService.analyzeStock(candidate.symbol, targetDate, true);
            if (res && res.task_id) {
              await aiPollingQueue.add(
                {
                  taskId: res.task_id,
                  symbol: candidate.symbol,
                  name: candidate.name,
                  executionLogId: executionLog.id,
                  taskLabel: task.name,
                  quant_score: candidate.score,
                  quant_factors: candidate.factors,
                  quant_reasons: candidate.reasons,
                  quant_warnings: candidate.warnings,
                  recommendation_style: style,
                  recommendation_source: universe,
                },
                {
                  jobId: `ai-poll-${isManual ? 'manual-' : ''}${res.task_id}`,
                  attempts: 10,
                  backoff: { type: 'fixed', delay: 3 * 60 * 1000 },
                }
              );
              count++;
            }
          } catch (err: any) {
            logger.error(`提交股票 ${candidate.symbol} 的 AI 分析任务失败:`, err);
            failed++;
          }
        }

        logger.info(
          `AI_DAILY_SCREENER 候选任务提交完成，候选池 ${candidateResult.analyzed_candidates}/${candidateResult.total_candidates}，成功提交 ${count} 个异步分析任务`
        );

        // 状态保留为 IN_PROGRESS，由 bull worker 来更新为 COMPLETED 或 FAILED
        await executionLog.update({ failed_items: failed });
        // 如果没有成功提交的任务，说明已经结束了
        if (count === 0) {
          await executionLog.update({ status: 'COMPLETED', completed_at: new Date() });
        }
      }

      await task.update({ last_run_status: 'SUCCESS' });
      return { success: true, message: 'Task executed successfully' };
    } catch (error: any) {
      logger.error(`Error executing task ${task.name}:`, error);
      await task.update({ last_run_status: 'FAILED' });
      await executionLog.update({ 
        status: 'FAILED', 
        completed_at: new Date(),
        error_message: error.message 
      });
      throw error;
    }
  }

  async executeTask(id: number) {
    const task = await ScheduledTask.findByPk(id);
    if (!task) throw new Error('Task not found');
    
    logger.info(`Manually triggering task ${task.id} (${task.name})`);
    return await this._executeTaskLogic(task, true);
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
