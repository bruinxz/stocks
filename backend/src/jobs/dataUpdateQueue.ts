import Bull from 'bull';
import { logger } from '../utils/logger';

export interface DataUpdateJobData {
  type:
    | 'daily_update'
    | 'new_stocks_sync'
    | 'weekly_completeness_check'
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
  dataSource?: 'akshare'; // 数据源，目前只支持akshare
  concurrency?: number; // 并发数量（批次大小）
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
});

dataUpdateQueue.on('failed', (job, error) => {
  logger.error(`数据更新任务 ${job?.id} 处理失败:`, {
    type: job?.data.type,
    date: job?.data.date,
    error: error.message,
  });
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
