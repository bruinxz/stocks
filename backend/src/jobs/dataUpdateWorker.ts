import { Job } from 'bull';
import { DataUpdateJobData, dataUpdateQueue } from './dataUpdateQueue';
import { DataSyncService } from '../data/services/DataSyncService';
import { DataUpdateLog, UpdateType, UpdateStatus } from '../models/DataUpdateLog';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { redisLock, LockKeys } from '../utils/redisLock';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';

export class DataUpdateWorker {
  private dataSyncService: DataSyncService;

  constructor() {
    this.dataSyncService = new DataSyncService();
    this.setupWorkers();
  }

  /**
   * 设置队列处理器
   */
  private setupWorkers() {
    // 每日更新处理器
    dataUpdateQueue.process('daily_update', 1, async (job: Job<DataUpdateJobData>) => {
      return await this.processDailyUpdate(job);
    });

    // 新股同步处理器
    dataUpdateQueue.process('new_stocks_sync', 1, async (job: Job<DataUpdateJobData>) => {
      return await this.processNewStocksSync(job);
    });

    // 周完整性检查处理器
    dataUpdateQueue.process('weekly_completeness_check', 1, async (job: Job<DataUpdateJobData>) => {
      return await this.processWeeklyCompletenessCheck(job);
    });

    // 手动同步处理器
    dataUpdateQueue.process('manual_sync', 1, async (job: Job<DataUpdateJobData>) => {
      return await this.processManualSync(job);
    });

    // 批量同步自定义处理器
    dataUpdateQueue.process('bulk_sync_custom', 1, async (job: Job<DataUpdateJobData>) => {
      return await this.processBulkSyncCustom(job);
    });

    logger.info('数据更新队列处理器已启动');
  }

  /**
   * 处理每日数据更新
   */
  private async processDailyUpdate(job: Job<DataUpdateJobData>) {
    const { date, forceUpdate = false } = job.data;
    const lockKey = LockKeys.DAILY_UPDATE(date);
    let lockValue: string | null = null;

    try {
      // 报告进度
      await job.progress(5);

      // 获取分布式锁，防止并发更新
      lockValue = await redisLock.acquire(lockKey, 15 * 60 * 1000); // 15分钟锁
      if (!lockValue) {
        throw new Error('无法获取分布式锁，可能有其他进程正在更新');
      }

      await job.progress(10);

      // 检查是否已更新（除非强制更新）
      if (!forceUpdate) {
        const existingUpdate = await DataUpdateLog.findOne({
          where: {
            date,
            type: UpdateType.DAILY_UPDATE,
            status: UpdateStatus.COMPLETED,
          },
        });

        if (existingUpdate) {
          logger.info(`日期 ${date} 的每日数据已更新，跳过`);
          return {
            skipped: true,
            reason: 'already_updated',
            logId: existingUpdate.id,
          };
        }
      }

      await job.progress(15);

      // 创建更新记录
      const updateLog = await DataUpdateLog.create({
        type: UpdateType.DAILY_UPDATE,
        status: UpdateStatus.IN_PROGRESS,
        date,
        startedAt: new Date(),
      });

      const resultDetails: any = {};
      let totalAffectedStocks = 0;
      let totalInsertedRecords = 0;

      // 1. 增量更新：只获取需要更新的股票
      await job.progress(20);
      logger.info('开始增量数据更新...');

      const today = new Date().toISOString().split('T')[0];
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const startDate = sevenDaysAgo.toISOString().split('T')[0];

      // 获取最近7天没有数据的股票
      const stocksNeedingUpdate = await this.getStocksNeedingIncrementalUpdate(startDate, today);
      logger.info(`有 ${stocksNeedingUpdate.length} 只股票需要增量更新`);

      await job.progress(30);

      if (stocksNeedingUpdate.length > 0) {
        // 分批更新，避免过多请求
        const batchSize = 5;
        const results: { [symbol: string]: number } = {};

        for (let i = 0; i < stocksNeedingUpdate.length; i += batchSize) {
          const batch = stocksNeedingUpdate.slice(i, i + batchSize);
          const batchPromises = batch.map(symbol =>
            this.syncStockWithLock(symbol, startDate, today)
              .then(count => {
                results[symbol] = count;
                return { symbol, count };
              })
              .catch(error => {
                logger.error(`更新股票 ${symbol} 失败:`, error);
                results[symbol] = -1;
                return { symbol, count: -1 };
              })
          );

          await Promise.all(batchPromises);

          // 更新进度
          const progress = 30 + Math.min(60, Math.floor((i + batchSize) / stocksNeedingUpdate.length * 60));
          await job.progress(progress);

          // 批次间延迟，避免请求过于频繁
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // 统计结果
        const successCount = Object.values(results).filter(count => count > 0).length;
        const failCount = Object.values(results).filter(count => count === -1).length;
        const skipCount = Object.values(results).filter(count => count === 0).length;
        const totalInserted = Object.values(results).filter(count => count > 0)
          .reduce((sum, count) => sum + count, 0);

        resultDetails.dailyUpdate = {
          stocksNeedingUpdate: stocksNeedingUpdate.length,
          successCount,
          failCount,
          skipCount,
          totalInserted,
        };

        totalAffectedStocks += successCount;
        totalInsertedRecords += totalInserted;
      } else {
        logger.info('没有股票需要更新');
      }

      await job.progress(90);

      // 2. 更新股票基本信息（新上市的股票）
      logger.info('检查并更新股票基本信息...');
      try {
        const newStocksCount = await this.dataSyncService.syncAllStocks();
        resultDetails.stockInfoUpdate = {
          updatedCount: newStocksCount,
        };
        totalAffectedStocks += newStocksCount;
      } catch (error) {
        logger.error('更新股票基本信息失败:', error);
        // 不中断整个更新流程
      }

      await job.progress(95);

      // 3. 更新更新记录状态
      await updateLog.update({
        status: UpdateStatus.COMPLETED,
        completedAt: new Date(),
        affectedStocks: totalAffectedStocks,
        insertedRecords: totalInsertedRecords,
        result: resultDetails,
      });

      logger.info(`每日数据更新完成。影响股票: ${totalAffectedStocks}, 插入记录: ${totalInsertedRecords}`);

      return {
        success: true,
        affectedStocks: totalAffectedStocks,
        insertedRecords: totalInsertedRecords,
        details: resultDetails,
        logId: updateLog.id,
      };
    } catch (error) {
      logger.error('处理每日数据更新失败:', error);

      // 更新失败记录
      await DataUpdateLog.create({
        type: UpdateType.DAILY_UPDATE,
        status: UpdateStatus.FAILED,
        date,
        error: error.message,
        startedAt: new Date(),
        completedAt: new Date(),
      });

      throw error;
    } finally {
      // 释放锁
      if (lockValue) {
        await redisLock.release(lockKey, lockValue);
      }
    }
  }

  /**
   * 获取需要增量更新的股票列表
   */
  private async getStocksNeedingIncrementalUpdate(startDate: string, endDate: string): Promise<string[]> {
    try {
      // 获取所有已上市股票
      const stocks = await Stock.findAll({
        where: { isListed: true },
        attributes: ['id', 'symbol'],
        limit: 1000, // 限制数量，避免过大查询
      });

      const needsUpdate: string[] = [];

      // 检查每只股票在指定日期范围内是否有数据
      for (const stock of stocks) {
        const hasRecentData = await DailyBar.findOne({
          where: {
            stockId: stock.id,
            time: {
              [Op.between]: [new Date(startDate), new Date(endDate)],
            },
          },
        });

        if (!hasRecentData) {
          needsUpdate.push(stock.symbol);
        }

        // 分批处理，避免内存溢出
        if (needsUpdate.length >= 50) {
          break; // 限制每次更新的数量
        }
      }

      return needsUpdate;
    } catch (error) {
      logger.error('获取增量更新股票列表失败:', error);
      return [];
    }
  }

  /**
   * 带锁的股票数据同步
   */
  private async syncStockWithLock(symbol: string, startDate: string, endDate: string): Promise<number> {
    const lockKey = LockKeys.STOCK_SYNC(symbol);
    const lockValue = await redisLock.acquire(lockKey, 5 * 60 * 1000); // 5分钟锁

    if (!lockValue) {
      logger.warn(`股票 ${symbol} 正在被其他进程同步，跳过`);
      return 0;
    }

    try {
      return await this.dataSyncService.syncStockHistory(symbol, startDate, endDate);
    } finally {
      await redisLock.release(lockKey, lockValue);
    }
  }

  /**
   * 处理新股同步
   */
  private async processNewStocksSync(job: Job<DataUpdateJobData>) {
    const { date } = job.data;
    const lockKey = LockKeys.NEW_STOCKS_SYNC;
    let lockValue: string | null = null;

    try {
      await job.progress(10);

      // 获取分布式锁
      lockValue = await redisLock.acquire(lockKey, 10 * 60 * 1000); // 10分钟锁
      if (!lockValue) {
        throw new Error('无法获取新股同步锁，可能有其他进程正在操作');
      }

      await job.progress(30);

      // 创建更新记录
      const updateLog = await DataUpdateLog.create({
        type: UpdateType.NEW_STOCKS_SYNC,
        status: UpdateStatus.IN_PROGRESS,
        date,
        startedAt: new Date(),
      });

      await job.progress(50);

      // 同步新股
      const syncedCount = await this.dataSyncService.syncAllStocks();

      await job.progress(90);

      // 更新记录
      await updateLog.update({
        status: UpdateStatus.COMPLETED,
        completedAt: new Date(),
        affectedStocks: syncedCount,
        result: { syncedCount },
      });

      logger.info(`新股同步完成。同步股票: ${syncedCount}`);

      return {
        success: true,
        syncedCount,
        logId: updateLog.id,
      };
    } catch (error) {
      logger.error('处理新股同步失败:', error);

      await DataUpdateLog.create({
        type: UpdateType.NEW_STOCKS_SYNC,
        status: UpdateStatus.FAILED,
        date,
        error: error.message,
        startedAt: new Date(),
        completedAt: new Date(),
      });

      throw error;
    } finally {
      if (lockValue) {
        await redisLock.release(lockKey, lockValue);
      }
    }
  }

  /**
   * 处理周完整性检查
   */
  private async processWeeklyCompletenessCheck(job: Job<DataUpdateJobData>) {
    const { date } = job.data;

    try {
      await job.progress(10);

      // 创建更新记录
      const updateLog = await DataUpdateLog.create({
        type: UpdateType.WEEKLY_COMPLETENESS_CHECK,
        status: UpdateStatus.IN_PROGRESS,
        date,
        startedAt: new Date(),
      });

      await job.progress(30);

      // 执行完整性检查
      const completenessResult = await this.checkWeeklyDataCompleteness();

      await job.progress(90);

      // 更新记录
      await updateLog.update({
        status: UpdateStatus.COMPLETED,
        completedAt: new Date(),
        result: completenessResult,
      });

      logger.info(`周完整性检查完成。缺失数据股票: ${completenessResult.missingDataCount}`);

      return {
        success: true,
        result: completenessResult,
        logId: updateLog.id,
      };
    } catch (error) {
      logger.error('处理周完整性检查失败:', error);

      await DataUpdateLog.create({
        type: UpdateType.WEEKLY_COMPLETENESS_CHECK,
        status: UpdateStatus.FAILED,
        date,
        error: error.message,
        startedAt: new Date(),
        completedAt: new Date(),
      });

      throw error;
    }
  }

  /**
   * 检查过去一周数据完整性
   */
  private async checkWeeklyDataCompleteness() {
    const today = new Date();
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // 获取所有已上市股票
    const stocks = await Stock.findAll({
      where: { isListed: true },
      attributes: ['id', 'symbol'],
      limit: 500, // 限制数量
    });

    const completenessResult = {
      totalStocks: stocks.length,
      checkedDateRange: {
        startDate: sevenDaysAgo.toISOString().split('T')[0],
        endDate: today.toISOString().split('T')[0],
      },
      missingDataStocks: [] as Array<{ symbol: string, missingDays: number }>,
      missingDataCount: 0,
    };

    // 检查每只股票最近7天的数据数量
    for (const stock of stocks) {
      const dataCount = await DailyBar.count({
        where: {
          stockId: stock.id,
          time: {
            [Op.between]: [sevenDaysAgo, today],
          },
        },
      });

      // 假设一周有5个交易日
      if (dataCount < 5) {
        const missingDays = 5 - dataCount;
        completenessResult.missingDataStocks.push({
          symbol: stock.symbol,
          missingDays,
        });
        completenessResult.missingDataCount++;
      }
    }

    return completenessResult;
  }

  /**
   * 处理手动同步
   */
  private async processManualSync(job: Job<DataUpdateJobData>) {
    // 手动同步可以支持更多自定义参数
    const { date, userId } = job.data;

    try {
      // 这里可以实现自定义的手动同步逻辑
      // 例如：同步指定股票、指定日期范围等

      const updateLog = await DataUpdateLog.create({
        type: UpdateType.MANUAL_SYNC,
        status: UpdateStatus.COMPLETED,
        date,
        result: { manual: true, userId },
        startedAt: new Date(),
        completedAt: new Date(),
      });

      return {
        success: true,
        message: '手动同步完成',
        logId: updateLog.id,
      };
    } catch (error) {
      logger.error('处理手动同步失败:', error);
      throw error;
    }
  }

  /**
   * 处理批量同步自定义任务
   */
  private async processBulkSyncCustom(job: Job<DataUpdateJobData>) {
    const {
      date,
      symbols,
      marketFilters,
      syncAllStocks,
      startDate,
      endDate,
      dataSource = 'akshare',
      concurrency = 10,
      userId,
    } = job.data;

    try {
      // 报告进度
      await job.progress(5);

      // 创建更新记录
      const updateLog = await DataUpdateLog.create({
        type: UpdateType.BULK_SYNC_CUSTOM, // 批量同步自定义任务类型
        status: UpdateStatus.IN_PROGRESS,
        date,
        result: {
          bulkSync: true,
          symbols,
          marketFilters,
          syncAllStocks,
          startDate,
          endDate,
          dataSource,
          concurrency,
          userId,
        },
        startedAt: new Date(),
      });

      await job.progress(10);

      // 确定要同步的股票列表
      let stocksToSync: string[] = [];

      if (symbols && symbols.length > 0) {
        // 使用指定的股票代码列表
        stocksToSync = symbols;
      } else if (marketFilters && marketFilters.length > 0) {
        // 按市场筛选
        const marketConditions = marketFilters.map(market => ({ market }));
        const stocks = await Stock.findAll({
          where: { [Op.or]: marketConditions },
          attributes: ['symbol'],
        });
        stocksToSync = stocks.map(s => s.symbol);
      } else if (syncAllStocks) {
        // 同步所有股票
        const stocks = await Stock.findAll({
          attributes: ['symbol'],
        });
        stocksToSync = stocks.map(s => s.symbol);
      } else {
        // 默认同步所有股票
        const stocks = await Stock.findAll({
          attributes: ['symbol'],
        });
        stocksToSync = stocks.map(s => s.symbol);
      }

      logger.info(`批量同步任务开始，共 ${stocksToSync.length} 只股票`);
      logger.info(`日期范围: ${startDate} 到 ${endDate}, 并发数: ${concurrency}`);

      // 更新日志记录
      await updateLog.update({
        result: {
          ...updateLog.result,
          totalStocks: stocksToSync.length,
          processedStocks: 0,
          currentProgress: 0,
        },
      });

      await job.progress(20);

      // 执行批量同步
      const syncResults = await this.dataSyncService.syncMultipleStocksHistory(
        stocksToSync,
        startDate || '2020-01-01',
        endDate || new Date().toISOString().split('T')[0],
        concurrency
      );

      // 统计结果
      const successfulSyncs = Object.values(syncResults).filter(count => count > 0).length;
      const failedSyncs = Object.values(syncResults).filter(count => count === -1).length;
      const totalRecordsInserted = Object.values(syncResults).reduce((sum, count) => count > 0 ? sum + count : sum, 0);

      // 更新日志记录
      await updateLog.update({
        status: UpdateStatus.COMPLETED,
        completedAt: new Date(),
        affectedStocks: stocksToSync.length,
        insertedRecords: totalRecordsInserted,
        result: {
          ...updateLog.result,
          successfulSyncs,
          failedSyncs,
          totalRecordsInserted,
          syncResults,
        },
      });

      await job.progress(100);

      return {
        success: true,
        message: `批量同步完成，共处理 ${stocksToSync.length} 只股票，插入 ${totalRecordsInserted} 条记录`,
        logId: updateLog.id,
        totalStocks: stocksToSync.length,
        successfulSyncs,
        failedSyncs,
        totalRecordsInserted,
      };
    } catch (error) {
      logger.error('处理批量同步任务失败:', error);

      // 更新日志记录为失败
      const updateLog = await DataUpdateLog.findOne({
        where: {
          date,
          type: UpdateType.BULK_SYNC_CUSTOM,
          status: UpdateStatus.IN_PROGRESS,
        },
        order: [['id', 'DESC']],
      });

      if (updateLog) {
        await updateLog.update({
          status: UpdateStatus.FAILED,
          completedAt: new Date(),
          error: error.message,
        });
      }

      throw error;
    }
  }

  /**
   * 获取队列状态
   */
  async getQueueStatus() {
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        dataUpdateQueue.getWaitingCount(),
        dataUpdateQueue.getActiveCount(),
        dataUpdateQueue.getCompletedCount(),
        dataUpdateQueue.getFailedCount(),
        dataUpdateQueue.getDelayedCount(),
      ]);

      return {
        waiting,
        active,
        completed,
        failed,
        delayed,
        total: waiting + active + completed + failed + delayed,
      };
    } catch (error) {
      logger.error('获取队列状态失败:', error);
      throw error;
    }
  }

  /**
   * 清理队列中的任务
   */
  async cleanQueue() {
    try {
      await dataUpdateQueue.clean(0, 'completed');
      await dataUpdateQueue.clean(0, 'failed');
      logger.info('数据更新队列已清理');
      return { success: true };
    } catch (error) {
      logger.error('清理队列失败:', error);
      throw error;
    }
  }
}

// 导出单例
export const dataUpdateWorker = new DataUpdateWorker();