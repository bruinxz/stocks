import { Router } from 'express';
import { MacroController } from '../controllers/MacroController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const macroController = new MacroController();
const authController = new AuthController();

/**
 * /api/macro/* — 宏观数据 / 期权波动率 / 基金重仓
 */

router.get('/indicators', authController.authenticate, macroController.getIndicators);
router.get('/qvix', authController.authenticate, macroController.getQvix);
router.get('/regime-snapshot', authController.authenticate, macroController.getRegimeSnapshot);
router.get(
  '/fund-holdings/:stock_code',
  authController.authenticate,
  macroController.getFundHoldingsByStock
);

export default router;
