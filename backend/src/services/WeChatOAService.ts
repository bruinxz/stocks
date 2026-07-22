/**
 * WeChatOAService — US-066 微信公众号（服务号）订阅消息通道
 *
 * 负责把"微信公众号"这条 channel 接入到与飞书 / 邮件平级的通知体系中。AC：
 *   - 封装服务号 API（access_token 管理）—— 委托 WeChatOAClient
 *   - 支持订阅消息模板：每日日报、业绩预告提醒、风控告警 3 种
 *   - 用户扫码绑定（生成参数二维码 → 关注公众号 → 后端识别 SCAN 事件并绑定）
 *   - endpoints: GET /api/settings/wechat-bind-qrcode, POST /api/settings/wechat-bind-confirm
 *
 * 设计要点：
 *   1. **复用 NotificationChannelsConfig.wechat namespace**（与 feishu / email 并列）
 *      —— 扩展 4 个新字段 (bind_scene_str / bound_at / earnings_alert / risk_alert)；
 *      由 normalizeNotificationConfig 统一规整。
 *   2. **绑定流程双 endpoint** —— GET wechat-bind-qrcode 生成参数二维码 + scene_str
 *      并持久化到 user.wechat.bind_scene_str（让 webhook SCAN 事件反查）；
 *      POST wechat-bind-confirm 由前端轮询调用 → 检查 wechat.openid 是否已被
 *      webhook 填好（同一 user 不允许 openid 漂移）→ 返回 bound:true/false。
 *   3. **3 类订阅消息模板**（template_id 由公众号后台后台申请，配置到 env）：
 *        - WECHAT_TEMPLATE_DAILY_DIGEST       —— 当日交易日报
 *        - WECHAT_TEMPLATE_EARNINGS_FORECAST  —— 业绩预告即时提醒
 *        - WECHAT_TEMPLATE_RISK_ALERT         —— 高风险告警
 *      每模板由独立 sendXxx() method，filed 名固定（与公众号后台模板 1:1 对应）。
 *   4. **fail-OPEN + 注入式 DataSource** —— 测试用 fake DataSource 完全脱 DB / 微信
 *      网络，与 EarningsForecastWatcher / WeeklyReviewReportService 镜像。
 *   5. **业务 ID `WECHAT-{user_id}-{path}-{YYYYMMDD}-{rand4}`** —— 与 US-064/065 一致
 *      命名范式；path = DIGEST / EARN / RISK / BIND 区分 4 路径。
 */

import moment from 'moment-timezone';

import { logger } from '../utils/logger';
import { randHex4 } from '../utils/randomHex';
import { User } from '../models/User';
import { dailyTradingDigestService } from './DailyTradingDigestService';
import type { NotificationChannelsConfig, DigestPayload } from './DailyTradingDigestService';
import {
  weChatOAClient,
  WeChatOAClient,
  WeChatQrCodeResult,
  WeChatSendResult,
  WeChatSubscribeMessageData,
  buildBindSceneStr,
  parseBindSceneStr,
  isValidOpenId,
} from './WeChatOAClient';
import {
  normalizeNotificationConfig,
  DEFAULT_NOTIFICATION_CONFIG,
} from './DailyTradingDigestService';

// ---------------------------------------------------------------------------
// 类型常量
// ---------------------------------------------------------------------------

/** 4 类微信消息 path —— ID + dedup namespace 用 */
export const WECHAT_MESSAGE_PATHS = Object.freeze({
  BIND: 'BIND',
  DIGEST: 'DIGEST',
  EARN: 'EARN',
  RISK: 'RISK',
} as const);
export type WeChatMessagePath = (typeof WECHAT_MESSAGE_PATHS)[keyof typeof WECHAT_MESSAGE_PATHS];

/** 3 类订阅消息模板 env 名 */
export const WECHAT_TEMPLATE_ENV = Object.freeze({
  DAILY_DIGEST: 'WECHAT_TEMPLATE_DAILY_DIGEST',
  EARNINGS_FORECAST: 'WECHAT_TEMPLATE_EARNINGS_FORECAST',
  RISK_ALERT: 'WECHAT_TEMPLATE_RISK_ALERT',
} as const);
export type WeChatTemplateKind = (typeof WECHAT_TEMPLATE_ENV)[keyof typeof WECHAT_TEMPLATE_ENV];

export interface BindQrCodeResult {
  bind_id: string;
  user_id: number;
  scene_str: string;
  qrcode_url: string;
  qrcode_image_url: string;
  expire_seconds: number;
  expire_at: string;
  ticket: string;
  /** 当前 user 已绑定的 openid（若已绑定）；调用方可决定是否覆盖 */
  current_openid?: string;
  current_bound_at?: string;
}

export interface BindConfirmResult {
  /** 是否已成功绑定（openid 已通过 webhook 写入 user.wechat.openid） */
  bound: boolean;
  bind_id: string;
  user_id: number;
  scene_str: string;
  openid?: string;
  bound_at?: string;
  message?: string;
}

export interface SendWeChatResult {
  message_id: string;
  status: 'sent' | 'skipped' | 'failed';
  sent: boolean;
  user_id: number;
  template_kind: WeChatTemplateKind;
  template_id?: string;
  openid?: string;
  message?: string;
  skip_reason?: string;
  error?: string;
  /** wechat 远端 response data */
  response?: any;
}

export interface SendDailyDigestOptions {
  user_id: number;
  payload: DigestPayload;
  /** 点击消息跳转 url，可选；默认 frontend_base_url + /workspace/portfolio */
  url?: string;
  /** 不实际发，dry_run 让 UI 预演 */
  dry_run?: boolean;
}

export interface EarningsForecastShortPayload {
  symbol: string;
  name: string;
  /** 预告类型如 '预增' / '扭亏' */
  forecast_type: string;
  /** 净利润变化区间格式化字符串，如 '+50.0% ~ +80.0%' / '≥ +50.0%' / '—' */
  profit_change_text: string;
  /** 报告期 e.g. '2026Q1' / '2026-03-31' */
  report_period: string;
  /** announce_date YYYY-MM-DD */
  announce_date: string;
}

export interface SendEarningsForecastOptions {
  user_id: number;
  payload: EarningsForecastShortPayload;
  /** 点击消息跳转 url（建议带 deeplink 到个股 AI 解读页） */
  url?: string;
  dry_run?: boolean;
}

export interface RiskAlertShortPayload {
  /** 告警等级，影响 first.value 颜色 */
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  /** 告警标题，e.g. '持仓个股触发熔断' */
  title: string;
  /** 一句简短描述 */
  detail: string;
  /** 触发时间 ISO 字符串 */
  triggered_at: string;
  /** 相关 symbol（可空） */
  symbol?: string;
}

export interface SendRiskAlertOptions {
  user_id: number;
  payload: RiskAlertShortPayload;
  url?: string;
  dry_run?: boolean;
}

// ---------------------------------------------------------------------------
// DataSource 接口（注入式）
// ---------------------------------------------------------------------------

export interface WeChatOADataSource {
  /** 取当前 user 的 normalized config */
  loadUserConfig(user_id: number): Promise<{
    username: string;
    config: NotificationChannelsConfig;
  } | null>;
  /** 保存绑定 scene_str（生成 QR 后立即落库，让 webhook SCAN 事件反查 user） */
  saveBindSceneStr(user_id: number, scene_str: string): Promise<void>;
  /** 取 user 当前 wechat 配置（仅含 openid + bound_at），让 confirm 端点轮询 */
  loadWeChatBindState(user_id: number): Promise<{
    openid: string;
    bind_scene_str: string;
    bound_at: string;
  } | null>;
  /**
   * webhook 收到 SCAN 事件后调用：scene_str → user_id；落 openid 到 user.wechat。
   * 失败 throw（webhook handler 转 500 让微信重试）。
   */
  applyBindResult(input: { user_id: number; openid: string; bound_at: string }): Promise<void>;
  /** dispatch 微信 subscribe message（注入 client，让单测 mock） */
  sendSubscribeMessage(input: {
    toUser: string;
    templateId: string;
    data: WeChatSubscribeMessageData;
    url?: string;
  }): Promise<WeChatSendResult>;
  /** 生成参数二维码（注入 client，让单测 mock） */
  createQrCode(sceneStr: string, expireSeconds?: number): Promise<WeChatQrCodeResult>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 判定本 user 在指定 template kind 下是否应发送微信订阅消息：
 *   wechat.enabled && wechat.openid 非空 && 对应模板开关 (daily_digest /
 *   earnings_alert / risk_alert) 为 true
 */
export function shouldSendWeChatForUser(
  config: NotificationChannelsConfig,
  kind: WeChatTemplateKind
): { shouldSend: boolean; reason?: string } {
  if (!config.wechat.enabled) {
    return { shouldSend: false, reason: 'wechat 通道未启用' };
  }
  if (!safeString(config.wechat.openid)) {
    return { shouldSend: false, reason: '未完成微信绑定（缺少 openid）' };
  }
  if (kind === WECHAT_TEMPLATE_ENV.DAILY_DIGEST && !config.wechat.daily_digest) {
    return { shouldSend: false, reason: '用户已关闭 wechat 当日日报' };
  }
  if (kind === WECHAT_TEMPLATE_ENV.EARNINGS_FORECAST && !config.wechat.earnings_alert) {
    return { shouldSend: false, reason: '用户已关闭 wechat 业绩预告提醒' };
  }
  if (kind === WECHAT_TEMPLATE_ENV.RISK_ALERT && !config.wechat.risk_alert) {
    return { shouldSend: false, reason: '用户已关闭 wechat 风控告警' };
  }
  return { shouldSend: true };
}

/**
 * 取指定模板 id（env 配置）。未配置返回空字符串，caller 走 skipped 分支。
 */
export function resolveTemplateId(
  kind: WeChatTemplateKind,
  env: NodeJS.ProcessEnv = process.env
): string {
  const raw = env[kind];
  return safeString(raw);
}

/**
 * 构造业务 ID `WECHAT-{user_id}-{path}-{YYYYMMDD}-{rand4}`，命名范式与 US-055 / US-063
 * / US-064 / US-065 一致。
 */
export function buildWeChatMessageId(
  user_id: number,
  path: WeChatMessagePath,
  options: { date?: string; rand4Provider?: () => string } = {}
): string {
  if (!Number.isInteger(user_id) || user_id <= 0) {
    throw new Error(`buildWeChatMessageId: invalid user_id=${user_id}`);
  }
  const dateStr =
    options.date && /^\d{8}$/.test(options.date)
      ? options.date
      : moment().tz('Asia/Shanghai').format('YYYYMMDD');
  const rand4 = options.rand4Provider ? options.rand4Provider() : randHex4();
  return `WECHAT-${user_id}-${path}-${dateStr}-${rand4}`;
}

/**
 * 当日日报 → 订阅消息 data 字段。
 *
 * 字段名约定（与公众号后台模板 1:1）：
 *   first       — 标题行（"📊 ZH-YYYY-MM-DD 当日交易日报"）
 *   keyword1    — 当日盈亏 (e.g. "+1,234.56 (+0.85%)")
 *   keyword2    — 买入笔数（"2 笔"）
 *   keyword3    — 卖出笔数（"1 笔"）
 *   keyword4    — 闭环成交数
 *   remark      — 备注（"点击查看完整日报"）
 *
 * 颜色：盈利绿 / 亏损红 / 平 灰，与 buildDigestCard 一致语义。
 */
export function buildDailyDigestSubscribeData(payload: DigestPayload): WeChatSubscribeMessageData {
  const pnl = payload.pnl;
  const pct = pnl.pnl_today_pct;
  let pnlText = `${formatSignedMoney(pnl.pnl_today)}`;
  if (pct !== null && pct !== undefined && Number.isFinite(pct)) {
    pnlText += ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  }
  const pnlColor = pnl.pnl_today > 0 ? '#3f8600' : pnl.pnl_today < 0 ? '#cf1322' : '#666666';
  return {
    first: {
      value: `📊 ${payload.trade_date} 当日交易日报\n`,
      color: '#333333',
    },
    keyword1: { value: pnlText, color: pnlColor },
    keyword2: { value: `${payload.trades_today_buy_count} 笔`, color: '#333333' },
    keyword3: { value: `${payload.trades_today_sell_count} 笔`, color: '#333333' },
    keyword4: {
      value: `${payload.trades_today_buy_count + payload.trades_today_sell_count} 笔闭环成交`,
      color: '#333333',
    },
    remark: {
      value: '\n点击查看完整日报与持仓明细 →',
      color: '#999999',
    },
  };
}

/**
 * 业绩预告即时提醒 → 订阅消息 data 字段。
 *
 * 字段名约定：
 *   first       — "🔔 业绩预告"
 *   keyword1    — 股票代码 + 名称
 *   keyword2    — 预告类型 + 净利润变化区间
 *   keyword3    — 报告期
 *   keyword4    — 公告日期
 *   remark      — "点击查看 AI 解读"
 */
export function buildEarningsForecastSubscribeData(
  payload: EarningsForecastShortPayload
): WeChatSubscribeMessageData {
  // 类型颜色：预增/扭亏/续盈 → 绿，预减/首亏/续亏 → 红，其他 → 灰
  const type = safeString(payload.forecast_type);
  const goodTypes = ['预增', '扭亏', '续盈', '略增'];
  const badTypes = ['预减', '首亏', '续亏', '略减'];
  const typeColor = goodTypes.includes(type)
    ? '#3f8600'
    : badTypes.includes(type)
    ? '#cf1322'
    : '#666666';
  return {
    first: { value: `🔔 业绩预告即时提醒\n`, color: '#333333' },
    keyword1: { value: `${payload.symbol} ${payload.name}`, color: '#1677ff' },
    keyword2: {
      value: `${type}  ${payload.profit_change_text}`,
      color: typeColor,
    },
    keyword3: { value: safeString(payload.report_period) || '—', color: '#333333' },
    keyword4: { value: safeString(payload.announce_date) || '—', color: '#333333' },
    remark: {
      value: '\n点击查看 AI 技术面解读与一致预期对比 →',
      color: '#999999',
    },
  };
}

/**
 * 高风险告警 → 订阅消息 data 字段。
 *
 * 字段名约定：
 *   first       — 标题行（"⚠️ 高风险告警"）
 *   keyword1    — 告警等级（HIGH 红 / MEDIUM 橙 / LOW 灰）
 *   keyword2    — 标题
 *   keyword3    — 触发时间
 *   keyword4    — 相关 symbol（可空 → "—"）
 *   remark      — 详细描述
 */
export function buildRiskAlertSubscribeData(
  payload: RiskAlertShortPayload
): WeChatSubscribeMessageData {
  const level = (payload.level || 'LOW').toUpperCase();
  const levelColor = level === 'HIGH' ? '#cf1322' : level === 'MEDIUM' ? '#fa8c16' : '#999999';
  return {
    first: { value: `⚠️ 风控告警\n`, color: '#333333' },
    keyword1: { value: `${level} 级`, color: levelColor },
    keyword2: { value: safeString(payload.title) || '风控告警', color: '#333333' },
    keyword3: { value: safeString(payload.triggered_at) || '—', color: '#333333' },
    keyword4: { value: safeString(payload.symbol) || '—', color: '#333333' },
    remark: {
      value: `\n${safeString(payload.detail) || '点击查看详情 →'}`,
      color: '#999999',
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeString(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function formatSignedMoney(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return `${sign}${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ---------------------------------------------------------------------------
// Default DataSource impl (Sequelize / WeChatOAClient 真实远端)
// ---------------------------------------------------------------------------

export class DefaultWeChatOADataSource implements WeChatOADataSource {
  private readonly client: WeChatOAClient;

  constructor(options?: { client?: WeChatOAClient }) {
    this.client = options?.client || weChatOAClient;
  }

  async loadUserConfig(
    user_id: number
  ): Promise<{ username: string; config: NotificationChannelsConfig } | null> {
    const user = await User.findByPk(user_id, {
      attributes: ['id', 'username', 'risk_config'],
      raw: true,
    });
    if (!user) return null;
    return {
      username: (user as any).username || '',
      config: normalizeNotificationConfig((user as any).risk_config),
    };
  }

  async saveBindSceneStr(user_id: number, scene_str: string): Promise<void> {
    const user = await User.findByPk(user_id);
    if (!user) throw new Error('用户不存在');
    const existing = normalizeNotificationConfig((user as any).risk_config);
    const nextWechat = { ...existing.wechat, bind_scene_str: scene_str };
    const next: NotificationChannelsConfig = {
      feishu: { ...existing.feishu },
      email: { ...existing.email },
      wechat: nextWechat,
      sms: { ...existing.sms },
    };
    const normalized = normalizeNotificationConfig({ notification_channels: next });
    const rc =
      (user as any).risk_config && typeof (user as any).risk_config === 'object'
        ? { ...(user as any).risk_config }
        : {};
    rc.notification_channels = normalized;
    (user as any).risk_config = rc;
    user.changed('risk_config', true);
    await user.save();
  }

  async loadWeChatBindState(user_id: number): Promise<{
    openid: string;
    bind_scene_str: string;
    bound_at: string;
  } | null> {
    const user = await User.findByPk(user_id, {
      attributes: ['risk_config'],
      raw: true,
    });
    if (!user) return null;
    const config = normalizeNotificationConfig((user as any).risk_config);
    return {
      openid: safeString(config.wechat.openid),
      bind_scene_str: safeString(config.wechat.bind_scene_str),
      bound_at: safeString(config.wechat.bound_at),
    };
  }

  async applyBindResult(input: {
    user_id: number;
    openid: string;
    bound_at: string;
  }): Promise<void> {
    const user = await User.findByPk(input.user_id);
    if (!user) throw new Error('用户不存在');
    const existing = normalizeNotificationConfig((user as any).risk_config);
    const nextWechat = {
      ...existing.wechat,
      enabled: true,
      openid: input.openid,
      bound_at: input.bound_at,
    };
    const next: NotificationChannelsConfig = {
      feishu: { ...existing.feishu },
      email: { ...existing.email },
      wechat: nextWechat,
      sms: { ...existing.sms },
    };
    const normalized = normalizeNotificationConfig({ notification_channels: next });
    const rc =
      (user as any).risk_config && typeof (user as any).risk_config === 'object'
        ? { ...(user as any).risk_config }
        : {};
    rc.notification_channels = normalized;
    (user as any).risk_config = rc;
    user.changed('risk_config', true);
    await user.save();
  }

  async sendSubscribeMessage(input: {
    toUser: string;
    templateId: string;
    data: WeChatSubscribeMessageData;
    url?: string;
  }): Promise<WeChatSendResult> {
    return this.client.sendSubscribeMessage(input);
  }

  async createQrCode(sceneStr: string, expireSeconds?: number): Promise<WeChatQrCodeResult> {
    return this.client.createQrCode(sceneStr, expireSeconds);
  }
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

/**
 * WeChatOAService —— 与 EarningsForecastWatcher / WeeklyReviewReportService 同款
 * service shape：DataSource 注入 + per-template send method + 业务 ID + fail-OPEN。
 */
export class WeChatOAService {
  private dataSource: WeChatOADataSource;

  constructor(options: { dataSource?: WeChatOADataSource } = {}) {
    this.dataSource = options.dataSource || new DefaultWeChatOADataSource();
  }

  /**
   * 测试用 —— 在 service 创建后切换 dataSource（与 EarningsForecastWatcher 同模式）。
   */
  setDataSource(ds: WeChatOADataSource): void {
    this.dataSource = ds;
  }

  /**
   * GET /api/settings/wechat-bind-qrcode endpoint 后端逻辑：
   *   1. 校验 user 存在
   *   2. buildBindSceneStr(user_id) 生成 scene_str
   *   3. 调 client.createQrCode(scene_str) 拿 ticket + 二维码 url
   *   4. 持久化 scene_str 到 user.risk_config.notification_channels.wechat.bind_scene_str
   *      让 webhook SCAN 事件反查 user
   *   5. 返回 BindQrCodeResult（带 qrcode_image_url 让前端直接 <img> 显示）
   *
   * @param user_id 当前登录用户
   * @param options.expireSeconds 二维码有效期（默认 30 天 = 2592000s）
   * @param options.rand6Provider 测试用注入随机数 provider
   */
  async getBindQrCode(
    user_id: number,
    options: { expireSeconds?: number; rand6Provider?: () => string } = {}
  ): Promise<BindQrCodeResult> {
    if (!Number.isInteger(user_id) || user_id <= 0) {
      throw new Error('user_id 必填且必须为正整数');
    }
    const userInfo = await this.dataSource.loadUserConfig(user_id);
    if (!userInfo) throw new Error('用户不存在');

    const sceneStr = buildBindSceneStr(user_id, options.rand6Provider);
    const expireSeconds = options.expireSeconds || 2592000;
    const qrRes = await this.dataSource.createQrCode(sceneStr, expireSeconds);
    if (!qrRes.success || !qrRes.ticket) {
      throw new Error(qrRes.message || '微信二维码生成失败');
    }
    await this.dataSource.saveBindSceneStr(user_id, sceneStr);
    const expireAt = moment()
      .tz('Asia/Shanghai')
      .add(qrRes.expire_seconds || expireSeconds, 'seconds')
      .toISOString();
    const bindId = buildWeChatMessageId(user_id, WECHAT_MESSAGE_PATHS.BIND);
    return {
      bind_id: bindId,
      user_id,
      scene_str: sceneStr,
      qrcode_url: qrRes.url || '',
      qrcode_image_url: qrRes.qrcode_image_url || '',
      expire_seconds: qrRes.expire_seconds || expireSeconds,
      expire_at: expireAt,
      ticket: qrRes.ticket,
      current_openid: safeString(userInfo.config.wechat.openid),
      current_bound_at: safeString(userInfo.config.wechat.bound_at),
    };
  }

  /**
   * POST /api/settings/wechat-bind-confirm endpoint 后端逻辑：
   *   前端轮询调用，检查当前 user 的 wechat.openid 是否已被 webhook SCAN 事件填好。
   *
   *   - bound:true → 返回最新 openid + bound_at（前端关闭轮询）
   *   - bound:false → 返回提示，前端等下次轮询
   *
   * 这是 polling 端点而非 webhook 推送端点（webhook 由 WechatEventController 处理；
   * 本端点只是给前端 UI 做"绑定结果可见性"）。
   */
  async confirmBind(user_id: number, sceneStr?: string): Promise<BindConfirmResult> {
    if (!Number.isInteger(user_id) || user_id <= 0) {
      throw new Error('user_id 必填且必须为正整数');
    }
    const state = await this.dataSource.loadWeChatBindState(user_id);
    if (!state) {
      return {
        bound: false,
        bind_id: buildWeChatMessageId(user_id, WECHAT_MESSAGE_PATHS.BIND),
        user_id,
        scene_str: safeString(sceneStr),
        message: '用户不存在',
      };
    }
    const matched =
      !sceneStr ||
      !safeString(sceneStr) ||
      safeString(state.bind_scene_str) === safeString(sceneStr);
    if (!matched) {
      return {
        bound: false,
        bind_id: buildWeChatMessageId(user_id, WECHAT_MESSAGE_PATHS.BIND),
        user_id,
        scene_str: safeString(sceneStr),
        message: 'scene_str 与最新一次生成的二维码不匹配，请重新扫码',
      };
    }
    if (state.openid && state.bound_at) {
      return {
        bound: true,
        bind_id: buildWeChatMessageId(user_id, WECHAT_MESSAGE_PATHS.BIND),
        user_id,
        scene_str: state.bind_scene_str,
        openid: state.openid,
        bound_at: state.bound_at,
        message: '已成功绑定',
      };
    }
    return {
      bound: false,
      bind_id: buildWeChatMessageId(user_id, WECHAT_MESSAGE_PATHS.BIND),
      user_id,
      scene_str: state.bind_scene_str,
      message: '尚未检测到扫码事件，请扫码并关注公众号',
    };
  }

  /**
   * Webhook 端：微信 SCAN 事件回传时调用，落 openid → user 映射。
   *
   * @param sceneStr 微信传回的 EventKey 字段（去掉 qrscene_ 前缀后）
   * @param openid   微信传回的 FromUserName
   * @param eventAt  事件发生时间 ISO（可选，缺省 = 当前服务器时间）
   *
   * @returns 绑定的 user_id；scene_str 无法解析时 throw（webhook handler 决定是否
   *          回 success 让微信不重试）。
   */
  async handleBindEventFromWebhook(input: {
    sceneStr: string;
    openid: string;
    eventAt?: string;
  }): Promise<{ user_id: number; bound_at: string }> {
    const parsed = parseBindSceneStr(input.sceneStr);
    if (!parsed) {
      throw new Error(`无法解析 scene_str：${input.sceneStr}`);
    }
    if (!isValidOpenId(input.openid)) {
      throw new Error(`openid 格式非法：${input.openid}`);
    }
    const boundAt = input.eventAt || new Date().toISOString();
    await this.dataSource.applyBindResult({
      user_id: parsed.user_id,
      openid: input.openid,
      bound_at: boundAt,
    });
    return { user_id: parsed.user_id, bound_at: boundAt };
  }

  /**
   * 发送当日交易日报订阅消息。
   *
   * 调用方（DailyTradingDigestService.sendDigests）已根据 feishu 主通道发送完毕后，
   * 对所有 user 同时启用 wechat.daily_digest 的用户再调用本 method 发一份微信消息。
   * 多通道并发 fan-out 是 caller 责任。
   */
  async sendDailyDigest(options: SendDailyDigestOptions): Promise<SendWeChatResult> {
    return this.sendByTemplate(
      WECHAT_TEMPLATE_ENV.DAILY_DIGEST,
      WECHAT_MESSAGE_PATHS.DIGEST,
      options.user_id,
      () => ({
        data: buildDailyDigestSubscribeData(options.payload),
        url: safeString(options.url),
      }),
      options.dry_run
    );
  }

  /**
   * 发送业绩预告即时提醒订阅消息。
   * 调用方：EarningsForecastWatcher.scanHeldStocks fan-out 同时启用 wechat
   * earnings_alert 的用户。
   */
  async sendEarningsForecast(options: SendEarningsForecastOptions): Promise<SendWeChatResult> {
    return this.sendByTemplate(
      WECHAT_TEMPLATE_ENV.EARNINGS_FORECAST,
      WECHAT_MESSAGE_PATHS.EARN,
      options.user_id,
      () => ({
        data: buildEarningsForecastSubscribeData(options.payload),
        url: safeString(options.url),
      }),
      options.dry_run
    );
  }

  /**
   * 发送高风控告警订阅消息。
   * 调用方：未来 US-067 RealtimeRiskWebhook 或 BlackSwanWatchdog fan-out。
   */
  async sendRiskAlert(options: SendRiskAlertOptions): Promise<SendWeChatResult> {
    return this.sendByTemplate(
      WECHAT_TEMPLATE_ENV.RISK_ALERT,
      WECHAT_MESSAGE_PATHS.RISK,
      options.user_id,
      () => ({
        data: buildRiskAlertSubscribeData(options.payload),
        url: safeString(options.url),
      }),
      options.dry_run
    );
  }

  // -------------------------------------------------------------------------
  // 私有 helpers
  // -------------------------------------------------------------------------

  /**
   * 公共 3 路径共享的 send 主流程：
   *   (1) 取 template_id；(2) 取 user.wechat 配置 + openid；(3) shouldSend gate；
   *   (4) dry_run 直接返回；(5) 调 sendSubscribeMessage；(6) 包成 SendWeChatResult。
   */
  private async sendByTemplate(
    kind: WeChatTemplateKind,
    path: WeChatMessagePath,
    user_id: number,
    buildPayload: (config: NotificationChannelsConfig) => {
      data: WeChatSubscribeMessageData;
      url?: string;
    },
    dryRun: boolean | undefined
  ): Promise<SendWeChatResult> {
    const messageId = buildWeChatMessageId(user_id, path);
    const templateId = resolveTemplateId(kind);
    if (!templateId) {
      return {
        message_id: messageId,
        status: 'skipped',
        sent: false,
        user_id,
        template_kind: kind,
        skip_reason: `未配置 ${kind} 模板 id（env ${kind}）`,
      };
    }
    const userInfo = await this.dataSource.loadUserConfig(user_id);
    if (!userInfo) {
      return {
        message_id: messageId,
        status: 'failed',
        sent: false,
        user_id,
        template_kind: kind,
        template_id: templateId,
        error: '用户不存在',
      };
    }
    const gate = shouldSendWeChatForUser(userInfo.config, kind);
    if (!gate.shouldSend) {
      return {
        message_id: messageId,
        status: 'skipped',
        sent: false,
        user_id,
        template_kind: kind,
        template_id: templateId,
        openid: safeString(userInfo.config.wechat.openid),
        skip_reason: gate.reason,
      };
    }
    const openid = safeString(userInfo.config.wechat.openid);
    let built: { data: WeChatSubscribeMessageData; url?: string };
    try {
      built = buildPayload(userInfo.config);
    } catch (err: any) {
      logger.warn(`微信订阅消息 buildPayload 异常 (kind=${kind}, user=${user_id}): ${err}`);
      return {
        message_id: messageId,
        status: 'failed',
        sent: false,
        user_id,
        template_kind: kind,
        template_id: templateId,
        openid,
        error: err?.message || String(err),
      };
    }
    if (dryRun) {
      return {
        message_id: messageId,
        status: 'skipped',
        sent: false,
        user_id,
        template_kind: kind,
        template_id: templateId,
        openid,
        skip_reason: 'dry_run',
        response: { dry_run_data: built.data, dry_run_url: built.url },
      };
    }
    const sendRes = await this.dataSource.sendSubscribeMessage({
      toUser: openid,
      templateId,
      data: built.data,
      url: built.url,
    });
    if (sendRes.success) {
      return {
        message_id: messageId,
        status: 'sent',
        sent: true,
        user_id,
        template_kind: kind,
        template_id: templateId,
        openid,
        response: sendRes.data,
      };
    }
    if (sendRes.skipped) {
      return {
        message_id: messageId,
        status: 'skipped',
        sent: false,
        user_id,
        template_kind: kind,
        template_id: templateId,
        openid,
        skip_reason: sendRes.message,
      };
    }
    return {
      message_id: messageId,
      status: 'failed',
      sent: false,
      user_id,
      template_kind: kind,
      template_id: templateId,
      openid,
      error: sendRes.message,
      response: sendRes.data,
    };
  }

  /**
   * PATCH endpoint 用：更新 wechat 通道 enabled / daily_digest / earnings_alert /
   * risk_alert 4 开关（openid / bind_scene_str / bound_at 不可手动改，靠 webhook
   * 写入）。
   */
  async updateWeChatConfig(
    user_id: number,
    patch: Partial<{
      enabled: boolean;
      daily_digest: boolean;
      earnings_alert: boolean;
      risk_alert: boolean;
    }>
  ): Promise<NotificationChannelsConfig> {
    const user = await User.findByPk(user_id);
    if (!user) throw new Error('用户不存在');
    const existing = normalizeNotificationConfig((user as any).risk_config);
    const nextWechat = { ...existing.wechat };
    if (patch.enabled !== undefined) nextWechat.enabled = !!patch.enabled;
    if (patch.daily_digest !== undefined) nextWechat.daily_digest = !!patch.daily_digest;
    if (patch.earnings_alert !== undefined) nextWechat.earnings_alert = !!patch.earnings_alert;
    if (patch.risk_alert !== undefined) nextWechat.risk_alert = !!patch.risk_alert;
    const next: NotificationChannelsConfig = {
      feishu: { ...existing.feishu },
      email: { ...existing.email },
      wechat: nextWechat,
      sms: { ...existing.sms },
    };
    const normalized = normalizeNotificationConfig({ notification_channels: next });
    const rc =
      (user as any).risk_config && typeof (user as any).risk_config === 'object'
        ? { ...(user as any).risk_config }
        : {};
    rc.notification_channels = normalized;
    (user as any).risk_config = rc;
    user.changed('risk_config', true);
    await user.save();
    return normalized;
  }

  /**
   * 解除绑定 —— 把 wechat.openid / bind_scene_str / bound_at 清空，但保留 enabled /
   * 各类 alert 开关（让用户改主意时重新扫码绑定即可继续接收）。
   */
  async unbindWeChat(user_id: number): Promise<NotificationChannelsConfig> {
    const user = await User.findByPk(user_id);
    if (!user) throw new Error('用户不存在');
    const existing = normalizeNotificationConfig((user as any).risk_config);
    const nextWechat = {
      ...existing.wechat,
      openid: '',
      bind_scene_str: '',
      bound_at: '',
    };
    const next: NotificationChannelsConfig = {
      feishu: { ...existing.feishu },
      email: { ...existing.email },
      wechat: nextWechat,
      sms: { ...existing.sms },
    };
    const normalized = normalizeNotificationConfig({ notification_channels: next });
    const rc =
      (user as any).risk_config && typeof (user as any).risk_config === 'object'
        ? { ...(user as any).risk_config }
        : {};
    rc.notification_channels = normalized;
    (user as any).risk_config = rc;
    user.changed('risk_config', true);
    await user.save();
    return normalized;
  }
}

export const weChatOAService = new WeChatOAService();
// 占位避免 DEFAULT_NOTIFICATION_CONFIG / dailyTradingDigestService unused import 警告
void DEFAULT_NOTIFICATION_CONFIG;
void dailyTradingDigestService;
