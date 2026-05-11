import axios, { AxiosInstance, Method } from 'axios';
import { logger } from '../utils/logger';

type FeishuField = {
  field_id: string;
  field_name: string;
  type: number;
};

export interface FeishuCreateRecordResult {
  success: boolean;
  skipped?: boolean;
  message?: string;
  data?: any;
}

/**
 * 飞书开放平台 - 多维表格客户端。
 *
 * 这个文件只负责开放平台鉴权、字段维护和记录写入，业务层不要直接拼 Feishu HTTP 请求。
 */
class FeishuBitableClient {
  private readonly http: AxiosInstance;
  private tenantAccessToken = '';
  private tokenExpiresAt = 0;
  private knownFieldNames: Set<string> | null = null;

  constructor() {
    this.http = axios.create({
      baseURL: process.env.FEISHU_API_BASE_URL || 'https://open.feishu.cn/open-apis',
      timeout: 15000,
    });
  }

  isEnabled(): boolean {
    const config = this.getConfig();
    return Boolean(config.app_id && config.app_secret && config.app_token && config.table_id);
  }

  async createRecord(fields: Record<string, any>): Promise<FeishuCreateRecordResult> {
    const config = this.getConfig();
    if (!this.isEnabled()) {
      return {
        success: false,
        skipped: true,
        message: '飞书多维表格配置不完整，已跳过写入',
      };
    }

    const normalizedFields = Object.fromEntries(
      Object.entries(fields)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, this.normalizeFieldValue(value)])
    );

    if (Object.keys(normalizedFields).length === 0) {
      return { success: false, skipped: true, message: '无可写入字段' };
    }

    try {
      await this.ensureTextFields(Object.keys(normalizedFields));
      const data = await this.request(
        'POST',
        `/bitable/v1/apps/${config.app_token}/tables/${config.table_id}/records`,
        {
          fields: normalizedFields,
        }
      );

      return { success: true, data };
    } catch (error: any) {
      logger.error('写入飞书多维表格失败:', error?.message || error);
      return { success: false, message: error?.message || '写入失败' };
    }
  }

  private normalizeFieldValue(value: any): string {
    if (value instanceof Date) {
      return this.formatDate(value);
    }
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value, null, 2);
    } catch (error) {
      return String(value);
    }
  }

  private async ensureTextFields(fieldNames: string[]) {
    if (!this.knownFieldNames) {
      const fields = await this.listFields();
      this.knownFieldNames = new Set(fields.map(field => field.field_name));
    }

    for (const fieldName of fieldNames) {
      if (this.knownFieldNames.has(fieldName)) continue;
      await this.createTextField(fieldName);
      this.knownFieldNames.add(fieldName);
    }
  }

  private async listFields(): Promise<FeishuField[]> {
    const config = this.getConfig();
    const allFields: FeishuField[] = [];
    let pageToken = '';

    do {
      const data = await this.request(
        'GET',
        `/bitable/v1/apps/${config.app_token}/tables/${config.table_id}/fields`,
        undefined,
        {
          page_size: 100,
          page_token: pageToken || undefined,
        }
      );
      const items = data?.items || data?.fields || [];
      allFields.push(...items);
      pageToken = data?.has_more ? data?.page_token || '' : '';
    } while (pageToken);

    return allFields;
  }

  private async createTextField(fieldName: string) {
    const config = this.getConfig();
    try {
      await this.request(
        'POST',
        `/bitable/v1/apps/${config.app_token}/tables/${config.table_id}/fields`,
        {
          field_name: fieldName,
          type: 1,
        }
      );
      logger.info(`飞书多维表格字段已创建: ${fieldName}`);
    } catch (error: any) {
      const message = error?.message || '';
      if (message.includes('duplicate') || message.includes('exist') || message.includes('重复')) {
        logger.warn(`飞书多维表格字段已存在，跳过创建: ${fieldName}`);
        return;
      }
      throw error;
    }
  }

  private async request(method: Method, url: string, data?: any, params?: any): Promise<any> {
    const token = await this.getTenantAccessToken();
    const response = await this.http.request({
      method,
      url,
      data,
      params,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const body = response.data || {};
    if (body.code !== 0) {
      throw new Error(`Feishu API error code=${body.code}, msg=${body.msg || body.message || ''}`);
    }

    return body.data;
  }

  private async getTenantAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tenantAccessToken && now < this.tokenExpiresAt) {
      return this.tenantAccessToken;
    }

    const { app_id, app_secret } = this.getConfig();
    if (!app_id || !app_secret) {
      throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET 未配置');
    }

    const response = await this.http.post('/auth/v3/tenant_access_token/internal', {
      app_id,
      app_secret,
    });
    const body = response.data || {};
    if (body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`获取飞书 tenant_access_token 失败: ${body.msg || JSON.stringify(body)}`);
    }

    this.tenantAccessToken = body.tenant_access_token;
    this.tokenExpiresAt = now + Math.max(Number(body.expire || 7200) - 300, 300) * 1000;
    return this.tenantAccessToken;
  }

  private getConfig() {
    const parsed = this.parseBitableUrl(process.env.FEISHU_BITABLE_URL || '');
    return {
      app_id: process.env.FEISHU_APP_ID || '',
      app_secret: process.env.FEISHU_APP_SECRET || '',
      app_token:
        process.env.FEISHU_BITABLE_APP_TOKEN ||
        process.env.FEISHU_BASE_APP_TOKEN ||
        parsed.app_token ||
        'FOT8bXz5daxZQqszBqecrCAKnbc',
      table_id:
        process.env.FEISHU_BITABLE_TABLE_ID ||
        process.env.FEISHU_BASE_TABLE_ID ||
        parsed.table_id ||
        'tblxGh9uXavoj9zR',
    };
  }

  private parseBitableUrl(url: string): { app_token?: string; table_id?: string } {
    const appToken = url.match(/\/base\/([^/?#]+)/)?.[1];
    const tableId = url.match(/[?&]table=([^&#]+)/)?.[1];
    return {
      app_token: appToken,
      table_id: tableId,
    };
  }

  private formatDate(value: Date): string {
    return value.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });
  }
}

export const feishuBitableClient = new FeishuBitableClient();
