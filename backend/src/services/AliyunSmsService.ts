/**
 * AliyunSmsService — US-067 阿里云短信通道（高优先级风控告警）
 *
 * 与 FeishuBotWebhookService / EmailNotificationService 完全镜像：
 *   1. **lazy-require @alicloud/dysmsapi20170525**：在第一次 send 时才加载 SDK，
 *      让本文件在 SDK 未安装的环境（CI / 单测前置 / 老版本 worktree）仍能
 *      import + typecheck，只有真正发短信时才报错 → 转入 fail-OPEN 分支。
 *   2. **DataSource 注入 buildSmsParams helper**：caller (RealtimeAlertDispatcher)
 *      传 `buildSmsParams(payload) → { signName, templateCode, templateParam }`
 *      函数，本 adapter 不知道告警 schema —— 只负责 dispatch + 错误处理 +
 *      fail-OPEN。与 FeishuBotWebhookService.sendDailyDigestCard 同款反向依赖避免范式。
 *   3. **阿里云配置 4 个 env**：ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET /
 *      ALIYUN_SMS_REGION (默认 cn-hangzhou) / ALIYUN_SMS_ENDPOINT (默认
 *      dysmsapi.aliyuncs.com)。`DISABLE_SMS_NOTIFICATION=true` 一键禁用
 *      (与 DISABLE_FEISHU_BOT_WEBHOOK / DISABLE_EMAIL_NOTIFICATION 同款)。
 *   4. **Client 缓存**：单进程内 client 只创建一次（每次 send 创建会有几百毫秒
 *      初始化延迟），但 env 变化时手动调 `resetSmsClient()` 清缓存。
 *   5. **fail-OPEN**：所有错误返回 `{success:false, message}`，不 throw —— 让
 *      RealtimeAlertDispatcher 不挂、上层 service 收到结果决定 status='failed' /
 *      'skipped' / 'partial'。
 *   6. **phone normalization**：去除 +86 / 86 / 各种分隔符，最终保留 11 位手机号
 *      给阿里云 SMS API（API 要求 PhoneNumbers 是逗号分隔的 11 位号码字符串）。
 */

import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

export interface AliyunSmsSendResult {
  success: boolean;
  /** 与 FeishuBotWebhookSendResult.skipped 同语义：not-an-error 但未发 */
  skipped?: boolean;
  message?: string;
  /** Aliyun BizId / RequestId / Code 等 */
  data?: any;
}

export interface SmsPayload {
  /** 短信签名（阿里云后台配的"签名"，e.g. "QuantX量化"） */
  signName: string;
  /** 短信模板 code（阿里云后台审核的 SMS_XXXX） */
  templateCode: string;
  /** 模板变量，会被 JSON.stringify 后传给阿里云 API */
  templateParam: Record<string, string>;
}

/** 第一次 send 前确定的 sms config snapshot —— 不在每次 send 时重读 env */
export interface AliyunSmsConfig {
  accessKeyId: string;
  accessKeySecret: string;
  region: string;
  endpoint: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 从 env 读取并 normalize 阿里云短信 config。任一必填字段缺失返回 null（caller fail-OPEN）。
 * - `ALIYUN_SMS_ACCESS_KEY_ID` / `ALIYUN_SMS_ACCESS_KEY_SECRET` 必填
 * - `ALIYUN_SMS_REGION` 默认 cn-hangzhou（阿里云短信主区域）
 * - `ALIYUN_SMS_ENDPOINT` 默认 dysmsapi.aliyuncs.com（公网端点）
 */
export function readAliyunSmsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): AliyunSmsConfig | null {
  const accessKeyId = safeString(env.ALIYUN_SMS_ACCESS_KEY_ID);
  const accessKeySecret = safeString(env.ALIYUN_SMS_ACCESS_KEY_SECRET);
  if (!accessKeyId || !accessKeySecret) return null;
  const region = safeString(env.ALIYUN_SMS_REGION) || 'cn-hangzhou';
  const endpoint = safeString(env.ALIYUN_SMS_ENDPOINT) || 'dysmsapi.aliyuncs.com';
  return { accessKeyId, accessKeySecret, region, endpoint };
}

/**
 * 是否禁用短信通知（DISABLE_SMS_NOTIFICATION=true 一键关闭）。
 */
export function isSmsDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolean(env.DISABLE_SMS_NOTIFICATION, false);
}

/**
 * 把任意手机号格式 normalize 成 11 位国内号（阿里云 SMS API 要求）。
 *   '+86 138-0013-8000' → '13800138000'
 *   '861380013800'      → '13800138000'（去 86 前缀，但只在剩 13 位时去）
 *   '13800138000'       → '13800138000'
 *   '+1 (415) 555-0100' → null（非 11 位国内号 → 拒）
 *
 * 严格保证返回值要么是 11 位首字符 1 的字符串，要么是 null。
 */
export function normalizeChinesePhone(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  let digits = input.replace(/[^0-9]/g, '');
  if (!digits) return null;
  // 去 +86 / 86 前缀
  if (digits.length === 13 && digits.startsWith('86')) {
    digits = digits.slice(2);
  } else if (digits.length === 14 && digits.startsWith('086')) {
    digits = digits.slice(3);
  }
  if (digits.length !== 11) return null;
  if (!digits.startsWith('1')) return null;
  return digits;
}

/**
 * 判定阿里云返回 code 是否成功 —— 'OK' = 真成功，其他都算失败（含 isv.* 业务错误）。
 */
export function isAliyunSuccessCode(code: any): boolean {
  if (!code) return false;
  return String(code).trim().toUpperCase() === 'OK';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeString(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function parseBoolean(v: any, fallback: boolean): boolean {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v === 'boolean') return v;
  const lower = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  return fallback;
}

// ---------------------------------------------------------------------------
// Client cache
// ---------------------------------------------------------------------------

/**
 * 单进程 sms client cache —— SDK 初始化 + TCP 握手 ~ 200ms，每次 send 都重建
 * 会显著增加告警分发延迟（一次告警 N 个用户 × 200ms）。
 */
let cachedClient: any = null;
let cachedConfigKey: string | null = null;

function configKey(cfg: AliyunSmsConfig): string {
  return `${cfg.accessKeyId}:${cfg.region}:${cfg.endpoint}`;
}

/**
 * 强制清缓存 —— env 变化（运维改 AK/SK）/ 测试需要重置时调。
 */
export function resetSmsClient(): void {
  cachedClient = null;
  cachedConfigKey = null;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * 阿里云短信 channel adapter。
 *
 * 与 FeishuBotWebhookService / EmailNotificationService 镜像：caller 注入
 * buildSmsParams helper 决定 signName / templateCode / templateParam；本 adapter
 * 不知道 caller schema —— 只负责短信 dispatch + 错误处理 + fail-OPEN。
 */
export class AliyunSmsService {
  /**
   * 是否启用短信通知（综合 env + SDK 是否可用）。
   */
  isEnabled(): boolean {
    if (isSmsDisabledByEnv()) return false;
    if (readAliyunSmsConfigFromEnv() === null) return false;
    return true;
  }

  /**
   * 发送 caller 构造好的短信 payload。
   *
   * @param payload caller 透传给 buildSmsParams 的输入（任何形态）；本方法不解析它
   * @param toPhone 接收方手机号（caller 必传 —— 通常来自 user.risk_config.notification_channels.sms.phone）
   * @param options.buildSmsParams caller 提供的 payload → SmsPayload 函数（必填）
   * @param options.smsConfigOverride 测试用 —— override env-derived sms config（生产不传）
   * @param options.clientOverride 测试用 —— inject sms-like client 完全脱 @alicloud 依赖
   */
  async sendSms(
    payload: any,
    toPhone: string,
    options: {
      buildSmsParams: (payload: any) => SmsPayload;
      smsConfigOverride?: AliyunSmsConfig;
      clientOverride?: { sendSms: (request: any) => Promise<any> };
    }
  ): Promise<AliyunSmsSendResult> {
    if (isSmsDisabledByEnv()) {
      return {
        success: false,
        skipped: true,
        message: '短信通知已通过环境变量禁用',
      };
    }
    const targetPhone = normalizeChinesePhone(safeString(toPhone));
    if (!targetPhone) {
      return {
        success: false,
        skipped: true,
        message: '接收人手机号为空或非 11 位国内号，已跳过短信推送',
      };
    }
    if (!options?.buildSmsParams || typeof options.buildSmsParams !== 'function') {
      return {
        success: false,
        message: 'sendSms 必须提供 options.buildSmsParams 以构造短信参数',
      };
    }
    if (!payload || typeof payload !== 'object') {
      return {
        success: false,
        message: '短信 payload 不能为空',
      };
    }

    let smsContent: SmsPayload;
    try {
      smsContent = options.buildSmsParams(payload);
    } catch (err: any) {
      logger.warn(`短信 buildSmsParams 异常: ${err?.message || err}`);
      return { success: false, message: `buildSmsParams 异常: ${err?.message || err}` };
    }
    if (
      !smsContent ||
      typeof smsContent.signName !== 'string' ||
      typeof smsContent.templateCode !== 'string' ||
      !smsContent.signName ||
      !smsContent.templateCode
    ) {
      return {
        success: false,
        message: 'buildSmsParams 返回的 SmsPayload 必须含非空 signName + templateCode',
      };
    }
    const templateParam =
      smsContent.templateParam && typeof smsContent.templateParam === 'object'
        ? smsContent.templateParam
        : {};

    const smsConfig = options.smsConfigOverride || readAliyunSmsConfigFromEnv();
    if (!smsConfig) {
      return {
        success: false,
        skipped: true,
        message:
          '未配置阿里云短信（缺少 ALIYUN_SMS_ACCESS_KEY_ID / ALIYUN_SMS_ACCESS_KEY_SECRET），已跳过短信推送',
      };
    }

    let client = options.clientOverride as any;
    if (!client) {
      try {
        client = getOrCreateClient(smsConfig);
      } catch (err: any) {
        const message = err?.message || String(err);
        logger.warn(`阿里云短信 SDK 创建失败 (@alicloud/dysmsapi20170525 不可用?): ${message}`);
        return {
          success: false,
          skipped: true,
          message: `阿里云短信 SDK 不可用：${message}`,
        };
      }
    }

    try {
      const sendRes = await client.sendSms({
        signName: smsContent.signName,
        templateCode: smsContent.templateCode,
        phoneNumbers: targetPhone,
        templateParam: JSON.stringify(templateParam),
      });
      // 阿里云 SDK 通常包一层 { body: { code, message, bizId, requestId } }
      const body = (sendRes && (sendRes.body || sendRes)) || {};
      const code = body.code ?? body.Code ?? body.statusCode;
      if (!isAliyunSuccessCode(code)) {
        const message =
          body.message || body.Message || body.msg || `阿里云短信发送失败: code=${code}`;
        logger.warn(
          `短信发送失败 (to=${targetPhone}, template=${smsContent.templateCode}): code=${code}, message=${message}`
        );
        return {
          success: false,
          message,
          data: {
            code,
            bizId: body.bizId || body.BizId,
            requestId: body.requestId || body.RequestId,
          },
        };
      }
      logger.info(
        `短信已发送 (to=${targetPhone}, template=${smsContent.templateCode}, bizId=${
          body.bizId || body.BizId || '?'
        })`
      );
      return {
        success: true,
        data: {
          code,
          bizId: body.bizId || body.BizId,
          requestId: body.requestId || body.RequestId,
        },
      };
    } catch (err: any) {
      const message = err?.message || String(err);
      logger.warn(`短信发送异常 (to=${targetPhone}): ${message}`);
      return { success: false, message };
    }
  }
}

/**
 * Lazy-require @alicloud/dysmsapi20170525 并返回 cached client。第一次 send 前才加载，
 * 让本文件在 SDK 未安装时仍可 typecheck/import。
 */
function getOrCreateClient(cfg: AliyunSmsConfig): any {
  const key = configKey(cfg);
  if (cachedClient && cachedConfigKey === key) {
    return cachedClient;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Dysmsapi20170525 = require('@alicloud/dysmsapi20170525');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const OpenApiClient = require('@alicloud/openapi-client');
  const Client = Dysmsapi20170525.default || Dysmsapi20170525;
  const ApiConfig = OpenApiClient.Config || OpenApiClient.default?.Config || OpenApiClient.default;
  const config = new ApiConfig({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    endpoint: cfg.endpoint,
    regionId: cfg.region,
  });
  const sdkClient = new Client(config);
  // 封一层：把 SDK 的 SendSmsRequest 包装隐藏起来，对外只暴露 sendSms({...})
  const wrapper = {
    async sendSms(req: {
      signName: string;
      templateCode: string;
      phoneNumbers: string;
      templateParam: string;
    }) {
      const SendSmsRequest =
        Dysmsapi20170525.SendSmsRequest || Dysmsapi20170525.default?.SendSmsRequest;
      const request = new SendSmsRequest({
        signName: req.signName,
        templateCode: req.templateCode,
        phoneNumbers: req.phoneNumbers,
        templateParam: req.templateParam,
      });
      return sdkClient.sendSms(request);
    },
  };
  cachedClient = wrapper;
  cachedConfigKey = key;
  return wrapper;
}

export const aliyunSmsService = new AliyunSmsService();
