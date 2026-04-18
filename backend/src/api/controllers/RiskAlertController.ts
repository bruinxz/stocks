import { Request, Response, NextFunction } from 'express';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { logger } from '../../utils/logger';

export class RiskAlertController {
  // 获取当前用户的未读告警及风控配置
  async getAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user.id;

      const user = await User.findByPk(userId);
      const alerts = await RiskAlert.findAll({
        where: { userId },
        order: [['createdAt', 'DESC']],
        limit: 50, // 只返回最近的50条
      });

      res.json({
        success: true,
        data: {
          alerts,
          riskConfig: user?.riskConfig || {
            stopLossPercent: 5,
            takeProfitPercent: 10,
            enableVolumeAlert: true,
            enableTechnicalAlert: true,
          }
        },
      });
    } catch (error: any) {
      logger.error('获取风控告警数据失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // 更新风控配置
  async updateRiskConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as any).user.id;
      const { stopLossPercent, takeProfitPercent, enableVolumeAlert, enableTechnicalAlert } = req.body;

      const user = await User.findByPk(userId);
      if (!user) {
        return res.status(404).json({ success: false, message: '用户不存在' });
      }

      user.riskConfig = {
        ...user.riskConfig,
        stopLossPercent: stopLossPercent !== undefined ? stopLossPercent : user.riskConfig?.stopLossPercent,
        takeProfitPercent: takeProfitPercent !== undefined ? takeProfitPercent : user.riskConfig?.takeProfitPercent,
        enableVolumeAlert: enableVolumeAlert !== undefined ? enableVolumeAlert : user.riskConfig?.enableVolumeAlert,
        enableTechnicalAlert: enableTechnicalAlert !== undefined ? enableTechnicalAlert : user.riskConfig?.enableTechnicalAlert,
      };

      await user.save();

      res.json({
        success: true,
        data: user.riskConfig,
        message: '风控配置已保存'
      });
    } catch (error: any) {
      logger.error('更新风控配置失败:', error);
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

  // 标记所有未读为已读
  async markAllAsRead(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;

      await RiskAlert.update(
        { isRead: true },
        { where: { userId: user.id, isRead: false } }
      );

      res.json({ success: true, message: '所有告警已标记为已读' });
    } catch (error: any) {
      logger.error('一键标记已读失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const riskAlertController = new RiskAlertController();
