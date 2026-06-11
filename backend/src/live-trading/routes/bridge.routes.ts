import { Router } from 'express';
import { bridgeController } from '../controllers/BridgeController';
import { bridgeAuthMiddleware } from '../middlewares/bridgeAuth';

const router = Router();

// 注意：bridge 路由不走用户 JWT 鉴权，只走 bridgeAuthMiddleware（HMAC + bridge_key 绑定 account）
router.use(bridgeAuthMiddleware);

router.post('/heartbeat', bridgeController.heartbeat.bind(bridgeController));
router.post('/account-snapshot', bridgeController.accountSnapshot.bind(bridgeController));
router.post('/positions', bridgeController.positions.bind(bridgeController));
router.post('/orders', bridgeController.orders.bind(bridgeController));
router.post('/trades', bridgeController.trades.bind(bridgeController));

router.get('/order-commands', bridgeController.pullCommands.bind(bridgeController));
router.get('/order-commands/stream', bridgeController.streamCommands.bind(bridgeController));
router.post('/order-commands/:id/ack', bridgeController.ackCommand.bind(bridgeController));
router.post('/order-events', bridgeController.orderEvents.bind(bridgeController));

export default router;
