import Bull from 'bull';
import { logger } from '../utils/logger';

export interface AIPollingJobData {
  taskId: string;
  symbol: string;
  name: string;
  executionLogId?: number;
}

const aiPollingQueue = new Bull<AIPollingJobData>('ai_polling', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || '0'),
  },
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: 'fixed',
      delay: 3 * 60 * 1000, // 3 minutes
    },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

aiPollingQueue.on('error', error => logger.error('aiPollingQueue 错误:', error));
aiPollingQueue.on('failed', (job, error) => logger.error(`AI 分析轮询任务 ${job?.id} 失败:`, error));

export { aiPollingQueue };
