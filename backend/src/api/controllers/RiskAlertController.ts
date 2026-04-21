import { Request, Response, NextFunction } from 'express';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { logger } from '../../utils/logger';

export class RiskAlertController {
  // 获取当前用户的未读告警及风控配置
  async getAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const user_id = (req as any).user.id;

      const user = await User.findByPk(user_id);
      const alerts = await RiskAlert.findAll({
        where: { user_id: user_id },
        order: [['created_at', 'DESC']],
        limit: 50, // 只返回最近的50条
      });

      res.json({
        success: true,
        data: {
          alerts,
          risk_config: user?.risk_config || {
            stop_loss_percent: 5,
            take_profit_percent: 10,
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
      const user_id = (req as any).user.id;
      const { stop_loss_percent, take_profit_percent, enableVolumeAlert, enableTechnicalAlert } = req.body;

      const user = await User.findByPk(user_id);
      if (!user) {
        return res.status(404).json({ success: false, message: '用户不存在' });
      }

      user.risk_config = {
        ...user.risk_config,
        stop_loss_percent: stop_loss_percent !== undefined ? stop_loss_percent : user.risk_config?.stop_loss_percent,
        take_profit_percent: take_profit_percent !== undefined ? take_profit_percent : user.risk_config?.take_profit_percent,
        enableVolumeAlert: enableVolumeAlert !== undefined ? enableVolumeAlert : user.risk_config?.enableVolumeAlert,
        enableTechnicalAlert: enableTechnicalAlert !== undefined ? enableTechnicalAlert : user.risk_config?.enableTechnicalAlert,
      };

      await user.save();

      res.json({
        success: true,
        data: user.risk_config,
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

      const alert = await RiskAlert.findOne({ where: { id, user_id: user.id } });
      if (alert) {
        alert.is_read = true;
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
        { is_read: true },
        { where: { user_id: user.id, is_read: false } }
      );

      res.json({ success: true, message: '所有告警已标记为已读' });
    } catch (error: any) {
      logger.error('一键标记已读失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const riskAlertController = new RiskAlertController();
