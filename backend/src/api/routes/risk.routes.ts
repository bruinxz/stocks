import { Router } from 'express';
import { riskController } from '../controllers/RiskController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/risk/position-limits
 * @desc 获取当前用户的仓位限制配置 (US-047)
 * @access Private
 */
router.get('/position-limits', authController.authenticate, riskController.getPositionLimits);

/**
 * @route PUT /api/risk/position-limits
 * @desc 更新当前用户的仓位限制配置 (US-047)
 * @access Private
 */
router.put('/position-limits', authController.authenticate, riskController.updatePositionLimits);

export default router;
