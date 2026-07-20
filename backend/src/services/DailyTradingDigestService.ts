/**
 * DailyTradingDigestService — US-063 飞书机器人当日交易日报
 *
 * 每个交易日 15:30（收盘后 30 分钟）聚合：
 *   1. 账户当日盈亏（绝对 + 百分比，对比昨日 snapshot）
 *   2. 新增 N 笔买入（前 3 只详情）
 *   3. 新增 M 笔卖出（前 3 只详情）
 *   4. 明日 3 个策略（MultiFactorAlpha / DragonHead / EarningsSurprise）候选 top 5
 *
 * 然后通过 FeishuBotWebhookService.sendDailyDigestCard() 发送 interactive card 到
 * 该用户的 webhook URL（存在 `User.risk_config.notification_channels.feishu.webhook_url`）。
 *
 * 设计遵循 US-055 引入的 6 项 AI/通知 service checklist（progress.txt 已记录）：
 *  (1) DataSource 接口注入（DailyTradingDigestDataSource + Default impl + PRODUCTION singleton）
 *  (2) 7+ 个 export 纯函数（normalizeNotificationConfig / pickTopTrades / buildPnLLine /
 *      formatCandidateLine / buildDigestCard / pickTopCandidates / formatPercent / formatMoney /
 *      shouldSendForUser / buildDigestId / computePnLSummary）
 *  (3) plain-object 返回类型（DigestForUserResult、SendDigestsResult、sent: boolean 字段）
 *  (4) status='partial'/'failed'/'sent' 仍正常返回让 caller 看到——AI/Feishu 调用昂贵
 *  (5) fail-OPEN on send 失败：service 返回 `sent=false + error` 不 throw，让 scheduler 不挂
 *  (6) 双重防御 try/catch：DataSource 实现层 catch + service 顶层再 catch
 *
 * 与 US-047+ 复用：notification config 落在 `User.risk_config.notification_channels` JSONB
 * namespace（与 position_limits / trailing_stop / drawdown_breaker 并列），共用 JSONB 列免去新表。
 */

import { Op } from 'sequelize';
import moment from 'moment-timezone';

import { logger } from '../utils/logger';
import { randHex4 } from '../utils/randomHex';
import { User } from '../models/User';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { Stock } from '../models/Stock';
import { feishuBotWebhookService, FeishuBotWebhookSendResult } from './FeishuBotWebhookService';
import { AUTONOMOUS_PORTFOLIO_NAME } from '../portfolio/internal/PaperTradingPortfolioFamilies';

// ---------------------------------------------------------------------------
// 类型常量
// ---------------------------------------------------------------------------

export const DIGEST_STATUS = Object.freeze({
  SENT: 'sent',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  PARTIAL: 'partial',
} as const);

export type DigestStatus = (typeof DIGEST_STATUS)[keyof typeof DIGEST_STATUS];

export const DEFAULT_TOP_TRADES = 3;
export const DEFAULT_TOP_CANDIDATES = 5;
export const MAX_TOP_TRADES = 10;
export const MAX_TOP_CANDIDATES = 20;

/**
 * 通知 channel 配置（feishu / email / wechat / sms）— 当前 US-063 只用 feishu.daily_digest。
 * Email / WeChat / SMS 留给未来 US-065 / US-066 / US-067 同 namespace 扩展。
 */
export interface NotificationChannelsConfig {
  feishu: {
    enabled: boolean;
    /** 用户自定义 webhook URL（缺省时退回到环境变量 FEISHU_BOT_WEBHOOK / FEISHU_RECOMMENDATION_BOT_WEBHOOK） */
    webhook_url?: string;
    daily_digest: boolean;
    earnings_alert: boolean;
    risk_alert: boolean;
    /**
     * PR-D (2026-06-29) — 个股利好/利空关键公告事件 (持仓 / 自选股
     * critical 公告 — 由 CriticalAnnouncementPushService 处理).
     * 默认开 (与既有 risk_alert / earnings_alert 同款 opt-out 行为).
     */
    stock_bullish_event: boolean;
  };
  email: {
    enabled: boolean;
    address?: string;
    weekly_review: boolean;
    /** US-067 — 高优先级风控告警邮件订阅 */
    risk_alert: boolean;
    /**
     * PR-D (2026-06-29) — 个股利好/利空关键公告事件邮件订阅. 默认关 (邮件
     * 通道默认全关, 用户主动启用).
     */
    stock_bullish_event: boolean;
  };
  wechat: {
    enabled: boolean;
    openid?: string;
    /** US-066 — 绑定时生成的 scene_str (`bind-{user_id}-{rand6}`)，扫码事件回调时反查用户 */
    bind_scene_str?: string;
    /** US-066 — 绑定时间 ISO 字符串；空 = 未绑定 */
    bound_at?: string;
    daily_digest: boolean;
    /** US-066 — 业绩预告即时提醒模板订阅 */
    earnings_alert: boolean;
    /** US-066 — 高优先级风控告警模板订阅 */
    risk_alert: boolean;
  };
  sms: {
    /** US-067 — SMS 通道总开关（即使配置了手机号，关 = 不发） */
    enabled: boolean;
    /** US-067 — 接收短信的手机号（仅支持 +86 / 11 位国内号） */
    phone?: string;
    /** US-067 — 高优先级风控告警短信订阅 */
    risk_alert: boolean;
  };
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationChannelsConfig = Object.freeze({
  feishu: {
    enabled: true,
    webhook_url: '',
    daily_digest: true,
    earnings_alert: true,
    risk_alert: true,
    stock_bullish_event: true,
  },
  email: {
    enabled: false,
    address: '',
    weekly_review: false,
    risk_alert: false,
    stock_bullish_event: false,
  },
  wechat: {
    enabled: false,
    openid: '',
    bind_scene_str: '',
    bound_at: '',
    daily_digest: false,
    earnings_alert: false,
    risk_alert: false,
  },
  sms: {
    enabled: false,
    phone: '',
    risk_alert: false,
  },
}) as NotificationChannelsConfig;

// ---------------------------------------------------------------------------
// 数据形状
// ---------------------------------------------------------------------------

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
  /** 'etf_rotation' — 信号优先重构 批5: 主线唯一为 ETF 因子轮动 */
  strategy: 'etf_rotation';
  /** 排序分 (ETF 四因子 total_score) */
  score?: number | null;
  /** 一句话原因摘要 */
  reason?: string | null;
  /** ETF 目标权重 (0..0.15) */
  target_weight?: number | null;
}

export interface DigestPnLSummary {
  /** 当前总资产 */
  total_value: number;
  /** 昨日收盘总资产；首次 = initial_capital */
  prev_total_value: number;
  /** 当日绝对盈亏（元） */
  pnl_today: number;
  /** 当日百分比盈亏（%）；prev_total_value <= 0 时 null */
  pnl_today_pct: number | null;
  /** 当前持仓市值 */
  position_value: number;
  /** 可用现金 */
  current_cash: number;
}

export interface DigestPayload {
  user_id: number;
  username: string;
  portfolio_id: number;
  portfolio_name: string;
  trade_date: string;
  pnl: DigestPnLSummary;
  trades_today_buy: DigestTradeRow[];
  trades_today_sell: DigestTradeRow[];
  trades_today_buy_count: number;
  trades_today_sell_count: number;
  candidates_tomorrow: DigestCandidateRow[];
}

export interface DigestForUserResult {
  digest_id: string;
  status: DigestStatus;
  /** 实际是否真的发到 webhook（dry_run / 配置关 / 失败均 false） */
  sent: boolean;
  user_id: number;
  username: string;
  trade_date: string;
  payload?: DigestPayload;
  webhook_url_used?: string;
  webhook_response?: any;
  /** 失败原因；status='sent' 时为 undefined */
  error?: string;
  /** 跳过原因（如 daily_digest=false / 无 webhook URL / 无 portfolio）；status='skipped' 时填 */
  skip_reason?: string;
}

export interface SendDigestsResult {
  trade_date: string;
  scanned_users: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  /** dry_run=true 时不实际发 webhook，但仍计算 payload */
  dry_run: boolean;
  per_user: DigestForUserResult[];
}

export interface SendDigestsOptions {
  /** 仅评估单个 user，缺省扫所有 is_active 且 enabled=true 的用户 */
  user_id?: number;
  /** 覆盖 trade_date，缺省 = 上海时区当前日期 */
  trade_date?: string;
  /** 不实际推送，只返回 payload，用于预演 */
  dry_run?: boolean;
  /** 每策略候选 cap，缺省 5（AC 要求） */
  per_strategy_limit?: number;
  /** 每方向 trade cap，缺省 3（AC 要求） */
  per_direction_trade_limit?: number;
}

// ---------------------------------------------------------------------------
// DataSource 接口（注入式）
// ---------------------------------------------------------------------------

export interface DailyTradingDigestDataSource {
  /** 列出所有 is_active 且 risk_config.notification_channels.feishu.daily_digest=true 的用户 */
  listEligibleUsers(options: { user_id?: number }): Promise<
    Array<{
      user_id: number;
      username: string;
      config: NotificationChannelsConfig;
    }>
  >;
  /** 取该 user 当日 portfolio + positions 信息 */
  loadPortfolioSummary(
    user_id: number
  ): Promise<{ portfolio: PaperTradingPortfolio; positions: PaperTradingPosition[] } | null>;
  /** 取该 portfolio 当日 trades（按 created_at 落在 [00:00, 24:00) 上海时区） */
  loadTodayTrades(portfolio_id: number, trade_date: string): Promise<PaperTradingTrade[]>;
  /** 取最近 N 条 snapshot（DESC by date）用于计算昨日 PnL */
  loadRecentSnapshots(
    portfolio_id: number,
    limit: number
  ): Promise<Array<{ date: string; total_value: number }>>;
  /** 取明日 3 个策略候选（top per_strategy_limit）— 真实生产用 todaySignalsService.getTodaySignals() */
  loadTomorrowCandidates(options: {
    trade_date: string;
    per_strategy_limit: number;
  }): Promise<DigestCandidateRow[]>;
  /** 调用 FeishuBotWebhookService.sendDailyDigestCard(payload, webhook_url) */
  sendFeishuCard(payload: DigestPayload, webhook_url: string): Promise<FeishuBotWebhookSendResult>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 解析 raw user.risk_config 取 notification_channels；缺失/非法字段静默退回 DEFAULT。
 * 与 US-047..US-055 normalizeXxxConfig 一致：用户改坏一项不该让整 service 4xx，
 * 退回到对应 default 值。
 */
export function normalizeNotificationConfig(raw: any): NotificationChannelsConfig {
  if (!raw || typeof raw !== 'object') return cloneDefault();
  const candidate = raw.notification_channels;
  if (!candidate || typeof candidate !== 'object') return cloneDefault();

  const feishuRaw = isObject(candidate.feishu) ? candidate.feishu : {};
  const emailRaw = isObject(candidate.email) ? candidate.email : {};
  const wechatRaw = isObject(candidate.wechat) ? candidate.wechat : {};
  const smsRaw = isObject(candidate.sms) ? candidate.sms : {};

  return {
    feishu: {
      enabled: safeBoolean(feishuRaw.enabled, DEFAULT_NOTIFICATION_CONFIG.feishu.enabled),
      webhook_url: safeString(feishuRaw.webhook_url),
      daily_digest: safeBoolean(
        feishuRaw.daily_digest,
        DEFAULT_NOTIFICATION_CONFIG.feishu.daily_digest
      ),
      earnings_alert: safeBoolean(
        feishuRaw.earnings_alert,
        DEFAULT_NOTIFICATION_CONFIG.feishu.earnings_alert
      ),
      risk_alert: safeBoolean(feishuRaw.risk_alert, DEFAULT_NOTIFICATION_CONFIG.feishu.risk_alert),
      stock_bullish_event: safeBoolean(
        feishuRaw.stock_bullish_event,
        DEFAULT_NOTIFICATION_CONFIG.feishu.stock_bullish_event
      ),
    },
    email: {
      enabled: safeBoolean(emailRaw.enabled, DEFAULT_NOTIFICATION_CONFIG.email.enabled),
      address: safeString(emailRaw.address),
      weekly_review: safeBoolean(
        emailRaw.weekly_review,
        DEFAULT_NOTIFICATION_CONFIG.email.weekly_review
      ),
      risk_alert: safeBoolean(emailRaw.risk_alert, DEFAULT_NOTIFICATION_CONFIG.email.risk_alert),
      stock_bullish_event: safeBoolean(
        emailRaw.stock_bullish_event,
        DEFAULT_NOTIFICATION_CONFIG.email.stock_bullish_event
      ),
    },
    wechat: {
      enabled: safeBoolean(wechatRaw.enabled, DEFAULT_NOTIFICATION_CONFIG.wechat.enabled),
      openid: safeString(wechatRaw.openid),
      bind_scene_str: safeString(wechatRaw.bind_scene_str),
      bound_at: safeString(wechatRaw.bound_at),
      daily_digest: safeBoolean(
        wechatRaw.daily_digest,
        DEFAULT_NOTIFICATION_CONFIG.wechat.daily_digest
      ),
      earnings_alert: safeBoolean(
        wechatRaw.earnings_alert,
        DEFAULT_NOTIFICATION_CONFIG.wechat.earnings_alert
      ),
      risk_alert: safeBoolean(wechatRaw.risk_alert, DEFAULT_NOTIFICATION_CONFIG.wechat.risk_alert),
    },
    sms: {
      enabled: safeBoolean(smsRaw.enabled, DEFAULT_NOTIFICATION_CONFIG.sms.enabled),
      phone: safeString(smsRaw.phone),
      risk_alert: safeBoolean(smsRaw.risk_alert, DEFAULT_NOTIFICATION_CONFIG.sms.risk_alert),
    },
  };
}

/**
 * 判定本 user 当前 trade_date 是否应发 daily digest：
 *   feishu.enabled && feishu.daily_digest && webhook_url 非空（或 env 已配）
 */
export function shouldSendForUser(
  config: NotificationChannelsConfig,
  hasFallbackEnvWebhook: boolean
): { shouldSend: boolean; reason?: string } {
  if (!config.feishu.enabled) {
    return { shouldSend: false, reason: 'feishu 通道未启用' };
  }
  if (!config.feishu.daily_digest) {
    return { shouldSend: false, reason: '用户已关闭 daily digest 推送' };
  }
  const hasUrl = !!safeString(config.feishu.webhook_url);
  if (!hasUrl && !hasFallbackEnvWebhook) {
    return { shouldSend: false, reason: '未配置 feishu webhook URL' };
  }
  return { shouldSend: true };
}

/**
 * 从所有 trade 里抽出某 direction 的 top-N（按 amount 降序，stable tie-break by symbol asc）。
 */
export function pickTopTrades(
  trades: DigestTradeRow[],
  direction: 'BUY' | 'SELL',
  limit: number
): DigestTradeRow[] {
  if (!Array.isArray(trades) || trades.length === 0) return [];
  const filtered = trades.filter(t => t.direction === direction);
  filtered.sort((a, b) => {
    const diff = (b.amount ?? 0) - (a.amount ?? 0);
    if (diff !== 0) return diff;
    return (a.symbol || '').localeCompare(b.symbol || '');
  });
  const cap = clampInt(limit, DEFAULT_TOP_TRADES, 1, MAX_TOP_TRADES);
  return filtered.slice(0, cap);
}

/**
 * 从混合 candidates（多策略）按 strategy 分桶后各取 top-N。
 * 输入是已聚合好的 list（DataSource.loadTomorrowCandidates 输出），本函数做安全 cap + 排序。
 */
export function pickTopCandidates(
  rows: DigestCandidateRow[],
  per_strategy_limit: number
): DigestCandidateRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const cap = clampInt(per_strategy_limit, DEFAULT_TOP_CANDIDATES, 1, MAX_TOP_CANDIDATES);
  const buckets = new Map<string, DigestCandidateRow[]>();
  for (const row of rows) {
    if (!row?.strategy || !row?.symbol) continue;
    const arr = buckets.get(row.strategy) || [];
    arr.push(row);
    buckets.set(row.strategy, arr);
  }
  // 按 score 降序 stable tie-break by symbol asc
  // 注意：必须显式 null/undefined check 防 `Number(null) === 0` 把 null 算成 0 排进有效分（CLAUDE.md US-031）
  const out: DigestCandidateRow[] = [];
  for (const [, arr] of buckets) {
    arr.sort((a, b) => {
      const sa =
        a.score !== null && a.score !== undefined && Number.isFinite(Number(a.score))
          ? Number(a.score)
          : -Infinity;
      const sb =
        b.score !== null && b.score !== undefined && Number.isFinite(Number(b.score))
          ? Number(b.score)
          : -Infinity;
      if (sb !== sa) return sb - sa;
      return (a.symbol || '').localeCompare(b.symbol || '');
    });
    out.push(...arr.slice(0, cap));
  }
  return out;
}

/**
 * 计算 PnL summary：基于当前 portfolio 与最近 snapshot。
 * 无 snapshot 时（首日 / 新户）用 initial_capital 作为 prev 兜底。
 */
export function computePnLSummary(input: {
  total_value: number;
  current_cash: number;
  initial_capital: number;
  positions_market_value: number;
  prev_snapshot_total_value: number | null;
}): DigestPnLSummary {
  const total = safeNumber(input.total_value);
  const cash = safeNumber(input.current_cash);
  const positionValue = safeNumber(input.positions_market_value);
  const prev =
    input.prev_snapshot_total_value !== null && Number.isFinite(input.prev_snapshot_total_value)
      ? Number(input.prev_snapshot_total_value)
      : safeNumber(input.initial_capital);
  const pnl = roundMoney(total - prev);
  const pnlPct = prev > 0 ? roundPct(((total - prev) / prev) * 100) : null;
  return {
    total_value: roundMoney(total),
    prev_total_value: roundMoney(prev),
    pnl_today: pnl,
    pnl_today_pct: pnlPct,
    position_value: roundMoney(positionValue),
    current_cash: roundMoney(cash),
  };
}

/**
 * "当日盈亏：+1,234.56 元 (+0.62%)" 一行文本。
 */
export function buildPnLLine(pnl: DigestPnLSummary): string {
  const sign = pnl.pnl_today > 0 ? '+' : pnl.pnl_today < 0 ? '' : '';
  const amount = `${sign}${formatMoney(pnl.pnl_today)}`;
  if (pnl.pnl_today_pct === null) return `当日盈亏：${amount} 元`;
  const pctSign = pnl.pnl_today_pct > 0 ? '+' : '';
  return `当日盈亏：${amount} 元 (${pctSign}${formatPercent(pnl.pnl_today_pct)})`;
}

/**
 * 单笔 trade 一行文本："002594 比亚迪 BUY 100股 @¥185.34 = ¥18,534.00"
 */
export function formatTradeLine(row: DigestTradeRow): string {
  const name = row.name || row.symbol;
  const tag = row.direction === 'BUY' ? '买入' : '卖出';
  const qty = `${safeInt(row.quantity)}股`;
  const price = `@${formatMoney(row.execute_price)}`;
  const amount = `= ${formatMoney(row.amount)}`;
  const pnl =
    row.direction === 'SELL' && row.realized_pnl !== undefined && row.realized_pnl !== null
      ? ` 盈亏 ${(row.realized_pnl as number) > 0 ? '+' : ''}${formatMoney(row.realized_pnl)}`
      : '';
  return `${row.symbol} ${name} ${tag} ${qty} ${price} ${amount}${pnl}`;
}

/**
 * 一行候选："[多因子] 600519 贵州茅台 综合分 91.2 — 高质量+低波"
 */
export function formatCandidateLine(row: DigestCandidateRow): string {
  const label = row.strategy === 'etf_rotation' ? '[ETF轮动]' : `[${row.strategy}]`;
  const name = row.name ? `${row.symbol} ${row.name}` : row.symbol;
  // 注意：必须显式 null/undefined check 防 `Number(null) === 0` JS 大坑（CLAUDE.md US-031）
  const hasScore =
    row.score !== null && row.score !== undefined && Number.isFinite(Number(row.score));
  const score = hasScore ? ` 分 ${Number(row.score).toFixed(1)}` : '';
  const reason = row.reason ? ` — ${safeText(row.reason, 28)}` : '';
  return `${label} ${name}${score}${reason}`;
}

/**
 * 业务 ID：`DIGEST-{user_id}-{YYYYMMDD}-{rand4}`（US-055 命名范式）。
 */
export function buildDigestId(user_id: number, trade_date: string, rand4Hex: string): string {
  const ymd = String(trade_date).replace(/-/g, '');
  const rand = String(rand4Hex || '')
    .slice(0, 4)
    .padStart(4, '0');
  return `DIGEST-${user_id}-${ymd}-${rand}`;
}

/**
 * 构造 Feishu interactive card 的 JSON 结构。
 * 不直接调 webhook —— sendFeishuCard 才发；本函数只产生 card object 便于单测断言。
 */
export function buildDigestCard(payload: DigestPayload): {
  msg_type: 'interactive';
  card: {
    header: { template: string; title: { content: string; tag: 'plain_text' } };
    elements: any[];
  };
} {
  const headerTemplate =
    payload.pnl.pnl_today > 0 ? 'red' : payload.pnl.pnl_today < 0 ? 'green' : 'blue';

  const elements: any[] = [];
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**模拟盘**：${safeText(payload.portfolio_name, 80)}（#${payload.portfolio_id}）`,
    },
  });
  // Section 1: PnL
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**${buildPnLLine(payload.pnl)}**` },
  });
  elements.push({
    tag: 'div',
    fields: [
      {
        is_short: true,
        text: { tag: 'lark_md', content: `**总资产**\n${formatMoney(payload.pnl.total_value)} 元` },
      },
      {
        is_short: true,
        text: {
          tag: 'lark_md',
          content: `**持仓市值**\n${formatMoney(payload.pnl.position_value)} 元`,
        },
      },
      {
        is_short: true,
        text: {
          tag: 'lark_md',
          content: `**可用现金**\n${formatMoney(payload.pnl.current_cash)} 元`,
        },
      },
      {
        is_short: true,
        text: {
          tag: 'lark_md',
          content: `**昨收**\n${formatMoney(payload.pnl.prev_total_value)} 元`,
        },
      },
    ],
  });
  elements.push({ tag: 'hr' });

  // Section 2: BUY
  const buyHeader =
    `**今日新增买入 ${payload.trades_today_buy_count} 笔**` +
    (payload.trades_today_buy_count > payload.trades_today_buy.length
      ? `（展示前 ${payload.trades_today_buy.length} 只）`
      : '');
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: buyHeader } });
  if (payload.trades_today_buy.length > 0) {
    for (const t of payload.trades_today_buy) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `• ${formatTradeLine(t)}` },
      });
    }
  } else {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '_暂无新增买入_' } });
  }

  // Section 3: SELL
  const sellHeader =
    `**今日新增卖出 ${payload.trades_today_sell_count} 笔**` +
    (payload.trades_today_sell_count > payload.trades_today_sell.length
      ? `（展示前 ${payload.trades_today_sell.length} 只）`
      : '');
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: sellHeader } });
  if (payload.trades_today_sell.length > 0) {
    for (const t of payload.trades_today_sell) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `• ${formatTradeLine(t)}` },
      });
    }
  } else {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '_暂无新增卖出_' } });
  }
  elements.push({ tag: 'hr' });

  // Section 4: Tomorrow candidates
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `**明日候选（3 策略 × Top 5）**` },
  });
  if (payload.candidates_tomorrow.length > 0) {
    for (const c of payload.candidates_tomorrow) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `• ${formatCandidateLine(c)}` },
      });
    }
  } else {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '_今日策略无候选_' } });
  }

  // Section 5: 宏观环境 (从 payload.macro_snapshot 取 — caller 提前拉好)
  if ((payload as any).macro_snapshot) {
    const snap = (payload as any).macro_snapshot;
    elements.push({ tag: 'hr' });
    const regimeIcon =
      snap.market_regime === 'bull'
        ? '🟢'
        : snap.market_regime === 'bear' || snap.market_regime === 'stress'
        ? '🔴'
        : '🟡';
    const macroLines: string[] = [
      `${regimeIcon} **市场环境: ${snap.market_regime_label || snap.market_regime}**`,
    ];
    macroLines.push(
      `沪深300 20日: ${
        snap.benchmark_return_20d_pct?.toFixed?.(2) ?? snap.benchmark_return_20d_pct ?? '—'
      }% | 60日回撤: ${snap.benchmark_drawdown_60d_pct?.toFixed?.(2) ?? '—'}%`
    );
    if (snap.macro) {
      macroLines.push(
        `PMI: ${snap.macro.pmi_latest ?? '—'} | M2: ${snap.macro.m2_yoy ?? '—'}% | 10Y国债: ${
          snap.macro.treasury_10y ?? '—'
        }%`
      );
    }
    if (snap.qvix) {
      const panicTag = snap.qvix.is_panic ? ' ⚠️恐慌' : '';
      macroLines.push(
        `QVIX(300ETF): ${snap.qvix.qvix_300etf_latest} (60d ${snap.qvix.qvix_300etf_percentile_60d}%分位)${panicTag}`
      );
    }
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: macroLines.join('\n') },
    });
  }

  // Footer
  const ts = moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm');
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `${payload.trade_date} · ${payload.username} · ${payload.portfolio_name} · 推送时间 ${ts}`,
      },
    ],
  });

  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: headerTemplate,
        title: {
          tag: 'plain_text',
          content: `📊 ${payload.trade_date} 当日交易日报`,
        },
      },
      elements,
    },
  };
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function cloneDefault(): NotificationChannelsConfig {
  return {
    feishu: { ...DEFAULT_NOTIFICATION_CONFIG.feishu },
    email: { ...DEFAULT_NOTIFICATION_CONFIG.email },
    wechat: { ...DEFAULT_NOTIFICATION_CONFIG.wechat },
    sms: { ...DEFAULT_NOTIFICATION_CONFIG.sms },
  };
}

function isObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function safeBoolean(v: any, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
    if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  }
  if (typeof v === 'number') return v !== 0;
  return fallback;
}

function safeString(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function safeNumber(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeInt(v: any): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : 0;
}

function clampInt(v: any, fallback: number, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isInteger(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function roundMoney(v: number): number {
  return Math.round(safeNumber(v) * 100) / 100;
}

function roundPct(v: number): number {
  return Math.round(safeNumber(v) * 100) / 100;
}

export function formatMoney(v: any): string {
  const n = safeNumber(v);
  // 加千分位逗号 + 保留 2 位
  const abs = Math.abs(n);
  const intPart = Math.floor(abs).toString();
  const intWithCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decPart = (abs - Math.floor(abs)).toFixed(2).slice(1);
  return `${n < 0 ? '-' : ''}${intWithCommas}${decPart}`;
}

export function formatPercent(v: any): string {
  const n = safeNumber(v);
  return `${n.toFixed(2)}%`;
}

function safeText(value: any, maxLength: number): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function nowShanghaiDate(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

// ---------------------------------------------------------------------------
// 默认 DataSource：真实生产实现（依赖 Sequelize models + FeishuBotWebhookService）
// ---------------------------------------------------------------------------

export class DefaultDailyTradingDigestDataSource implements DailyTradingDigestDataSource {
  async listEligibleUsers(options: { user_id?: number }) {
    const where: any = { is_active: true };
    if (options.user_id !== undefined) {
      where.id = Number(options.user_id);
    }
    const users = await User.findAll({
      where,
      attributes: ['id', 'username', 'risk_config'],
      raw: true,
    });
    return users.map(u => ({
      user_id: (u as any).id,
      username: (u as any).username,
      config: normalizeNotificationConfig((u as any).risk_config),
    }));
  }

  async loadPortfolioSummary(user_id: number) {
    const preferredName =
      safeString(process.env.DAILY_TRADING_DIGEST_PORTFOLIO_NAME) || AUTONOMOUS_PORTFOLIO_NAME;
    let portfolio = await PaperTradingPortfolio.findOne({
      where: { user_id, is_active: true, name: preferredName },
      order: [['id', 'ASC']],
    });
    if (!portfolio) {
      portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id, is_active: true },
        // 没有配置/默认盘时，自动跟单盘优先，其次固定取最早创建的 active 盘。
        order: [
          ['auto_trade_enabled', 'DESC'],
          ['id', 'ASC'],
        ],
      });
    }
    if (!portfolio) return null;
    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id: portfolio.id },
    });
    return { portfolio, positions };
  }

  async loadTodayTrades(portfolio_id: number, trade_date: string) {
    const dayStart = moment.tz(trade_date, 'Asia/Shanghai').startOf('day').toDate();
    const dayEnd = moment.tz(trade_date, 'Asia/Shanghai').endOf('day').toDate();
    return PaperTradingTrade.findAll({
      where: {
        portfolio_id,
        created_at: { [Op.gte]: dayStart, [Op.lte]: dayEnd },
      },
      order: [['created_at', 'ASC']],
    });
  }

  async loadRecentSnapshots(portfolio_id: number, limit: number) {
    const rows = (await PaperTradingSnapshot.findAll({
      attributes: ['date', 'total_value'],
      where: { portfolio_id },
      order: [['date', 'DESC']],
      limit,
      raw: true,
    })) as unknown as Array<{ date: string; total_value: number | string }>;
    return rows.map(r => ({ date: r.date, total_value: Number(r.total_value) }));
  }

  async loadTomorrowCandidates(options: {
    trade_date: string;
    per_strategy_limit: number;
  }): Promise<DigestCandidateRow[]> {
    // Lazy require 避免 cycle：DailyTradingDigestService → TodaySignalsService → strategies
    let signals: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { todaySignalsService } = require('./TodaySignalsService');
      signals = await todaySignalsService.getTodaySignals({
        trade_date: options.trade_date,
      });
    } catch (err: any) {
      logger.warn(
        `[DailyTradingDigest] loadTomorrowCandidates 失败 trade_date=${options.trade_date}: ${
          err?.message || err
        }`
      );
      return [];
    }

    const out: DigestCandidateRow[] = [];
    // ETF 因子轮动 — 取 BUY/HOLD (target_weight > 0) 作为明日候选, 按 total_score 排序
    const etfSignals: any[] = Array.isArray(signals?.etf_rotation?.signals)
      ? signals.etf_rotation.signals
      : [];
    const picks = etfSignals
      .filter(s => s?.action === 'buy' || s?.action === 'hold' || Number(s?.target_weight) > 0)
      .sort((a, b) => Number(b?.score ?? 0) - Number(a?.score ?? 0));
    for (const s of picks.slice(0, options.per_strategy_limit)) {
      out.push({
        strategy: 'etf_rotation',
        symbol: String(s.etf_code || s.symbol || '').trim(),
        name: s.name || null,
        score: Number.isFinite(Number(s.score)) ? Number(s.score) : null,
        reason: Array.isArray(s.reasons) && s.reasons.length ? String(s.reasons[0]) : null,
        target_weight: Number.isFinite(Number(s.target_weight)) ? Number(s.target_weight) : null,
      });
    }
    // 兜底：strategy 没填 name 时按 stock_code 批量回查 Stock 表填回去
    const missingNameCodes = out.filter(r => !r.name && r.symbol).map(r => r.symbol);
    if (missingNameCodes.length > 0) {
      try {
        const stockRows: any[] = await Stock.findAll({
          attributes: ['symbol', 'name'],
          // Stock.symbol 形如 'sh.600519'，stock_code 是 '600519'
          where: {
            [Op.or]: [
              { symbol: { [Op.in]: missingNameCodes } },
              ...missingNameCodes.map(c => ({
                symbol: { [Op.like]: `%.${c}` },
              })),
            ],
          },
          raw: true,
        });
        const nameMap = new Map<string, string>();
        for (const r of stockRows) {
          const symbol: string = r.symbol;
          // 去前缀 sh./sz./bj. 当 code 用
          const pureCode = symbol.includes('.') ? symbol.split('.').pop() || symbol : symbol;
          if (r.name) nameMap.set(pureCode, r.name);
        }
        for (const row of out) {
          if (!row.name && nameMap.has(row.symbol)) {
            row.name = nameMap.get(row.symbol) || null;
          }
        }
      } catch (err: any) {
        logger.debug(`[DailyTradingDigest] 回查 Stock 名称失败: ${err?.message || err}`);
      }
    }

    return out.filter(r => !!r.symbol);
  }

  async sendFeishuCard(payload: DigestPayload, webhook_url: string) {
    return feishuBotWebhookService.sendDailyDigestCard(payload, webhook_url, {
      buildCard: buildDigestCard,
    });
  }
}

export const PRODUCTION_DAILY_TRADING_DIGEST_DATA_SOURCE: DailyTradingDigestDataSource =
  new DefaultDailyTradingDigestDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class DailyTradingDigestService {
  private readonly dataSource: DailyTradingDigestDataSource;

  constructor(
    dataSource: DailyTradingDigestDataSource = PRODUCTION_DAILY_TRADING_DIGEST_DATA_SOURCE
  ) {
    this.dataSource = dataSource;
  }

  /**
   * 主入口 — 批量给所有符合条件的用户发日报。
   * 任一 user 失败不阻塞其他 user（fail-OPEN per-user try/catch）。
   */
  async sendDigests(options: SendDigestsOptions = {}): Promise<SendDigestsResult> {
    const tradeDate = options.trade_date || nowShanghaiDate();
    const dryRun = options.dry_run === true;
    const perStrategyLimit = clampInt(
      options.per_strategy_limit,
      DEFAULT_TOP_CANDIDATES,
      1,
      MAX_TOP_CANDIDATES
    );
    const perDirectionTradeLimit = clampInt(
      options.per_direction_trade_limit,
      DEFAULT_TOP_TRADES,
      1,
      MAX_TOP_TRADES
    );

    let users: Array<{ user_id: number; username: string; config: NotificationChannelsConfig }> =
      [];
    try {
      users = await this.dataSource.listEligibleUsers({ user_id: options.user_id });
    } catch (err: any) {
      logger.error(`[DailyTradingDigest] listEligibleUsers 失败: ${err?.message || err}`);
      return {
        trade_date: tradeDate,
        scanned_users: 0,
        sent_count: 0,
        skipped_count: 0,
        failed_count: 0,
        dry_run: dryRun,
        per_user: [],
      };
    }

    // 候选只算一次，所有 user 共享（明日候选不因 user 而异）
    let candidates: DigestCandidateRow[] = [];
    try {
      const raw = await this.dataSource.loadTomorrowCandidates({
        trade_date: tradeDate,
        per_strategy_limit: perStrategyLimit,
      });
      candidates = pickTopCandidates(raw, perStrategyLimit);
    } catch (err: any) {
      logger.warn(
        `[DailyTradingDigest] loadTomorrowCandidates 失败 trade_date=${tradeDate}: ${
          err?.message || err
        }`
      );
    }

    const hasFallbackEnv = !!(
      process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || process.env.FEISHU_BOT_WEBHOOK
    );

    const perUser: DigestForUserResult[] = [];
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const user of users) {
      try {
        const result = await this.sendDigestForUser({
          user_id: user.user_id,
          username: user.username,
          config: user.config,
          candidates,
          trade_date: tradeDate,
          dry_run: dryRun,
          per_direction_trade_limit: perDirectionTradeLimit,
          has_fallback_env_webhook: hasFallbackEnv,
        });
        perUser.push(result);
        if (result.status === DIGEST_STATUS.SENT) sentCount += 1;
        else if (result.status === DIGEST_STATUS.SKIPPED) skippedCount += 1;
        else failedCount += 1;
      } catch (err: any) {
        logger.error(
          `[DailyTradingDigest] sendDigestForUser user=${user.user_id} 二重 throw: ${
            err?.message || err
          }`
        );
        failedCount += 1;
        perUser.push({
          digest_id: buildDigestId(user.user_id, tradeDate, randHex4()),
          status: DIGEST_STATUS.FAILED,
          sent: false,
          user_id: user.user_id,
          username: user.username,
          trade_date: tradeDate,
          error: String(err?.message || err),
        });
      }
    }

    return {
      trade_date: tradeDate,
      scanned_users: users.length,
      sent_count: sentCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      dry_run: dryRun,
      per_user: perUser,
    };
  }

  /**
   * 单用户日报生成 + 发送（如未跳过）。
   * 失败不 throw，转 DigestForUserResult.error 返回（fail-OPEN）。
   */
  async sendDigestForUser(options: {
    user_id: number;
    username: string;
    config: NotificationChannelsConfig;
    candidates: DigestCandidateRow[];
    trade_date: string;
    dry_run: boolean;
    per_direction_trade_limit: number;
    has_fallback_env_webhook: boolean;
  }): Promise<DigestForUserResult> {
    const {
      user_id,
      username,
      config,
      candidates,
      trade_date,
      dry_run,
      per_direction_trade_limit,
      has_fallback_env_webhook,
    } = options;
    const digestId = buildDigestId(user_id, trade_date, randHex4());

    const gate = shouldSendForUser(config, has_fallback_env_webhook);
    if (!gate.shouldSend) {
      return {
        digest_id: digestId,
        status: DIGEST_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        trade_date,
        skip_reason: gate.reason,
      };
    }

    // ---- 取该 user 的 portfolio + positions + trades + snapshots --------
    let summary: { portfolio: PaperTradingPortfolio; positions: PaperTradingPosition[] } | null;
    try {
      summary = await this.dataSource.loadPortfolioSummary(user_id);
    } catch (err: any) {
      logger.warn(
        `[DailyTradingDigest] loadPortfolioSummary user=${user_id} 失败: ${err?.message || err}`
      );
      return {
        digest_id: digestId,
        status: DIGEST_STATUS.FAILED,
        sent: false,
        user_id,
        username,
        trade_date,
        error: `加载模拟盘失败：${err?.message || err}`,
      };
    }
    if (!summary || !summary.portfolio) {
      return {
        digest_id: digestId,
        status: DIGEST_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        trade_date,
        skip_reason: '用户尚未建立模拟盘',
      };
    }

    let trades: PaperTradingTrade[] = [];
    try {
      trades = await this.dataSource.loadTodayTrades(summary.portfolio.id, trade_date);
    } catch (err: any) {
      logger.warn(
        `[DailyTradingDigest] loadTodayTrades user=${user_id} 失败: ${err?.message || err}`
      );
      // 容忍：trade 加载失败，继续走（buy/sell count 显示 0）
    }
    const tradeRows: DigestTradeRow[] = trades.map(t => ({
      symbol: t.symbol,
      name: t.name,
      direction: t.direction,
      quantity: Number(t.quantity),
      execute_price: Number(t.execute_price),
      amount: Number(t.amount),
      realized_pnl:
        t.realized_pnl !== null && t.realized_pnl !== undefined ? Number(t.realized_pnl) : null,
    }));

    let snapshots: Array<{ date: string; total_value: number }> = [];
    try {
      snapshots = await this.dataSource.loadRecentSnapshots(summary.portfolio.id, 30);
    } catch (err: any) {
      logger.warn(
        `[DailyTradingDigest] loadRecentSnapshots user=${user_id} 失败: ${err?.message || err}`
      );
    }
    // 找 < trade_date 的最近一日 snapshot 作为 prev_total_value
    const prevSnap = snapshots
      .filter(s => s && s.date && s.date < trade_date)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const prevTotal = prevSnap ? prevSnap.total_value : null;

    const positionsMarketValue = summary.positions.reduce(
      (sum, p) => sum + safeNumber(p.market_value),
      0
    );
    const pnl = computePnLSummary({
      total_value: Number(summary.portfolio.total_value),
      current_cash: Number(summary.portfolio.current_cash),
      initial_capital: Number(summary.portfolio.initial_capital),
      positions_market_value: positionsMarketValue,
      prev_snapshot_total_value: prevTotal,
    });

    const buys = pickTopTrades(tradeRows, 'BUY', per_direction_trade_limit);
    const sells = pickTopTrades(tradeRows, 'SELL', per_direction_trade_limit);
    const buyCount = tradeRows.filter(t => t.direction === 'BUY').length;
    const sellCount = tradeRows.filter(t => t.direction === 'SELL').length;

    const payload: DigestPayload = {
      user_id,
      username,
      portfolio_id: Number(summary.portfolio.id),
      portfolio_name:
        safeString(summary.portfolio.name) || `模拟盘 #${Number(summary.portfolio.id)}`,
      trade_date,
      pnl,
      trades_today_buy: buys,
      trades_today_sell: sells,
      trades_today_buy_count: buyCount,
      trades_today_sell_count: sellCount,
      candidates_tomorrow: candidates,
    };

    // 加宏观环境 snapshot（fail-safe: 拉不到不影响日报）
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { marketEnvironmentService } = require('./MarketEnvironmentService');
      const snap = await marketEnvironmentService.getEnvironmentForStock('sh.000300', {
        use_cache: true,
        as_of: trade_date,
      });
      if (snap) (payload as any).macro_snapshot = snap;
    } catch {
      // 静默
    }

    if (dry_run) {
      return {
        digest_id: digestId,
        status: DIGEST_STATUS.SENT,
        sent: false,
        user_id,
        username,
        trade_date,
        payload,
        skip_reason: 'dry_run',
      };
    }

    const webhookUrl =
      safeString(config.feishu.webhook_url) ||
      safeString(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK) ||
      safeString(process.env.FEISHU_BOT_WEBHOOK);

    // ---- 发送 webhook（fail-OPEN） ---------------------------------------
    let sendRes: FeishuBotWebhookSendResult;
    try {
      sendRes = await this.dataSource.sendFeishuCard(payload, webhookUrl);
    } catch (err: any) {
      logger.warn(
        `[DailyTradingDigest] sendFeishuCard user=${user_id} 失败: ${err?.message || err}`
      );
      return {
        digest_id: digestId,
        status: DIGEST_STATUS.FAILED,
        sent: false,
        user_id,
        username,
        trade_date,
        payload,
        webhook_url_used: webhookUrl,
        error: `飞书 webhook 异常：${err?.message || err}`,
      };
    }

    if (sendRes.success) {
      return {
        digest_id: digestId,
        status: DIGEST_STATUS.SENT,
        sent: true,
        user_id,
        username,
        trade_date,
        payload,
        webhook_url_used: webhookUrl,
        webhook_response: sendRes.data,
      };
    }
    if (sendRes.skipped) {
      return {
        digest_id: digestId,
        status: DIGEST_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        trade_date,
        payload,
        webhook_url_used: webhookUrl,
        skip_reason: sendRes.message,
      };
    }
    return {
      digest_id: digestId,
      status: DIGEST_STATUS.PARTIAL,
      sent: false,
      user_id,
      username,
      trade_date,
      payload,
      webhook_url_used: webhookUrl,
      webhook_response: sendRes.data,
      error: sendRes.message || 'feishu webhook 返回失败',
    };
  }

  /**
   * GET endpoint 用：取该 user 的 normalized notification config。
   */
  async getNotificationConfig(user_id: number): Promise<NotificationChannelsConfig> {
    const user = await User.findByPk(user_id, { attributes: ['risk_config'], raw: true });
    return normalizeNotificationConfig((user as any)?.risk_config);
  }

  /**
   * PUT endpoint 用：merge + 落 User.risk_config.notification_channels JSONB。
   * 复用 US-017 JSONB mutation 模式（必须 .changed('risk_config', true)）。
   */
  async updateNotificationConfig(
    user_id: number,
    patch: Partial<NotificationChannelsConfig>
  ): Promise<NotificationChannelsConfig> {
    const user = await User.findByPk(user_id);
    if (!user) throw new Error('用户不存在');
    const existing = normalizeNotificationConfig((user as any).risk_config);
    const next: NotificationChannelsConfig = {
      feishu: { ...existing.feishu, ...(patch.feishu || {}) },
      email: { ...existing.email, ...(patch.email || {}) },
      wechat: { ...existing.wechat, ...(patch.wechat || {}) },
      sms: { ...existing.sms, ...(patch.sms || {}) },
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
   * US-067 — 专用 patch endpoint：merge + 落 user.notification_channels.sms。
   *
   * 与 `updateEmailConfig` / `updateWeChatConfig` 同款 sub-resource 范式 —— 让前端
   * SettingsWorkspace 的 SMS Card 表单代码不必构造嵌套 patch 对象。
   *
   * Body 接受 `{ enabled?, phone?, risk_alert? }` 三字段；phone normalize 让 11
   * 位国内号留下，其他全留给 `RealtimeAlertDispatcher.shouldDispatchForChannel`
   * 在发送前做最终校验（前端可以保存 + 提示，但发送时 service 会自己拒）。
   */
  async updateSmsConfig(
    user_id: number,
    patch: Partial<{
      enabled: boolean;
      phone: string;
      risk_alert: boolean;
    }>
  ): Promise<NotificationChannelsConfig> {
    const user = await User.findByPk(user_id);
    if (!user) throw new Error('用户不存在');
    const existing = normalizeNotificationConfig((user as any).risk_config);
    const nextSms = { ...existing.sms, ...(patch || {}) };
    const next: NotificationChannelsConfig = {
      feishu: { ...existing.feishu },
      email: { ...existing.email },
      wechat: { ...existing.wechat },
      sms: nextSms,
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

export const dailyTradingDigestService = new DailyTradingDigestService();
