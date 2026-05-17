import Bull from 'bull';
import { QuantBacktestOptions } from '../quant/types/QuantTypes';
import { logger } from '../utils/logger';

export interface QuantBacktestJobData {
  task_id: number;
  user_id?: number;
  options: QuantBacktestOptions;
}

const quantBacktestQueue = new Bull<QuantBacktestJobData>('quant-backtest', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '1'),
  },
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 8000,
    },
    timeout: 6 * 60 * 60 * 1000,
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

quantBacktestQueue.on('error', error => logger.error('量化跑分队列错误:', error));
quantBacktestQueue.on('waiting', jobId => logger.info(`量化跑分任务 ${jobId} 等待中`));
quantBacktestQueue.on('active', job =>
  logger.info(`量化跑分任务 ${job.id} 开始处理`, {
    task_id: job.data.task_id,
    strategies: job.data.options.strategy_keys,
  })
);
quantBacktestQueue.on('completed', (job, result) =>
  logger.info(`量化跑分任务 ${job.id} 处理完成`, {
    task_id: job.data.task_id,
    result,
  })
);
quantBacktestQueue.on('failed', (job, error) =>
  logger.error(`量化跑分任务 ${job?.id} 处理失败`, {
    task_id: job?.data?.task_id,
    error: error.message,
  })
);

export { quantBacktestQueue };
