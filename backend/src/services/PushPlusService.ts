import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

/**
 * PushPlus 推送服务（https://www.pushplus.plus）
 *
 * 核心接口：
 *  - POST https://www.pushplus.plus/send  发送消息（支持 text/markdown/html）
 *
 * 集成模式：一对多群组推送 (Topic)
 *  - 管理员在官网创建一个群组，获得群组编码 (topic) 和二维码
 *  - 用户微信扫码关注公众号即加入群组，无需实名和注册
 *  - 系统通过系统 Token + topic 群发给所有已扫码的用户
 */

export interface SendMessageResult {
  success: boolean;
  message?: string;
  data?: any;
}

class PushPlusService {
  private readonly systemToken: string;
  private readonly topic: string;
  private readonly baseUrl = 'https://www.pushplus.plus';
  private readonly http: AxiosInstance;

  constructor() {
    this.systemToken = process.env.PUSHPLUS_TOKEN || '';
    this.topic = process.env.PUSHPLUS_TOPIC || '';
    
    if (!this.systemToken) {
      logger.warn('PUSHPLUS_TOKEN 未配置，推送功能将不可用');
    }
    if (!this.topic) {
      logger.warn('PUSHPLUS_TOPIC 未配置，群组推送功能将不可用');
    }
    
    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
  }

  /**
   * 发送 Markdown 消息给整个群组（一对多）
   * @param title 消息标题
   * @param content 消息正文（支持 Markdown）
   */
  async sendMarkdownToTopic(title: string, content: string): Promise<SendMessageResult> {
    if (!this.systemToken) {
      return { success: false, message: 'PUSHPLUS_TOKEN 未配置' };
    }
    if (!this.topic) {
      return { success: false, message: 'PUSHPLUS_TOPIC 未配置' };
    }
    return this._send(this.systemToken, title, content, 'markdown', this.topic);
  }

  /**
   * 使用系统主 Token 发送消息给管理员自己（测试用）
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
    template: 'html' | 'txt' | 'markdown' | 'json' = 'markdown',
    topic?: string
  ): Promise<SendMessageResult> {
    try {
      const payload: any = {
        token,
        title,
        content,
        template,
      };
      
      // 如果指定了群组编码，则附加 topic 参数实现一对多群发
      if (topic) {
        payload.topic = topic;
      }
      
      const resp = await this.http.post('/send', payload);
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
