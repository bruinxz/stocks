import { Router } from 'express';
import { riskAlertController } from '../controllers/RiskAlertController';
import { AuthController } from '../controllers/AuthController';

const router = Router();
const authController = new AuthController();

/**
 * @route GET /api/risk-alerts
 * @desc 获取当前用户的风控告警列表
 * @access Private
 */
router.get('/', authController.authenticate, riskAlertController.getAlerts);

/**
 * @route PUT /api/risk-alerts/read-all
 * @desc 将所有告警标记为已读
 * @access Private
 */
router.put('/read-all', authController.authenticate, riskAlertController.markAllAsRead);

/**
 * @route PUT /api/risk-alerts/:id/read
 * @desc 将单个告警标记为已读
 * @access Private
 */
router.put('/:id/read', authController.authenticate, riskAlertController.markAsRead);

/**
 * @route PUT /api/risk-alerts/config
 * @desc 更新风控阈值配置
 * @access Private
 */
router.put('/config', authController.authenticate, riskAlertController.updateRiskConfig);

export default router;
