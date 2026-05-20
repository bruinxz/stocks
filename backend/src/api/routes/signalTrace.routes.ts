import { Router } from 'express';
import { AuthController } from '../controllers/AuthController';
import { signalTraceController } from '../controllers/SignalTraceController';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/signals/:id/trace
 * @desc 获取单笔推荐/信号的完整因果链路：来源任务、量化/Agent、风控、交易与收益
 * @access Private
 */
router.get(
  '/:id/trace',
  authController.authenticate,
  signalTraceController.getTrace.bind(signalTraceController)
);

export default router;
