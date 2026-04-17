import { Router } from 'express';
import { paperTradingController } from '../controllers/PaperTradingController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/paper-trading
 * @desc 获取当前用户的模拟盘数据及持仓明细
 * @access Private
 */
router.get('/', authController.authenticate, paperTradingController.getPortfolio);

export default router;
