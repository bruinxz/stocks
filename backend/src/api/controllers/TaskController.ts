import { Request, Response, NextFunction } from 'express';
import { schedulerService } from '../../services/SchedulerService';
import { TaskExecutionLog } from '../../models/TaskExecutionLog';
import { logger } from '../../utils/logger';
import { dataUpdateQueue } from '../../jobs/dataUpdateQueue';
import { aiPollingQueue } from '../../jobs/aiPollingQueue';
import { taskAutomationHealthService } from '../../services/TaskAutomationHealthService';
import { taskParameterAuditService } from '../../services/TaskParameterAuditService';
import { runtimeSchemaHealthService } from '../../services/RuntimeSchemaHealthService';

type QueueJobSummary = {
  id: string | number;
  queue_name: string;
  name?: string;
  state: string;
  progress: any;
  failed_reason?: string;
  attempts_made?: number;
  timestamp?: number;
  processed_on?: number;
  finished_on?: number;
  data?: any;
  return_value?: any;
};

const QUEUE_JOB_STATES = ['waiting', 'active', 'delayed', 'completed', 'failed', 'paused'];
const QUEUE_JOB_LOOKUP_LIMIT = 300;

const extractExecutionLogIdFromJob = (job: any): number | undefined => {
  const jobIdMatch = String(job?.id || '').match(/(?:^|-)log-(\d+)(?:-|$)/);
  if (jobIdMatch) return Number(jobIdMatch[1]);

  const data = job?.data || {};
  const candidates = [data.executionLogId, data.execution_log_id, data.task_execution_log_id];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }

  return undefined;
};

const summarizeQueueJob = async (queue_name: string, job: any): Promise<QueueJobSummary> => {
  let state = 'unknown';
  try {
    state = await job.getState();
  } catch (error: any) {
    logger.warn(`获取队列任务状态失败 ${queue_name}/${job?.id}:`, error);
  }

  return {
    id: job.id,
    queue_name,
    name: job.name,
    state,
    progress: typeof job.progress === 'function' ? job.progress() : job._progress,
    failed_reason: job.failedReason,
    attempts_made: job.attemptsMade,
    timestamp: job.timestamp,
    processed_on: job.processedOn,
    finished_on: job.finishedOn,
    data: job.data,
    return_value: job.returnvalue,
  };
};

const attachQueueJobsToLogs = async (logs: any[]) => {
  const normalizedLogs = logs.map(log => ({
    ...log,
    queue_jobs: [],
    queue_summary: { total: 0, completed: 0, failed: 0, active: 0, waiting: 0, delayed: 0 },
  }));

  if (normalizedLogs.length === 0) return normalizedLogs;

  const logIdSet = new Set<number>(normalizedLogs.map(log => Number(log.id)).filter(Boolean));
  const jobsByLogId = new Map<number, QueueJobSummary[]>();

  const collectQueueJobs = async (queue_name: string, queue: any) => {
    const jobs = await queue.getJobs(QUEUE_JOB_STATES as any, 0, QUEUE_JOB_LOOKUP_LIMIT - 1, false);

    for (const job of jobs) {
      const executionLogId = extractExecutionLogIdFromJob(job);
      if (!executionLogId || !logIdSet.has(executionLogId)) continue;

      const summary = await summarizeQueueJob(queue_name, job);
      const existing = jobsByLogId.get(executionLogId) || [];
      existing.push(summary);
      jobsByLogId.set(executionLogId, existing);
    }
  };

  try {
    await Promise.all([
      collectQueueJobs('data-update', dataUpdateQueue),
      collectQueueJobs('ai_polling', aiPollingQueue),
    ]);
  } catch (error: any) {
    logger.warn('获取定时任务关联队列详情失败，已降级返回执行日志:', error);
    return normalizedLogs.map(log => ({
      ...log,
      queue_error: error?.message || String(error),
    }));
  }

  return normalizedLogs.map(log => {
    const queue_jobs = jobsByLogId.get(Number(log.id)) || [];
    const queue_summary = queue_jobs.reduce(
      (summary, job) => {
        summary.total += 1;
        if (job.state === 'completed') summary.completed += 1;
        else if (job.state === 'failed') summary.failed += 1;
        else if (job.state === 'active') summary.active += 1;
        else if (job.state === 'waiting') summary.waiting += 1;
        else if (job.state === 'delayed') summary.delayed += 1;
        return summary;
      },
      { total: 0, completed: 0, failed: 0, active: 0, waiting: 0, delayed: 0 }
    );

    return { ...log, queue_jobs, queue_summary };
  });
};

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

  async getAutomationHealth(req: Request, res: Response, next: NextFunction) {
    try {
      const health = await taskAutomationHealthService.getHealth();
      res.json({ success: true, data: health });
    } catch (error: any) {
      logger.error('获取自动化闭环健康状态失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getRuntimeSchemaHealth(req: Request, res: Response, next: NextFunction) {
    try {
      const health = await runtimeSchemaHealthService.getHealth();
      res.json({ success: true, data: health });
    } catch (error: any) {
      logger.error('获取数据库运行时 schema 健康状态失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async applyRiskLimitSuggestion(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await taskAutomationHealthService.applyRiskLimitSuggestion({
        dry_run: req.body?.dry_run !== false,
        task_ids: Array.isArray(req.body?.task_ids) ? req.body.task_ids : undefined,
        source_loop_run_id: req.body?.source_loop_run_id,
        operator: {
          user_id: (req as any).user?.id,
          username: (req as any).user?.username,
        },
      });

      if (!result.dry_run && Array.isArray((result as any).changes)) {
        await Promise.all(
          (result as any).changes
            .map((change: any) => Number(change.id))
            .filter((id: number) => Number.isInteger(id) && id > 0)
            .map((id: number) => schedulerService.reloadTask(id))
        );
      }

      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('应用风险阈值建议失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async applyLiveShadowBudgetSuggestion(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await schedulerService.applyLiveShadowBudgetSuggestion({
        audit_id: req.body?.audit_id ? Number(req.body.audit_id) : undefined,
        dry_run: req.body?.dry_run !== false,
        operator: {
          user_id: (req as any).user?.id,
          username: (req as any).user?.username,
        },
      });
      res.json({ success: true, data: result, message: result.message });
    } catch (error: any) {
      logger.error('应用影子预算建议失败:', error);
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
      const enrichedLogs = await attachQueueJobsToLogs(logs.map(log => log.toJSON()));
      res.json({ success: true, data: enrichedLogs });
    } catch (error: any) {
      logger.error('获取定时任务日志失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async getTaskParameterAudits(req: Request, res: Response, next: NextFunction) {
    try {
      const audits = await taskParameterAuditService.list({
        task_id: req.query.task_id ? Number(req.query.task_id) : undefined,
        event_type: req.query.event_type ? String(req.query.event_type) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : 50,
        watched_only: req.query.watched_only !== 'false',
      });
      res.json({ success: true, data: audits });
    } catch (error: any) {
      logger.error('获取任务参数审计记录失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async reportDeploymentSmoke(req: Request, res: Response, next: NextFunction) {
    try {
      const summary = req.body?.summary || req.body || {};
      const criticalFailed = Number(summary.critical_failed || 0);
      const failed = Number(summary.failed || 0);
      const eventType =
        summary.skipped === true
          ? 'deployment_smoke_skipped'
          : criticalFailed > 0 || failed > 0 || summary.success === false
          ? 'deployment_smoke_failed'
          : 'deployment_smoke_passed';

      const audit = await taskParameterAuditService.record({
        task: {
          id: 0,
          name: '部署后只读冒烟测试',
          type: 'DEPLOYMENT_SMOKE',
        },
        event_type: eventType,
        before_parameters: {},
        after_parameters: {
          success: Boolean(summary.success),
          base_url: summary.base_url,
          passed: Number(summary.passed || 0),
          failed,
          critical_failed: criticalFailed,
          optional_failed: Number(summary.optional_failed || 0),
          skipped: Number(summary.skipped || 0),
          skip_reason: summary.skip_reason,
          timeout_ms: Number(summary.timeout_ms || 0),
          deployment_id: req.body?.deployment_id,
          source: req.body?.source || 'deployment_script',
          local_regression: req.body?.local_regression || null,
        },
        changed_keys: [
          'success',
          'passed',
          'failed',
          'critical_failed',
          'optional_failed',
          'skipped',
          'skip_reason',
          'timeout_ms',
        ],
        metadata: {
          source: req.body?.source || 'deployment_script',
          deployment_id: req.body?.deployment_id,
          local_regression: req.body?.local_regression || null,
          results: Array.isArray(req.body?.results) ? req.body.results.slice(0, 80) : undefined,
        },
      });

      res.json({
        success: true,
        data: audit,
        message: audit ? '部署冒烟结果已记录' : '部署冒烟结果无变化，已跳过记录',
      });
    } catch (error: any) {
      logger.error('记录部署冒烟结果失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async createTask(req: Request, res: Response, next: NextFunction) {
    try {
      const task = await schedulerService.createTask(req.body, {
        operator: {
          user_id: (req as any).user?.id,
          username: (req as any).user?.username,
        },
        source: 'task_controller_create',
      });
      res.json({ success: true, data: task });
    } catch (error: any) {
      logger.error('创建定时任务失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  async updateTask(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { audit_event_type, source_loop_run_id, ...updatePayload } = req.body || {};
      const task = await schedulerService.updateTask(parseInt(id), updatePayload, {
        operator: {
          user_id: (req as any).user?.id,
          username: (req as any).user?.username,
        },
        event_type: audit_event_type,
        source_loop_run_id,
        source: 'task_controller_update',
      });
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
