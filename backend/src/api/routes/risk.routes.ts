import { Router } from 'express';
import { riskController } from '../controllers/RiskController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @openapi
 * /api/risk/position-limits:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 获取当前用户的仓位限制配置 (US-047)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 仓位限制配置 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/position-limits', authController.authenticate, riskController.getPositionLimits);

/**
 * @openapi
 * /api/risk/position-limits:
 *   put:
 *     tags: [风控 Risk]
 *     summary: 更新当前用户的仓位限制配置 (US-047)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put('/position-limits', authController.authenticate, riskController.updatePositionLimits);

/**
 * @openapi
 * /api/risk/trailing-stop:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 获取当前用户的追踪止损配置 (US-048)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 追踪止损配置 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/trailing-stop', authController.authenticate, riskController.getTrailingStop);

/**
 * @openapi
 * /api/risk/trailing-stop:
 *   put:
 *     tags: [风控 Risk]
 *     summary: 更新当前用户的追踪止损配置 (US-048)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put('/trailing-stop', authController.authenticate, riskController.updateTrailingStop);

/**
 * @openapi
 * /api/risk/drawdown-breaker:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 获取当前用户的组合回撤熔断配置 (US-049)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 回撤熔断配置 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/drawdown-breaker', authController.authenticate, riskController.getDrawdownBreaker);

/**
 * @openapi
 * /api/risk/drawdown-breaker:
 *   put:
 *     tags: [风控 Risk]
 *     summary: 更新当前用户的组合回撤熔断配置 (US-049)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put('/drawdown-breaker', authController.authenticate, riskController.updateDrawdownBreaker);

/**
 * @openapi
 * /api/risk/drawdown-breaker/clear-pause:
 *   post:
 *     tags: [风控 Risk]
 *     summary: 手动解除当前用户的 LEVEL_1 暂停状态 (US-049)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 解除结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.post(
  '/drawdown-breaker/clear-pause',
  authController.authenticate,
  riskController.clearDrawdownBreakerPause
);

/**
 * @openapi
 * /api/risk/market-regime-status:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 当前市场环境实时快照（指数收盘 + 涨跌 + MA20 vs MA60 + 已触发告警）只读 (US-050)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 市场环境快照 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/market-regime-status',
  authController.authenticate,
  riskController.getMarketRegimeStatus
);

/**
 * @openapi
 * /api/risk/market-regime:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 获取当前用户的市场环境预警配置 (US-050)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 市场环境预警配置 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/market-regime', authController.authenticate, riskController.getMarketRegimeConfig);

/**
 * @openapi
 * /api/risk/market-regime:
 *   put:
 *     tags: [风控 Risk]
 *     summary: 更新当前用户的市场环境预警配置 (US-050)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put('/market-regime', authController.authenticate, riskController.updateMarketRegimeConfig);

/**
 * @openapi
 * /api/risk/per-stock-stop-loss:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 获取当前用户的每股止损配置 (US-051)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 每股止损配置 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/per-stock-stop-loss', authController.authenticate, riskController.getPerStockStopLoss);

/**
 * @openapi
 * /api/risk/per-stock-stop-loss:
 *   put:
 *     tags: [风控 Risk]
 *     summary: 更新当前用户的每股止损配置 (US-051)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put(
  '/per-stock-stop-loss',
  authController.authenticate,
  riskController.updatePerStockStopLoss
);

/**
 * @openapi
 * /api/risk/industry-concentration:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 获取当前用户的行业集中度配置 (US-052)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 行业集中度配置 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/industry-concentration',
  authController.authenticate,
  riskController.getIndustryConcentration
);

/**
 * @openapi
 * /api/risk/industry-concentration:
 *   put:
 *     tags: [风控 Risk]
 *     summary: 更新当前用户的行业集中度配置 (US-052)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put(
  '/industry-concentration',
  authController.authenticate,
  riskController.updateIndustryConcentration
);

/**
 * @openapi
 * /api/risk/black-swan:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 获取当前用户的黑天鹅监控配置 (US-053)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 黑天鹅配置 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/black-swan', authController.authenticate, riskController.getBlackSwan);

/**
 * @openapi
 * /api/risk/black-swan:
 *   put:
 *     tags: [风控 Risk]
 *     summary: 更新当前用户的黑天鹅监控配置 (US-053)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put('/black-swan', authController.authenticate, riskController.updateBlackSwan);

/**
 * @openapi
 * /api/risk/morning-checkup/today:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 获取今日开盘前风险体检报告（无则回退到最新一条）(US-054)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 今日体检报告 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get(
  '/morning-checkup/today',
  authController.authenticate,
  riskController.getMorningCheckupToday
);

/**
 * @openapi
 * /api/risk/morning-checkup:
 *   get:
 *     tags: [风控 Risk]
 *     summary: 获取当前用户的开盘前风险体检配置 (US-054)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 体检配置 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.get('/morning-checkup', authController.authenticate, riskController.getMorningCheckupConfig);

/**
 * @openapi
 * /api/risk/morning-checkup:
 *   put:
 *     tags: [风控 Risk]
 *     summary: 更新当前用户的开盘前风险体检配置 (US-054)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: 更新结果 }
 *       400: { description: 参数错误 }
 *       401: { description: 未授权 }
 */
router.put(
  '/morning-checkup',
  authController.authenticate,
  riskController.updateMorningCheckupConfig
);

// ============================================================
// Phase 2: Position Sizing Policy
// ============================================================

/**
 * @openapi
 * /api/risk/sizing-policy:
 *   get:
 *     tags: [风控 Risk]
 *     summary: (Phase 2) 获取用户 sizing 配置 (含 default 对比)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 当前 sizing 配置 + defaults }
 */
router.get('/sizing-policy', authController.authenticate, riskController.getSizingPolicy);

/**
 * @openapi
 * /api/risk/sizing-policy:
 *   put:
 *     tags: [风控 Risk]
 *     summary: (Phase 2) 更新 sizing 配置
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               method: { type: string, enum: [equal_pct, vol_target, atr_based] }
 *               base_position_pct: { type: number }
 *               max_position_pct: { type: number }
 *               vol_target_pct: { type: number }
 *               vol_max_lookback_days: { type: integer }
 *               atr_risk_pct: { type: number }
 *               atr_period: { type: integer }
 *     responses:
 *       200: { description: 已保存 }
 */
router.put('/sizing-policy', authController.authenticate, riskController.updateSizingPolicy);

export default router;
