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
}

export interface WeChatChannelConfig {
  enabled: boolean;
  openid?: string;
  daily_digest: boolean;
}

export interface NotificationChannelsConfig {
  feishu: FeishuChannelConfig;
  email: EmailChannelConfig;
  wechat: WeChatChannelConfig;
}

export type NotificationChannelsPatch = Partial<{
  feishu: Partial<FeishuChannelConfig>;
  email: Partial<EmailChannelConfig>;
  wechat: Partial<WeChatChannelConfig>;
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

const settingsService = {
  loadNotificationChannels,
  updateNotificationChannels,
  previewDailyDigest,
  sendDailyDigestNow,
};

export default settingsService;
