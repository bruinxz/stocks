import { Request, Response, NextFunction } from 'express';
import { User } from '../../models/User';
import { pushPlusService } from '../../services/PushPlusService';
import { logger } from '../../utils/logger';

/**
 * 微信推送绑定控制器（基于 PushPlus）
 *
 * 由于 PushPlus 没有提供 OAuth 扫码回调接入方式，采用其官方推荐的集成模式：
 *   1. 用户到 PushPlus 官网 (https://www.pushplus.plus) 微信扫码登录
 *   2. 在个人中心复制自己的 "user token"
 *   3. 粘贴到我们系统的绑定框
 *   4. 后端发送一条测试消息校验 token 有效性后再保存
 *
 * 主要接口：
 *  - POST /api/auth/wechat/bind        绑定 PushPlus token（Authed）
 *  - POST /api/auth/wechat/test        发送一条测试推送（Authed）
 *  - POST /api/auth/wechat/unbind      解绑（Authed）
 *  - PUT  /api/auth/wechat/notify      开关通知（Authed）
 */
export class WechatAuthController {
  constructor() {
    this.bindPushPlusToken = this.bindPushPlusToken.bind(this);
    this.sendTestPush = this.sendTestPush.bind(this);
    this.unbindWechat = this.unbindWechat.bind(this);
    this.updateNotifyEnabled = this.updateNotifyEnabled.bind(this);
  }

  /**
   * 绑定 PushPlus Token
   * Body: { token: string }
   * 流程：格式校验 -> 唯一性检查 -> 发送一条测试推送验证 token -> 持久化
   */
  async bindPushPlusToken(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user as User;
      const rawToken: string = (req.body?.token || '').trim();

      if (!rawToken) {
        return res.status(400).json({ success: false, message: '请输入 PushPlus Token' });
      }
      if (!pushPlusService.isValidTokenFormat(rawToken)) {
        return res.status(400).json({
          success: false,
          message: 'Token 格式不正确（应为 32 位十六进制字符串）',
        });
      }

      // 检查是否被其他用户占用
      const occupied = await User.findOne({ where: { pushplus_token: rawToken } });
      if (occupied && occupied.id !== user.id) {
        return res.status(409).json({
          success: false,
          message: '该 Token 已被其他账号绑定',
        });
      }

      // 发送测试推送验证 token 有效性
      const testResult = await pushPlusService.sendMarkdownToUser(
        rawToken,
        '🎉 绑定成功 - A股AI分析系统',
        [
          `# 欢迎，${user.nickname || user.username}`,
          '',
          '您已成功将微信公众号绑定到 **A股AI分析系统**。',
          '',
          '之后 AI 定时任务完成后，系统会把您收藏股票的分析结果第一时间推送到这里。',
          '',
          '> 可在「个人中心」随时关闭通知或解绑',
        ].join('\n')
      );

      if (!testResult.success) {
        return res.status(400).json({
          success: false,
          message: `Token 校验失败：${testResult.message || '无法发送测试推送'}`,
        });
      }

      user.pushplus_token = rawToken;
      user.wechat_notify_enabled = true;
      await user.save();

      logger.info(`用户 ${user.username} 成功绑定 PushPlus Token`);
      return res.json({
        success: true,
        message: '绑定成功，测试推送已发送到您的微信',
        data: {
          pushplus_token: rawToken,
          wechat_notify_enabled: true,
        },
      });
    } catch (err) {
      logger.error('绑定 PushPlus Token 失败:', err);
      next(err);
    }
  }

  /**
   * 主动发送一条测试推送（已绑定用户使用）
   */
  async sendTestPush(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user as User;
      if (!user.pushplus_token) {
        return res.status(400).json({ success: false, message: '您尚未绑定 PushPlus' });
      }
      const result = await pushPlusService.sendMarkdownToUser(
        user.pushplus_token,
        '🔔 测试推送 - A股AI分析系统',
        [
          '# 测试推送',
          '',
          '如果您看到这条消息，说明 PushPlus 通道工作正常。',
          '',
          `- 用户: ${user.username}`,
          `- 时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
        ].join('\n')
      );
      if (result.success) {
        return res.json({ success: true, message: '测试推送已发送，请在微信查收' });
      }
      return res.status(400).json({
        success: false,
        message: `发送失败：${result.message || '未知错误'}`,
      });
    } catch (err) {
      logger.error('发送测试推送失败:', err);
      next(err);
    }
  }

  async unbindWechat(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user as User;
      user.pushplus_token = null;
      user.wechat_notify_enabled = false;
      await user.save();
      return res.json({ success: true, message: '已解绑微信通知' });
    } catch (err) {
      logger.error('解绑微信失败:', err);
      next(err);
    }
  }

  async updateNotifyEnabled(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user as User;
      const { enabled } = req.body || {};
      user.wechat_notify_enabled = !!enabled;
      await user.save();
      return res.json({
        success: true,
        data: { wechat_notify_enabled: user.wechat_notify_enabled },
      });
    } catch (err) {
      logger.error('更新微信通知开关失败:', err);
      next(err);
    }
  }
}

export const wechatAuthController = new WechatAuthController();
