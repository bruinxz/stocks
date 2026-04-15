import { backtestQueue } from './queue';
import { processBacktestJob } from './backtestJob';
import { logger } from '../utils/logger';

// 设置队列处理器
backtestQueue.process(async (job) => {
  logger.info(`开始处理回测任务 ${job.id}`);
  try {
    const result = await processBacktestJob(job.data);
    return result;
  } catch (error) {
    logger.error(`回测任务 ${job.id} 处理失败:`, error);
    throw error;
  }
});

logger.info('Bull队列处理器已启动，等待任务...');

// 优雅关闭
process.on('SIGTERM', async () => {
  logger.info('收到SIGTERM信号，正在关闭队列处理器...');
  await backtestQueue.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('收到SIGINT信号，正在关闭队列处理器...');
  await backtestQueue.close();
  process.exit(0);
});