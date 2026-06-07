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

/**
 * @route GET /api/risk/market-regime-status
 * @desc 当前市场环境实时快照（指数收盘 + 3 日/月度涨跌 + MA20 vs MA60 +
 *       已触发的市场预警告警）— 只读，不写 RiskAlert (US-050)
 * @access Private
 */
router.get(
  '/market-regime-status',
  authController.authenticate,
  riskController.getMarketRegimeStatus
);

/**
 * @route GET /api/risk/market-regime
 * @desc 获取当前用户的市场环境预警配置 (US-050)
 * @access Private
 */
router.get('/market-regime', authController.authenticate, riskController.getMarketRegimeConfig);

/**
 * @route PUT /api/risk/market-regime
 * @desc 更新当前用户的市场环境预警配置 (US-050)
 * @access Private
 */
router.put('/market-regime', authController.authenticate, riskController.updateMarketRegimeConfig);

/**
 * @route GET /api/risk/per-stock-stop-loss
 * @desc 获取当前用户的每股止损配置 (US-051)
 * @access Private
 */
router.get('/per-stock-stop-loss', authController.authenticate, riskController.getPerStockStopLoss);

/**
 * @route PUT /api/risk/per-stock-stop-loss
 * @desc 更新当前用户的每股止损配置 (US-051)
 * @access Private
 */
router.put(
  '/per-stock-stop-loss',
  authController.authenticate,
  riskController.updatePerStockStopLoss
);

/**
 * @route GET /api/risk/industry-concentration
 * @desc 获取当前用户的行业集中度配置 (US-052)
 * @access Private
 */
router.get(
  '/industry-concentration',
  authController.authenticate,
  riskController.getIndustryConcentration
);

/**
 * @route PUT /api/risk/industry-concentration
 * @desc 更新当前用户的行业集中度配置 (US-052)
 * @access Private
 */
router.put(
  '/industry-concentration',
  authController.authenticate,
  riskController.updateIndustryConcentration
);

/**
 * @route GET /api/risk/black-swan
 * @desc 获取当前用户的黑天鹅监控配置 (US-053)
 * @access Private
 */
router.get('/black-swan', authController.authenticate, riskController.getBlackSwan);

/**
 * @route PUT /api/risk/black-swan
 * @desc 更新当前用户的黑天鹅监控配置 (US-053)
 * @access Private
 */
router.put('/black-swan', authController.authenticate, riskController.updateBlackSwan);

export default router;
