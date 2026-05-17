import { Job } from 'bull';
import { quantBacktestQueue, QuantBacktestJobData } from './quantBacktestQueue';
import { quantBacktestService } from '../quant/services/QuantBacktestService';
import { logger } from '../utils/logger';

const resolveBacktestConcurrency = () => {
  const configured = Number(process.env.QUANT_BACKTEST_CONCURRENCY || 2);
  if (!Number.isFinite(configured) || configured <= 0) return 2;
  return Math.max(1, Math.min(Math.floor(configured), 3));
};

const quantBacktestConcurrency = resolveBacktestConcurrency();

quantBacktestQueue.process(quantBacktestConcurrency, async (job: Job<QuantBacktestJobData>) => {
  await job.progress(5);
  const result = await quantBacktestService.processBacktestTask(
    job.data.task_id,
    job.data.options,
    {
      user_id: job.data.user_id,
      on_progress: async progress => job.progress(progress),
    }
  );
  await job.progress(100);
  return result;
});

quantBacktestQueue.on('failed', async (job, error) => {
  if (!job) return;
  try {
    await quantBacktestService.markTaskFailed(job.data.task_id, error);
  } catch (markError: any) {
    logger.error(`标记量化跑分任务失败状态异常 ${job.data.task_id}:`, markError);
  }
});

logger.info(`量化跑分队列处理器已启动，并发数: ${quantBacktestConcurrency}`);
