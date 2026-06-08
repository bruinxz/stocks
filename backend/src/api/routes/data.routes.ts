import { Router } from 'express';
import { DataController } from '../controllers/DataController';
import { AuthController } from '../controllers/AuthController';

/**
 * US-079 数据健康度看板路由
 *
 * - GET  /api/data/health-status   聚合所有数据源同步状态（红 / 黄 / 绿）
 * - POST /api/data/sync/:source    手动触发指定数据源的当日同步
 *
 * 路由顺序：health-status 在 sync/:source 之前注册（无冲突，但仍维持 US-015
 * "sub-resource before :param catchall" 习惯避免后续重构破坏）。
 */
const router = Router();
const dataController = new DataController();
const authController = new AuthController();

router.get('/health-status', authController.authenticate, dataController.getHealthStatus);
router.post('/sync/:source', authController.authenticate, dataController.triggerSync);

export default router;
