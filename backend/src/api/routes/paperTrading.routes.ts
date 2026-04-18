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

/**
 * @route POST /api/paper-trading/trade
 * @desc 在模拟盘中进行买入或卖出交易
 * @access Private
 */
router.post('/trade', authController.authenticate, paperTradingController.placeTrade);

/**
 * @route GET /api/paper-trading/history
 * @desc 获取模拟盘的交易流水
 * @access Private
 */
router.get('/history', authController.authenticate, paperTradingController.getTradeHistory);

/**
 * @route GET /api/paper-trading/snapshots
 * @desc 获取模拟盘的资金曲线快照
 * @access Private
 */
router.get('/snapshots', authController.authenticate, paperTradingController.getSnapshots);

export default router;
