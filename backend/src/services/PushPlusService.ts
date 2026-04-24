import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

/**
 * PushPlus 推送服务（https://www.pushplus.plus）
 *
 * 核心接口：
 *  - POST https://www.pushplus.plus/send  发送消息（支持 text/markdown/html）
 *
 * 集成模式：
 *  - 每个用户自行到 PushPlus 官网（微信扫码登录）获取自己的 user token
 *  - 用户把 token 填入我们的个人中心完成绑定
 *  - 推送时用用户自己的 token 作为接收凭证，一对一送达其微信公众号
 *  - 系统主 Token（PUSHPLUS_TOKEN 环境变量）保留用于管理员推送/兜底
 */

export interface SendMessageResult {
  success: boolean;
  message?: string;
  data?: any;
}

class PushPlusService {
  private readonly systemToken: string;
  private readonly baseUrl = 'https://www.pushplus.plus';
  private readonly http: AxiosInstance;

  constructor() {
    this.systemToken = process.env.PUSHPLUS_TOKEN || '';
    if (!this.systemToken) {
      logger.warn('PUSHPLUS_TOKEN 未配置，系统主 Token 推送功能将不可用');
    }
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
  }

  /**
   * 校验 token 格式（PushPlus token 通常为 32 位十六进制字符串）
   */
  isValidTokenFormat(token: string): boolean {
    return /^[a-f0-9]{32}$/i.test((token || '').trim());
  }

  /**
   * 发送 Markdown 消息给指定用户（使用其自己的 PushPlus token）
   * @param userToken 接收者的 PushPlus user token
   * @param title 消息标题（微信推送列表显示）
   * @param content 消息正文（支持 Markdown）
   */
  async sendMarkdownToUser(
    userToken: string,
    title: string,
    content: string
  ): Promise<SendMessageResult> {
    if (!userToken) {
      return { success: false, message: '接收者 token 为空' };
    }
    return this._send(userToken, title, content, 'markdown');
  }

  /**
   * 使用系统主 Token 发送消息（管理员通知 / 兜底场景）
   */
  async sendMarkdownBySystem(title: string, content: string): Promise<SendMessageResult> {
    if (!this.systemToken) {
      return { success: false, message: 'PUSHPLUS_TOKEN 未配置' };
    }
    return this._send(this.systemToken, title, content, 'markdown');
  }

  private async _send(
    token: string,
    title: string,
    content: string,
    template: 'html' | 'txt' | 'markdown' | 'json' = 'markdown'
  ): Promise<SendMessageResult> {
    try {
      const resp = await this.http.post('/send', {
        token,
        title,
        content,
        template,
      });
      const { code, msg, data } = resp.data || {};
      logger.info(`PushPlus 返回: code=${code}, msg=${msg}, data=${JSON.stringify(data)}`);
      if (code === 200) {
        return { success: true, data };
      }
      return { success: false, message: msg || `code=${code}` };
    } catch (error: any) {
      logger.error('调用 PushPlus 发送消息接口失败:', error.message || error);
      return { success: false, message: error.message || '调用失败' };
    }
  }
}

export const pushPlusService = new PushPlusService();
