import { Router } from 'express';
import { DataController } from '../controllers/DataController';
import { AuthController } from '../controllers/AuthController';

/**
 * US-079 数据健康度看板路由（US-088 扩展龙虎榜查询）
 *
 * - GET  /api/data/health-status                        聚合所有数据源同步状态（红 / 黄 / 绿）
 * - GET  /api/data/dragon-tiger                         US-088: 按 stock_code / seat_type 查询龙虎榜
 * - POST /api/data/sync/:source                         手动触发指定数据源的当日同步
 *
 * 路由顺序：static / sub-resource GET (health-status, dragon-tiger) 必须在
 * `:param` 风格路由前注册。本文件目前所有 GET 都是静态路径 + POST 是 :source
 * catchall，无直接冲突；保留此注释提醒未来添加 `GET /api/data/:source`
 * 之类的路由时不要把 dragon-tiger 推到后面（参见 backend/CLAUDE.md 的
 * US-015 lesson）。
 */
const router = Router();
const dataController = new DataController();
const authController = new AuthController();

router.get('/health-status', authController.authenticate, dataController.getHealthStatus);
router.get('/dragon-tiger', authController.authenticate, dataController.listDragonTiger);
router.post('/sync/:source', authController.authenticate, dataController.triggerSync);

export default router;
