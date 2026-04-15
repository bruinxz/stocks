import { CombinedDataSource, StockBasicInfo, DailyBar as DataSourceDailyBar } from '../sources/CombinedDataSource';
import { Stock, DailyBar } from '../../models';
import { sequelize } from '../../config/database';
import { logger } from '../../utils/logger';
import { getEast8TimeString, getEast8DateString, getEast8Time } from '../../utils/timezone';
import { normalizeSymbol, extractMarket as extractMarketFromSymbol, isValidSymbol, normalizeSymbols } from '../../utils/stockSymbol';
import { Op } from 'sequelize';

/**
 * 错误分类
 */
export enum ErrorCategory {
  STOCK_UPSERT = 'stock_upsert',
  STOCK_NOT_FOUND = 'stock_not_found',
  DATA_SOURCE_FETCH = 'data_source_fetch',
  DATA_VALIDATION = 'data_validation',
  DATABASE_INSERT = 'database_insert',
  DATABASE_QUERY = 'database_query',
  DATE_VALIDATION = 'date_validation',
  CONFIGURATION = 'configuration',
  NETWORK = 'network',
  UNKNOWN = 'unknown',
}

/**
 * 错误统计
 */
export interface ErrorStats {
  [category: string]: {
    count: number;
    lastError: string | null;
    lastTimestamp: string | null;
    samples: Array<{ error: string; timestamp: string; context?: any }>;
  };
}

/**
 * 同步结果统计
 */
export interface SyncStats {
  totalSyncs: number;
  successfulSyncs: number;
  failedSyncs: number;
  totalRecordsInserted: number;
  averageInsertPerSync: number;
  lastSyncTimestamp: string | null;
  errorStats: ErrorStats;
}

export class DataSyncService {
  private dataSource: CombinedDataSource;
  private errorStats: ErrorStats;
  private syncStats: {
    totalSyncs: number;
    successfulSyncs: number;
    failedSyncs: number;
    totalRecordsInserted: number;
    totalRecordsAttempted: number;
    totalRecordsFailed: number;
    lastSyncTimestamp: string | null;
    lastAlertTimestamp: string | null;
    consecutiveHighFailureSyncs: number;
  };

  constructor() {
    this.dataSource = new CombinedDataSource();
    this.resetStats();
  }

  /**
   * 记录错误
   */
  private recordError(
    category: ErrorCategory,
    error: Error | string,
    context?: any
  ): void {
    const errorMessage = typeof error === 'string' ? error : error.message;
    const timestamp = getEast8TimeString();

    if (!this.errorStats[category]) {
      this.errorStats[category] = {
        count: 0,
        lastError: null,
        lastTimestamp: null,
        samples: [],
      };
    }

    const categoryStats = this.errorStats[category];
    categoryStats.count++;
    categoryStats.lastError = errorMessage;
    categoryStats.lastTimestamp = timestamp;

    // 保留最近10个错误样本
    categoryStats.samples.push({
      error: errorMessage,
      timestamp,
      context,
    });

    if (categoryStats.samples.length > 10) {
      categoryStats.samples = categoryStats.samples.slice(-10);
    }

    logger.error(`[${category}] ${errorMessage}`, { context });
  }

  /**
   * 记录同步结果
   */
  private recordSyncResult(success: boolean, recordsInserted: number = 0): void {
    this.syncStats.totalSyncs++;

    if (success) {
      this.syncStats.successfulSyncs++;
      this.syncStats.totalRecordsInserted += recordsInserted;
    } else {
      this.syncStats.failedSyncs++;
    }

    this.syncStats.lastSyncTimestamp = getEast8TimeString();

    // 检查是否需要告警
    this.checkAndAlert();
  }

  /**
   * 记录同步指标（记录尝试和失败的详细统计）
   */
  private recordSyncMetrics(recordsAttempted: number, recordsFailed: number = 0): void {
    this.syncStats.totalRecordsAttempted += recordsAttempted;
    this.syncStats.totalRecordsFailed += recordsFailed;

    // 检查失败率
    if (recordsAttempted > 0) {
      const failureRate = recordsFailed / recordsAttempted;
      if (failureRate > 0.5) { // 失败率超过50%
        this.syncStats.consecutiveHighFailureSyncs++;
        logger.warn(`高失败率告警: 尝试 ${recordsAttempted} 条记录，失败 ${recordsFailed} 条，失败率 ${(failureRate * 100).toFixed(1)}%`);
      } else {
        this.syncStats.consecutiveHighFailureSyncs = 0; // 重置连续高失败计数
      }
    }
  }

  /**
   * 检查并触发告警
   */
  private checkAndAlert(): void {
    // 检查连续高失败同步次数
    if (this.syncStats.consecutiveHighFailureSyncs >= 3) {
      const now = getEast8TimeString();
      const lastAlert = this.syncStats.lastAlertTimestamp;

      // 防止告警过于频繁（至少间隔1小时）
      if (!lastAlert || (new Date(now).getTime() - new Date(lastAlert).getTime() > 3600000)) {
        logger.error(`⚠️ 严重告警: 连续 ${this.syncStats.consecutiveHighFailureSyncs} 次同步出现高失败率！`);
        logger.error(`  总同步次数: ${this.syncStats.totalSyncs}`);
        logger.error(`  成功同步: ${this.syncStats.successfulSyncs}`);
        logger.error(`  失败同步: ${this.syncStats.failedSyncs}`);
        logger.error(`  总尝试记录: ${this.syncStats.totalRecordsAttempted}`);
        logger.error(`  总失败记录: ${this.syncStats.totalRecordsFailed}`);
        if (this.syncStats.totalRecordsAttempted > 0) {
          const overallFailureRate = (this.syncStats.totalRecordsFailed / this.syncStats.totalRecordsAttempted * 100).toFixed(1);
          logger.error(`  总体失败率: ${overallFailureRate}%`);
        }

        this.syncStats.lastAlertTimestamp = now;

        // 这里可以扩展为发送邮件、Slack通知等
        // 例如: this.sendAlertToSlack(message);
      }
    }

    // 检查总体失败率
    if (this.syncStats.totalRecordsAttempted > 100) { // 至少有100条记录才检查
      const overallFailureRate = this.syncStats.totalRecordsFailed / this.syncStats.totalRecordsAttempted;
      if (overallFailureRate > 0.3) { // 总体失败率超过30%
        logger.warn(`高总体失败率: ${(overallFailureRate * 100).toFixed(1)}% (${this.syncStats.totalRecordsFailed}/${this.syncStats.totalRecordsAttempted})`);
      }
    }
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.errorStats = {};
    this.syncStats = {
      totalSyncs: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      totalRecordsInserted: 0,
      totalRecordsAttempted: 0,
      totalRecordsFailed: 0,
      lastSyncTimestamp: null,
      lastAlertTimestamp: null,
      consecutiveHighFailureSyncs: 0,
    };
  }

  /**
   * 获取错误统计
   */
  getErrorStats(): ErrorStats {
    return { ...this.errorStats };
  }

  /**
   * 获取同步统计
   */
  getSyncStats() {
    const averageInsertPerSync = this.syncStats.totalSyncs > 0
      ? this.syncStats.totalRecordsInserted / this.syncStats.totalSyncs
      : 0;

    return {
      ...this.syncStats,
      averageInsertPerSync: parseFloat(averageInsertPerSync.toFixed(2)),
      errorStats: this.getErrorStats(),
    };
  }

  /**
   * 同步所有股票列表
   */
  async syncAllStocks(): Promise<number> {
    try {
      logger.info('Starting to sync all stocks from data source...');

      const stocks = await this.dataSource.getAllStocks();
      logger.info(`Fetched ${stocks.length} stocks from data source`);

      let createdCount = 0;
      let updatedCount = 0;
      let failedCount = 0;

      for (const stockData of stocks) {
        const symbol = normalizeSymbol(stockData.code);
        try {
          const [stock, created] = await Stock.upsert({
            symbol: symbol,
            name: stockData.code_name,
            listingDate: this.safeParseDate(stockData.ipoDate),
            delistingDate: this.safeParseDate(stockData.outDate),
            isListed: stockData.status === 1,
            type: this.mapStockType(stockData.type),
            market: extractMarketFromSymbol(symbol),
          }, {
            conflictFields: ['symbol'],
          });

          if (created) {
            createdCount++;
          } else {
            updatedCount++;
          }
        } catch (error) {
          failedCount++;
          this.recordError(
            ErrorCategory.STOCK_UPSERT,
            error,
            { symbol: symbol, stockData }
          );
        }
      }

      // 记录同步指标
      this.recordSyncMetrics(stocks.length, failedCount);

      logger.info(`Stock sync completed. Created: ${createdCount}, Updated: ${updatedCount}, Failed: ${failedCount}`);
      const totalAffected = createdCount + updatedCount;
      this.recordSyncResult(true, totalAffected);
      return totalAffected;
    } catch (error) {
      this.recordError(ErrorCategory.DATA_SOURCE_FETCH, error);
      this.recordSyncResult(false);
      throw error;
    }
  }

  /**
   * 同步单只股票的历史数据
   * @param symbol 股票代码
   * @param startDate 开始日期，格式：'2020-01-01'
   * @param endDate 结束日期，格式：'2023-12-31'
   */
  async syncStockHistory(
    symbol: string,
    startDate: string,
    endDate: string
  ): Promise<number> {
    const normalizedSymbol = normalizeSymbol(symbol);
    try {
      logger.info(`Syncing history for ${normalizedSymbol} (original: ${symbol}) from ${startDate} to ${endDate}`);

      // 验证日期范围
      const { validStartDate, validEndDate } = this.validateDateRange(startDate, endDate);
      if (validStartDate !== startDate || validEndDate !== endDate) {
        logger.info(`日期范围已调整: ${validStartDate} 到 ${validEndDate} (原始: ${startDate} 到 ${endDate})`);
      }

      // 查找股票
      const stock = await Stock.findOne({
        where: { symbol: normalizedSymbol },
      });

      if (!stock) {
        const error = new Error(`Stock ${normalizedSymbol} not found in database`);
        this.recordError(ErrorCategory.STOCK_NOT_FOUND, error, { symbol: normalizedSymbol });
        throw error;
      }

      // 从数据源获取指定日期范围的数据
      // 我们会获取整个范围的数据，然后只插入数据库中不存在的记录
      const bars = await this.dataSource.queryHistoryKData(
        normalizedSymbol,
        validStartDate,
        validEndDate
      );

      logger.info(`Fetched ${bars.length} daily bars for ${normalizedSymbol} from ${validStartDate} to ${validEndDate}`);

      let insertedCount = 0;
      let failedCount = 0;
      let processedCount = 0;

      for (const barData of bars) {
        processedCount++;
        try {
          // 检查是否已存在
          const existing = await DailyBar.findOne({
            where: {
              stockId: stock.id,
              time: new Date(barData.date + 'T00:00:00.000Z'),
            },
          });

          if (!existing) {
            // 确保所有字段类型正确
            const barToInsert = {
              stockId: stock.id,
              time: new Date(barData.date + 'T00:00:00.000Z'),
              open: Number(barData.open) || 0,
              high: Number(barData.high) || 0,
              low: Number(barData.low) || 0,
              close: Number(barData.close) || 0,
              volume: Math.round(Number(barData.volume) || 0), // 确保是整数
              turnover: Number(barData.amount) || 0,
              adjClose: Number(barData.close) || 0,
              turnoverRate: Number(barData.turn) || 0,
              changePercent: Number(barData.pctChg) || 0,
              pe: Number(barData.peTTM) || 0,
              pb: Number(barData.pbMRQ) || 0,
              ps: Number(barData.psTTM) || 0,
              isTradingDay: barData.tradestatus === 1,
              isSuspended: barData.tradestatus === 0,
            };

            // 验证关键字段
            if (isNaN(barToInsert.volume)) {
              const error = `Invalid volume for ${normalizedSymbol} on ${barData.date}: ${barData.volume}, using 0`;
              logger.warn(error);
              this.recordError(ErrorCategory.DATA_VALIDATION, error, { symbol: normalizedSymbol, date: barData.date, field: 'volume', value: barData.volume });
              barToInsert.volume = 0;
            }

            if (isNaN(barToInsert.close)) {
              const error = `Invalid close price for ${normalizedSymbol} on ${barData.date}: ${barData.close}, using 0`;
              logger.warn(error);
              this.recordError(ErrorCategory.DATA_VALIDATION, error, { symbol: normalizedSymbol, date: barData.date, field: 'close', value: barData.close });
              barToInsert.close = 0;
            }

            await DailyBar.create(barToInsert);
            insertedCount++;
          }
        } catch (error) {
          failedCount++;
          this.recordError(
            ErrorCategory.DATABASE_INSERT,
            error,
            { symbol: normalizedSymbol, date: barData.date, barData }
          );
          // 继续处理下一条记录
        }
      }

      // 记录同步指标
      const attemptedCount = bars.length; // 尝试处理的记录数
      this.recordSyncMetrics(attemptedCount, failedCount);

      logger.info(`Inserted ${insertedCount} new daily bars for ${normalizedSymbol}, failed: ${failedCount}`);
      this.recordSyncResult(true, insertedCount);
      return insertedCount;
    } catch (error) {
      this.recordError(ErrorCategory.DATA_SOURCE_FETCH, error, { symbol: normalizedSymbol, startDate, endDate });
      this.recordSyncResult(false);
      throw error;
    }
  }

  /**
   * 批量同步多只股票的历史数据
   * @param symbols 股票代码数组
   * @param startDate 开始日期
   * @param endDate 结束日期
   * @param batchSize 批次大小
   */
  async syncMultipleStocksHistory(
    symbols: string[],
    startDate: string,
    endDate: string,
    batchSize: number = 10
  ): Promise<{ [symbol: string]: number }> {
    const normalizedSymbols = normalizeSymbols(symbols);
    const results: { [symbol: string]: number } = {};

    for (let i = 0; i < normalizedSymbols.length; i += batchSize) {
      const batch = normalizedSymbols.slice(i, i + batchSize);
      const promises = batch.map(symbol =>
        this.syncStockHistory(symbol, startDate, endDate)
          .then(count => {
            results[symbol] = count;
            return { symbol, count };
          })
          .catch(error => {
            this.recordError(
              ErrorCategory.UNKNOWN,
              error,
              { symbol, startDate, endDate, batchIndex: i / batchSize }
            );
            results[symbol] = -1;
            return { symbol, count: -1 };
          })
      );

      await Promise.all(promises);
      logger.info(`Completed batch ${i / batchSize + 1}/${Math.ceil(normalizedSymbols.length / batchSize)}`);

      // 批次间延迟，避免请求过于频繁
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  /**
   * 同步指数成分股
   * @param indexCode 指数代码，如 'sh.000300' (沪深300)
   */
  async syncIndexStocks(indexCode: string): Promise<number> {
    try {
      logger.info(`Syncing index stocks for ${indexCode}`);

      const indexStocks = await this.dataSource.getIndexStocks(indexCode);
      logger.info(`Fetched ${indexStocks.length} stocks for index ${indexCode}`);

      let syncedCount = 0;
      let failedCount = 0;
      for (const stockData of indexStocks) {
        const symbol = normalizeSymbol(stockData.code);
        try {
          const [stock, created] = await Stock.upsert({
            symbol: symbol,
            name: stockData.code_name,
            market: extractMarketFromSymbol(symbol),
            isListed: true,
            type: 'stock',
          }, {
            conflictFields: ['symbol'],
          });

          if (created) {
            syncedCount++;
          }
        } catch (error) {
          failedCount++;
          this.recordError(
            ErrorCategory.STOCK_UPSERT,
            error,
            { symbol: symbol, indexCode, stockData }
          );
        }
      }

      // 记录同步指标
      this.recordSyncMetrics(indexStocks.length, failedCount);

      logger.info(`Index stock sync completed for ${indexCode}. Synced: ${syncedCount}, Failed: ${failedCount}`);
      this.recordSyncResult(true, syncedCount);
      return syncedCount;
    } catch (error) {
      this.recordError(ErrorCategory.DATA_SOURCE_FETCH, error, { indexCode });
      this.recordSyncResult(false);
      throw error;
    }
  }

  /**
   * 获取需要更新的股票列表（最近N天没有数据的股票）
   * @param days 天数阈值
   */
  async getStocksNeedingUpdate(days: number = 7): Promise<string[]> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const stocks = await Stock.findAll({
        include: [{
          model: DailyBar,
          as: 'dailyBars',
          required: false,
          where: {
            time: { [Op.gte]: cutoffDate },
          },
        }],
      });

      const needsUpdate = stocks.filter(stock => {
        // 如果没有最近的数据，则需要更新
        return !stock.dailyBars || stock.dailyBars.length === 0;
      });

      return normalizeSymbols(needsUpdate.map(stock => stock.symbol));
    } catch (error) {
      this.recordError(ErrorCategory.DATABASE_QUERY, error);
      throw error;
    }
  }

  /**
   * 每日数据更新任务
   */
  async dailyUpdate(): Promise<{ [symbol: string]: number }> {
    try {
      logger.info('Starting daily data update...');

      // 获取最后一个交易日作为结束日期
      const lastTradingDay = this.getLastTradingDay();
      // 计算东八区7天前的日期
      const nowEast8 = getEast8Time();
      const sevenDaysAgo = new Date(nowEast8.getTime() - 7 * 24 * 60 * 60 * 1000);
      const startDate = sevenDaysAgo.toISOString().split('T')[0];

      // 验证日期范围
      const { validStartDate, validEndDate } = this.validateDateRange(startDate, lastTradingDay);
      logger.info(`使用日期范围: ${validStartDate} 到 ${validEndDate} (原始: ${startDate} 到 ${lastTradingDay})`);

      // 检查是否需要更新（如果结束日期早于最后一个交易日）
      if (validEndDate < lastTradingDay) {
        logger.warn(`有效结束日期 ${validEndDate} 早于最后一个交易日 ${lastTradingDay}，可能是周末或节假日`);
      }

      // 获取所有已上市的股票
      const stocks = await Stock.findAll({
        where: { isListed: true },
        attributes: ['symbol'],
      });

      const symbols = normalizeSymbols(stocks.map(stock => stock.symbol));
      logger.info(`Updating ${symbols.length} stocks (filtered from ${stocks.length} total stocks)`);

      if (symbols.length === 0) {
        logger.warn('No valid symbols found for daily update');
        return {};
      }

      const results = await this.syncMultipleStocksHistory(
        symbols,
        validStartDate,
        validEndDate,
        5 // 小批次，避免请求过多
      );

      const successCount = Object.values(results).filter(count => count > 0).length;
      const failCount = Object.values(results).filter(count => count === -1).length;
      const skipCount = Object.values(results).filter(count => count === 0).length;
      const totalInserted = Object.values(results).filter(count => count > 0).reduce((sum, count) => sum + count, 0);

      logger.info(`Daily update completed. Success: ${successCount}, Failed: ${failCount}, Skipped: ${skipCount}, Inserted: ${totalInserted}`);

      // 记录同步结果：只要有任何成功或跳过的股票（而不是全部失败），就认为是成功的
      const hasSuccess = successCount > 0 || skipCount > 0;
      this.recordSyncResult(hasSuccess, totalInserted);

      return results;
    } catch (error) {
      this.recordError(ErrorCategory.DATA_SOURCE_FETCH, error);
      this.recordSyncResult(false);
      throw error;
    }
  }

  /**
   * 安全解析日期字符串，如果无效则返回null
   */
  private safeParseDate(dateString: string | null | undefined): Date | null {
    if (!dateString || dateString.trim() === '' || dateString.toLowerCase() === 'null' || dateString === 'Invalid date') {
      return null;
    }

    try {
      const date = new Date(dateString);
      // 检查是否为有效日期
      if (isNaN(date.getTime())) {
        return null;
      }
      return date;
    } catch {
      return null;
    }
  }

  /**
   * 映射股票类型
   */
  private mapStockType(type: number): string {
    const typeMap: { [key: number]: string } = {
      1: 'stock',
      2: 'index',
      3: 'fund',
      4: 'bond',
      5: 'option',
    };
    return typeMap[type] || 'other';
  }

  /**
   * 从股票代码中提取市场信息
   * @deprecated 使用 extractMarketFromSymbol 工具函数
   */
  private extractMarket(symbol: string): string {
    return extractMarketFromSymbol(symbol);
  }

  /**
   * 验证日期范围，确保不请求未来日期
   */
  private validateDateRange(startDate: string, endDate: string): { validStartDate: string; validEndDate: string } {
    const today = getEast8DateString();

    // 如果结束日期晚于今天，调整为今天
    let validEndDate = endDate;
    if (endDate > today) {
      logger.warn(`结束日期 ${endDate} 晚于今天 ${today}，调整为今天`);
      validEndDate = today;
    }

    // 如果开始日期晚于有效结束日期，调整开始日期
    let validStartDate = startDate;
    if (startDate > validEndDate) {
      logger.warn(`开始日期 ${startDate} 晚于结束日期 ${validEndDate}，调整为结束日期前30天`);
      const start = new Date(validEndDate);
      start.setDate(start.getDate() - 30);
      validStartDate = start.toISOString().split('T')[0];
    }

    // 确保日期格式正确
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(validStartDate) || !dateRegex.test(validEndDate)) {
      throw new Error(`日期格式无效: startDate=${validStartDate}, endDate=${validEndDate}，必须为YYYY-MM-DD格式`);
    }

    // 检查开始日期是否太早（A股历史数据从1990年开始）
    const minDate = '1990-01-01';
    if (validStartDate < minDate) {
      logger.warn(`开始日期 ${validStartDate} 早于A股历史起始日期 ${minDate}，调整为 ${minDate}`);
      validStartDate = minDate;
    }

    return { validStartDate, validEndDate };
  }

  /**
   * 获取最后一个交易日（简单实现：如果不是周末则返回昨天，否则返回周五）
   * 未来可扩展为查询交易日历
   */
  private getLastTradingDay(date?: Date): string {
    const inputDate = date || getEast8Time();
    const result = new Date(inputDate);
    const dayOfWeek = result.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday

    // 如果是周日，回退2天到周五
    if (dayOfWeek === 0) {
      result.setDate(result.getDate() - 2);
    }
    // 如果是周一，回退3天到周五
    else if (dayOfWeek === 1) {
      result.setDate(result.getDate() - 3);
    }
    // 其他工作日，回退1天
    else {
      result.setDate(result.getDate() - 1);
    }

    return result.toISOString().split('T')[0];
  }

  /**
   * 检查是否为交易日（简单实现：周一至周五）
   * 未来可扩展为查询交易日历
   */
  private isTradingDay(date: string): boolean {
    const dateObj = new Date(date + 'T00:00:00.000Z');
    const dayOfWeek = dateObj.getDay();
    return dayOfWeek >= 1 && dayOfWeek <= 5; // 周一至周五
  }

  /**
   * 获取服务状态
   */
  getStatus() {
    return {
      dataSourceStatus: this.dataSource.getStatus(),
      lastSync: getEast8TimeString(),
    };
  }
}