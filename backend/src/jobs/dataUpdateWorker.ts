import { Job } from 'bull';
import { DataUpdateJobData, dataUpdateQueue } from './dataUpdateQueue';
import { DataSyncService } from '../data/services/DataSyncService';
import { DataUpdateLog, UpdateType, UpdateStatus } from '../models/DataUpdateLog';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { dataQualityService } from '../services/DataQualityService';
import { redisLock, LockKeys } from '../utils/redisLock';
import { logger } from '../utils/logger';
import { Op } from 'sequelize';
import moment from 'moment-timezone';

export class DataUpdateWorker {
  private dataSyncService: DataSyncService;

  constructor() {
    this.dataSyncService = new DataSyncService();
    if (String(process.env.DISABLE_QUEUE_WORKERS || '').toLowerCase() === 'true') {
      logger.info('数据更新队列处理器已按环境变量禁用');
      return;
    }
    this.setupWorkers();
  }

  private isLockBusyError(error: any): boolean {
    const message = error?.message || String(error || '');
    return message.includes('无法获取分布式锁') || message.includes('正在更新');
  }

  private startLockRenewal(
    lockKey: string,
    lockValue: string,
    ttlMs: number,
    label: string
  ): NodeJS.Timeout {
    const intervalMs = Math.max(30_000, Math.floor(ttlMs / 3));
    return setInterval(async () => {
      try {
        const renewed = await redisLock.renew(lockKey, lockValue, ttlMs);
        if (!renewed) {
          logger.warn(`${label} 锁续期失败，锁可能已过期或被其他进程接管`, { lockKey });
        }
      } catch (error) {
        logger.warn(`${label} 锁续期异常`, error);
      }
    }, intervalMs);
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

    // 数据质量画像扫描处理器
    dataUpdateQueue.process('data_quality_scan', 1, async (job: Job<DataUpdateJobData>) => {
      return await this.processDataQualityScan(job);
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
    const { date, forceUpdate = false, max_stocks = 300 } = job.data;
    const lockKey = LockKeys.DAILY_UPDATE(date);
    let lockValue: string | null = null;
    let renewTimer: NodeJS.Timeout | null = null;

    try {
      // 报告进度
      await job.progress(5);

      // 获取分布式锁，防止并发更新
      lockValue = await redisLock.acquire(lockKey, 2 * 60 * 60 * 1000); // 日更可能受外部源限速，锁续期兜底
      if (!lockValue) {
        logger.warn(`日期 ${date} 的每日数据更新已在运行，当前任务跳过`);
        await job.progress(100);
        return {
          success: true,
          skipped: true,
          reason: 'lock_busy',
          message: '已有每日数据更新任务正在运行，当前任务已跳过',
          totalStocks: 1,
          affected_stocks: 0,
          failed: 0,
        };
      }
      renewTimer = this.startLockRenewal(lockKey, lockValue, 2 * 60 * 60 * 1000, '每日更新');

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
          await job.progress(100);
          return {
            success: true,
            skipped: true,
            reason: 'already_updated',
            message: '当日每日行情增量同步已存在完成记录，当前任务已跳过',
            totalStocks: 0,
            affected_stocks: 0,
            failed: 0,
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
        started_at: new Date(),
      });

      const resultDetails: any = {};
      let totalAffectedStocks = 0;
      let totalInsertedRecords = 0;
      let dailySuccessCount = 0;
      let dailyFailCount = 0;
      let dailySkipCount = 0;

      // 1. 增量更新：只获取需要更新的股票
      await job.progress(20);
      logger.info('开始增量数据更新...');

      const target_date = date || moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
      const sevenDaysAgo = moment
        .tz(target_date, 'Asia/Shanghai')
        .subtract(7, 'days')
        .format('YYYY-MM-DD');

      // 获取最新K线早于目标日期的股票。旧逻辑只判断“最近7天是否有任意数据”，
      // 会导致已同步到上一个交易日的股票在新交易日被错误跳过。
      const stocksNeedingUpdate = await this.getStocksNeedingIncrementalUpdate(
        target_date,
        max_stocks
      );
      logger.info(`有 ${stocksNeedingUpdate.length} 只股票需要增量更新`);

      await job.progress(30);

      if (stocksNeedingUpdate.length > 0) {
        // 分批更新，避免过多请求
        const batchSize = 5;
        const results: { [symbol: string]: number } = {};

        for (let i = 0; i < stocksNeedingUpdate.length; i += batchSize) {
          const batch = stocksNeedingUpdate.slice(i, i + batchSize);
          const batchPromises = batch.map(symbol =>
            this.syncStockWithLock(symbol, sevenDaysAgo, target_date, 'tencent_only')
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
          const progress =
            30 + Math.min(60, Math.floor(((i + batchSize) / stocksNeedingUpdate.length) * 60));
          await job.progress(progress);

          // 批次间延迟，避免请求过于频繁
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // 统计结果
        const successCount = Object.values(results).filter(count => count > 0).length;
        const failCount = Object.values(results).filter(count => count === -1).length;
        const skipCount = Object.values(results).filter(count => count === 0).length;
        const totalInserted = Object.values(results)
          .filter(count => count > 0)
          .reduce((sum, count) => sum + count, 0);
        dailySuccessCount = successCount;
        dailyFailCount = failCount;
        dailySkipCount = skipCount;

        resultDetails.dailyUpdate = {
          stocksNeedingUpdate: stocksNeedingUpdate.length,
          maxStocks: max_stocks,
          targetDate: target_date,
          startDate: sevenDaysAgo,
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
        completed_at: new Date(),
        affected_stocks: totalAffectedStocks,
        inserted_records: totalInsertedRecords,
        result: resultDetails,
      });

      logger.info(
        `每日数据更新完成。影响股票: ${totalAffectedStocks}, 插入记录: ${totalInsertedRecords}`
      );

      return {
        success: true,
        affected_stocks: totalAffectedStocks,
        inserted_records: totalInsertedRecords,
        totalStocks: stocksNeedingUpdate.length,
        successfulSyncs: dailySuccessCount,
        failedSyncs: dailyFailCount,
        skippedSyncs: dailySkipCount,
        totalRecordsInserted: totalInsertedRecords,
        details: resultDetails,
        logId: updateLog.id,
      };
    } catch (error) {
      logger.error('处理每日数据更新失败:', error);

      if (this.isLockBusyError(error)) {
        return {
          success: true,
          skipped: true,
          reason: 'lock_busy',
          message: error.message,
          totalStocks: 1,
          affected_stocks: 0,
          failed: 0,
        };
      }

      // 更新失败记录
      await DataUpdateLog.create({
        type: UpdateType.DAILY_UPDATE,
        status: UpdateStatus.FAILED,
        date,
        error: error.message,
        started_at: new Date(),
        completed_at: new Date(),
      });

      throw error;
    } finally {
      if (renewTimer) {
        clearInterval(renewTimer);
      }
      // 释放锁
      if (lockValue) {
        await redisLock.release(lockKey, lockValue);
      }
    }
  }

  /**
   * 获取需要增量更新的股票列表
   */
  private async getStocksNeedingIncrementalUpdate(
    target_date: string,
    limit = 300
  ): Promise<string[]> {
    try {
      const targetStart = moment.tz(target_date, 'Asia/Shanghai').startOf('day').toDate();
      const rows = (await Stock.findAll({
        where: { is_listed: true },
        attributes: [
          'id',
          'symbol',
          [
            DailyBar.sequelize!.fn('MAX', DailyBar.sequelize!.col('daily_bars.time')),
            'latest_time',
          ],
        ],
        include: [
          {
            model: DailyBar,
            attributes: [],
            required: false,
          },
        ],
        group: ['Stock.id', 'Stock.symbol'],
        having: DailyBar.sequelize!.literal(
          `MAX("daily_bars"."time") IS NULL OR MAX("daily_bars"."time") < '${targetStart.toISOString()}'`
        ),
        order: [
          DailyBar.sequelize!.literal('MAX("daily_bars"."time") ASC NULLS FIRST') as any,
          ['id', 'ASC'],
        ],
        limit,
        raw: true,
        subQuery: false,
      })) as any[];

      return rows.map(row => row.symbol);
    } catch (error) {
      logger.error('获取增量更新股票列表失败:', error);
      return [];
    }
  }

  /**
   * 带锁的股票数据同步
   */
  private async syncStockWithLock(
    symbol: string,
    start_date: string,
    end_date: string,
    dataSource = 'auto'
  ): Promise<number> {
    const lockKey = LockKeys.STOCK_SYNC(symbol);
    const lockValue = await redisLock.acquire(lockKey, 30 * 60 * 1000); // 单股同步可能遇到外部源限速

    if (!lockValue) {
      logger.warn(`股票 ${symbol} 正在被其他进程同步，跳过`);
      return 0;
    }

    try {
      return await this.dataSyncService.syncStockHistory(symbol, start_date, end_date, dataSource);
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
        started_at: new Date(),
      });

      await job.progress(50);

      // 同步新股
      const syncedCount = await this.dataSyncService.syncAllStocks();

      await job.progress(90);

      // 更新记录
      await updateLog.update({
        status: UpdateStatus.COMPLETED,
        completed_at: new Date(),
        affected_stocks: syncedCount,
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
        started_at: new Date(),
        completed_at: new Date(),
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
        started_at: new Date(),
      });

      await job.progress(30);

      // 执行完整性检查
      const completenessResult = await this.checkWeeklyDataCompleteness();

      await job.progress(90);

      // 更新记录
      await updateLog.update({
        status: UpdateStatus.COMPLETED,
        completed_at: new Date(),
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
        started_at: new Date(),
        completed_at: new Date(),
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
      where: { is_listed: true },
      attributes: ['id', 'symbol'],
    });

    const completenessResult = {
      totalStocks: stocks.length,
      checkedDateRange: {
        start_date: sevenDaysAgo.toISOString().split('T')[0],
        end_date: today.toISOString().split('T')[0],
      },
      missingDataStocks: [] as Array<{ symbol: string; missingDays: number }>,
      missingDataCount: 0,
    };

    // 检查每只股票最近7天的数据数量
    for (const stock of stocks) {
      const dataCount = await DailyBar.count({
        where: {
          stock_id: stock.id,
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
   * 扫描并更新股票数据质量状态
   */
  private async processDataQualityScan(job: Job<DataUpdateJobData>) {
    const { date, user_id, scope = 'market', lookback_days = 180, limit = 200 } = job.data;

    try {
      await job.progress(10);

      const updateLog = await DataUpdateLog.create({
        type: UpdateType.DATA_QUALITY_SCAN,
        status: UpdateStatus.IN_PROGRESS,
        date,
        started_at: new Date(),
        result: { scope, lookback_days, limit, user_id },
      });

      await job.progress(40);
      const result = await dataQualityService.updateStockQualityStatuses({
        user_id,
        scope,
        lookback_days,
        limit,
      });

      await job.progress(90);
      await updateLog.update({
        status: UpdateStatus.COMPLETED,
        completed_at: new Date(),
        affected_stocks: result.updated,
        result,
      });

      await job.progress(100);
      logger.info(`数据质量扫描完成。扫描 ${result.scanned}，更新 ${result.updated}`);

      return {
        success: true,
        ...result,
        logId: updateLog.id,
      };
    } catch (error) {
      logger.error('处理数据质量扫描失败:', error);

      await DataUpdateLog.create({
        type: UpdateType.DATA_QUALITY_SCAN,
        status: UpdateStatus.FAILED,
        date,
        error: error.message,
        started_at: new Date(),
        completed_at: new Date(),
      });

      throw error;
    }
  }

  /**
   * 处理手动同步
   */
  private async processManualSync(job: Job<DataUpdateJobData>) {
    // 手动同步可以支持更多自定义参数
    const { date, user_id } = job.data;

    try {
      // 这里可以实现自定义的手动同步逻辑
      // 例如：同步指定股票、指定日期范围等

      const updateLog = await DataUpdateLog.create({
        type: UpdateType.MANUAL_SYNC,
        status: UpdateStatus.COMPLETED,
        date,
        result: { manual: true, user_id },
        started_at: new Date(),
        completed_at: new Date(),
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
      start_date,
      end_date,
      dataSource = 'auto',
      concurrency = 2, // 默认将并发数降为 2，避免同时启动过多 Python 进程导致小服务器 CPU/内存 爆满
      user_id,
      batch_limit,
      lag_days_threshold = 0,
      stale_first = true,
      include_no_data,
    } = job.data;

    const lockKey = LockKeys.BULK_SYNC;
    let lockValue: string | null = null;

    try {
      // 报告进度
      await job.progress(5);

      // 获取分布式锁，防止批量同步并发（锁24小时，或执行完毕后释放）
      lockValue = await redisLock.acquire(lockKey, 24 * 60 * 60 * 1000);
      if (!lockValue) {
        throw new Error('无法获取分布式锁，已有批量同步任务正在运行');
      }

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
          start_date,
          end_date,
          dataSource,
          concurrency,
          user_id,
          batch_limit,
          lag_days_threshold,
          stale_first,
          include_no_data: include_no_data ?? 'auto',
        },
        started_at: new Date(),
      });

      await job.progress(10);

      // 如果未指定开始日期，提供一个合理的默认值
      const actualStartDate = start_date || '2020-01-01';
      const actualEndDate = end_date || moment().tz('Asia/Shanghai').format('YYYY-MM-DD');

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
        stocksToSync = await this.getStocksForHistorySync({
          batch_limit,
          lag_days_threshold,
          stale_first,
          include_no_data,
          end_date: actualEndDate,
        });
      } else {
        stocksToSync = await this.getStocksForHistorySync({
          batch_limit,
          lag_days_threshold,
          stale_first,
          include_no_data,
          end_date: actualEndDate,
        });
      }

      // 检查是否为重试任务，实现断点续传
      let processedStocksSet = new Set<string>();
      if (job.attemptsMade > 0 && job.data.completedSymbols) {
        processedStocksSet = new Set(job.data.completedSymbols);
        logger.info(`任务重试检测到已完成 ${processedStocksSet.size} 只股票，将从断点处继续执行`);
        stocksToSync = stocksToSync.filter(s => !processedStocksSet.has(s));
      }

      // 初始化任务数据中的 completedSymbols
      if (!job.data.completedSymbols) {
        job.data.completedSymbols = [];
        await job.update(job.data);
      }

      if (stocksToSync.length === 0) {
        await updateLog.update({
          status: UpdateStatus.COMPLETED,
          completed_at: new Date(),
          result: {
            ...updateLog.result,
            totalStocks: 0,
            processedStocks: 0,
            currentProgress: 100,
            skipped: true,
            reason: 'no_stocks_to_sync',
          },
        });
        await job.progress(100);
        return {
          success: true,
          skipped: true,
          reason: 'no_stocks_to_sync',
          totalStocks: 0,
          successfulSyncs: 0,
          failedSyncs: 0,
          skippedSyncs: 0,
          totalRecordsInserted: 0,
          logId: updateLog.id,
        };
      }

      logger.info(`批量同步任务开始，本次需要处理 ${stocksToSync.length} 只股票`);
      logger.info(`日期范围: ${actualStartDate} 到 ${actualEndDate}, 并发数: ${concurrency}`);

      // 更新日志记录
      await updateLog.update({
        result: {
          ...updateLog.result,
          totalStocks: stocksToSync.length + processedStocksSet.size,
          processedStocks: processedStocksSet.size,
          currentProgress:
            processedStocksSet.size > 0
              ? Math.floor(
                  (processedStocksSet.size / (stocksToSync.length + processedStocksSet.size)) * 100
                )
              : 0,
        },
      });

      await job.progress(20);

      // 执行批量同步
      let currentTotalInserted = job.data.totalInserted || 0;
      const totalCountForProgress = stocksToSync.length + processedStocksSet.size;

      const syncResults = await this.dataSyncService.syncMultipleStocksHistory(
        stocksToSync,
        actualStartDate,
        actualEndDate,
        concurrency,
        async (processedCount, totalCount, currentBatchInserted, completedBatchSymbols) => {
          currentTotalInserted += currentBatchInserted;

          // 更新 job.data 实现断点续传状态保存
          if (completedBatchSymbols && completedBatchSymbols.length > 0) {
            job.data.completedSymbols.push(...completedBatchSymbols);
            job.data.totalInserted = currentTotalInserted;
            await job.update(job.data);
          }

          const overallProcessedCount = processedCount + processedStocksSet.size;

          // 更新日志进度
          await updateLog.update({
            affected_stocks: overallProcessedCount,
            inserted_records: currentTotalInserted,
            result: {
              ...updateLog.result,
              processedStocks: overallProcessedCount,
              currentProgress: Math.floor((overallProcessedCount / totalCountForProgress) * 100),
            },
          });

          // 报告 Bull 队列进度 (在20%到99%之间)
          const bullProgress =
            20 + Math.floor((overallProcessedCount / totalCountForProgress) * 79);
          await job.progress(bullProgress);
        },
        dataSource
      );

      // 统计结果
      const successfulSyncs = Object.values(syncResults).filter(count => count > 0).length;
      const failedSyncs = Object.values(syncResults).filter(count => count === -1).length;
      const skippedSyncs = Object.values(syncResults).filter(count => count === 0).length;
      const totalRecordsInserted = Object.values(syncResults).reduce(
        (sum, count) => (count > 0 ? sum + count : sum),
        0
      );

      // 更新日志记录
      await updateLog.update({
        status: UpdateStatus.COMPLETED,
        completed_at: new Date(),
        affected_stocks: stocksToSync.length + processedStocksSet.size,
        inserted_records: currentTotalInserted,
        result: {
          ...updateLog.result,
          successfulSyncs,
          failedSyncs,
          skippedSyncs,
          totalRecordsInserted: currentTotalInserted,
        },
      });

      await job.progress(100);

      return {
        success: true,
        message: `批量同步完成，共处理 ${
          stocksToSync.length + processedStocksSet.size
        } 只股票，插入 ${currentTotalInserted} 条记录`,
        logId: updateLog.id,
        totalStocks: stocksToSync.length + processedStocksSet.size,
        successfulSyncs,
        failedSyncs,
        skippedSyncs,
        totalRecordsInserted: currentTotalInserted,
      };
    } catch (error: any) {
      logger.error('批量同步任务执行失败:', error);

      // 更新日志状态
      await DataUpdateLog.update(
        {
          status: UpdateStatus.FAILED,
          error: error.message,
          completed_at: new Date(),
        },
        {
          where: {
            date,
            type: UpdateType.BULK_SYNC_CUSTOM,
            status: UpdateStatus.IN_PROGRESS,
          },
        }
      );

      throw error;
    } finally {
      if (lockValue) {
        await redisLock.release(lockKey, lockValue);
      }
    }
  }

  private async getStocksForHistorySync(options: {
    batch_limit?: number;
    lag_days_threshold?: number;
    stale_first?: boolean;
    include_no_data?: boolean;
    end_date: string;
  }): Promise<string[]> {
    const limit = Math.min(Math.max(Number(options.batch_limit || 200), 1), 6000);
    const lagDaysThreshold = Math.max(Number(options.lag_days_threshold || 0), 0);
    const targetDate = moment.tz(options.end_date, 'Asia/Shanghai').endOf('day').toDate();
    const rows = (await Stock.findAll({
      where: { is_listed: true },
      attributes: [
        'id',
        'symbol',
        [DailyBar.sequelize!.fn('MAX', DailyBar.sequelize!.col('daily_bars.time')), 'latest_time'],
      ],
      include: [
        {
          model: DailyBar,
          attributes: [],
          required: false,
        },
      ],
      group: ['Stock.id', 'Stock.symbol'],
      order: [
        DailyBar.sequelize!.literal(
          options.stale_first === false
            ? 'MAX("daily_bars"."time") DESC NULLS LAST'
            : 'MAX("daily_bars"."time") ASC NULLS FIRST'
        ) as any,
        DailyBar.sequelize!.literal(`
          CASE
            WHEN "Stock"."symbol" LIKE 'sh.60%' THEN 1
            WHEN "Stock"."symbol" LIKE 'sz.00%' THEN 2
            WHEN "Stock"."symbol" LIKE 'sz.30%' THEN 3
            WHEN "Stock"."symbol" LIKE 'sh.68%' THEN 4
            WHEN "Stock"."symbol" LIKE 'bj.%' THEN 8
            ELSE 9
          END
        `) as any,
        ['id', 'ASC'],
      ],
      raw: true,
      subQuery: false,
      limit: limit * 6,
    })) as any[];

    const totalRows = rows.length;
    const noDataRows = rows.filter(row => !row.latest_time).length;
    const shouldIncludeNoData =
      options.include_no_data !== undefined
        ? Boolean(options.include_no_data)
        : totalRows > 0 && noDataRows / totalRows >= 0.35;

    if (options.include_no_data === undefined && shouldIncludeNoData) {
      logger.info(`历史同步检测到行情库覆盖率较低，自动纳入未入库股票: ${noDataRows}/${totalRows}`);
    }

    return rows
      .filter(row => {
        if (!row.latest_time) return shouldIncludeNoData;
        const latest = new Date(row.latest_time);
        const lagDays = moment(targetDate).diff(moment(latest), 'days');
        return lagDays > lagDaysThreshold;
      })
      .slice(0, limit)
      .map(row => row.symbol);
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
