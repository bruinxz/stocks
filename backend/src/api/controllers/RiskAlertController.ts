import { Request, Response, NextFunction } from 'express';
import { RiskAlert } from '../../models/RiskAlert';
import { logger } from '../../utils/logger';

export class RiskAlertController {
  // 获取当前用户的未读告警
  async getAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;

      const alerts = await RiskAlert.findAll({
        where: { userId: user.id },
        order: [['createdAt', 'DESC']],
        limit: 50, // 只返回最近的50条
      });

      res.json({
        success: true,
        data: alerts,
      });
    } catch (error: any) {
      logger.error('获取风控告警数据失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // 标记为已读
  async markAsRead(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const user = (req as any).user;

      const alert = await RiskAlert.findOne({ where: { id, userId: user.id } });
      if (alert) {
        alert.isRead = true;
        await alert.save();
      }

      res.json({ success: true, message: '已标记为已读' });
    } catch (error: any) {
      logger.error('标记已读失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const riskAlertController = new RiskAlertController();
