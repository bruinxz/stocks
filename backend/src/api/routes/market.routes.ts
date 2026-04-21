import { Router } from 'express';
import { MarketController } from '../controllers/MarketController';
import { AuthController } from '../controllers/AuthController';
import { body, query } from 'express-validator';
import { validateRequest } from '../../middlewares/validateRequest';

const router = Router();
const marketController = new MarketController();
const authController = new AuthController();

// Market routes

/**
 * @swagger
 * tags:
 *   name: Market
 *   description: 大盘视图和收藏功能
 */

/**
 * @swagger
 * /api/market/overview:
 *   get:
 *     tags: [Market]
 *     summary: 获取市场大盘概览
 *     description: 获取沪深300等核心指数的最新状态和近期走势
 */
router.get('/overview', authController.authenticate, marketController.getMarketOverview);

/**
 * @swagger
 * /api/market/search:
 *   get:
 *     tags: [Market]
 *     summary: 搜索股票
 *     description: 根据关键词搜索股票，支持分页和筛选
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         description: 搜索关键词（股票代码或名称）
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: 页码
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: 每页数量
 *       - in: query
 *         name: market
 *         schema:
 *           type: string
 *         description: 市场筛选（SH, SZ, BJ）
 *       - in: query
 *         name: industry
 *         schema:
 *           type: string
 *         description: 行业筛选
 *     responses:
 *       200:
 *         description: 搜索成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     stocks:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/Stock'
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         total:
 *                           type: integer
 *                         totalPages:
 *                           type: integer
 *       500:
 *         description: 服务器错误
 */
router.get('/search', marketController.searchStocks);

/**
 * @swagger
 * /api/market/history/{symbol}:
 *   get:
 *     tags: [Market]
 *     summary: 获取股票历史走势
 *     description: 获取指定股票的历史K线数据
 *     parameters:
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: 股票代码（如 600000.SH）
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: 开始日期（YYYY-MM-DD），默认一年前
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: 结束日期（YYYY-MM-DD），默认今天
 *       - in: query
 *         name: frequency
 *         schema:
 *           type: string
 *           enum: [d, w, m]
 *           default: d
 *         description: 数据频率（d-日线，w-周线，m-月线）
 *     responses:
 *       200:
 *         description: 获取成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     stock:
 *                       $ref: '#/components/schemas/Stock'
 *                     history:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           date:
 *                             type: string
 *                           open:
 *                             type: number
 *                           high:
 *                             type: number
 *                           low:
 *                             type: number
 *                           close:
 *                             type: number
 *                           volume:
 *                             type: number
 *                           amount:
 *                             type: number
 *                           pctChg:
 *                             type: number
 *                           adjustflag:
 *                             type: number
 *                     summary:
 *                       type: object
 *                       properties:
 *                         start_date:
 *                           type: string
 *                         end_date:
 *                           type: string
 *                         totalDays:
 *                           type: integer
 *                         priceChange:
 *                           type: string
 *       400:
 *         description: 参数错误
 *       404:
 *         description: 未找到数据
 *       500:
 *         description: 服务器错误
 */
router.get('/history/:symbol', marketController.getStockHistory);

/**
 * @swagger
 * /api/market/favorites:
 *   get:
 *     tags: [Market]
 *     summary: 获取用户收藏列表
 *     description: 获取当前用户收藏的所有股票
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: group_id
 *         schema:
 *           type: string
 *         description: 按分组筛选
 *     responses:
 *       200:
 *         description: 获取成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     favorites:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           group_id:
 *                             type: string
 *                           tags:
 *                             type: string
 *                           notes:
 *                             type: string
 *                           sort_order:
 *                             type: integer
 *                           stock:
 *                             $ref: '#/components/schemas/Stock'
 *                     grouped:
 *                       type: object
 *                       additionalProperties:
 *                         type: array
 *                         items:
 *                           type: object
 *       401:
 *         description: 未授权
 *       500:
 *         description: 服务器错误
 */
router.get('/favorites', authController.authenticate, marketController.getFavorites);

/**
 * @swagger
 * /api/market/favorites/{symbol}:
 *   post:
 *     tags: [Market]
 *     summary: 收藏股票
 *     description: 将股票添加到收藏夹
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: 股票代码
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               group_id:
 *                 type: string
 *               tags:
 *                 type: string
 *               notes:
 *                 type: string
 *               sort_order:
 *                 type: integer
 *     responses:
 *       200:
 *         description: 收藏成功
 *       400:
 *         description: 已收藏或参数错误
 *       401:
 *         description: 未授权
 *       404:
 *         description: 股票不存在
 *       500:
 *         description: 服务器错误
 */
router.post('/favorites/:symbol', authController.authenticate, marketController.addFavorite as any);

/**
 * @swagger
 * /api/market/favorites/{symbol}:
 *   delete:
 *     tags: [Market]
 *     summary: 取消收藏
 *     description: 从收藏夹移除股票
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: 股票代码
 *     responses:
 *       200:
 *         description: 取消成功
 *       401:
 *         description: 未授权
 *       404:
 *         description: 未找到收藏记录
 *       500:
 *         description: 服务器错误
 */
router.delete('/favorites/:symbol', authController.authenticate, marketController.removeFavorite as any);

/**
 * @swagger
 * /api/market/favorites/{symbol}:
 *   get:
 *     tags: [Market]
 *     summary: 检查收藏状态
 *     description: 检查股票是否已被当前用户收藏
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: 股票代码
 *     responses:
 *       200:
 *         description: 检查成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     isFavorite:
 *                       type: boolean
 *                     favorite:
 *                       type: object
 *                       nullable: true
 *       401:
 *         description: 未授权
 *       500:
 *         description: 服务器错误
 */
router.get('/favorites/:symbol', authController.authenticate, marketController.checkFavorite as any);

/**
 * @swagger
 * /api/market/favorites/{symbol}:
 *   patch:
 *     tags: [Market]
 *     summary: 更新收藏信息
 *     description: 更新收藏的分组、标签、备注等信息
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: 股票代码
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               group_id:
 *                 type: string
 *               tags:
 *                 type: string
 *               notes:
 *                 type: string
 *               sort_order:
 *                 type: integer
 *     responses:
 *       200:
 *         description: 更新成功
 *       401:
 *         description: 未授权
 *       404:
 *         description: 未找到收藏记录
 *       500:
 *         description: 服务器错误
 */
router.patch('/favorites/:symbol', authController.authenticate, marketController.updateFavorite as any);

/**
 * @swagger
 * /api/market/update-data:
 *   post:
 *     tags: [Market]
 *     summary: 数据更新接口
 *     description: |
 *       触发数据更新任务，包括：
 *       1. 查询新股并同步到数据库
 *       2. 更新全部股票最新数据（比较数据库最新日期）
 *       3. 检查过去一周数据完整性，缺失的补更新
 *
 *       接口会异步执行，立即返回任务ID。如果当天已经更新成功则跳过。
 *     responses:
 *       200:
 *         description: 更新任务已开始或今日已更新
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     updatedToday:
 *                       type: boolean
 *                       description: 今日是否已更新过
 *                     logId:
 *                       type: integer
 *                       description: 更新记录ID
 *                     status:
 *                       type: string
 *                       enum: [pending, in_progress, completed, failed]
 *                       description: 更新状态
 *                     started_at:
 *                       type: string
 *                       format: date-time
 *       500:
 *         description: 服务器错误
 */
router.post('/update-data', marketController.updateData);

/**
 * @swagger
 * /api/market/update-status:
 *   get:
 *     tags: [Market]
 *     summary: 查询数据更新状态
 *     description: 查询数据更新任务的状态、队列情况和锁状态
 *     parameters:
 *       - in: query
 *         name: jobId
 *         schema:
 *           type: string
 *         description: 任务ID（可选）
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           format: date
 *         description: 日期 YYYY-MM-DD（可选）
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *         description: 开始日期 YYYY-MM-DD（可选），筛选创建时间
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *         description: 结束日期 YYYY-MM-DD（可选），筛选创建时间
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [daily_update, new_stocks_sync, weekly_completeness_check, manual_sync, bulk_sync_custom]
 *           default: daily_update
 *         description: 更新类型（可选），可传递多个type参数进行多选
 *     responses:
 *       200:
 *         description: 查询成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     job:
 *                       type: object
 *                       nullable: true
 *                       description: 任务详情
 *                     logs:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/DataUpdateLog'
 *                     queue:
 *                       type: object
 *                       description: 队列状态
 *                     locks:
 *                       type: object
 *                       description: 分布式锁状态
 *       500:
 *         description: 服务器错误
 */
router.get('/update-status', marketController.getUpdateStatus);

/**
 * @swagger
 * /api/market/manual-sync:
 *   post:
 *     tags: [Market]
 *     summary: 手动触发数据同步
 *     description: 手动触发指定类型的数据同步任务
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [daily_update, new_stocks_sync, weekly_completeness_check, manual_sync, health_check]
 *                 default: new_stocks_sync
 *                 description: 同步类型
 *               force:
 *                 type: boolean
 *                 default: false
 *                 description: 是否强制更新（忽略检查）
 *     responses:
 *       200:
 *         description: 任务已排队
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     jobId:
 *                       type: string
 *                     type:
 *                       type: string
 *                     date:
 *                       type: string
 *                     queue:
 *                       type: string
 *       400:
 *         description: 参数错误
 *       500:
 *         description: 服务器错误
 */
router.post('/manual-sync', marketController.triggerManualSync);

/**
 * @swagger
 * /api/market/bulk-sync:
 *   post:
 *     tags: [Market]
 *     summary: 触发批量数据同步
 *     description: |
 *       触发自定义范围的批量数据同步任务，支持：
 *       1. 指定股票代码列表
 *       2. 按市场筛选（SH, SZ, BJ）
 *       3. 同步所有股票
 *       4. 自定义日期范围和并发数
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               symbols:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: 指定股票代码列表（如 ["sh.600000", "sz.000001"]）
 *               marketFilters:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [SH, SZ, BJ]
 *                 description: 按市场筛选
 *               syncAllStocks:
 *                 type: boolean
 *                 default: false
 *                 description: 是否同步所有股票（如果为true，忽略symbols和marketFilters）
 *               start_date:
 *                 type: string
 *                 format: date
 *                 description: 同步开始日期（YYYY-MM-DD），默认一年前
 *               end_date:
 *                 type: string
 *                 format: date
 *                 description: 同步结束日期（YYYY-MM-DD），默认今天
 *               dataSource:
 *                 type: string
 *                 enum: [akshare]
 *                 default: akshare
 *                 description: 数据源（目前只支持akshare）
 *               concurrency:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 50
 *                 default: 10
 *                 description: 并发数量（批次大小）
 *     responses:
 *       200:
 *         description: 批量同步任务已排队
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     jobId:
 *                       type: string
 *                     type:
 *                       type: string
 *                     date:
 *                       type: string
 *                     queue:
 *                       type: string
 *                     totalStocks:
 *                       type: string
 *                     concurrency:
 *                       type: integer
 *       400:
 *         description: 参数错误
 *       500:
 *         description: 服务器错误
 */
router.post('/bulk-sync', marketController.triggerBulkSync as any);

/**
 * @swagger
 * /api/market/clean-queue:
 *   post:
 *     tags: [Market]
 *     summary: 清理数据更新队列
 *     description: 清理已完成或失败的数据更新任务
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           default: all
 *         description: 清理类型（目前仅支持all）
 *     responses:
 *       200:
 *         description: 清理成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     type:
 *                       type: string
 *       500:
 *         description: 服务器错误
 */
router.post('/clean-queue', marketController.cleanUpdateQueue);

/**
 * @swagger
 * /api/market/update-stats:
 *   get:
 *     tags: [Market]
 *     summary: 获取数据更新统计信息
 *     description: 获取指定天数内的数据更新统计信息
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 7
 *           minimum: 1
 *           maximum: 30
 *         description: 统计天数（1-30）
 *     responses:
 *       200:
 *         description: 查询成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     stats:
 *                       type: object
 *                       description: 统计信息
 *                     period:
 *                       type: object
 *                       description: 统计周期
 *       500:
 *         description: 服务器错误
 */
router.get('/update-stats', marketController.getUpdateStats);

/**
 * @swagger
 * /api/market/queue/{jobId}/cancel:
 *   post:
 *     tags: [Market]
 *     summary: 取消数据更新任务
 *     description: 取消指定ID的数据更新任务（仅支持等待中、延迟中或进行中的任务）
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: 任务ID
 *     responses:
 *       200:
 *         description: 取消成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     jobId:
 *                       type: string
 *                     state:
 *                       type: string
 *                     cancelledAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: 参数错误或任务状态不可取消
 *       404:
 *         description: 任务不存在
 *       500:
 *         description: 服务器错误
 */
router.post('/queue/:jobId/cancel', marketController.cancelJob as any);

/**
 * @swagger
 * /api/market/queue/{jobId}/retry:
 *   post:
 *     tags: [Market]
 *     summary: 重试数据更新任务
 *     description: 重试指定ID的失败数据更新任务
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: 任务ID
 *     responses:
 *       200:
 *         description: 重试成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     originalJobId:
 *                       type: string
 *                     newJobId:
 *                       type: string
 *                     type:
 *                       type: string
 *                     date:
 *                       type: string
 *                     retriedAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: 参数错误或任务状态不可重试
 *       404:
 *         description: 任务不存在
 *       500:
 *         description: 服务器错误
 */
router.post('/queue/:jobId/retry', marketController.retryJob as any);

/**
 * @swagger
 * /api/market/health:
 *   get:
 *     tags: [Market]
 *     summary: 系统健康检查
 *     description: 检查系统各服务的健康状态（数据库、Redis、队列等）
 *     responses:
 *       200:
 *         description: 健康检查成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [healthy, degraded, unhealthy]
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *                     services:
 *                       type: object
 *                       additionalProperties:
 *                         type: object
 *       500:
 *         description: 健康检查失败
 */
router.get('/health', marketController.healthCheck as any);

/**
 * @swagger
 * /api/market/data-completeness:
 *   get:
 *     tags: [Market]
 *     summary: 获取数据完整性统计
 *     description: 统计数据库里股票的只数和数据完整性（从指定开始日期到结束日期）
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *           default: 2020-01-01
 *         description: 开始日期（YYYY-MM-DD）
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *           default: 2026-04-10
 *         description: 结束日期（YYYY-MM-DD）
 *     responses:
 *       200:
 *         description: 统计成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     summary:
 *                       type: object
 *                       properties:
 *                         totalStocks:
 *                           type: integer
 *                         processedStocks:
 *                           type: integer
 *                         stocksWithData:
 *                           type: integer
 *                         stocksWithoutData:
 *                           type: integer
 *                         expectedTradingDays:
 *                           type: integer
 *                         dateRange:
 *                           type: object
 *                           properties:
 *                             start_date:
 *                               type: string
 *                             end_date:
 *                               type: string
 *                         timestamp:
 *                           type: string
 *                           format: date-time
 *                     completenessLevels:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           label:
 *                             type: string
 *                           count:
 *                             type: integer
 *                           percentage:
 *                             type: string
 *                     marketStats:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           market:
 *                             type: string
 *                           total:
 *                             type: integer
 *                           completeCount:
 *                             type: integer
 *                           completeRate:
 *                             type: string
 *                     metrics:
 *                       type: object
 *                       properties:
 *                         avgCompleteness:
 *                           type: string
 *                         medianCompleteness:
 *                           type: string
 *                         highQualityStocks:
 *                           type: integer
 *                         highQualityPercentage:
 *                           type: string
 *                         lowQualityStocks:
 *                           type: integer
 *                         lowQualityPercentage:
 *                           type: string
 *                     qualityAssessment:
 *                       type: string
 *                     dataQualityIssues:
 *                       type: object
 *                       properties:
 *                         hasUndefinedSymbols:
 *                           type: boolean
 *                         undefinedSymbolCount:
 *                           type: integer
 *                         hasEmptyNames:
 *                           type: boolean
 *                         emptyNameCount:
 *                           type: integer
 *       400:
 *         description: 参数错误
 *       500:
 *         description: 服务器错误
 */
router.get('/data-completeness', marketController.getDataCompletenessStats as any);

/**
 * @swagger
 * /api/market/data-completeness/refresh:
 *   post:
 *     tags: [Market]
 *     summary: 刷新数据完整性统计缓存
 *     description: 强制清除数据完整性统计的缓存，使下次请求重新计算
 *     parameters:
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date
 *           default: 2020-01-01
 *         description: 开始日期（YYYY-MM-DD）
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date
 *           default: 2026-04-10
 *         description: 结束日期（YYYY-MM-DD）
 *     responses:
 *       200:
 *         description: 缓存清除成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     message:
 *                       type: string
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: 参数错误
 *       500:
 *         description: 服务器错误
 */
router.post('/data-completeness/refresh', marketController.refreshDataCompletenessCache as any);


export default router;
