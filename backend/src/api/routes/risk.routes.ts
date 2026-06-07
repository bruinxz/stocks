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

/**
 * @route GET /api/risk/drawdown-breaker
 * @desc 获取当前用户的组合回撤熔断配置 (US-049)
 * @access Private
 */
router.get('/drawdown-breaker', authController.authenticate, riskController.getDrawdownBreaker);

/**
 * @route PUT /api/risk/drawdown-breaker
 * @desc 更新当前用户的组合回撤熔断配置 (US-049)
 * @access Private
 */
router.put('/drawdown-breaker', authController.authenticate, riskController.updateDrawdownBreaker);

/**
 * @route POST /api/risk/drawdown-breaker/clear-pause
 * @desc 手动解除当前用户的 LEVEL_1 暂停状态 (US-049)
 * @access Private
 */
router.post(
  '/drawdown-breaker/clear-pause',
  authController.authenticate,
  riskController.clearDrawdownBreakerPause
);

export default router;
