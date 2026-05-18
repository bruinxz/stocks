import { DailyBar } from '../../models/DailyBar';
import { Stock } from '../../models/Stock';
import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { DataSyncService } from './DataSyncService';

export interface IDataService {
  /**
   * 获取股票日线数据
   * @param fastMode 快速模式：如果为true，只返回数据库已有数据，不尝试数据源补充
   */
  getDailyBars(
    symbol: string,
    start_date: Date,
    end_date: Date,
    fastMode?: boolean
  ): Promise<DailyBar[]>;

  /**
   * 获取多只股票日线数据
   */
  getMultipleDailyBars(
    symbols: string[],
    start_date: Date,
    end_date: Date,
    fastMode?: boolean
  ): Promise<Map<string, DailyBar[]>>;

  /**
   * 获取股票基本信息
   */
  getStockInfo(symbol: string): Promise<Stock | null>;

  /**
   * 获取股票列表
   */
  getStockList(): Promise<Stock[]>;

  /**
   * 获取交易日历
   */
  getTradingDays(start_date: Date, end_date: Date): Promise<Date[]>;

  /**
   * 异步补充股票缺失数据（不阻塞主请求）
   */
  asyncSupplementMissingData(symbol: string, start_date: Date, end_date: Date): Promise<void>;
}

export class DataService implements IDataService {
  private dataSyncService: DataSyncService;
  // 记录数据源空结果的缓存，避免对明显无数据的股票频繁查询
  private emptyResultCache: Map<string, number>; // key: symbol_start_end, value: timestamp
  // 记录数据源错误，避免频繁请求不可用的数据源
  private sourceErrorCache: Map<string, number>; // key: symbol or 'global', value: timestamp
  private EMPTY_RESULT_CACHE_MS = 5 * 60 * 1000; // 5分钟缓存空结果
  private SOURCE_ERROR_CACHE_MS = 10 * 60 * 1000; // 10分钟缓存数据源错误
  // 数据源错误计数，连续错误达到阈值时临时禁用数据源
  private consecutiveSourceErrors = 0;
  private MAX_CONSECUTIVE_ERRORS = 5;

  constructor() {
    this.dataSyncService = new DataSyncService();
    this.emptyResultCache = new Map();
    this.sourceErrorCache = new Map();
  }

  /**
   * 检查数据源是否可用（避免连续错误时频繁调用）
   */
  private isDataSourceAvailable(symbol: string): boolean {
    const key = `source_error_${symbol}`;
    const globalKey = 'source_error_global';
    const now = Date.now();

    // 检查特定股票的错误缓存
    const symbolErrorTime = this.sourceErrorCache.get(key);
    if (symbolErrorTime && now - symbolErrorTime < this.SOURCE_ERROR_CACHE_MS) {
      logger.warn(`数据源对于股票 ${symbol} 暂时不可用（错误缓存期内）`);
      return false;
    }

    // 检查全局错误缓存
    const globalErrorTime = this.sourceErrorCache.get(globalKey);
    if (globalErrorTime && now - globalErrorTime < this.SOURCE_ERROR_CACHE_MS) {
      logger.warn(`数据源全局暂时不可用（错误缓存期内）`);
      return false;
    }

    return true;
  }

  /**
   * 记录数据源错误
   */
  private recordDataSourceError(symbol: string): void {
    const key = `source_error_${symbol}`;
    const globalKey = 'source_error_global';
    const now = Date.now();

    this.sourceErrorCache.set(key, now);
    this.sourceErrorCache.set(globalKey, now);

    // 清理过期错误缓存
    const expiryTime = 24 * 60 * 60 * 1000; // 1天
    for (const [cacheKey, timestamp] of this.sourceErrorCache.entries()) {
      if (now - timestamp > expiryTime) {
        this.sourceErrorCache.delete(cacheKey);
      }
    }
  }

  /**
   * 生成缓存键
   */
  private getCacheKey(symbol: string, start_date: string, end_date: string): string {
    return `${symbol}_${start_date}_${end_date}`;
  }

  /**
   * 检查是否应该跳过同步（因为最近一次同步返回了空结果）
   */
  private shouldSkipDueToEmptyResult(symbol: string, start_date: string, end_date: string): boolean {
    const key = this.getCacheKey(symbol, start_date, end_date);
    const lastEmptyResult = this.emptyResultCache.get(key);

    if (!lastEmptyResult) {
      return false;
    }

    // 检查是否在空结果缓存期内
    const now = Date.now();
    return now - lastEmptyResult < this.EMPTY_RESULT_CACHE_MS;
  }

  /**
   * 记录空结果（数据源返回0条数据）
   */
  private recordEmptyResult(symbol: string, start_date: string, end_date: string): void {
    const key = this.getCacheKey(symbol, start_date, end_date);
    this.emptyResultCache.set(key, Date.now());

    // 清理过期缓存（超过1天的记录）
    const expiryTime = 24 * 60 * 60 * 1000; // 1天
    const now = Date.now();
    for (const [cacheKey, timestamp] of this.emptyResultCache.entries()) {
      if (now - timestamp > expiryTime) {
        this.emptyResultCache.delete(cacheKey);
      }
    }
  }

  /**
   * 查找缺失的日期范围
   */
  private findMissingDateRanges(
    existingBars: DailyBar[],
    start_date: Date,
    end_date: Date
  ): { start_date: Date; end_date: Date }[] {
    if (existingBars.length === 0) {
      return [{ start_date, end_date }];
    }

    // 按时间排序
    const sortedBars = [...existingBars].sort((a, b) => a.time.getTime() - b.time.getTime());
    const missingRanges: { start_date: Date; end_date: Date }[] = [];

    // 检查开始日期到第一个数据点之间的缺失
    const firstBarTime = sortedBars[0].time.getTime();
    const startTime = start_date.getTime();
    if (firstBarTime > startTime) {
      const missingEnd = new Date(firstBarTime - 24 * 60 * 60 * 1000); // 前一天
      missingRanges.push({ start_date, end_date: missingEnd });
    }

    // 检查数据点之间的缺失
    for (let i = 0; i < sortedBars.length - 1; i++) {
      const currentTime = sortedBars[i].time.getTime();
      const nextTime = sortedBars[i + 1].time.getTime();
      const gap = nextTime - currentTime;

      // 如果间隔超过2天（允许周末和节假日），认为有缺失
      if (gap > 2 * 24 * 60 * 60 * 1000) {
        const missingStart = new Date(currentTime + 24 * 60 * 60 * 1000); // 下一天
        const missingEnd = new Date(nextTime - 24 * 60 * 60 * 1000); // 前一天
        missingRanges.push({ start_date: missingStart, end_date: missingEnd });
      }
    }

    // 检查最后一个数据点到结束日期之间的缺失
    const lastBarTime = sortedBars[sortedBars.length - 1].time.getTime();
    const endTime = end_date.getTime();
    if (lastBarTime < endTime) {
      const missingStart = new Date(lastBarTime + 24 * 60 * 60 * 1000); // 下一天
      missingRanges.push({ start_date: missingStart, end_date });
    }

    return this.mergeMissingRanges(missingRanges);
  }

  /**
   * 合并相邻的缺失日期范围，减少数据源调用次数
   */
  private mergeMissingRanges(
    ranges: { start_date: Date; end_date: Date }[]
  ): { start_date: Date; end_date: Date }[] {
    if (ranges.length <= 1) {
      return ranges;
    }

    // 按开始日期排序
    const sortedRanges = [...ranges].sort((a, b) => a.start_date.getTime() - b.start_date.getTime());
    const merged: { start_date: Date; end_date: Date }[] = [];
    let currentRange = sortedRanges[0];

    for (let i = 1; i < sortedRanges.length; i++) {
      const nextRange = sortedRanges[i];
      const currentEnd = currentRange.end_date.getTime();
      const nextStart = nextRange.start_date.getTime();

      // 如果两个范围相邻或重叠（间隔小于等于3天），合并它们
      // 3天考虑到周末和节假日
      if (nextStart - currentEnd <= 3 * 24 * 60 * 60 * 1000) {
        // 合并范围，取最晚的结束日期
        currentRange = {
          start_date: currentRange.start_date,
          end_date:
            currentRange.end_date.getTime() > nextRange.end_date.getTime()
              ? currentRange.end_date
              : nextRange.end_date,
        };
      } else {
        merged.push(currentRange);
        currentRange = nextRange;
      }
    }

    merged.push(currentRange);

    // 限制最大范围数量（避免过多数据源调用）
    const MAX_RANGES = 3;
    if (merged.length > MAX_RANGES) {
      logger.warn(`合并后仍有 ${merged.length} 个缺失范围，限制为 ${MAX_RANGES} 个`);
      return merged.slice(0, MAX_RANGES);
    }

    return merged;
  }

  /**
   * 获取缺失日期的数据并插入数据库
   */
  private async fetchAndInsertMissingData(
    missingRanges: { start_date: Date; end_date: Date }[],
    symbol: string
  ): Promise<number> {
    // 检查数据源是否可用
    if (!this.isDataSourceAvailable(symbol)) {
      logger.warn(`数据源对于股票 ${symbol} 不可用，跳过数据补充`);
      return 0;
    }

    let totalInserted = 0;

    for (const range of missingRanges) {
      // 检查是否应该跳过（因为最近返回过空结果）
      const startDateStr = range.start_date.toISOString().split('T')[0];
      const endDateStr = range.end_date.toISOString().split('T')[0];

      if (this.shouldSkipDueToEmptyResult(symbol, startDateStr, endDateStr)) {
        logger.info(
          `跳过股票 ${symbol} 的缺失范围 ${startDateStr} 到 ${endDateStr}（最近返回过空结果）`
        );
        continue;
      }

      logger.info(`获取股票 ${symbol} 缺失数据: ${startDateStr} 到 ${endDateStr}`);

      try {
        const syncCount = await this.dataSyncService.syncStockHistory(
          symbol,
          startDateStr,
          endDateStr
        );

        if (syncCount > 0) {
          logger.info(
            `成功插入 ${syncCount} 条缺失数据 for ${symbol} (${startDateStr} to ${endDateStr})`
          );
          totalInserted += syncCount;
          // 成功时重置错误计数
          this.consecutiveSourceErrors = 0;
        } else {
          // 数据源返回0条数据，可能是这个时间段没有数据（如停牌期间）
          logger.info(
            `数据源返回 0 条数据 for ${symbol} (${startDateStr} to ${endDateStr})，可能是停牌或无数据`
          );
          this.recordEmptyResult(symbol, startDateStr, endDateStr);
        }
      } catch (syncError) {
        logger.error(
          `获取股票 ${symbol} 缺失数据失败 (${startDateStr} 到 ${endDateStr}):`,
          syncError
        );
        // 记录数据源错误
        this.recordDataSourceError(symbol);
        this.consecutiveSourceErrors++;

        // 如果连续错误达到阈值，暂时禁用数据源
        if (this.consecutiveSourceErrors >= this.MAX_CONSECUTIVE_ERRORS) {
          logger.error(`数据源连续错误 ${this.consecutiveSourceErrors} 次，暂时禁用数据源`);
          break;
        }
        // 继续尝试其他范围，不抛出异常
      }
    }

    return totalInserted;
  }

  async getDailyBars(
    symbol: string,
    start_date: Date,
    end_date: Date,
    fastMode = false
  ): Promise<DailyBar[]> {
    try {
      logger.info(
        `DataService.getDailyBars: symbol=${symbol}, start_date=${start_date}, end_date=${end_date}, fastMode=${fastMode}`
      );

      // 通过symbol查找股票
      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) {
        logger.warn(`股票 ${symbol} 不存在`);
        return [];
      }

      // 1. 先查询数据库中已有的数据
      const bars = await DailyBar.findAll({
        where: {
          stock_id: stock.id,
          time: {
            [Op.between]: [start_date, end_date],
          },
        },
        order: [['time', 'ASC']],
      });

      // 快速模式：只返回数据库已有数据，不尝试补充
      if (fastMode) {
        logger.info(`DataService.getDailyBars: 快速模式，直接返回 ${bars.length} 条数据`);
        return bars;
      }

      // 2. 异步补充缺失数据（不阻塞主请求）
      this.asyncSupplementMissingData(symbol, start_date, end_date).catch(error => {
        logger.error(`异步补充数据失败 for ${symbol}:`, error);
      });

      logger.info(`DataService.getDailyBars: 返回 ${bars.length} 条数据，已触发异步补充`);
      return bars;
    } catch (error) {
      logger.error(`获取股票 ${symbol} 日线数据失败:`, error);
      return [];
    }
  }

  async asyncSupplementMissingData(symbol: string, start_date: Date, end_date: Date): Promise<void> {
    try {
      logger.info(`开始异步补充股票 ${symbol} 缺失数据: ${start_date} 到 ${end_date}`);

      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) {
        logger.warn(`股票 ${symbol} 不存在，跳过补充`);
        return;
      }

      // 查询数据库现有数据
      const bars = await DailyBar.findAll({
        where: {
          stock_id: stock.id,
          time: {
            [Op.between]: [start_date, end_date],
          },
        },
        order: [['time', 'ASC']],
      });

      // 检查缺失数据
      const missingRanges = this.findMissingDateRanges(bars, start_date, end_date);
      if (missingRanges.length === 0) {
        logger.info(`股票 ${symbol} 数据完整，无需补充`);
        return;
      }

      logger.info(`发现 ${missingRanges.length} 个缺失日期范围，开始异步补充`);

      // 检查数据源是否可用
      if (!this.isDataSourceAvailable(symbol)) {
        logger.warn(`数据源对于股票 ${symbol} 不可用，跳过补充`);
        return;
      }

      // 获取并插入缺失数据（带超时保护）
      try {
        await Promise.race([
          this.fetchAndInsertMissingData(missingRanges, symbol),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('数据补充超时 (60s)')), 60000)
          ),
        ]);
        logger.info(`股票 ${symbol} 异步数据补充完成`);
      } catch (syncError) {
        logger.error(`股票 ${symbol} 异步数据补充失败:`, syncError);
        // 记录数据源错误
        this.recordDataSourceError(symbol);
      }
    } catch (error) {
      logger.error(`异步补充股票 ${symbol} 数据过程出错:`, error);
    }
  }

  async getMultipleDailyBars(
    symbols: string[],
    start_date: Date,
    end_date: Date,
    fastMode = false
  ): Promise<Map<string, DailyBar[]>> {
    const result = new Map<string, DailyBar[]>();
    const promises = symbols.map(async symbol => {
      const bars = await this.getDailyBars(symbol, start_date, end_date, fastMode);
      result.set(symbol, bars);
    });
    await Promise.all(promises);
    return result;
  }

  async getStockInfo(symbol: string): Promise<Stock | null> {
    try {
      return await Stock.findOne({ where: { symbol } });
    } catch (error) {
      logger.error(`获取股票 ${symbol} 信息失败:`, error);
      return null;
    }
  }

  async getStockList(): Promise<Stock[]> {
    try {
      return await Stock.findAll({
        order: [['symbol', 'ASC']],
      });
    } catch (error) {
      logger.error('获取股票列表失败:', error);
      return [];
    }
  }

  async getTradingDays(start_date: Date, end_date: Date): Promise<Date[]> {
    try {
      // 从daily_bars表中获取唯一的交易日
      const bars = await DailyBar.findAll({
        attributes: ['time'],
        where: {
          time: {
            [Op.between]: [start_date, end_date],
          },
          is_trading_day: true,
        },
        group: ['time'],
        order: [['time', 'ASC']],
      });
      return bars.map(bar => bar.time);
    } catch (error) {
      logger.error('获取交易日历失败:', error);
      return [];
    }
  }
}
