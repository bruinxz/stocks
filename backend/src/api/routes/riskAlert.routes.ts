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
 * @route PUT /api/risk-alerts/:id/read
 * @desc 将告警标记为已读
 * @access Private
 */
router.put('/:id/read', authController.authenticate, riskAlertController.markAsRead);

export default router;
