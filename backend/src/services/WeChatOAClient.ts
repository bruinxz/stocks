/**
 * WeChatOAClient — US-066 微信公众号（服务号）API 封装
 *
 * 与 FeishuBotWebhookService / EmailNotificationService 镜像的 channel adapter，
 * 但对接的是「微信公众平台开放接口」(api.weixin.qq.com)。
 *
 * 设计要点：
 *   1. **access_token 缓存 2 小时 TTL** —— 微信 access_token 官方 7200s 有效期，
 *      并发 / 频繁调用同一接口必须复用同一 token；提前 5 分钟刷新（120 - 5 = 115min
 *      重新拉取）避免边界 race。
 *   2. **fail-OPEN 一致语义** —— 与 FeishuBotWebhookService.sendDailyDigestCard
 *      相同：失败返回 `{success:false, message}`，不 throw。让 scheduler / batch
 *      场景一个用户的微信发送失败不挂整批。
 *   3. **DISABLE_WECHAT_OA=true 一键禁用** + 缺 APPID/APPSECRET 时也走 skipped 而非
 *      error（与 DISABLE_FEISHU_BOT_WEBHOOK / DISABLE_EMAIL_NOTIFICATION 同款）。
 *   4. **生成参数二维码** —— 走 qrcode/create 接口：scene_str 自定义场景值，user
 *      关注 + 扫码触发 push 事件 (event=SCAN，由 WechatEventController/webhook 处理
 *      并落 user→openid 映射)。微信限制 scene_str 64 字符以内 + 30 天有效。
 *   5. **订阅通知模板（subscribe_message）** —— message/subscribe/send 接口；3 类
 *      模板 (daily_digest / earnings_alert / risk_alert) 由 caller 传 template_id +
 *      data 字段。本 client 只负责 dispatch + 错误处理。模板 id 由公众号后台后台
 *      申请，配置在 env (WECHAT_TEMPLATE_DAILY_DIGEST / _EARNINGS_FORECAST /
 *      _RISK_ALERT)。
 *   6. **重试 access_token 失效** —— errcode=40001 (invalid credential / token 过期)
 *      或 40014 (invalid token) 时 invalidate cache → 重新拉一次 → 最多 1 次重试。
 *
 * 5 个 env config：
 *   - WECHAT_OA_APPID                       公众号 AppID（必填）
 *   - WECHAT_OA_APPSECRET                   公众号 AppSecret（必填）
 *   - WECHAT_OA_API_BASE                    可选，默认 https://api.weixin.qq.com
 *   - WECHAT_OA_TIMEOUT_MS                  可选，默认 10000
 *   - DISABLE_WECHAT_OA                     可选，true 一键禁用
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';
import { randomAlphaNonce } from '../utils/randomNonce';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export interface WeChatOAConfig {
  appId: string;
  appSecret: string;
  apiBase: string;
  timeoutMs: number;
}

export interface WeChatSendResult {
  success: boolean;
  /** not-an-error but未发；与 FeishuBotWebhookSendResult.skipped 同语义 */
  skipped?: boolean;
  message?: string;
  /** 微信返回 body 原始数据（含 errcode/errmsg/msgid） */
  data?: any;
}

export interface WeChatQrCodeResult {
  success: boolean;
  skipped?: boolean;
  message?: string;
  /** 用户扫码的 url；前端拿到这个 url 后用 qr.js 之类渲染二维码图（避免后端 PNG 二进制传输） */
  url?: string;
  /** 微信侧 ticket（最终扫码图也可以走 showqrcode?ticket=xxx 接口拉 PNG）*/
  ticket?: string;
  /** 二维码 PNG 直链（showqrcode 接口；前端 <img> 可直接用） */
  qrcode_image_url?: string;
  /** 二维码有效期（秒），微信默认 30 天 = 2592000 秒 */
  expire_seconds?: number;
  /** scene_str 回传给 caller，让 caller 落库 user_id ↔ scene 映射 */
  scene_str?: string;
  /** 微信返回原始 body */
  raw?: any;
}

/**
 * 订阅消息 data 字段格式 —— { key: { value: string, color?: string } }
 * caller 决定字段名（与公众号后台模板字段一一对应）。
 */
export type WeChatSubscribeMessageData = Record<string, { value: string; color?: string }>;

export interface SendSubscribeMessageInput {
  /** 接收消息的用户 openid */
  toUser: string;
  /** 公众号后台申请的模板 id */
  templateId: string;
  /** 模板字段数据 */
  data: WeChatSubscribeMessageData;
  /** 点击消息后跳转的 url（小程序则用 miniprogram.appid + page） */
  url?: string;
  /** 跳转小程序，与 url 二选一 */
  miniprogram?: { appid: string; pagepath?: string };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 从 env 读取并 normalize 微信公众号 config。
 * 任一必填字段缺失返回 null（caller fail-OPEN）。
 */
export function readWeChatOAConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WeChatOAConfig | null {
  const appId = safeString(env.WECHAT_OA_APPID);
  const appSecret = safeString(env.WECHAT_OA_APPSECRET);
  if (!appId || !appSecret) return null;
  const apiBase = safeString(env.WECHAT_OA_API_BASE) || 'https://api.weixin.qq.com';
  const timeoutMs = parsePositiveIntOrDefault(env.WECHAT_OA_TIMEOUT_MS, 10000);
  return { appId, appSecret, apiBase, timeoutMs };
}

/**
 * 是否禁用微信公众号通道（DISABLE_WECHAT_OA=true 一键关闭）。
 */
export function isWeChatOADisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return parseBoolean(env.DISABLE_WECHAT_OA, false);
}

/**
 * 校验 openid 形态 —— 微信 openid 长度通常 28 字符，仅 letters/digits/_ /-。
 * 严格校验避免一个非法字符串调用 send 接口浪费一次远端调用。
 */
export function isValidOpenId(openid: string): boolean {
  if (!openid || typeof openid !== 'string') return false;
  const trimmed = openid.trim();
  if (trimmed.length < 10 || trimmed.length > 64) return false;
  // 微信 openid 由 ASCII letters/digits/-/_ 组成
  return /^[A-Za-z0-9_-]+$/.test(trimmed);
}

/**
 * 校验 scene_str —— 微信限制 1-64 chars, 仅 ASCII letters/digits/_/-/!；
 * 不能含特殊字符（否则 qrcode/create 直接 40169 错误）。
 */
export function isValidSceneStr(sceneStr: string): boolean {
  if (!sceneStr || typeof sceneStr !== 'string') return false;
  const trimmed = sceneStr.trim();
  if (trimmed.length < 1 || trimmed.length > 64) return false;
  return /^[A-Za-z0-9_\-!.]+$/.test(trimmed);
}

/**
 * 给用户生成专属 scene_str（参数二维码的「场景值」），让微信扫码 push 事件回传时
 * 服务端能反查到是哪个 user 在绑定。格式：`bind-{user_id}-{rand6}`。
 *
 * `user_id` 必须为正整数；`rand6Provider` 可注入用于单测确定性。
 */
export function buildBindSceneStr(user_id: number, rand6Provider?: () => string): string {
  if (!Number.isInteger(user_id) || user_id <= 0) {
    throw new Error(`buildBindSceneStr: invalid user_id=${user_id}`);
  }
  const rand6 = rand6Provider ? rand6Provider() : defaultRand6();
  return `bind-${user_id}-${rand6}`;
}

/**
 * 反解 scene_str 取 user_id（绑定事件 webhook 收到 SCAN 事件时反查用户）。
 * 非 bind- 前缀 / 非整数 user_id / 长度不符 → 返回 null。
 */
export function parseBindSceneStr(sceneStr: string): { user_id: number; rand6: string } | null {
  if (!sceneStr || typeof sceneStr !== 'string') return null;
  const m = sceneStr.match(/^bind-(\d+)-([A-Za-z0-9]{4,8})$/);
  if (!m) return null;
  const uid = Number(m[1]);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  return { user_id: uid, rand6: m[2] };
}

/**
 * 给 access_token 缓存计算下次刷新时间 —— 微信默认 7200s，提前 5 分钟刷新避免边界。
 */
export function computeTokenExpireAt(expiresIn: number, nowMs: number = Date.now()): number {
  const safe = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200;
  // 提前 5 分钟刷新 → 留 buffer
  const expireMs = (safe - 300) * 1000;
  return nowMs + Math.max(expireMs, 60_000); // 至少留 1 分钟
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

function parsePositiveIntOrDefault(v: any, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function defaultRand6(): string {
  // 6 位 0-9A-Z 随机，避免与 user_id（数字）混淆
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return randomAlphaNonce(6, chars);
}

// ---------------------------------------------------------------------------
// access_token cache（单进程）
// ---------------------------------------------------------------------------

interface CachedToken {
  appId: string;
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/**
 * 强制清空 access_token 缓存 —— 收到 errcode=40001/40014 / env 切换时调用。
 */
export function resetWeChatAccessToken(): void {
  cachedToken = null;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * 微信公众号 API 封装。
 *
 * 与 FeishuBotWebhookService 同款 fail-OPEN 范式 —— send 接口返回结果对象不 throw，
 * 由 caller 决定 status='failed' / 'skipped'。
 */
export class WeChatOAClient {
  private readonly http: AxiosInstance;
  /** 测试用 inject —— 让单测完全脱离网络 */
  private accessTokenProvider?: () => Promise<string>;

  constructor(options?: { http?: AxiosInstance; accessTokenProvider?: () => Promise<string> }) {
    this.http =
      options?.http ||
      axios.create({
        timeout: 10000,
      });
    this.accessTokenProvider = options?.accessTokenProvider;
  }

  /**
   * 是否启用微信公众号通道（综合 env 检查 + DISABLE_WECHAT_OA flag）。
   */
  isEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    if (isWeChatOADisabledByEnv(env)) return false;
    if (readWeChatOAConfigFromEnv(env) === null) return false;
    return true;
  }

  /**
   * 取 access_token —— 优先用缓存，过期 / 缺失才远端拉。
   *
   * @throws 任何拉取失败均 throw，让 caller 转 fail-OPEN（caller 已有 try/catch）。
   */
  async getAccessToken(configOverride?: WeChatOAConfig): Promise<string> {
    if (this.accessTokenProvider) {
      return this.accessTokenProvider();
    }
    const cfg = configOverride || readWeChatOAConfigFromEnv();
    if (!cfg) {
      throw new Error('未配置微信公众号（缺少 WECHAT_OA_APPID / WECHAT_OA_APPSECRET）');
    }
    if (cachedToken && cachedToken.appId === cfg.appId && cachedToken.expiresAt > Date.now()) {
      return cachedToken.token;
    }
    const url = `${
      cfg.apiBase
    }/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
      cfg.appId
    )}&secret=${encodeURIComponent(cfg.appSecret)}`;
    const res = await this.http.get(url, { timeout: cfg.timeoutMs });
    const body = res?.data || {};
    if (!body.access_token) {
      throw new Error(
        `微信 access_token 获取失败：errcode=${body.errcode || '?'}, errmsg=${body.errmsg || '?'}`
      );
    }
    cachedToken = {
      appId: cfg.appId,
      token: String(body.access_token),
      expiresAt: computeTokenExpireAt(Number(body.expires_in)),
    };
    return cachedToken.token;
  }

  /**
   * 生成参数二维码（永久不限 / 临时 30 天可选；本系统统一用临时 30 天，让用户绑定后续约
   * 期可主动废弃，且 scene_str 字符串自由）。
   *
   * @param sceneStr 自定义场景值（必须通过 isValidSceneStr 校验）
   * @param expireSeconds 二维码有效期，默认 30 天 = 2592000s（微信最大值）
   */
  async createQrCode(sceneStr: string, expireSeconds = 2592000): Promise<WeChatQrCodeResult> {
    if (isWeChatOADisabledByEnv()) {
      return { success: false, skipped: true, message: '微信公众号通道已通过环境变量禁用' };
    }
    if (!isValidSceneStr(sceneStr)) {
      return { success: false, message: `scene_str 格式非法：${sceneStr}` };
    }
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err: any) {
      const message = err?.message || String(err);
      logger.warn(`微信二维码生成失败 (access_token): ${message}`);
      return { success: false, skipped: true, message };
    }
    const cfg = readWeChatOAConfigFromEnv();
    const base = cfg?.apiBase || 'https://api.weixin.qq.com';
    const url = `${base}/cgi-bin/qrcode/create?access_token=${encodeURIComponent(token)}`;
    const body = {
      expire_seconds: expireSeconds,
      action_name: 'QR_STR_SCENE', // 临时 字符串 scene
      action_info: {
        scene: { scene_str: sceneStr },
      },
    };
    try {
      const res = await this.http.post(url, body, { timeout: cfg?.timeoutMs || 10000 });
      const data = res?.data || {};
      if (data.errcode && Number(data.errcode) !== 0) {
        // 40001 / 40014: invalid token → 重试一次
        if ([40001, 40014].includes(Number(data.errcode))) {
          resetWeChatAccessToken();
          return await this.createQrCodeInternalRetry(sceneStr, expireSeconds);
        }
        return {
          success: false,
          message: `微信二维码生成失败：errcode=${data.errcode}, errmsg=${data.errmsg || '?'}`,
          raw: data,
        };
      }
      const ticket = String(data.ticket || '');
      if (!ticket) {
        return { success: false, message: '微信二维码生成失败：缺少 ticket', raw: data };
      }
      return {
        success: true,
        ticket,
        url: String(data.url || ''),
        qrcode_image_url: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(
          ticket
        )}`,
        expire_seconds: Number(data.expire_seconds) || expireSeconds,
        scene_str: sceneStr,
        raw: data,
      };
    } catch (err: any) {
      const message = err?.response?.data?.errmsg || err?.message || '微信二维码请求异常';
      logger.warn(`微信二维码请求异常: ${message}`);
      return { success: false, message };
    }
  }

  /** 私有 —— invalid token 时单次重试，避免 stack 递归 */
  private async createQrCodeInternalRetry(
    sceneStr: string,
    expireSeconds: number
  ): Promise<WeChatQrCodeResult> {
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err: any) {
      return { success: false, skipped: true, message: err?.message || String(err) };
    }
    const cfg = readWeChatOAConfigFromEnv();
    const base = cfg?.apiBase || 'https://api.weixin.qq.com';
    const url = `${base}/cgi-bin/qrcode/create?access_token=${encodeURIComponent(token)}`;
    const body = {
      expire_seconds: expireSeconds,
      action_name: 'QR_STR_SCENE',
      action_info: { scene: { scene_str: sceneStr } },
    };
    try {
      const res = await this.http.post(url, body, { timeout: cfg?.timeoutMs || 10000 });
      const data = res?.data || {};
      if (data.errcode && Number(data.errcode) !== 0) {
        return {
          success: false,
          message: `微信二维码重试失败：errcode=${data.errcode}, errmsg=${data.errmsg || '?'}`,
          raw: data,
        };
      }
      const ticket = String(data.ticket || '');
      if (!ticket) {
        return { success: false, message: '微信二维码重试失败：缺少 ticket', raw: data };
      }
      return {
        success: true,
        ticket,
        url: String(data.url || ''),
        qrcode_image_url: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(
          ticket
        )}`,
        expire_seconds: Number(data.expire_seconds) || expireSeconds,
        scene_str: sceneStr,
        raw: data,
      };
    } catch (err: any) {
      const message = err?.response?.data?.errmsg || err?.message || '微信二维码重试异常';
      return { success: false, message };
    }
  }

  /**
   * 发送订阅消息（subscribe_message/send）。
   *
   * 调用方 (WeChatOAService) 决定 templateId + data + url。本 client 只负责
   * dispatch + 错误处理 + token 失效重试。
   */
  async sendSubscribeMessage(input: SendSubscribeMessageInput): Promise<WeChatSendResult> {
    if (isWeChatOADisabledByEnv()) {
      return { success: false, skipped: true, message: '微信公众号通道已通过环境变量禁用' };
    }
    if (!isValidOpenId(input?.toUser)) {
      return { success: false, message: `toUser openid 格式非法：${input?.toUser}` };
    }
    if (!input.templateId || typeof input.templateId !== 'string') {
      return { success: false, message: 'templateId 必填' };
    }
    if (!input.data || typeof input.data !== 'object') {
      return { success: false, message: 'data 必须为对象' };
    }
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err: any) {
      const message = err?.message || String(err);
      logger.warn(`微信订阅消息发送失败 (access_token): ${message}`);
      return { success: false, skipped: true, message };
    }
    return await this.sendSubscribeInternal(token, input, /* canRetry */ true);
  }

  private async sendSubscribeInternal(
    token: string,
    input: SendSubscribeMessageInput,
    canRetry: boolean
  ): Promise<WeChatSendResult> {
    const cfg = readWeChatOAConfigFromEnv();
    const base = cfg?.apiBase || 'https://api.weixin.qq.com';
    const url = `${base}/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(token)}`;
    const body: any = {
      touser: input.toUser,
      template_id: input.templateId,
      data: input.data,
    };
    if (input.url) body.url = input.url;
    if (input.miniprogram) body.miniprogram = input.miniprogram;
    try {
      const res = await this.http.post(url, body, { timeout: cfg?.timeoutMs || 10000 });
      const data = res?.data || {};
      const code = Number(data.errcode || 0);
      if (code === 0) {
        return { success: true, data };
      }
      // token 失效 → 重试一次
      if ([40001, 40014].includes(code) && canRetry) {
        resetWeChatAccessToken();
        try {
          const newToken = await this.getAccessToken();
          return await this.sendSubscribeInternal(newToken, input, /* canRetry */ false);
        } catch (err: any) {
          return {
            success: false,
            skipped: true,
            message: `重新获取 access_token 失败：${err?.message || err}`,
          };
        }
      }
      return {
        success: false,
        message: `微信订阅消息发送失败：errcode=${code}, errmsg=${data.errmsg || '?'}`,
        data,
      };
    } catch (err: any) {
      const message = err?.response?.data?.errmsg || err?.message || '微信订阅消息请求异常';
      logger.warn(`微信订阅消息请求异常 (touser=${input.toUser}): ${message}`);
      return { success: false, message };
    }
  }
}

export const weChatOAClient = new WeChatOAClient();
