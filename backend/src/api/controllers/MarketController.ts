import { Request, Response } from 'express';
import { Stock } from '../../models/Stock';
import { FavoriteStock } from '../../models/FavoriteStock';
import { DailyBar } from '../../models/DailyBar';
import { DataUpdateLog, UpdateType, UpdateStatus } from '../../models/DataUpdateLog';
import { DataService } from '../../data/services/DataService';
import { DataSyncService } from '../../data/services/DataSyncService';
import { DataSourceHealthService } from '../../data/services/DataSourceHealthService';
import { stockFactorService } from '../../data/services/StockFactorService';
import { dataQualityService } from '../../services/DataQualityService';
import { dataUpdateQueue } from '../../jobs/dataUpdateQueue';
import { dataUpdateWorker } from '../../jobs/dataUpdateWorker';
import { redisLock, LockKeys } from '../../utils/redisLock';
import { logger } from '../../utils/logger';
import { Op } from 'sequelize';
import { sequelize } from '../../config/database';

interface SearchStocksQuery {
  q?: string;
  page?: string;
  limit?: string;
  market?: string;
  industry?: string;
}

interface GetHistoryParams {
  symbol: string;
}

interface GetHistoryQuery {
  start_date?: string;
  end_date?: string;
  frequency?: 'd' | 'w' | 'm';
}

interface FavoriteParams {
  symbol: string;
}

interface FavoriteBody {
  group_id?: string;
  tags?: string;
  notes?: string;
  sort_order?: number;
}

/**
 * 大盘视图控制器
 * 提供股票搜索、历史数据获取、收藏功能
 */
export class MarketController {
  private dataService: DataService;
  private dataSyncService: DataSyncService;

  // 数据完整性统计缓存（内存缓存，有效期5分钟）
  private dataCompletenessCache: {
    data: any;
    timestamp: number;
  } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟

  constructor() {
    this.dataService = new DataService();
    this.dataSyncService = new DataSyncService();
  }

  // 获取市场大盘概览 (沪深300等核心指数的最新状态和近期走势)
  getMarketOverview = async (req: Request, res: Response) => {
    try {
      // 定义我们需要获取走势的代表性指数/股票
      const indices = [
        { symbol: 'sh.000300', name: '沪深300' },
        { symbol: 'sh.000001', name: '上证指数' },
        { symbol: 'sz.399001', name: '深证成指' },
        { symbol: 'sz.399006', name: '创业板指' },
      ];

      const overviewData = await Promise.all(
        indices.map(async index => {
          try {
            // 获取最近 30 个交易日的数据用于绘制迷你走势图
            const bars = await this.dataService.getDailyBars(
              index.symbol,
              new Date(Date.now() - 45 * 24 * 60 * 60 * 1000), // 往前推 45 天确保有足够的交易日
              new Date(),
              true
            );

            if (!bars || bars.length === 0) {
              return { ...index, current_price: 0, change: 0, change_percent: 0, trend: [] };
            }

            const latestBar = bars[bars.length - 1];
            const previousBar = bars.length > 1 ? bars[bars.length - 2] : latestBar;

            const change = latestBar.close - previousBar.close;
            const change_percent = (change / previousBar.close) * 100;

            return {
              ...index,
              current_price: latestBar.close,
              change,
              change_percent,
              trend: bars.slice(-30).map(b => ({ time: b.time, close: b.close })), // 只取最近 30 天画图
            };
          } catch (e) {
            logger.error(`Failed to fetch overview for ${index.symbol}`, e);
            return { ...index, current_price: 0, change: 0, change_percent: 0, trend: [] };
          }
        })
      );

      // 简单模拟一个市场情绪得分 (0-100)，实际项目中可以根据涨跌家数比、连板高度等计算
      const upCount = overviewData.filter(d => d.change_percent > 0).length;
      const downCount = overviewData.filter(d => d.change_percent < 0).length;
      // 基于真实指数的涨跌来计算一个确定性的情绪分，不再使用 Math.random()
      const sentimentScore = 50 + upCount * 10 - downCount * 10;

      res.json({
        success: true,
        data: {
          indices: overviewData,
          sentiment: {
            score: Math.min(100, Math.max(0, Math.round(sentimentScore))),
            label: sentimentScore > 70 ? '贪婪' : sentimentScore < 30 ? '恐惧' : '中性',
          },
        },
      });
    } catch (error: any) {
      logger.error('获取大盘概览失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  /**
   * 搜索股票
   */
  searchStocks = async (
    req: Request<
      Record<string, never>,
      Record<string, never>,
      Record<string, never>,
      SearchStocksQuery
    >,
    res: Response
  ) => {
    try {
      const { q, page = '1', limit = '20', market, industry } = req.query;
      const pageNum = parseInt(page, 10);
      const limitNum = parseInt(limit, 10);
      const offset = (pageNum - 1) * limitNum;

      const where: any = {};

      // 搜索关键词
      if (q && q.trim()) {
        const searchTerm = `%${q.trim()}%`;
        where[Op.or] = [
          { symbol: { [Op.iLike]: searchTerm } },
          { name: { [Op.iLike]: searchTerm } },
        ];
      }

      // 市场筛选
      if (market) {
        where.market = market;
      }

      // 行业筛选
      if (industry) {
        where.industry = industry;
      }

      const { count, rows } = await Stock.findAndCountAll({
        where,
        limit: limitNum,
        offset,
        order: [['symbol', 'ASC']],
      });

      // 如果数据库中没有找到，尝试从数据源搜索
      if (rows.length === 0 && q && q.trim()) {
        try {
          // 先尝试同步股票基本信息
          // 注：DataService暂无syncStockBasicInfo方法，暂时跳过
          // await this.dataSyncService.syncStockData? 暂时不实现

          // 重新查询
          const retryResult = await Stock.findAndCountAll({
            where: {
              [Op.or]: [
                { symbol: { [Op.iLike]: `%${q.trim()}%` } },
                { name: { [Op.iLike]: `%${q.trim()}%` } },
              ],
            },
            limit: limitNum,
            offset: 0, // 重新从第一页开始
            order: [['symbol', 'ASC']],
          });

          return res.json({
            success: true,
            data: {
              stocks: retryResult.rows,
              pagination: {
                page: pageNum,
                limit: limitNum,
                total: retryResult.count,
                totalPages: Math.ceil(retryResult.count / limitNum),
              },
            },
          });
        } catch (syncError) {
          logger.warn(`Failed to sync stock info for search term "${q}":`, syncError.message);
          // 继续返回空结果
        }
      }

      res.json({
        success: true,
        data: {
          stocks: rows,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total: count,
            totalPages: Math.ceil(count / limitNum),
          },
        },
      });
    } catch (error) {
      logger.error('Error searching stocks:', error);
      res.status(500).json({
        success: false,
        error: '搜索股票失败',
        details: error.message,
      });
    }
  };

  /**
   * 获取股票历史走势
   */
  getStockHistory = async (
    req: Request<GetHistoryParams, Record<string, never>, Record<string, never>, GetHistoryQuery>,
    res: Response
  ) => {
    try {
      const { symbol } = req.params;
      const { start_date, end_date, frequency = 'd' } = req.query;

      // 验证参数
      if (!symbol) {
        return res.status(400).json({
          success: false,
          error: '股票代码不能为空',
        });
      }

      // 设置默认日期范围：最近一年
      const defaultEndDate = new Date();
      const defaultStartDate = new Date();
      defaultStartDate.setFullYear(defaultStartDate.getFullYear() - 1);

      const start = start_date || defaultStartDate.toISOString().split('T')[0];
      const end = end_date || defaultEndDate.toISOString().split('T')[0];

      // 验证日期格式
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(start) || !dateRegex.test(end)) {
        return res.status(400).json({
          success: false,
          error: '日期格式应为 YYYY-MM-DD',
        });
      }

      // 获取历史数据（使用快速模式，优先返回数据库已有数据）
      const bars = await this.dataService.getDailyBars(
        symbol,
        new Date(start),
        new Date(end),
        true
      );

      // 获取股票基本信息
      const stock = await Stock.findOne({ where: { symbol } });
      const stockInfo = stock
        ? {
            symbol: stock.symbol,
            name: stock.name,
            market: stock.market,
            industry: stock.industry,
          }
        : null;

      if (bars.length === 0) {
        // 返回空数组而不是404错误
        return res.json({
          success: true,
          data: {
            stock: stockInfo,
            history: [],
            summary: {
              start_date: '',
              end_date: '',
              totalDays: 0,
              priceChange: '0%',
            },
          },
        });
      }

      // 格式化返回数据并去重（每个日期只保留一条记录）
      const dateMap = new Map<string, any>();

      bars.forEach(bar => {
        const date = bar.time.toISOString().split('T')[0];
        const existing = dateMap.get(date);

        // 选择策略：对于sh.600000，当前价格约7-8元，选择价格较低的那条记录
        // 如果没有现有记录，或者当前记录的价格更接近合理范围（< 20），则使用当前记录
        if (!existing) {
          dateMap.set(date, bar);
        } else {
          // 判断哪条记录更可能是原始价格（非复权）
          // 简单规则：选择收盘价较低的那条
          const currentClose = parseFloat(String(bar.close));
          const existingClose = parseFloat(String(existing.close));

          if (currentClose < existingClose && currentClose < 20) {
            dateMap.set(date, bar);
          }
        }
      });

      // 转换为数组并按日期排序
      const uniqueBars = Array.from(dateMap.values()).sort(
        (a, b) => a.time.getTime() - b.time.getTime()
      );

      const historyData = uniqueBars.map(bar => ({
        date: bar.time.toISOString().split('T')[0], // 格式化为YYYY-MM-DD
        open: parseFloat(String(bar.open)),
        high: parseFloat(String(bar.high)),
        low: parseFloat(String(bar.low)),
        close: parseFloat(String(bar.close)),
        volume: parseFloat(String(bar.volume)),
        amount: parseFloat(String(bar.turnover || 0)),
        pctChg: parseFloat(String(bar.change_percent || 0)),
        adjustflag: 3, // 默认不复权
      }));

      res.json({
        success: true,
        data: {
          stock: stockInfo,
          history: historyData,
          summary: {
            start_date: historyData[0].date,
            end_date: historyData[historyData.length - 1].date,
            totalDays: historyData.length,
            priceChange:
              historyData.length > 0
                ? (
                    ((historyData[historyData.length - 1].close - historyData[0].open) /
                      historyData[0].open) *
                    100
                  ).toFixed(2) + '%'
                : '0%',
          },
        },
      });
    } catch (error) {
      logger.error(`Error fetching stock history for ${req.params.symbol}:`, error);
      res.status(500).json({
        success: false,
        error: '获取股票历史数据失败',
        details: error.message,
      });
    }
  };

  /**
   * 收藏股票
   */
  addFavorite = async (
    req: Request<FavoriteParams, Record<string, never>, FavoriteBody>,
    res: Response
  ) => {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({
          success: false,
          error: '用户未登录',
        });
      }

      const { symbol } = req.params;
      const { group_id, tags, notes, sort_order } = req.body;

      // 查找股票
      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) {
        return res.status(404).json({
          success: false,
          error: '股票不存在',
        });
      }

      // 检查是否已收藏
      const existingFavorite = await FavoriteStock.findOne({
        where: { user_id, stock_id: stock.id },
      });

      if (existingFavorite) {
        return res.status(400).json({
          success: false,
          error: '该股票已在收藏夹中',
        });
      }

      // 创建收藏记录
      const favorite = await FavoriteStock.create({
        user_id,
        stock_id: stock.id,
        group_id,
        tags,
        notes,
        sort_order: sort_order || 0,
      });

      res.json({
        success: true,
        data: {
          favorite: await favorite.reload({
            include: [
              {
                model: Stock,
                attributes: ['symbol', 'name', 'market', 'industry'],
              },
            ],
          }),
        },
      });
    } catch (error) {
      logger.error(`Error adding favorite for ${req.params.symbol}:`, error);
      res.status(500).json({
        success: false,
        error: '收藏股票失败',
        details: error.message,
      });
    }
  };

  /**
   * 取消收藏
   */
  removeFavorite = async (req: Request<FavoriteParams>, res: Response) => {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({
          success: false,
          error: '用户未登录',
        });
      }

      const { symbol } = req.params;

      // 查找股票
      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) {
        return res.status(404).json({
          success: false,
          error: '股票不存在',
        });
      }

      // 删除收藏记录
      const deletedCount = await FavoriteStock.destroy({
        where: { user_id, stock_id: stock.id },
      });

      if (deletedCount === 0) {
        return res.status(404).json({
          success: false,
          error: '未找到收藏记录',
        });
      }

      res.json({
        success: true,
        data: { deleted: true },
      });
    } catch (error) {
      logger.error(`Error removing favorite for ${req.params.symbol}:`, error);
      res.status(500).json({
        success: false,
        error: '取消收藏失败',
        details: error.message,
      });
    }
  };

  /**
   * 获取用户收藏列表
   */
  getFavorites = async (req: Request, res: Response) => {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({
          success: false,
          error: '用户未登录',
        });
      }

      const { group_id } = req.query;

      const where: any = { user_id };
      if (group_id) {
        where.group_id = group_id;
      }

      const favorites = await FavoriteStock.findAll({
        where,
        include: [
          {
            model: Stock,
            attributes: ['symbol', 'name', 'market', 'industry', 'listing_date', 'is_listed'],
          },
        ],
        order: [
          ['sort_order', 'DESC'],
          ['created_at', 'DESC'],
        ],
      });

      // 按分组组织
      const groupedFavorites = favorites.reduce((acc, favorite) => {
        const group = favorite.group_id || '默认';
        if (!acc[group]) {
          acc[group] = [];
        }
        acc[group].push(favorite);
        return acc;
      }, {} as Record<string, any[]>);

      res.json({
        success: true,
        data: {
          favorites,
          grouped: groupedFavorites,
        },
      });
    } catch (error) {
      logger.error('Error fetching favorites:', error);
      res.status(500).json({
        success: false,
        error: '获取收藏列表失败',
        details: error.message,
      });
    }
  };

  /**
   * 检查股票是否已收藏
   */
  checkFavorite = async (req: Request<FavoriteParams>, res: Response) => {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({
          success: false,
          error: '用户未登录',
        });
      }

      const { symbol } = req.params;

      // 查找股票
      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) {
        return res.json({
          success: true,
          data: { isFavorite: false },
        });
      }

      // 检查收藏状态
      const favorite = await FavoriteStock.findOne({
        where: { user_id, stock_id: stock.id },
      });

      res.json({
        success: true,
        data: {
          isFavorite: !!favorite,
          favorite: favorite || null,
        },
      });
    } catch (error) {
      logger.error(`Error checking favorite for ${req.params.symbol}:`, error);
      res.status(500).json({
        success: false,
        error: '检查收藏状态失败',
        details: error.message,
      });
    }
  };

  /**
   * 更新收藏信息
   */
  updateFavorite = async (
    req: Request<FavoriteParams, Record<string, never>, Partial<FavoriteBody>>,
    res: Response
  ) => {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({
          success: false,
          error: '用户未登录',
        });
      }

      const { symbol } = req.params;
      const { group_id, tags, notes, sort_order } = req.body;

      // 查找股票
      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) {
        return res.status(404).json({
          success: false,
          error: '股票不存在',
        });
      }

      // 查找收藏记录
      const favorite = await FavoriteStock.findOne({
        where: { user_id, stock_id: stock.id },
      });

      if (!favorite) {
        return res.status(404).json({
          success: false,
          error: '未找到收藏记录',
        });
      }

      // 更新字段
      if (group_id !== undefined) favorite.group_id = group_id;
      if (tags !== undefined) favorite.tags = tags;
      if (notes !== undefined) favorite.notes = notes;
      if (sort_order !== undefined) favorite.sort_order = sort_order;

      await favorite.save();

      res.json({
        success: true,
        data: {
          favorite: await favorite.reload({
            include: [
              {
                model: Stock,
                attributes: ['symbol', 'name', 'market', 'industry'],
              },
            ],
          }),
        },
      });
    } catch (error) {
      logger.error(`Error updating favorite for ${req.params.symbol}:`, error);
      res.status(500).json({
        success: false,
        error: '更新收藏信息失败',
        details: error.message,
      });
    }
  };

  /**
   * 数据更新接口
   * 使用Bull队列系统处理，包含分布式锁防止并发
   */
  updateData = async (req: Request, res: Response) => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const forceUpdate = req.query.force === 'true';

      // 1. 检查Redis分布式锁，防止并发请求
      const lockKey = LockKeys.DATA_UPDATE;
      const lockValue = await redisLock.acquire(lockKey, 5000, 100, 2); // 快速尝试获取锁

      if (!lockValue) {
        return res.status(429).json({
          success: false,
          error: '系统繁忙，请稍后再试',
          code: 'UPDATE_IN_PROGRESS',
        });
      }

      try {
        // 2. 检查队列中是否有活跃的每日更新任务
        const [waitingJobs, activeJobs] = await Promise.all([
          dataUpdateQueue.getJobs(['waiting', 'delayed']),
          dataUpdateQueue.getJobs(['active']),
        ]);

        const hasPendingUpdate = [...waitingJobs, ...activeJobs].some(
          job => job.data.type === 'daily_update' && job.data.date === today
        );

        if (hasPendingUpdate && !forceUpdate) {
          return res.json({
            success: true,
            data: {
              message: '已有更新任务在队列中等待处理',
              queued: true,
              date: today,
            },
          });
        }

        // 3. 检查当天是否已有成功的更新记录
        if (!forceUpdate) {
          const existingUpdate = await DataUpdateLog.findOne({
            where: {
              date: today,
              type: UpdateType.DAILY_UPDATE,
              status: UpdateStatus.COMPLETED,
            },
          });

          if (existingUpdate) {
            return res.json({
              success: true,
              data: {
                message: '今日数据已更新，跳过',
                updatedToday: true,
                logId: existingUpdate.id,
                result: existingUpdate.result,
              },
            });
          }
        }

        // 4. 添加任务到队列
        const job = await dataUpdateQueue.add(
          'daily_update',
          {
            type: 'daily_update',
            date: today,
            forceUpdate,
          },
          {
            jobId: `daily-update-${today}-${Date.now()}`,
            priority: 1, // 较高优先级
          }
        );

        logger.info(`数据更新任务已添加到队列，Job ID: ${job.id}`);

        res.json({
          success: true,
          data: {
            message: '数据更新任务已排队',
            jobId: job.id,
            queue: 'data-update',
            date: today,
            estimatedStart: new Date(Date.now() + 1000).toISOString(), // 预估1秒后开始
          },
        });
      } finally {
        // 释放分布式锁
        await redisLock.release(lockKey, lockValue);
      }
    } catch (error) {
      logger.error('数据更新接口错误:', error);
      res.status(500).json({
        success: false,
        error: '数据更新失败',
        details: error.message,
      });
    }
  };

  /**
   * 查询数据更新状态
   */
  getUpdateStatus = async (req: Request, res: Response) => {
    try {
      const { jobId, date, start_date, end_date } = req.query;
      // type可以是单个值或数组（多个type参数）
      const typeParam = req.query.type;
      const types = Array.isArray(typeParam) ? typeParam : typeParam ? [typeParam] : [];

      const statusData: any = {
        job: null,
        jobs: [], // 新增：所有活动任务列表
        logs: [],
        queue: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, total: 0 },
        locks: { global: false, daily: false, newStocks: false },
        errors: {},
      };

      // 1. 如果提供了jobId，查询特定任务
      if (jobId) {
        try {
          const job = await dataUpdateQueue.getJob(jobId.toString());
          if (job) {
            try {
              const state = await job.getState();
              statusData.job = {
                id: job.id,
                data: job.data,
                state: state,
                progress: job.progress(),
                failedReason: job.failedReason,
                finishedOn: job.finishedOn,
                processedOn: job.processedOn,
              };
            } catch (jobError) {
              logger.warn(`获取任务 ${jobId} 状态失败:`, jobError);
              statusData.errors.jobState = jobError.message;
              statusData.job = {
                id: job.id,
                data: job.data,
                state: 'unknown',
                progress: 0,
              };
            }
          }
        } catch (error) {
          logger.warn(`查询任务 ${jobId} 失败:`, error);
          statusData.errors.jobQuery = error.message;
        }
      }

      // 2. 总是获取所有活动任务（等待中、进行中、延迟中）
      try {
        const activeJobs = await dataUpdateQueue.getJobs(['waiting', 'active', 'delayed']);

        // 获取每个任务的状态和详细信息
        const jobsWithDetails = await Promise.all(
          activeJobs.slice(0, 50).map(async job => {
            // 限制最多50个任务
            try {
              const state = await job.getState();
              return {
                id: job.id,
                data: job.data,
                state: state,
                progress: job.progress(),
                failedReason: job.failedReason,
                finishedOn: job.finishedOn,
                processedOn: job.processedOn,
                timestamp: job.timestamp,
              };
            } catch (jobError) {
              logger.warn(`获取任务 ${job.id} 详细信息失败:`, jobError);
              return {
                id: job.id,
                data: job.data,
                state: 'unknown',
                progress: 0,
                error: jobError.message,
              };
            }
          })
        );

        statusData.jobs = jobsWithDetails;
      } catch (jobsError) {
        logger.warn('获取活动任务列表失败:', jobsError);
        statusData.errors.jobsQuery = jobsError.message;
      }

      // 2. 查询数据库更新记录
      try {
        const where: any = {};

        // 按更新日期筛选
        if (date) where.date = date;

        // 按任务类型筛选（支持多类型）
        if (types.length > 0) {
          where.type = types;
        }

        // 按创建日期范围筛选
        if (start_date || end_date) {
          const createdAtFilter: any = {};
          if (start_date) {
            createdAtFilter[Op.gte] = new Date(start_date as string);
          }
          if (end_date) {
            // 结束日期包括当天，所以设置为当天的23:59:59
            const endDateTime = new Date(end_date as string);
            endDateTime.setHours(23, 59, 59, 999);
            createdAtFilter[Op.lte] = endDateTime;
          }
          where.created_at = createdAtFilter;
        }

        const updateLogs = await DataUpdateLog.findAll({
          where,
          order: [['created_at', 'DESC']],
          limit: 50, // 增加返回数量，显示更多历史记录
        });

        statusData.logs = updateLogs;
      } catch (dbError) {
        logger.warn('查询更新记录失败:', dbError);
        statusData.errors.dbQuery = dbError.message;
        // 如果表不存在，返回空数组
        statusData.logs = [];
      }

      // 3. 获取队列状态
      try {
        const queueStatus = await dataUpdateWorker.getQueueStatus();
        statusData.queue = queueStatus;
      } catch (queueError) {
        logger.warn('获取队列状态失败:', queueError);
        statusData.errors.queueStatus = queueError.message;
        // 使用默认队列状态
      }

      // 4. Redis锁状态
      try {
        const today = new Date().toISOString().split('T')[0];
        statusData.locks = {
          global: await redisLock.isLocked(LockKeys.DATA_UPDATE),
          daily: await redisLock.isLocked(LockKeys.DAILY_UPDATE(today)),
          newStocks: await redisLock.isLocked(LockKeys.NEW_STOCKS_SYNC),
        };
      } catch (lockError) {
        logger.warn('检查锁状态失败:', lockError);
        statusData.errors.lockCheck = lockError.message;
        // 使用默认锁状态
      }

      // 如果没有致命错误，返回成功
      const hasFatalError =
        Object.keys(statusData.errors).length > 0 &&
        statusData.errors.dbQuery &&
        statusData.errors.dbQuery.includes('relation') &&
        statusData.errors.dbQuery.includes('does not exist');

      if (!hasFatalError) {
        res.json({
          success: true,
          data: statusData,
        });
      } else {
        // 如果表不存在，返回特殊错误
        res.status(500).json({
          success: false,
          error: '数据更新日志表不存在',
          details: '请先创建 data_update_logs 表',
          data: statusData,
        });
      }
    } catch (error) {
      logger.error('查询更新状态错误:', error);
      res.status(500).json({
        success: false,
        error: '查询状态失败',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    }
  };

  /**
   * 手动触发数据同步
   */
  triggerManualSync = async (req: Request, res: Response) => {
    try {
      const { type = 'new_stocks_sync', force = false } = req.body;
      const today = new Date().toISOString().split('T')[0];

      // 验证类型
      const validTypes = [
        'daily_update',
        'new_stocks_sync',
        'weekly_completeness_check',
        'data_quality_scan',
        'manual_sync',
        'health_check',
      ];
      if (!validTypes.includes(type)) {
        return res.status(400).json({
          success: false,
          error: `无效的类型，可选值: ${validTypes.join(', ')}`,
        });
      }

      // 特殊处理完整性检查任务
      if (type === 'health_check') {
        // 强制清除完整性缓存
        this.dataCompletenessCache = null;
        logger.info('触发了健康检查，已清除数据完整性缓存');
        return res.json({
          success: true,
          data: {
            message: `健康检查已触发，缓存已清除`,
            type,
            date: today,
          },
        });
      }

      // 检查是否有同类型任务正在运行，避免重复发送
      const activeJobs = await dataUpdateQueue.getJobs(['active', 'waiting']);
      const isJobRunning = activeJobs.some(job => job.name === type);

      if (isJobRunning) {
        return res.status(400).json({
          success: false,
          error: '该类型的同步任务正在运行或等待中，请勿重复触发',
        });
      }

      // 添加任务到队列
      const job = await dataUpdateQueue.add(
        type,
        {
          type: type as any,
          date: today,
          forceUpdate: force,
          user_id: (req as any).user?.id,
        },
        {
          jobId: `${type}-${today}-${Date.now()}`,
          priority: 2, // 手动同步优先级更高
        }
      );

      logger.info(`手动同步任务已添加到队列，类型: ${type}, Job ID: ${job.id}`);

      res.json({
        success: true,
        data: {
          message: `手动同步任务已排队`,
          jobId: job.id,
          type,
          date: today,
          queue: 'data-update',
        },
      });
    } catch (error) {
      logger.error('手动触发同步错误:', error);
      res.status(500).json({
        success: false,
        error: '手动同步失败',
        details: error.message,
      });
    }
  };

  /**
   * 触发批量数据同步
   */
  triggerBulkSync = async (req: Request, res: Response) => {
    try {
      const {
        symbols,
        marketFilters,
        syncAllStocks = false,
        start_date,
        end_date,
        dataSource = 'akshare',
        concurrency = 10,
      } = req.body;

      const today = new Date().toISOString().split('T')[0];

      // 验证参数
      if (!symbols && !marketFilters && !syncAllStocks) {
        return res.status(400).json({
          success: false,
          error: '请指定要同步的股票范围：symbols、marketFilters或syncAllStocks',
        });
      }

      if (symbols && !Array.isArray(symbols)) {
        return res.status(400).json({
          success: false,
          error: 'symbols必须是一个数组',
        });
      }

      if (marketFilters && !Array.isArray(marketFilters)) {
        return res.status(400).json({
          success: false,
          error: 'marketFilters必须是一个数组',
        });
      }

      if (concurrency && (typeof concurrency !== 'number' || concurrency < 1 || concurrency > 50)) {
        return res.status(400).json({
          success: false,
          error: 'concurrency必须是1到50之间的数字',
        });
      }

      const validDataSources = ['auto', 'tushare', 'baostock', 'akshare', 'eastmoney', 'sina'];
      if (dataSource && !validDataSources.includes(dataSource)) {
        return res.status(400).json({
          success: false,
          error: `dataSource必须是以下值之一: ${validDataSources.join(', ')}`,
        });
      }

      // 添加任务到队列
      const job = await dataUpdateQueue.add(
        'bulk_sync_custom',
        {
          type: 'bulk_sync_custom' as any,
          date: today,
          symbols,
          marketFilters,
          syncAllStocks,
          start_date,
          end_date,
          dataSource,
          concurrency,
          user_id: (req as any).user?.id,
        },
        {
          jobId: `bulk-sync-${today}-${Date.now()}`,
          priority: 1, // 批量同步优先级较高
        }
      );

      logger.info(`批量同步任务已添加到队列，Job ID: ${job.id}`);

      res.json({
        success: true,
        data: {
          message: '批量同步任务已排队',
          jobId: job.id,
          type: 'bulk_sync_custom',
          date: today,
          queue: 'data-update',
          totalStocks: symbols?.length || '待计算',
          concurrency,
        },
      });
    } catch (error) {
      logger.error('触发批量同步错误:', error);
      res.status(500).json({
        success: false,
        error: '触发批量同步失败',
        details: error.message,
      });
    }
  };

  /**
   * 清理数据更新队列
   */
  cleanUpdateQueue = async (req: Request, res: Response) => {
    try {
      const { type = 'all' } = req.query;

      if (type === 'all') {
        await dataUpdateWorker.cleanQueue();
      } else {
        // 可以按类型清理，暂时只支持全部清理
        await dataUpdateWorker.cleanQueue();
      }

      res.json({
        success: true,
        data: {
          message: '数据更新队列已清理',
          type,
        },
      });
    } catch (error) {
      logger.error('清理队列错误:', error);
      res.status(500).json({
        success: false,
        error: '清理队列失败',
        details: error.message,
      });
    }
  };

  /**
   * 获取数据更新统计信息
   */
  getUpdateStats = async (req: Request, res: Response) => {
    try {
      const { days = 7 } = req.query;
      const daysNum = parseInt(days.toString(), 10);

      // 计算日期范围
      const end_date = new Date();
      const start_date = new Date();
      start_date.setDate(start_date.getDate() - daysNum);

      // 查询更新日志
      const updateLogs = await DataUpdateLog.findAll({
        where: {
          created_at: {
            [Op.between]: [start_date, end_date],
          },
          type: UpdateType.DAILY_UPDATE,
        },
        order: [['date', 'DESC']],
      });

      // 统计信息
      const stats = {
        totalUpdates: updateLogs.length,
        successfulUpdates: updateLogs.filter(log => log.status === UpdateStatus.COMPLETED).length,
        failedUpdates: updateLogs.filter(log => log.status === UpdateStatus.FAILED).length,
        inProgressUpdates: updateLogs.filter(log => log.status === UpdateStatus.IN_PROGRESS).length,
        avgAffectedStocks: 0,
        avgInsertedRecords: 0,
        dailyBreakdown: {} as Record<string, any>,
      };

      let totalAffectedStocks = 0;
      let totalInsertedRecords = 0;
      let successfulCount = 0;

      updateLogs.forEach(log => {
        if (log.status === UpdateStatus.COMPLETED && log.result) {
          totalAffectedStocks += log.affected_stocks || 0;
          totalInsertedRecords += log.inserted_records || 0;
          successfulCount++;

          // 按日统计
          const dateStr = log.date;
          if (!stats.dailyBreakdown[dateStr]) {
            stats.dailyBreakdown[dateStr] = {
              date: dateStr,
              affected_stocks: 0,
              inserted_records: 0,
              status: log.status,
            };
          }
          stats.dailyBreakdown[dateStr].affected_stocks += log.affected_stocks || 0;
          stats.dailyBreakdown[dateStr].inserted_records += log.inserted_records || 0;
        }
      });

      if (successfulCount > 0) {
        stats.avgAffectedStocks = Math.round(totalAffectedStocks / successfulCount);
        stats.avgInsertedRecords = Math.round(totalInsertedRecords / successfulCount);
      }

      // 转换为数组并排序
      stats.dailyBreakdown = Object.values(stats.dailyBreakdown).sort((a: any, b: any) =>
        b.date.localeCompare(a.date)
      );

      res.json({
        success: true,
        data: {
          stats,
          period: {
            days: daysNum,
            start_date: start_date.toISOString().split('T')[0],
            end_date: end_date.toISOString().split('T')[0],
          },
        },
      });
    } catch (error) {
      logger.error('获取更新统计错误:', error);
      res.status(500).json({
        success: false,
        error: '获取统计失败',
        details: error.message,
      });
    }
  };

  /**
   * 获取数据源健康状态
   */
  getDataSourceHealth = async (req: Request, res: Response): Promise<void> => {
    try {
      let probeResult: any = null;
      if (req.query.refresh === 'true') {
        probeResult = await DataSourceHealthService.refreshExternalProviderHealth();
      }

      const providers = await DataSourceHealthService.getHealthSnapshots();
      const enabledProviders = providers.filter((provider: any) => provider.is_enabled);
      const healthyProviders = enabledProviders.filter(
        (provider: any) => provider.status === 'healthy'
      );
      const degradedProviders = enabledProviders.filter(
        (provider: any) => provider.status === 'degraded'
      );
      const unhealthyProviders = enabledProviders.filter(
        (provider: any) => provider.status === 'unhealthy'
      );
      const disabledProviders = providers.filter(
        (provider: any) => !provider.is_enabled || provider.status === 'disabled'
      );

      const avgHealthScore =
        enabledProviders.length > 0
          ? Number(
              (
                enabledProviders.reduce(
                  (sum: number, provider: any) => sum + Number(provider.health_score || 0),
                  0
                ) / enabledProviders.length
              ).toFixed(2)
            )
          : 0;
      const routingPlans = await DataSourceHealthService.getRoutingPlans([
        'stock_list',
        'history_k',
        'stock_basic',
        'fundamental_factor',
        'money_flow',
        'valuation',
        'realtime_quote',
        'intraday_bar',
      ]);
      const quantReadiness = DataSourceHealthService.buildQuantReadiness(providers, routingPlans);

      const status =
        healthyProviders.length > 0 &&
        degradedProviders.length === 0 &&
        unhealthyProviders.length === 0
          ? 'healthy'
          : healthyProviders.length > 0 || degradedProviders.length > 0
          ? 'degraded'
          : unhealthyProviders.length > 0
          ? 'unhealthy'
          : 'healthy';

      res.json({
        success: true,
        data: {
          status,
          timestamp: new Date().toISOString(),
          summary: {
            total_providers: providers.length,
            enabled_providers: enabledProviders.length,
            healthy_providers: healthyProviders.length,
            degraded_providers: degradedProviders.length,
            unhealthy_providers: unhealthyProviders.length,
            disabled_providers: disabledProviders.length,
            avg_health_score: avgHealthScore,
          },
          providers,
          routing_plans: routingPlans,
          quant_readiness: quantReadiness,
          probe_result: probeResult,
        },
      });
    } catch (error: any) {
      logger.error('获取数据源健康状态错误:', error);
      res.status(500).json({
        success: false,
        error: '获取数据源健康状态失败',
        details: error.message,
      });
    }
  };

  /**
   * 获取行情数据质量画像
   */
  getDataQuality = async (req: Request, res: Response): Promise<void> => {
    try {
      const user_id = (req as any).user?.id;
      const {
        scope = 'market',
        symbols,
        lookback_days = '180',
        limit = '80',
        update_status = 'false',
      } = req.query;

      const symbolList =
        typeof symbols === 'string'
          ? symbols
              .split(',')
              .map(symbol => symbol.trim())
              .filter(Boolean)
          : undefined;

      const options = {
        user_id,
        scope: ['favorites', 'market', 'all'].includes(scope as string) ? (scope as any) : 'market',
        symbols: symbolList,
        lookback_days: parseInt(lookback_days as string, 10),
        limit: parseInt(limit as string, 10),
      };

      const data =
        update_status === 'true'
          ? await dataQualityService.updateStockQualityStatuses(options)
          : await dataQualityService.scanMarketDataQuality(options);

      res.json({
        success: true,
        data,
      });
    } catch (error: any) {
      logger.error('获取数据质量画像错误:', error);
      res.status(500).json({
        success: false,
        error: '获取数据质量画像失败',
        details: error.message,
      });
    }
  };

  /**
   * 获取量化因子落盘覆盖情况
   */
  getFactorCoverage = async (req: Request, res: Response): Promise<void> => {
    try {
      const user_id = (req as any).user?.id;
      const { scope = 'market', symbols, limit = '120' } = req.query;
      const symbolList =
        typeof symbols === 'string'
          ? symbols
              .split(',')
              .map(item => item.trim())
              .filter(Boolean)
          : undefined;
      const data = await stockFactorService.getCoverage({
        scope: scope as any,
        symbols: symbolList,
        limit: Number(limit || 120),
        user_id,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取因子覆盖情况失败:', error);
      res.status(500).json({
        success: false,
        error: '获取因子覆盖情况失败',
        details: error.message,
      });
    }
  };

  /**
   * 手动触发量化因子落盘
   */
  syncFactors = async (req: Request, res: Response): Promise<void> => {
    try {
      const user_id = (req as any).user?.id;
      const {
        scope = 'market',
        symbols,
        limit = 120,
        as_of,
        provider = 'auto',
        prefer_real_provider,
        skip_if_coverage_rate_gte,
        skip_if_real_provider_rate_gte,
      } = req.body || {};
      const symbolList = Array.isArray(symbols)
        ? symbols
        : typeof symbols === 'string'
        ? symbols
            .split(',')
            .map(item => item.trim())
            .filter(Boolean)
        : undefined;
      const data = await stockFactorService.syncDerivedFactors({
        scope,
        symbols: symbolList,
        limit: Number(limit || 120),
        as_of,
        user_id,
        provider,
        prefer_real_provider:
          prefer_real_provider === undefined ? undefined : Boolean(prefer_real_provider),
        skip_if_coverage_rate_gte:
          skip_if_coverage_rate_gte === undefined ? undefined : Number(skip_if_coverage_rate_gte),
        skip_if_real_provider_rate_gte:
          skip_if_real_provider_rate_gte === undefined
            ? undefined
            : Number(skip_if_real_provider_rate_gte),
      });
      res.json({
        success: true,
        data,
        message: data.message,
      });
    } catch (error: any) {
      logger.error('量化因子落盘失败:', error);
      res.status(500).json({
        success: false,
        error: '量化因子落盘失败',
        details: error.message,
      });
    }
  };

  /**
   * 因子真实数据源烟测
   */
  smokeTestFactorProvider = async (req: Request, res: Response): Promise<void> => {
    try {
      const { provider = 'auto', symbol, as_of } = req.query as Record<string, string>;
      const data = await stockFactorService.runProviderSmokeTest({
        provider: provider as any,
        symbol,
        as_of,
      });
      res.json({
        success: true,
        data,
        message: data.conclusion,
      });
    } catch (error: any) {
      logger.error('因子数据源烟测失败:', error);
      res.status(500).json({
        success: false,
        error: '因子数据源烟测失败',
        details: error.message,
      });
    }
  };

  /**
   * 系统健康检查
   */
  healthCheck = async (req: Request, res: Response): Promise<void> => {
    try {
      const healthInfo: any = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        services: {},
      };

      // 检查数据库连接
      try {
        await sequelize.authenticate();
        healthInfo.services.database = {
          status: 'healthy',
          type: 'PostgreSQL',
          connected: true,
        };
      } catch (dbError) {
        healthInfo.services.database = {
          status: 'unhealthy',
          type: 'PostgreSQL',
          connected: false,
          error: dbError.message,
        };
        healthInfo.status = 'degraded';
      }

      // 检查Redis锁连接
      try {
        const redisHealthy = await redisLock.healthCheck();
        healthInfo.services.redisLock = {
          status: redisHealthy ? 'healthy' : 'unhealthy',
          type: 'Redis',
          connected: redisHealthy,
        };
        if (!redisHealthy) {
          healthInfo.status = 'degraded';
        }
      } catch (redisError) {
        healthInfo.services.redisLock = {
          status: 'unhealthy',
          type: 'Redis',
          connected: false,
          error: redisError.message,
        };
        healthInfo.status = 'degraded';
      }

      // 检查数据更新队列
      try {
        const queueStats = await dataUpdateQueue.getJobCounts();
        healthInfo.services.dataUpdateQueue = {
          status: 'healthy',
          type: 'Bull Queue',
          stats: queueStats,
        };
      } catch (queueError) {
        healthInfo.services.dataUpdateQueue = {
          status: 'unhealthy',
          type: 'Bull Queue',
          connected: false,
          error: queueError.message,
        };
        healthInfo.status = 'degraded';
      }

      // 检查数据源健康状态
      try {
        const dataSourceHealth = await DataSourceHealthService.getHealthSnapshots();
        const enabledProviders = dataSourceHealth.filter((provider: any) => provider.is_enabled);
        const unhealthyCount = enabledProviders.filter(
          (provider: any) => provider.status === 'unhealthy'
        ).length;
        const degradedCount = enabledProviders.filter(
          (provider: any) => provider.status === 'degraded'
        ).length;
        const avgScore =
          enabledProviders.length > 0
            ? enabledProviders.reduce(
                (sum: number, provider: any) => sum + Number(provider.health_score || 0),
                0
              ) / enabledProviders.length
            : 0;

        healthInfo.services.dataSource = {
          status:
            unhealthyCount === 0 && degradedCount === 0 && avgScore >= 70
              ? 'healthy'
              : unhealthyCount > 0 && unhealthyCount >= enabledProviders.length
              ? 'unhealthy'
              : unhealthyCount > 0 || degradedCount > 0 || avgScore < 70
              ? 'degraded'
              : 'healthy',
          type: 'Market Data Providers',
          provider_count: dataSourceHealth.length,
          enabled_count: enabledProviders.length,
          unhealthy_count: unhealthyCount,
          degraded_count: degradedCount,
          avg_health_score: Number(avgScore.toFixed(2)),
        };

        if (healthInfo.services.dataSource.status !== 'healthy') {
          healthInfo.status = 'degraded';
        }
      } catch (dataSourceError: any) {
        healthInfo.services.dataSource = {
          status: 'unhealthy',
          type: 'Market Data Providers',
          error: dataSourceError.message,
        };
        healthInfo.status = 'degraded';
      }

      // 根据服务状态确定整体状态
      const unhealthyServices = Object.values(healthInfo.services).filter(
        (service: any) => service.status === 'unhealthy'
      );
      if (unhealthyServices.length > 0) {
        healthInfo.status = 'unhealthy';
      }

      res.json({
        success: true,
        data: healthInfo,
      });
    } catch (error) {
      logger.error('系统健康检查错误:', error);
      res.status(500).json({
        success: false,
        error: '健康检查失败',
        details: error.message,
      });
    }
  };

  /**
   * 取消数据更新任务
   */
  cancelJob = async (req: Request, res: Response): Promise<void> => {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: '任务ID不能为空',
        });
        return;
      }

      const job = await dataUpdateQueue.getJob(jobId);

      if (!job) {
        res.status(404).json({
          success: false,
          error: '任务不存在',
        });
        return;
      }

      // 只有等待中或延迟中的任务可以取消
      const state = await job.getState();
      const cancellableStates = ['waiting', 'delayed', 'active'];

      if (!cancellableStates.includes(state)) {
        res.status(400).json({
          success: false,
          error: `任务状态为${state}，无法取消`,
        });
        return;
      }

      // 取消任务
      if (state === 'active') {
        // 正在运行的任务不能直接 remove，而是使用 discard 或将进度设置为取消标志
        // 这里尝试 discard 它，或者标记为失败
        try {
          await job.moveToFailed({ message: 'User manually cancelled the task' }, true);
        } catch (e) {
          // Fallback if moveToFailed throws
          await job.discard();
          await job.remove();
        }
      } else {
        // waiting / delayed 的任务可以直接 remove
        await job.remove();
      }

      logger.info(`数据更新任务 ${jobId} 已取消`, {
        type: job.data.type,
        date: job.data.date,
        state,
      });

      res.json({
        success: true,
        data: {
          message: '任务已取消',
          jobId,
          state,
          cancelledAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('取消数据更新任务错误:', error);
      res.status(500).json({
        success: false,
        error: '取消任务失败',
        details: error.message,
      });
    }
  };

  /**
   * 重试数据更新任务
   */
  retryJob = async (req: Request, res: Response): Promise<void> => {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: '任务ID不能为空',
        });
        return;
      }

      const job = await dataUpdateQueue.getJob(jobId);

      if (!job) {
        res.status(404).json({
          success: false,
          error: '任务不存在',
        });
        return;
      }

      // 只有失败的任务可以重试
      const state = await job.getState();

      if (state !== 'failed') {
        res.status(400).json({
          success: false,
          error: `任务状态为${state}，无法重试（仅支持失败的任务）`,
        });
        return;
      }

      // 获取任务数据
      const jobData = job.data;

      // 创建新任务（重试）
      const newJob = await dataUpdateQueue.add(job.name, jobData, {
        attempts: 3, // 重置重试次数
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        timeout: 30 * 60 * 1000,
      });

      logger.info(`数据更新任务 ${jobId} 已重试，新任务ID: ${newJob.id}`, {
        type: jobData.type,
        date: jobData.date,
        originalState: state,
      });

      res.json({
        success: true,
        data: {
          message: '任务已重试',
          originalJobId: jobId,
          newJobId: newJob.id,
          type: jobData.type,
          date: jobData.date,
          retriedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('重试数据更新任务错误:', error);
      res.status(500).json({
        success: false,
        error: '重试任务失败',
        details: error.message,
      });
    }
  };

  /**
   * 获取数据完整性统计
   */
  /**
   * 获取数据完整性统计（带缓存）
   */
  getDataCompletenessStats = async (req: Request, res: Response): Promise<void> => {
    try {
      const { start_date = '2020-01-01', end_date = '2026-04-10' } = req.query;

      // 验证日期格式
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(start_date as string) || !dateRegex.test(end_date as string)) {
        res.status(400).json({
          success: false,
          error: '日期格式应为 YYYY-MM-DD',
        });
        return;
      }

      // 检查缓存
      const now = Date.now();
      if (
        this.dataCompletenessCache &&
        now - this.dataCompletenessCache.timestamp < this.CACHE_TTL
      ) {
        logger.info('使用缓存的数据完整性统计');
        res.json({
          success: true,
          data: {
            ...this.dataCompletenessCache.data,
            summary: {
              ...this.dataCompletenessCache.data.summary,
              timestamp: new Date().toISOString(), // 更新返回的时间戳
              cached: true, // 标记为缓存数据
              cacheTimestamp: new Date(this.dataCompletenessCache.timestamp).toISOString(),
            },
          },
        });
        return;
      }

      logger.info('缓存未命中，重新计算数据完整性统计');

      // 计算期望的交易天数（估算）
      // 从2020-01-01到2026-04-10大约有6年零3.5个月
      // 每年约250个交易日，总共约 6.3 * 250 = 1575 个交易日
      const expectedTradingDays = 1575;

      // 获取所有上市股票
      const allStocks = await Stock.findAll({
        attributes: ['id', 'symbol', 'name', 'market', 'is_listed'],
        where: { is_listed: true },
        order: [
          ['market', 'ASC'],
          ['symbol', 'ASC'],
        ],
      });

      // 获取每个股票在指定时间段内的日线数据数量
      // 使用一次性聚合查询，而不是循环执行 5000+ 次 COUNT 查询，这能将耗时从几十秒缩短到几百毫秒
      // DailyBar 只有复合主键 time 和 stock_id，没有 id 列
      const barCounts = await DailyBar.findAll({
        attributes: ['stock_id', [sequelize.fn('COUNT', sequelize.col('stock_id')), 'count']],
        where: {
          time: {
            [Op.between]: [start_date, end_date], // 直接使用字符串格式的日期 YYYY-MM-DD
          },
        },
        group: ['stock_id'],
        raw: true,
      });

      // 建立 stock_id -> count 的映射，O(1) 复杂度查找
      const barCountMap = new Map<number, number>();
      (barCounts as any[]).forEach(item => {
        // Handle different ORM/DB return formats where the count might be a string or number
        const countVal = typeof item.count === 'string' ? parseInt(item.count, 10) : item.count;
        barCountMap.set(Number(item.stock_id), countVal);
      });

      // 统计阶梯
      const completenessLevels = [
        { min: 0.9, max: 1.0, label: '90%-100%', count: 0 },
        { min: 0.7, max: 0.9, label: '70%-89%', count: 0 },
        { min: 0.5, max: 0.7, label: '50%-69%', count: 0 },
        { min: 0.3, max: 0.5, label: '30%-49%', count: 0 },
        { min: 0.1, max: 0.3, label: '10%-29%', count: 0 },
        { min: 0.0, max: 0.1, label: '0%-9%', count: 0 },
      ];

      // 按市场统计
      const marketStats: Record<string, { total: number; completeCount: number }> = {
        SH: { total: 0, completeCount: 0 },
        SZ: { total: 0, completeCount: 0 },
        BJ: { total: 0, completeCount: 0 },
        UNKNOWN: { total: 0, completeCount: 0 },
      };

      const stockStats = [];
      let processed = 0;
      const batchSize = 100;

      for (let i = 0; i < allStocks.length; i += batchSize) {
        const batch = allStocks.slice(i, i + batchSize);

        for (const stock of batch) {
          try {
            // 获取该股票的日线数据数量，直接从预先加载的 map 中获取，O(1) 复杂度
            const barCount = barCountMap.get(stock.id) || 0;

            // 计算完整性比例
            const completeness = barCount / expectedTradingDays;

            // 判断完整性等级
            let completenessLabel = '';
            for (const level of completenessLevels) {
              if (completeness >= level.min && completeness < level.max) {
                level.count++;
                completenessLabel = level.label;
                break;
              }
            }

            // 更新市场统计
            const market = stock.market || 'UNKNOWN';
            if (!marketStats[market]) {
              marketStats[market] = { total: 0, completeCount: 0 };
            }
            marketStats[market].total++;
            if (completeness >= 0.9) {
              marketStats[market].completeCount++;
            }

            stockStats.push({
              symbol: stock.symbol,
              name: stock.name,
              market: stock.market,
              barCount,
              completeness: Math.min(1.0, completeness),
              completenessLabel,
              listing_date: stock.listing_date,
            });

            processed++;
          } catch (error) {
            logger.error(`处理股票 ${stock.symbol} 失败: ${error.message}`);
          }
        }
      }

      const stocksWithData = stockStats.filter(s => s.barCount > 0).length;

      // 汇总指标
      const avgCompleteness = stockStats.reduce((sum, s) => sum + s.completeness, 0) / processed;
      const medianCompleteness =
        stockStats.map(s => s.completeness).sort((a, b) => a - b)[Math.floor(processed / 2)] || 0;

      const highQualityStocks = stockStats.filter(s => s.completeness >= 0.9).length;
      const lowQualityStocks = stockStats.filter(s => s.completeness < 0.3).length;

      // 数据质量评估
      let qualityAssessment = '良好';
      if (avgCompleteness < 0.5) {
        qualityAssessment = '警告：平均数据完整性低于50%，建议执行全量数据更新';
      } else if (avgCompleteness < 0.8) {
        qualityAssessment = '提示：数据完整性一般，建议检查缺失数据的股票';
      }

      // 构建响应数据
      const responseData = {
        summary: {
          totalStocks: allStocks.length,
          processedStocks: processed,
          stocksWithData,
          stocksWithoutData: processed - stocksWithData,
          expectedTradingDays,
          dateRange: { start_date, end_date },
          timestamp: new Date().toISOString(),
          cached: false, // 标记为非缓存数据
        },
        completenessLevels: completenessLevels.map(level => ({
          label: level.label,
          count: level.count,
          percentage: ((level.count / processed) * 100).toFixed(1),
        })),
        marketStats: Object.entries(marketStats).map(([market, stats]) => ({
          market,
          total: stats.total,
          completeCount: stats.completeCount,
          completeRate:
            stats.total > 0 ? ((stats.completeCount / stats.total) * 100).toFixed(1) : '0.0',
        })),
        metrics: {
          avgCompleteness: (avgCompleteness * 100).toFixed(2),
          medianCompleteness: (medianCompleteness * 100).toFixed(2),
          highQualityStocks,
          highQualityPercentage: ((highQualityStocks / processed) * 100).toFixed(1),
          lowQualityStocks,
          lowQualityPercentage: ((lowQualityStocks / processed) * 100).toFixed(1),
        },
        qualityAssessment,
        // 数据质量问题标记
        dataQualityIssues: {
          hasUndefinedSymbols: allStocks.some(s => !s.symbol || s.symbol === 'undefined'),
          undefinedSymbolCount: allStocks.filter(s => !s.symbol || s.symbol === 'undefined').length,
          hasEmptyNames: allStocks.some(s => !s.name || s.name === 'undefined'),
          emptyNameCount: allStocks.filter(s => !s.name || s.name === 'undefined').length,
        },
      };

      // 保存到缓存
      this.dataCompletenessCache = {
        data: responseData,
        timestamp: Date.now(),
      };

      logger.info('数据完整性统计已缓存');

      res.json({
        success: true,
        data: responseData,
      });
    } catch (error) {
      logger.error('获取数据完整性统计错误:', error);
      res.status(500).json({
        success: false,
        error: '获取数据完整性统计失败',
        details: error.message,
      });
    }
  };

  /**
   * 刷新数据完整性统计缓存
   */
  refreshDataCompletenessCache = async (req: Request, res: Response): Promise<void> => {
    try {
      const { start_date = '2020-01-01', end_date = '2026-04-10' } = req.query;

      // 验证日期格式
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(start_date as string) || !dateRegex.test(end_date as string)) {
        res.status(400).json({
          success: false,
          error: '日期格式应为 YYYY-MM-DD',
        });
        return;
      }

      // 清空缓存，强制重新计算
      this.dataCompletenessCache = null;
      logger.info('数据完整性统计缓存已清除，等待下次请求重新计算');

      res.json({
        success: true,
        data: {
          message: '数据完整性统计缓存已清除，下次请求将重新计算',
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('刷新数据完整性统计缓存错误:', error);
      res.status(500).json({
        success: false,
        error: '刷新缓存失败',
        details: error.message,
      });
    }
  };
}
