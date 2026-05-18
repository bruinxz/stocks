import Bull from 'bull';
import { logger } from '../utils/logger';

export interface BacktestJobData {
  user_id: number;
  name: string;
  description?: string;
  symbols: string[];
  start_date: Date;
  end_date: Date;
  initial_capital: number;
  strategyType: string;
  strategyParams: any;
  slippage: number;
  commissionRate: number;
  frequency: string;
}

// 创建队列实例
const backtestQueue = new Bull<BacktestJobData>('backtest', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    timeout: 5 * 60 * 1000, // 5分钟超时
  },
});

// 队列事件监听
backtestQueue.on('error', error => {
  logger.error('队列错误:', error);
});

backtestQueue.on('waiting', jobId => {
  logger.info(`任务 ${jobId} 等待中`);
});

backtestQueue.on('active', job => {
  logger.info(`任务 ${job.id} 开始处理`);
});

backtestQueue.on('completed', (job, result) => {
  logger.info(`任务 ${job.id} 处理完成`, { resultId: result?.backtestResultId });
});

backtestQueue.on('failed', (job, error) => {
  logger.error(`任务 ${job?.id} 处理失败:`, error);
});

backtestQueue.on('stalled', job => {
  logger.warn(`任务 ${job.id} 处理停滞`);
});

// 清理已完成的任务（保留7天）
setInterval(async () => {
  try {
    const completedJobs = await backtestQueue.getJobs(['completed']);
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const job of completedJobs) {
      if (job.finishedOn && job.finishedOn < weekAgo) {
        await job.remove();
        logger.debug(`已清理旧任务 ${job.id}`);
      }
    }
  } catch (error) {
    logger.error('清理队列任务失败:', error);
  }
}, 60 * 60 * 1000); // 每小时清理一次

export { backtestQueue };
