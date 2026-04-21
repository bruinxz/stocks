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

export default router;
