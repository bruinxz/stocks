import Bull from 'bull';
import { logger } from '../utils/logger';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { ScheduledTask } from '../models/ScheduledTask';
import { cronNotificationLifecycleService } from '../services/CronNotificationLifecycleService';

export interface DataUpdateJobData {
  type:
    | 'daily_update'
    | 'new_stocks_sync'
    | 'weekly_completeness_check'
    | 'data_quality_scan'
    | 'manual_sync'
    | 'bulk_sync_custom';
  date: string; // 更新日期 YYYY-MM-DD
  forceUpdate?: boolean; // 是否强制更新（忽略当日检查）
  user_id?: number; // 触发用户ID（可选）
  // 批量同步自定义参数
  symbols?: string[]; // 指定股票代码列表
  marketFilters?: ('SH' | 'SZ' | 'BJ')[]; // 按市场筛选
  syncAllStocks?: boolean; // 同步所有股票
  start_date?: string; // 同步开始日期 YYYY-MM-DD
  end_date?: string; // 同步结束日期 YYYY-MM-DD
  dataSource?:
    | 'auto'
    | 'tushare'
    | 'baostock'
    | 'akshare'
    | 'eastmoney'
    | 'tencent'
    | 'tencent_only'
    | 'sina'; // 数据源选择，默认auto自动fallback
  concurrency?: number; // 并发数量（批次大小）
  execution_log_id?: number; // 关联 task_execution_logs.id，便于前端查看定时任务投递后的队列明细
  scheduled_task_id?: number; // 关联 scheduled_tasks.id
  scope?: 'favorites' | 'market' | 'all'; // 数据质量扫描范围
  lookback_days?: number; // 数据质量扫描窗口
  limit?: number; // 数据质量扫描数量
  max_stocks?: number; // 每日增量同步最多处理股票数，避免一次性压垮小服务器
  batch_limit?: number; // 历史同步每次最多处理股票数，用于持续分片追赶
  lag_days_threshold?: number; // 仅处理最新K线落后该天数以上的股票
  stale_first?: boolean; // 历史同步是否按最新K线最旧优先
  include_no_data?: boolean; // 历史同步是否包含从未入库K线的股票；未指定时在行情库冷启动/低覆盖率场景自动纳入
  completedSymbols?: string[]; // 记录已完成的股票列表（用于断点续传）
  totalInserted?: number; // 记录已插入的条数（用于断点续传）
}

// 创建数据更新队列实例
const dataUpdateQueue = new Bull<DataUpdateJobData>('data-update', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '1'), // 使用不同的Redis DB
  },
  defaultJobOptions: {
    attempts: 3, // 失败重试3次
    backoff: {
      type: 'exponential', // 指数退避
      delay: 5000, // 5秒
    },
    timeout: 24 * 60 * 60 * 1000, // 24小时超时（全量同步可能耗时很长，防止触发重复重试）
    removeOnComplete: 100, // 保留最近100个完成的任务
    removeOnFail: 50, // 保留最近50个失败的任务
  },
});

export async function finalizeQueuedScheduledTask(input: {
  scheduled_task_id: number;
  execution_log_id?: number;
  status: 'SUCCESS' | 'FAILED';
  error_message?: string;
}): Promise<void> {
  const task = await ScheduledTask.findByPk(input.scheduled_task_id);
  if (!task) return;

  if (input.status === 'SUCCESS') {
    await task.update({
      last_run_status: 'SUCCESS',
      consecutive_failure_count: 0,
    });
    await cronNotificationLifecycleService.recordRecovery({
      task_id: task.id,
      task_type: task.type,
      task_name: task.name,
      execution_log_id: input.execution_log_id,
    });
    return;
  }

  const failureCount = Number(task.consecutive_failure_count || 0) + 1;
  const configuredThreshold = Number(process.env.SCHEDULER_FAILURE_KILL_THRESHOLD || 5);
  const threshold =
    Number.isFinite(configuredThreshold) && configuredThreshold > 0
      ? Math.floor(configuredThreshold)
      : 5;
  const killed = task.is_active && failureCount >= threshold;
  await task.update({
    last_run_status: 'FAILED',
    consecutive_failure_count: failureCount,
    ...(killed ? { is_active: false } : {}),
  });
  await cronNotificationLifecycleService.recordFailure({
    task_id: task.id,
    task_type: task.type,
    task_name: task.name,
    failure_count: failureCount,
    error_message: input.error_message,
    execution_log_id: input.execution_log_id,
    killed,
  });
}

// 队列事件监听
dataUpdateQueue.on('error', error => {
  logger.error('数据更新队列错误:', error);
});

dataUpdateQueue.on('waiting', jobId => {
  logger.info(`数据更新任务 ${jobId} 等待中`);
});

dataUpdateQueue.on('active', job => {
  logger.info(`数据更新任务 ${job.id} 开始处理`, {
    type: job.data.type,
    date: job.data.date,
  });
});

dataUpdateQueue.on('completed', (job, result) => {
  logger.info(`数据更新任务 ${job.id} 处理完成`, {
    type: job.data.type,
    date: job.data.date,
    result,
  });

  if (job.data.execution_log_id || job.data.scheduled_task_id) {
    (async () => {
      const totalItems = Number(
        result?.totalStocks ?? result?.affected_stocks ?? result?.affectedStocks ?? 1
      );
      const failedItems = Number(result?.failedSyncs ?? result?.failed ?? 0);
      const isSkipped = Boolean(result?.skipped);
      const completedItems = isSkipped
        ? 0
        : result?.successfulSyncs !== undefined
        ? Number(result.successfulSyncs) + Number(result?.skippedSyncs || 0)
        : failedItems > 0 && totalItems > 0
        ? Math.max(totalItems - failedItems, 0)
        : totalItems;

      const log = job.data.execution_log_id
        ? await TaskExecutionLog.findByPk(job.data.execution_log_id)
        : null;
      if (log) {
        const finalStatus =
          failedItems >= totalItems && totalItems > 0 && !isSkipped ? 'FAILED' : 'COMPLETED';
        await log.update({
          status: finalStatus,
          total_items: isSkipped ? 0 : totalItems,
          completed_items: completedItems,
          failed_items: failedItems,
          error_message: isSkipped
            ? result?.message || result?.reason || '队列任务已跳过'
            : failedItems > 0
            ? `数据更新队列部分失败：${failedItems}/${totalItems}`
            : null,
          completed_at: new Date(),
        });
      }

      if (job.data.scheduled_task_id) {
        const failed = failedItems >= totalItems && totalItems > 0 && !isSkipped;
        await finalizeQueuedScheduledTask({
          scheduled_task_id: job.data.scheduled_task_id,
          execution_log_id: job.data.execution_log_id,
          status: failed ? 'FAILED' : 'SUCCESS',
          error_message: failed ? `数据更新队列全部失败：${failedItems}/${totalItems}` : undefined,
        });
      }
    })().catch(error => logger.error('更新/上报数据更新队列完成状态失败:', error));
  }
});

dataUpdateQueue.on('failed', (job, error) => {
  logger.error(`数据更新任务 ${job?.id} 处理失败:`, {
    type: job?.data.type,
    date: job?.data.date,
    error: error.message,
  });

  const maxAttempts = Number(job?.opts?.attempts || 1);
  if (
    (job?.data?.execution_log_id || job?.data?.scheduled_task_id) &&
    job.attemptsMade >= maxAttempts
  ) {
    (async () => {
      const log = job.data.execution_log_id
        ? await TaskExecutionLog.findByPk(job.data.execution_log_id)
        : null;
      if (log) {
        await log.update({
          status: 'FAILED',
          failed_items: Math.max(Number(log.failed_items || 0), 1),
          error_message: error.message,
          completed_at: new Date(),
        });
      }

      if (job.data.scheduled_task_id) {
        await finalizeQueuedScheduledTask({
          scheduled_task_id: job.data.scheduled_task_id,
          execution_log_id: job.data.execution_log_id,
          status: 'FAILED',
          error_message: error.message,
        });
      }
    })().catch(reportError => logger.error('更新数据队列失败状态失败:', reportError));
  }
});

dataUpdateQueue.on('stalled', job => {
  logger.warn(`数据更新任务 ${job.id} 处理停滞`, {
    type: job.data.type,
    date: job.data.date,
  });
});

dataUpdateQueue.on('progress', (job, progress) => {
  logger.info(`数据更新任务 ${job.id} 进度: ${progress}%`, {
    type: job.data.type,
    date: job.data.date,
  });
});

// 已经在 defaultJobOptions 中配置了 removeOnComplete: 100 和 removeOnFail: 50
// 无需再设置单独的 setInterval 清理任务，避免每次 getJobs() 将大量对象载入内存并浪费事件循环资源

export { dataUpdateQueue };
