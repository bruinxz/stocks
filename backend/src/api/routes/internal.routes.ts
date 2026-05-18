import { Router } from 'express';
import { InternalDataController } from '../controllers/InternalDataController';
import { authenticateInternalApi } from '../../middlewares/internalAuth';

const router = Router();
const internalDataController = new InternalDataController();

/**
 * @swagger
 * tags:
 *   name: Internal
 *   description: 内部系统调用API (仅限持有API Key的授权服务如TradingAgents访问)
 */

// 所有 /api/internal/ 路由均受内部 API Key 保护
router.use(authenticateInternalApi);

/**
 * @swagger
 * /api/internal/stocks:
 *   get:
 *     tags: [Internal]
 *     summary: 获取全量股票基础信息
 *     description: 返回所有当前上市的A股代码、行业等基础信息，供Agent构建选股池
 *     security:
 *       - ApiKeyAuth: []
 */
router.get('/stocks', internalDataController.getAllStocks);

/**
 * @swagger
 * /api/internal/data/history:
 *   get:
 *     tags: [Internal]
 *     summary: 获取单只股票日线历史数据
 *     description: 为Python Agent优化的数据格式，直接返回带有复权价格、成交额的高质量数据
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: 股票代码 (e.g. sh.600000)
 *       - in: query
 *         name: start_date
 *         required: false
 *         schema:
 *           type: string
 *         description: 开始日期 (YYYY-MM-DD)
 *       - in: query
 *         name: end_date
 *         required: false
 *         schema:
 *           type: string
 *         description: 结束日期 (YYYY-MM-DD)
 */
router.get('/data/history', internalDataController.getHistoricalData);

/**
 * @swagger
 * /api/internal/data/batch-history:
 *   post:
 *     tags: [Internal]
 *     summary: 批量获取多只股票的日线历史数据
 *     description: 一次请求返回最多50只股票的历史数据，以字典形式返回，极大地减少Agent的并发请求数
 *     security:
 *       - ApiKeyAuth: []
 */
router.post('/data/batch-history', internalDataController.getBatchHistoricalData);

/**
 * @swagger
 * /api/internal/data/quotes:
 *   get:
 *     tags: [Internal]
 *     summary: 获取多只股票实时切片数据
 *     description: 提供极速的股票当前实时价格、涨跌幅等快照数据 (缓存 3 秒)
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: symbols
 *         required: true
 *         schema:
 *           type: string
 *         description: 股票代码列表，逗号分隔 (e.g. sh.600000,sz.000001)
 */
router.get('/data/quotes', internalDataController.getRealtimeQuotes);

/**
 * @swagger
 * /api/internal/data/intraday:
 *   get:
 *     tags: [Internal]
 *     summary: 获取单只股票日内分时K线
 *     description: 提供股票的分钟级别K线数据，用于分析日内走势 (缓存 60 秒)
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: 股票代码 (e.g. sh.600000)
 *       - in: query
 *         name: period
 *         required: false
 *         schema:
 *           type: string
 *           enum: [1m, 5m, 15m, 30m, 60m]
 *           default: 1m
 *         description: K线周期
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           default: 240
 *         description: 返回的K线数量
 */
router.get('/data/intraday', internalDataController.getIntradayBars);

export default router;
