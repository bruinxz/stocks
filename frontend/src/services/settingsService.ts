import api from './api';

/**
 * US-063 通知通道与日报配置前端 API 客户端。
 *
 * 调用 4 个后端端点（全部走 /api/settings 命名空间，与 /api/risk 平行）：
 *   - GET  /api/settings/notification-channels       → loadNotificationChannels()
 *   - POST /api/settings/notification-channels       → updateNotificationChannels(patch)
 *   - POST /api/settings/daily-digest/preview        → previewDailyDigest()
 *   - POST /api/settings/daily-digest/send           → sendDailyDigestNow()
 *
 * 数据形态对齐 backend DailyTradingDigestService.NotificationChannelsConfig
 * + SendDigestsResult。所有响应遵循统一信封 `{ success, data, message? }`，
 * service 层解出 `data` 直接返回。失败时 throw Error 让组件用 try/catch 捕获。
 */

// ---------- 配置数据形态 ---------------------------------------------------

export interface FeishuChannelConfig {
  enabled: boolean;
  webhook_url?: string;
  daily_digest: boolean;
  earnings_alert: boolean;
  risk_alert: boolean;
}

export interface EmailChannelConfig {
  enabled: boolean;
  address?: string;
  weekly_review: boolean;
  /** US-067 — 高优先级风控告警邮件订阅 */
  risk_alert: boolean;
}

export interface WeChatChannelConfig {
  enabled: boolean;
  openid?: string;
  /** US-066 — 绑定 scene_str（扫码事件 webhook 用） */
  bind_scene_str?: string;
  /** US-066 — 绑定时间 ISO；空 = 未绑定 */
  bound_at?: string;
  daily_digest: boolean;
  /** US-066 — 业绩预告即时提醒模板订阅 */
  earnings_alert: boolean;
  /** US-066 — 高优先级风控告警模板订阅 */
  risk_alert: boolean;
}

/** US-067 — 阿里云短信通道；用于 HIGH 级 RiskAlert 实时推送。 */
export interface SmsChannelConfig {
  enabled: boolean;
  /** 11 位国内手机号，前端展示时可加 +86 前缀 */
  phone?: string;
  /** 高优先级风控告警短信订阅；与 sms.enabled 同时为 true 才推送 */
  risk_alert: boolean;
}

export interface NotificationChannelsConfig {
  feishu: FeishuChannelConfig;
  email: EmailChannelConfig;
  wechat: WeChatChannelConfig;
  /** US-067 — 阿里云短信通道（高优先级风控告警） */
  sms: SmsChannelConfig;
}

export type NotificationChannelsPatch = Partial<{
  feishu: Partial<FeishuChannelConfig>;
  email: Partial<EmailChannelConfig>;
  wechat: Partial<WeChatChannelConfig>;
  sms: Partial<SmsChannelConfig>;
}>;

// ---------- 日报预览/发送结果（DigestForUserResult 的 frontend 视角） -------

export interface DigestTradeRow {
  symbol: string;
  name: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  execute_price: number;
  amount: number;
  realized_pnl?: number | null;
}

export interface DigestCandidateRow {
  symbol: string;
  name?: string | null;
  strategy: 'multi_factor' | 'dragon_head' | 'earnings_surprise' | string;
  score?: number | null;
  reason?: string | null;
}

export interface DigestPnLSummary {
  total_value: number;
  prev_total_value: number;
  pnl_today: number;
  pnl_today_pct: number | null;
  position_value: number;
  current_cash: number;
}

export interface DigestPayload {
  user_id: number;
  username: string;
  trade_date: string;
  pnl: DigestPnLSummary;
  trades_today_buy: DigestTradeRow[];
  trades_today_sell: DigestTradeRow[];
  trades_today_buy_count: number;
  trades_today_sell_count: number;
  candidates_tomorrow: DigestCandidateRow[];
}

export type DigestStatus = 'sent' | 'skipped' | 'failed' | 'partial';

export interface DigestForUserResult {
  digest_id: string;
  status: DigestStatus;
  sent: boolean;
  user_id: number;
  username: string;
  trade_date: string;
  payload?: DigestPayload;
  webhook_url_used?: string;
  webhook_response?: any;
  error?: string;
  skip_reason?: string;
}

export interface SendDigestsResult {
  trade_date: string;
  scanned_users: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  dry_run: boolean;
  per_user: DigestForUserResult[];
}

// ---------- API 调用 -------------------------------------------------------

export async function loadNotificationChannels(): Promise<NotificationChannelsConfig> {
  const res = await api.get('/settings/notification-channels');
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取通知通道配置失败');
  }
  return res.data.data as NotificationChannelsConfig;
}

export async function updateNotificationChannels(
  patch: NotificationChannelsPatch
): Promise<NotificationChannelsConfig> {
  const res = await api.post('/settings/notification-channels', patch);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '保存通知通道配置失败');
  }
  return res.data.data as NotificationChannelsConfig;
}

/**
 * dry_run 预演当前用户当日的日报 payload —— 不实际推 webhook，只返回 payload。
 * 让用户在 SettingsWorkspace 点 "预览今日日报" 即时验证 webhook URL + 配置正确。
 */
export async function previewDailyDigest(tradeDate?: string): Promise<SendDigestsResult> {
  const body = tradeDate ? { trade_date: tradeDate } : {};
  const res = await api.post('/settings/daily-digest/preview', body);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '预览日报失败');
  }
  return res.data.data as SendDigestsResult;
}

/**
 * 立即给当前用户发一次日报（非 dry_run），用于手动触发或冒烟测试。
 */
export async function sendDailyDigestNow(tradeDate?: string): Promise<SendDigestsResult> {
  const body = tradeDate ? { trade_date: tradeDate } : {};
  const res = await api.post('/settings/daily-digest/send', body);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '触发日报推送失败');
  }
  return res.data.data as SendDigestsResult;
}

// ---------- US-065 周报数据形态 ----------------------------------------------

export interface PrevWeekRange {
  start_date: string;
  end_date: string;
  week_id: string;
}

export interface WeeklyEquityPoint {
  date: string;
  total_value: number;
}

export interface IndustryContributionRow {
  industry: string;
  realized_pnl: number;
  trade_count: number;
  symbols: string[];
}

export interface SymbolContributionRow {
  symbol: string;
  name: string;
  industry: string | null;
  realized_pnl: number;
  trade_count: number;
}

export interface UpcomingEventRow {
  symbol: string;
  name: string;
  event_type: 'earnings_forecast' | 'earnings_report';
  detail: string;
  announce_date?: string | null;
}

export interface AIWeeklyOpinion {
  source: 'remote' | 'heuristic';
  headline: string;
  paragraphs: string[];
}

export interface WeeklyReviewPayload {
  user_id: number;
  username: string;
  week: PrevWeekRange;
  pnl: {
    start_value: number;
    end_value: number;
    pnl_amount: number;
    pnl_pct: number | null;
  };
  equity_curve: WeeklyEquityPoint[];
  industry_contribution: IndustryContributionRow[];
  top_winners: SymbolContributionRow[];
  top_losers: SymbolContributionRow[];
  trade_count: number;
  realized_pnl_total: number;
  upcoming_events: UpcomingEventRow[];
  ai_opinion: AIWeeklyOpinion;
}

export type WeeklyReviewStatus = 'sent' | 'skipped' | 'failed' | 'partial';

export interface WeeklyReviewForUserResult {
  report_id: string;
  status: WeeklyReviewStatus;
  sent: boolean;
  user_id: number;
  username: string;
  week: PrevWeekRange;
  payload?: WeeklyReviewPayload;
  email_used?: string;
  email_response?: any;
  error?: string;
  skip_reason?: string;
}

export interface SendWeeklyReviewResult {
  week: PrevWeekRange;
  scanned_users: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  dry_run: boolean;
  per_user: WeeklyReviewForUserResult[];
}

/**
 * US-065 — 更新邮件通道开关 / 接收地址 / weekly_review 开关。
 * US-067 — 扩展 risk_alert 字段：HIGH 级 RiskAlert 邮件订阅开关。
 */
export async function updateEmailConfig(patch: {
  enabled?: boolean;
  address?: string;
  weekly_review?: boolean;
  /** US-067 — 高优先级风控告警邮件订阅 */
  risk_alert?: boolean;
}): Promise<NotificationChannelsConfig> {
  const res = await api.post('/settings/email-config', patch);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '保存邮件通道配置失败');
  }
  return res.data.data as NotificationChannelsConfig;
}

/**
 * US-065 — dry_run 预演上周复盘邮件 payload，不实际发送。
 */
export async function previewWeeklyReview(
  referenceDate?: string,
  upcomingLookaheadDays?: number
): Promise<SendWeeklyReviewResult> {
  const body: any = {};
  if (referenceDate) body.reference_date = referenceDate;
  if (upcomingLookaheadDays !== undefined) body.upcoming_lookahead_days = upcomingLookaheadDays;
  const res = await api.post('/settings/weekly-review/preview', body);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '预览周报失败');
  }
  return res.data.data as SendWeeklyReviewResult;
}

/**
 * US-065 — 立即给当前用户发一封上周复盘邮件（非 dry_run）。
 */
export async function sendWeeklyReviewNow(
  referenceDate?: string,
  upcomingLookaheadDays?: number
): Promise<SendWeeklyReviewResult> {
  const body: any = {};
  if (referenceDate) body.reference_date = referenceDate;
  if (upcomingLookaheadDays !== undefined) body.upcoming_lookahead_days = upcomingLookaheadDays;
  const res = await api.post('/settings/weekly-review/send', body);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '触发周报推送失败');
  }
  return res.data.data as SendWeeklyReviewResult;
}

// ---------- US-066 微信公众号绑定与配置 ------------------------------------

export interface WeChatBindQrCodeResult {
  bind_id: string;
  user_id: number;
  scene_str: string;
  /** showqrcode 接口直链，前端 <img src="..."> 直接可显示 */
  qrcode_image_url: string;
  /** 用户扫码跳转的 url；showqrcode 已包含图片本身，正常不用 */
  qrcode_url: string;
  ticket: string;
  expire_seconds: number;
  /** ISO 字符串，过期时刻；前端展示倒计时 */
  expire_at: string;
  /** 当前 user 已绑定的 openid（若已绑定）；前端展示提示已重新生成 */
  current_openid?: string;
  current_bound_at?: string;
}

export interface WeChatBindConfirmResult {
  bound: boolean;
  bind_id: string;
  user_id: number;
  scene_str: string;
  openid?: string;
  bound_at?: string;
  message?: string;
}

export type WeChatTestKind = 'daily_digest' | 'earnings_alert' | 'risk_alert';

export interface WeChatSendResult {
  message_id: string;
  status: 'sent' | 'skipped' | 'failed';
  sent: boolean;
  user_id: number;
  template_kind: string;
  template_id?: string;
  openid?: string;
  message?: string;
  skip_reason?: string;
  error?: string;
  response?: any;
}

/**
 * US-066 — 生成微信公众号参数二维码 + 落 scene_str 到用户 wechat config。
 * 后端调 weixin qrcode/create 接口拿 ticket 与跳转 url，前端拿到 qrcode_image_url
 * 后用 <img> 直接显示让用户扫码 → 关注公众号 → 后端 webhook 写入 openid → 前端
 * 轮询 confirmWeChatBind 看到 bound:true。
 */
export async function getWeChatBindQrCode(): Promise<WeChatBindQrCodeResult> {
  const res = await api.get('/settings/wechat-bind-qrcode');
  if (!res.data?.success) {
    throw new Error(res.data?.message || '生成微信绑定二维码失败');
  }
  return res.data.data as WeChatBindQrCodeResult;
}

/**
 * US-066 — 轮询确认微信绑定状态。
 * 前端展示二维码后每 3 秒轮询一次，bound:true 关闭轮询并刷新 notification-channels。
 *
 * @param sceneStr 可选 —— 传入后端会与最近一次生成的 scene_str 比对，不匹配返回提示
 */
export async function confirmWeChatBind(sceneStr?: string): Promise<WeChatBindConfirmResult> {
  const body: any = {};
  if (sceneStr) body.scene_str = sceneStr;
  const res = await api.post('/settings/wechat-bind-confirm', body);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '确认微信绑定状态失败');
  }
  return res.data.data as WeChatBindConfirmResult;
}

/**
 * US-066 — 更新当前用户的 wechat 通道 4 个开关。
 * Body: { enabled?, daily_digest?, earnings_alert?, risk_alert? }
 */
export async function updateWeChatConfig(patch: {
  enabled?: boolean;
  daily_digest?: boolean;
  earnings_alert?: boolean;
  risk_alert?: boolean;
}): Promise<NotificationChannelsConfig> {
  const res = await api.post('/settings/wechat-config', patch);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '保存微信通道配置失败');
  }
  return res.data.data as NotificationChannelsConfig;
}

/**
 * US-066 — 解除微信绑定（清空 openid / bind_scene_str / bound_at；保留 enabled / 各开关）。
 */
export async function unbindWeChat(): Promise<NotificationChannelsConfig> {
  const res = await api.post('/settings/wechat-unbind', {});
  if (!res.data?.success) {
    throw new Error(res.data?.message || '解除微信绑定失败');
  }
  return res.data.data as NotificationChannelsConfig;
}

/**
 * US-066 — 给当前用户发一条测试订阅消息（冒烟测试 access_token + template_id + openid 是否畅通）。
 * @param kind 模板类型，缺省 daily_digest
 * @param dryRun 不真发，只返回组装好的 data 字段供 UI 预览
 */
export async function sendWeChatTestMessage(
  kind: WeChatTestKind = 'daily_digest',
  dryRun = false
): Promise<WeChatSendResult> {
  const res = await api.post('/settings/wechat-test', { template_kind: kind, dry_run: dryRun });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '发送测试微信消息失败');
  }
  return res.data.data as WeChatSendResult;
}

// ---------- US-067 阿里云短信通道 (实时风控 webhook) -----------------------

/**
 * US-067 — 一条 channel 在 dispatcher 里的派发结果（与后端
 * RealtimeAlertChannelResult 对齐；前端只展示 status / message）。
 */
export interface RealtimeAlertChannelResult {
  channel: 'feishu' | 'email' | 'sms';
  status: 'sent' | 'skipped' | 'failed' | 'partial';
  sent: boolean;
  message?: string;
  data?: any;
}

/**
 * US-067 — dispatcher.dispatch 返回结果（对齐后端
 * RealtimeAlertDispatchResult）。`channels` 列出 3 个通道（feishu/email/sms）
 * 各自的派发状态；`status` 是 3 通道整体汇总（sent / skipped / failed / partial）。
 */
export interface RealtimeAlertDispatchResult {
  alert_id_dispatch: string;
  user_id: number;
  symbol: string;
  level: string;
  rule_id: string;
  signature: string;
  status: 'sent' | 'skipped' | 'failed' | 'partial';
  sent_any: boolean;
  dry_run: boolean;
  deduped: boolean;
  channels: RealtimeAlertChannelResult[];
  skip_reason?: string;
}

/**
 * US-067 — 更新当前用户的 SMS 通道配置（与 updateEmailConfig / updateWeChatConfig
 * 同款 sub-resource 范式）。Body 接受 3 字段：`enabled` / `phone` / `risk_alert`。
 */
export async function updateSmsConfig(patch: {
  enabled?: boolean;
  phone?: string;
  risk_alert?: boolean;
}): Promise<NotificationChannelsConfig> {
  const res = await api.post('/settings/sms-config', patch);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '保存 SMS 通道配置失败');
  }
  return res.data.data as NotificationChannelsConfig;
}

/**
 * US-067 — 给当前用户冒烟测试一条 HIGH 风控告警；3 channel 全派
 * (feishu/email/sms)。`dryRun=true`（默认）只返回 payload 不真发，让用户反复测试
 * 不触发 30 min dedup。
 */
export async function sendRealtimeAlertTest(
  dryRun = true,
  message?: string
): Promise<RealtimeAlertDispatchResult> {
  const body: any = { dry_run: dryRun };
  if (typeof message === 'string' && message.trim()) {
    body.message = message.trim();
  }
  const res = await api.post('/settings/sms-test', body);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '发送测试实时告警失败');
  }
  return res.data.data as RealtimeAlertDispatchResult;
}

// ---------- US-080 推送渠道矩阵视图 ----------------------------------------

/**
 * US-080 — 事件类型 ↔ 渠道矩阵的事件 / 渠道 enum。
 *   - daily_digest: 当日交易日报 (15:30 飞书 + 微信)
 *   - earnings_alert: 业绩预告即时提醒 (持仓股 / 自选股)
 *   - risk_alert: HIGH 级风控告警 (实时多通道)
 *   - weekly_review: 上周复盘报告 (周一 08:00 邮件)
 */
export type NotificationEventKey =
  | 'daily_digest'
  | 'earnings_alert'
  | 'risk_alert'
  | 'weekly_review';

export type NotificationChannelKey = 'feishu' | 'email' | 'wechat' | 'sms';

export interface NotificationMatrixCell {
  /** 该 (event, channel) 组合是否受架构支持；false → UI 渲染为 "—"，PUT 时被忽略 */
  applicable: boolean;
  /** 该格当前是否启用 = (channel.enabled) && (channel.<event_field>) */
  enabled: boolean;
}

export interface NotificationConfigMatrixView {
  channels: {
    feishu: { enabled: boolean; webhook_url: string; configured: boolean };
    email: { enabled: boolean; address: string; configured: boolean };
    wechat: {
      enabled: boolean;
      openid: string;
      bound_at: string;
      bound: boolean;
    };
    sms: { enabled: boolean; phone: string; configured: boolean };
  };
  matrix: Record<NotificationEventKey, Record<NotificationChannelKey, NotificationMatrixCell>>;
  raw: NotificationChannelsConfig;
}

/**
 * US-080 — PUT /api/settings/notification-config 请求 body。
 *
 * 两份 patch 可同时存在：
 *   - `matrix_updates` 矩阵反向 patch（事件订阅开关）；
 *   - `channels_updates` 顶部 3 个 Card 的单字段同步（webhook_url / address /
 *     channel.enabled 等）。
 *
 * 后端合并后走 dailyTradingDigestService.updateNotificationConfig，与 POST
 * /notification-channels 完全等价。
 */
export interface NotificationConfigMatrixPatch {
  matrix_updates?: Partial<
    Record<NotificationEventKey, Partial<Record<NotificationChannelKey, boolean>>>
  >;
  channels_updates?: Partial<{
    feishu: Partial<FeishuChannelConfig>;
    email: Partial<EmailChannelConfig>;
    wechat: Partial<WeChatChannelConfig>;
    sms: Partial<SmsChannelConfig>;
  }>;
}

/**
 * US-080 — 拉取推送渠道矩阵视图（GET /api/settings/notification-config）。
 */
export async function loadNotificationConfig(): Promise<NotificationConfigMatrixView> {
  const res = await api.get('/settings/notification-config');
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取推送渠道配置失败');
  }
  return res.data.data as NotificationConfigMatrixView;
}

/**
 * US-080 — 推送渠道批量保存（PUT /api/settings/notification-config）。
 * 支持矩阵开关 + 单字段同步同时传入；返回最新矩阵视图供前端 setView。
 */
export async function updateNotificationConfig(
  patch: NotificationConfigMatrixPatch
): Promise<NotificationConfigMatrixView> {
  const res = await api.put('/settings/notification-config', patch);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '保存推送渠道配置失败');
  }
  return res.data.data as NotificationConfigMatrixView;
}

const settingsService = {
  loadNotificationChannels,
  updateNotificationChannels,
  loadNotificationConfig,
  updateNotificationConfig,
  updateEmailConfig,
  previewDailyDigest,
  sendDailyDigestNow,
  previewWeeklyReview,
  sendWeeklyReviewNow,
  getWeChatBindQrCode,
  confirmWeChatBind,
  updateWeChatConfig,
  unbindWeChat,
  sendWeChatTestMessage,
  updateSmsConfig,
  sendRealtimeAlertTest,
};

export default settingsService;
