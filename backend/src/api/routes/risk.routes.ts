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

/**
 * @route GET /api/risk/trailing-stop
 * @desc 获取当前用户的追踪止损配置 (US-048)
 * @access Private
 */
router.get('/trailing-stop', authController.authenticate, riskController.getTrailingStop);

/**
 * @route PUT /api/risk/trailing-stop
 * @desc 更新当前用户的追踪止损配置 (US-048)
 * @access Private
 */
router.put('/trailing-stop', authController.authenticate, riskController.updateTrailingStop);

export default router;
