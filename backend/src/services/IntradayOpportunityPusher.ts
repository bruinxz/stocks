/**
 * IntradayOpportunityPusher — CE-C 实时机会推送
 *
 * 接到上游 (CE-B 规则引擎) 触发的"实时买入机会"信号后, 干 3 件事:
 *   1. 精细 dedup (per-rule TTL + per-symbol 1h cap + 全局 1min cap circuit breaker)
 *   2. 多群路由 (business / ops / per-user webhook) — Promise.allSettled 并行
 *   3. 卡片渲染 (绿色 header / 触发理由 / Unicode sparkline / AI 解读 deeplink)
 *   4. 持久化 IntradayOpportunityPush 审计行 (含 skipped/dry_run/circuit_breaker 留痕)
 *
 * **与 RealtimeAlertDispatcher (US-067 风控告警) 的关系**:
 *   - 二者完全解耦, 不共享 dedup buffer (本 service 是 in-process Map, 那个是 User JSONB)
 *   - 卡片视觉对立: 告警红 header / 机会绿 header, 让用户一眼分清两类消息
 *   - 多群路由扩展了告警 dispatcher 单 user 视角 — 本 service 支持 业务群+运维群+用户群
 *
 * **dedup 策略** (核心难点):
 *   - 每 trigger_rule 有独立 TTL (breakout 30min / volume 5min / dragon_tiger 1h)
 *   - 桶分签名: `intraday_opp::{symbol}::{rule}::{floor(ts/ttl)}` —
 *     同桶内重复触发只发一次, 下一桶起算自动突破
 *   - per-symbol 1h 上限 5 次 (防个股震荡风暴)
 *   - 全局 1min 上限 20 次 (防系统级风暴, e.g. 大盘暴跌触发批量 rapid_fall_stabilize)
 *   - 命中上限仅 warn + 返 'circuit_breaker' (不写飞书 + 不计入 dedup 桶)
 *
 * **fail-open 范式**:
 *   - 任一 webhook URL 缺失 → warn + 'no_webhook' 不算 fail
 *   - DB 写库异常 → warn 不阻塞 push 返回结果
 *   - 任一群 push 异常 → 其他群继续 (Promise.allSettled)
 *   - dry_run=true → 跳过所有 webhook + DB, 仅返 plan (UI 预览用)
 *
 * **测试**:
 *   - 所有"对外副作用" (HTTP / DB) 走 PusherDataSource 注入 fake
 *   - 纯函数 (signature builder / TTL 选择 / card 模板) 全 export 便于断言
 *   - 飞书 webhook URL 校验复用 webhookUrlGuard (依赖 axios stub 由 caller 提供)
 */

import { logger } from '../utils/logger';
import { formatEast8Readable } from '../utils/timezone';
import {
  feishuBotWebhookService,
  FeishuBotWebhookSendResult,
} from './FeishuBotWebhookService';
import { sparklinePngService, SparklinePngService, SparklineResult } from './SparklinePngService';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const OPPORTUNITY_TARGET_GROUPS = Object.freeze({
  BUSINESS: 'business',
  OPS: 'ops',
  USER: 'user',
} as const);

export type OpportunityTargetGroup =
  (typeof OPPORTUNITY_TARGET_GROUPS)[keyof typeof OPPORTUNITY_TARGET_GROUPS];

export const OPPORTUNITY_ACTIONS = Object.freeze({
  STRONG_BUY: 'strong_buy',
  BUY: 'buy',
  ADD: 'add',
  HOLD: 'hold',
} as const);

export type OpportunityAction =
  (typeof OPPORTUNITY_ACTIONS)[keyof typeof OPPORTUNITY_ACTIONS];

export const OPPORTUNITY_RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const);

export type OpportunityRiskLevel =
  (typeof OPPORTUNITY_RISK_LEVELS)[keyof typeof OPPORTUNITY_RISK_LEVELS];

/** Per-trigger-rule dedup TTL (毫秒). 任何未列出的 rule 回落到 DEFAULT_TTL_MS. */
export const TRIGGER_RULE_DEDUP_TTL_MS: Record<string, number> = Object.freeze({
  breakout_60d_high: 30 * 60 * 1000,
  breakout_20d_high: 30 * 60 * 1000,
  volume_spike: 5 * 60 * 1000,
  rapid_rise: 5 * 60 * 1000,
  rapid_fall_stabilize: 5 * 60 * 1000,
  northbound_inflow_surge: 60 * 60 * 1000,
  dragon_tiger_first_board: 60 * 60 * 1000,
}) as Record<string, number>;

export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/** 同 symbol 1 小时内最多推送次数 (防个股震荡风暴). */
export const PER_SYMBOL_HOURLY_CAP = 5;
export const PER_SYMBOL_WINDOW_MS = 60 * 60 * 1000;

/** 全局 1 分钟内最多推送次数 (防系统级风暴). */
export const GLOBAL_MINUTE_CAP = 20;
export const GLOBAL_WINDOW_MS = 60 * 1000;

/** in-process dedup buffer LRU 上限 (跨进程不共享, 重启清空). */
export const DEDUP_BUFFER_LRU_LIMIT = 1000;

/**
 * PR-L emergency stop-loss (2026-06-29):
 * PR-K 30 天回测证实当前推荐系统 confidence_score 反向 — high(≥70) win 30% <
 * low(<50) win 40%. 该 gate 在 push entry 处暂停 conf≥70 的飞书推送 (audit 仍写一行
 * 留痕, dedup buffer 不消耗). **等 PR-I 战法库 + conf evaluator 修复后, 把
 * EMERGENCY_CONF_GATE 切回 false** — 现阶段优先 fail-closed (高 conf 一律不推) 防
 * 用户群被毒推. UI 仍显示推荐 (HomeWorkspace banner 警示).
 */
/**
 * PR-W (2026-06-30) — 解除 PR-L 紧急 conf gate.
 * 用户实测明确反馈"飞书没收到通知". PR-L 把 conf≥70 的飞书推送全 gate 是 over-fix.
 * 改回 false 让推送正常. 反向 conf 修复走 PR-M3 SourceTypeWinRateAdjuster (已部署).
 */
export const EMERGENCY_CONF_GATE = false;
export const EMERGENCY_CONF_GATE_THRESHOLD = 70;
export const EMERGENCY_CONF_GATE_SKIP_REASON = 'emergency_stop_loss_conf_gate';

const DEFAULT_FRONTEND_BASE = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface OpportunityDecision {
  action: OpportunityAction;
  /** 0-100; caller 自行 clamp */
  confidence_score: number;
  risk_level: OpportunityRiskLevel;
  suggested_position_pct?: number | null;
  /** [low, high]; 缺一返 null */
  entry_zone?: [number, number] | null;
  stop_loss?: number | null;
  take_profit?: number | null;
}

export interface OpportunityInput {
  symbol: string;
  name: string;
  trigger_rule: string;
  trigger_rule_label: string;
  trigger_time: Date;
  current_price: number;
  /** 当日累计涨跌百分比 (例如 5.32 → 涨 5.32%) */
  change_pct: number;
  /** 5 日量比 (current_volume / avg5d_volume); null = 数据缺失 */
  volume_ratio?: number | null;
  decision: OpportunityDecision;
  reasons: string[];
  industry?: string | null;
  market_segment?: string | null;
  /** AIInvestmentSignal.id 用于深页跳转 */
  source_signal_id?: number | null;
}

export interface PushOptions {
  target_groups?: OpportunityTargetGroup[];
  user_ids?: number[];
  /** 默认 true; sparkline 取失败也 OK, 卡片继续推 */
  include_chart?: boolean;
  /** UI 预览; 跳过所有 webhook + DB + dedup 写入 */
  dry_run?: boolean;
  /** 单测 / 重放用; 不传走 Date.now() */
  now_ms_override?: number;
  /** 前端 base URL override; 不传走 env */
  frontend_base_url?: string;
  /** 是否持久化审计行 (默认 true; 单测 / cron preview 可关) */
  persist?: boolean;
}

export interface PushedGroupResult {
  group: OpportunityTargetGroup;
  /** target_groups='user' 时携带具体 user_id, 其他空 */
  user_id?: number;
  ok: boolean;
  /** 'sent' / 'no_webhook' / 'send_error' / 'dry_run' */
  status: 'sent' | 'no_webhook' | 'send_error' | 'dry_run';
  message?: string;
  webhook_response?: any;
}

export interface PushResult {
  ok: boolean;
  pushed_groups: PushedGroupResult[];
  /** 顶层 skip 原因 — 'deduped' / 'circuit_breaker' / 'dry_run' / 'no_webhook' (无任何 group 成功) / PR-L 'emergency_stop_loss_conf_gate' */
  skipped_reason?: 'deduped' | 'no_webhook' | 'circuit_breaker' | 'dry_run' | 'invalid_input' | 'emergency_stop_loss_conf_gate';
  dedup_signature: string;
  /** caller 调试用 — buildOpportunityCard 输出 */
  card_payload?: any;
  /** Unicode sparkline 数据 (若取到) */
  sparkline?: SparklineResult | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** PR-L (2026-06-29) — confidence_score ≥ threshold 时拦截推送. NaN/null → 不拦截.
 *  pure (export for test). 见顶部 EMERGENCY_CONF_GATE 注释. */
export function isEmergencyConfGated(
  decision: OpportunityDecision,
  threshold: number = EMERGENCY_CONF_GATE_THRESHOLD
): boolean {
  if (!EMERGENCY_CONF_GATE) return false;
  if (!decision) return false;
  const n = Number(decision.confidence_score);
  if (!Number.isFinite(n)) return false;
  return n >= threshold;
}

/** 取 trigger_rule 对应 TTL; 未知 rule 走 DEFAULT_TTL_MS. */
export function ttlForTriggerRule(rule: string): number {
  if (!rule) return DEFAULT_TTL_MS;
  const ttl = TRIGGER_RULE_DEDUP_TTL_MS[rule];
  return Number.isFinite(ttl) && (ttl as number) > 0 ? (ttl as number) : DEFAULT_TTL_MS;
}

/**
 * dedup signature: `intraday_opp::{symbol}::{rule}::{bucket}` —
 * 同桶内同 (symbol, rule) 视为重复, 下一桶起算自动突破.
 * bucket = floor(timestamp / ttl) — 每 ttl 一桶, 同桶内只允许第一条通过.
 */
export function buildOpportunitySignature(
  symbol: string,
  trigger_rule: string,
  trigger_time_ms: number,
  ttl_ms: number
): string {
  const sym = String(symbol || '').trim() || 'UNKNOWN_SYMBOL';
  const rule = String(trigger_rule || '').trim() || 'unknown';
  const ts = Number.isFinite(trigger_time_ms) ? Number(trigger_time_ms) : 0;
  const safeTtl = Number.isFinite(ttl_ms) && (ttl_ms as number) > 0 ? (ttl_ms as number) : DEFAULT_TTL_MS;
  const bucket = Math.floor(ts / safeTtl);
  return `intraday_opp::${sym}::${rule}::${bucket}`;
}

/**
 * 安全 clamp 数值到 [min, max], NaN / 非数 → 默认 fallback.
 */
export function safeClamp(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** 显示用涨跌百分比格式化 — '+5.32%' / '-1.20%' / '0.00%'; null/undefined/非有限 → '—'. */
export function formatChangePct(pct: any): string {
  if (pct === null || pct === undefined || pct === '') return '—';
  const n = Number(pct);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

/** 显示用价格格式化 — 2 位小数; null/undefined/非有限 → '—'. */
export function formatPrice(value: any): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(2);
}

/** entry_zone tuple → '12.34 - 12.50'; 任一缺失 → '—' */
export function formatEntryZone(zone: [number, number] | null | undefined): string {
  if (!Array.isArray(zone) || zone.length !== 2) return '—';
  const [lo, hi] = zone;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '—';
  return `${Number(lo).toFixed(2)} - ${Number(hi).toFixed(2)}`;
}

const ACTION_LABEL_ZH: Record<OpportunityAction, string> = {
  strong_buy: '强烈买入',
  buy: '买入',
  add: '加仓',
  hold: '持有',
};

const RISK_LABEL_ZH: Record<OpportunityRiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
};

export function actionLabel(action: OpportunityAction): string {
  return ACTION_LABEL_ZH[action] || action;
}

export function riskLabel(level: OpportunityRiskLevel): string {
  return RISK_LABEL_ZH[level] || level;
}

/** Truncate 中文友好 — 简单 Math.min slice + ellipsis. */
export function safeText(value: any, maxLength: number): string {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

/**
 * 构造前端深页 deeplink — `/workspace/today?intraday=<symbol>&signal_id=<id>`.
 */
export function buildIntradayDeeplink(
  symbol: string,
  signal_id: number | null | undefined,
  baseUrl: string = DEFAULT_FRONTEND_BASE
): string {
  const safeBase = String(baseUrl || DEFAULT_FRONTEND_BASE).replace(/\/+$/, '');
  const params = new URLSearchParams({ intraday: String(symbol || '') });
  if (signal_id !== null && signal_id !== undefined) {
    params.set('signal_id', String(signal_id));
  }
  params.set('type', 'intraday_opportunity');
  return `${safeBase}/workspace/today?${params.toString()}`;
}

/**
 * 构造飞书 interactive card — 绿色 header / 6 字段 / 触发理由 / 数值段 / sparkline / 2 action button.
 * 纯函数, 单测可断言 elements 顺序 + header 模板色.
 */
export function buildOpportunityCard(
  input: OpportunityInput,
  options: {
    deeplink_url: string;
    sparkline?: SparklineResult | null;
    include_chart?: boolean;
  }
): any {
  const decision = input.decision || ({} as OpportunityDecision);
  const elements: any[] = [];

  // Section 0: subtitle (规则 + symbol + name)
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `**${safeText(input.trigger_rule_label, 32) || input.trigger_rule}**\n**${safeText(
        input.symbol,
        24
      )} ${safeText(input.name, 32)}**`,
    },
  });

  // Section 1: 6 字段双列 (现价/涨幅/评分/风险/仓位/行业)
  const score = safeClamp(decision.confidence_score, 0, 100, 0);
  const fields: any[] = [
    {
      is_short: true,
      text: { tag: 'lark_md', content: `**现价**\n${formatPrice(input.current_price)} 元` },
    },
    {
      is_short: true,
      text: { tag: 'lark_md', content: `**今日涨幅**\n${formatChangePct(input.change_pct)}` },
    },
    {
      is_short: true,
      text: {
        tag: 'lark_md',
        content: `**置信度评分**\n${score.toFixed(0)} / 100 (${actionLabel(decision.action)})`,
      },
    },
    {
      is_short: true,
      text: {
        tag: 'lark_md',
        content: `**风险等级**\n${riskLabel(decision.risk_level)}${
          decision.suggested_position_pct !== null && decision.suggested_position_pct !== undefined
            ? ' · 建议仓位 ' + (Number(decision.suggested_position_pct) || 0).toFixed(1) + '%'
            : ''
        }`,
      },
    },
    {
      is_short: true,
      text: {
        tag: 'lark_md',
        content: `**量比**\n${
          input.volume_ratio !== null && input.volume_ratio !== undefined && Number.isFinite(Number(input.volume_ratio))
            ? Number(input.volume_ratio).toFixed(2)
            : '—'
        }`,
      },
    },
    {
      is_short: true,
      text: {
        tag: 'lark_md',
        content: `**行业**\n${safeText(input.industry, 24) || '—'}${
          input.market_segment ? ' / ' + safeText(input.market_segment, 16) : ''
        }`,
      },
    },
  ];
  elements.push({ tag: 'div', fields });

  // Section 2: 触发理由 top 3
  elements.push({ tag: 'hr' });
  const reasons = Array.isArray(input.reasons) ? input.reasons.slice(0, 3).filter(Boolean) : [];
  if (reasons.length > 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          '**触发理由**\n' + reasons.map(r => `- ${safeText(r, 120)}`).join('\n'),
      },
    });
  }

  // Section 3: 数值段 (入场区间 / 止损 / 止盈)
  const entryZoneStr = formatEntryZone(decision.entry_zone || null);
  const stopLossStr =
    decision.stop_loss !== null && decision.stop_loss !== undefined
      ? formatPrice(decision.stop_loss)
      : '—';
  const takeProfitStr =
    decision.take_profit !== null && decision.take_profit !== undefined
      ? formatPrice(decision.take_profit)
      : '—';
  elements.push({
    tag: 'div',
    fields: [
      {
        is_short: true,
        text: { tag: 'lark_md', content: `**入场区间**\n${entryZoneStr}` },
      },
      {
        is_short: true,
        text: { tag: 'lark_md', content: `**止损 / 止盈**\n${stopLossStr} / ${takeProfitStr}` },
      },
    ],
  });

  // Section 4: K 线缩略图 (V0 unicode sparkline; V1 改 img_key)
  if (options.include_chart !== false && options.sparkline && options.sparkline.rendered) {
    const dirIcon =
      options.sparkline.direction === 'up'
        ? '↗'
        : options.sparkline.direction === 'down'
          ? '↘'
          : '→';
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**近 20 日趋势** ${dirIcon}\n\`${options.sparkline.rendered}\`  (${formatPrice(
          options.sparkline.low
        )} - ${formatPrice(options.sparkline.high)})`,
      },
    });
  }

  // Section 5: action buttons
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '查看 AI 解读 →' },
        type: 'primary',
        url: options.deeplink_url,
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '加入自选' },
        type: 'default',
        // V0 暂不实现 callback, V1 接入 /api/favorite POST
        value: { action: 'add_to_favorite', symbol: input.symbol, source: 'intraday_opp' },
      },
    ],
  });

  // Footer — 北京时间 + UTC+8 标识
  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content: `触发时间: ${formatEast8Readable(input.trigger_time)} · ${input.trigger_rule}`,
      },
    ],
  });

  return {
    msg_type: 'interactive',
    card: {
      header: {
        template: 'green',
        title: {
          tag: 'plain_text',
          content: '🎯 实时买入机会',
        },
      },
      elements,
    },
  };
}

/** Normalize / validate input — 缺 symbol / rule / trigger_time → null. */
export function validateOpportunityInput(input: any): OpportunityInput | null {
  if (!input || typeof input !== 'object') return null;
  if (!input.symbol || typeof input.symbol !== 'string') return null;
  if (!input.trigger_rule || typeof input.trigger_rule !== 'string') return null;
  if (!(input.trigger_time instanceof Date) || Number.isNaN(input.trigger_time.getTime())) {
    // 允许 ISO string fallback
    if (typeof input.trigger_time === 'string') {
      const d = new Date(input.trigger_time);
      if (Number.isNaN(d.getTime())) return null;
      input.trigger_time = d;
    } else {
      return null;
    }
  }
  if (!input.decision || typeof input.decision !== 'object') return null;
  return input as OpportunityInput;
}

// ---------------------------------------------------------------------------
// In-process dedup buffer (跨进程不共享, 重启清空)
// ---------------------------------------------------------------------------

interface DedupRecord {
  signature: string;
  pushed_at_ms: number;
}

interface SymbolPushHistory {
  symbol: string;
  pushed_at_ms: number;
}

/**
 * Helper — 把 ttl bucket signature 加入 buffer, FIFO trim 到 LRU limit.
 * Export 让单测可纯函数验证.
 */
export function appendDedupRecord(
  buffer: DedupRecord[],
  rec: DedupRecord,
  limit: number = DEDUP_BUFFER_LRU_LIMIT
): DedupRecord[] {
  // 去同 signature (同桶重复, 不应该发生, 但兜底)
  const filtered = buffer.filter(r => r.signature !== rec.signature);
  filtered.push(rec);
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : DEDUP_BUFFER_LRU_LIMIT;
  if (filtered.length > safeLimit) {
    return filtered.slice(filtered.length - safeLimit);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// DataSource (DI seam)
// ---------------------------------------------------------------------------

export interface PusherDataSource {
  /** 取 per-user webhook URL (User.risk_config.feishu.webhook_url); 不存在返 null */
  loadUserWebhook(user_id: number): Promise<string | null>;
  /** 调 FeishuBotWebhookService.sendRiskAlertCard (复用同款 fail-OPEN 范式) */
  sendFeishuCard(card: any, webhook_url: string): Promise<FeishuBotWebhookSendResult>;
  /** 写一行审计 (失败 warn 不抛错) */
  persistAuditRow(row: AuditRowInput): Promise<void>;
  /** V0 不暴露 sparkline 拉取 — 直接调 sparklinePngService; V1 可注入 fake. */
  fetchSparkline(symbol: string): Promise<SparklineResult | null>;
}

export interface AuditRowInput {
  symbol: string;
  name: string;
  trigger_rule: string;
  trigger_time: Date;
  decision: OpportunityDecision;
  reasons: string[];
  source_signal_id: number | null;
  target_groups: string;
  push_result: Record<string, unknown>;
}

/** Default DS — Sequelize User / IntradayOpportunityPush via lazy require. */
export class DefaultPusherDataSource implements PusherDataSource {
  constructor(private readonly sparkline: SparklinePngService = sparklinePngService) {}

  async loadUserWebhook(user_id: number): Promise<string | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { User } = require('../models/User');
      const u = await User.findByPk(user_id, { attributes: ['risk_config'], raw: true });
      if (!u) return null;
      const rc: any = (u as any).risk_config;
      if (!rc || typeof rc !== 'object') return null;
      const feishu = rc.feishu || rc.notification_channels?.feishu;
      const url = String(feishu?.webhook_url || '').trim();
      return url || null;
    } catch (err: any) {
      logger.warn(
        `[IntradayOpportunityPusher] loadUserWebhook user=${user_id} 失败: ${err?.message || err}`
      );
      return null;
    }
  }

  async sendFeishuCard(card: any, webhook_url: string): Promise<FeishuBotWebhookSendResult> {
    return feishuBotWebhookService.sendRiskAlertCard({} as any, webhook_url, {
      // 传入 buildCard 直接返回我们已构造好的 card body
      buildCard: () => card,
    });
  }

  async persistAuditRow(row: AuditRowInput): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IntradayOpportunityPush } = require('../models/IntradayOpportunityPush');
      await IntradayOpportunityPush.create({
        symbol: row.symbol,
        name: row.name || null,
        trigger_rule: row.trigger_rule,
        trigger_time: row.trigger_time,
        pushed_at: new Date(),
        decision: row.decision,
        reasons: row.reasons || [],
        source_signal_id: row.source_signal_id,
        target_groups: row.target_groups,
        push_result: row.push_result,
      });
    } catch (err: any) {
      logger.warn(
        `[IntradayOpportunityPusher] persistAuditRow 失败 (fail-OPEN, 主推送不阻塞): ${
          err?.message || err
        }`
      );
    }
  }

  async fetchSparkline(symbol: string): Promise<SparklineResult | null> {
    try {
      return await this.sparkline.renderMiniKline(symbol, 20);
    } catch (err: any) {
      logger.warn(
        `[IntradayOpportunityPusher] fetchSparkline symbol=${symbol} 失败: ${err?.message || err}`
      );
      return null;
    }
  }
}

export const PRODUCTION_PUSHER_DATA_SOURCE: PusherDataSource = new DefaultPusherDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class IntradayOpportunityPusher {
  private readonly dataSource: PusherDataSource;

  // in-process dedup buffer
  private dedupBuffer: DedupRecord[] = [];
  // per-symbol push history for 1h cap (FIFO trimmed by GLOBAL_WINDOW_MS lookback)
  private symbolHistory: SymbolPushHistory[] = [];
  // global push history for 1min cap
  private globalHistory: Array<{ pushed_at_ms: number }> = [];

  constructor(dataSource: PusherDataSource = PRODUCTION_PUSHER_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 主入口 — caller (CE-B 规则引擎) fire-and-forget 调用本方法.
   *
   * 流程:
   *   (1) validate input
   *   (2) compute dedup signature + circuit_breaker check
   *   (3) build card + (option) sparkline
   *   (4) fan-out 多群 Promise.allSettled (dry_run 跳过)
   *   (5) 标记 dedup buffer (除非 dry_run / 入口已 skip)
   *   (6) persist audit row (fail-OPEN)
   */
  async push(input: OpportunityInput, options: PushOptions = {}): Promise<PushResult> {
    const normalized = validateOpportunityInput(input);
    if (!normalized) {
      return {
        ok: false,
        pushed_groups: [],
        skipped_reason: 'invalid_input',
        dedup_signature: '',
      };
    }

    // PR-L emergency stop-loss gate (2026-06-29) — 高 conf 反向, push entry 处直接拦截.
    // dry_run 仍跳过该 gate (UI 预览不受影响). audit 仍写一行留痕便于回查.
    if (!options.dry_run && isEmergencyConfGated(normalized.decision)) {
      logger.warn(
        `[PR-L emergency] skip push for ${normalized.symbol} conf=${normalized.decision.confidence_score} ` +
          `(high conf 反向 — 见 PR-K 30 天回测; 等 conf evaluator 修复)`
      );
      if (options.persist !== false) {
        await this.safePersist(
          normalized,
          (options.target_groups || [OPPORTUNITY_TARGET_GROUPS.BUSINESS]).join(','),
          {
            ok: false,
            dedup_signature: '',
            skipped_reason: EMERGENCY_CONF_GATE_SKIP_REASON,
            pushed_groups: [],
          }
        );
      }
      return {
        ok: false,
        pushed_groups: [],
        skipped_reason: 'emergency_stop_loss_conf_gate',
        dedup_signature: '',
      };
    }

    const now = Number.isFinite(options.now_ms_override)
      ? Number(options.now_ms_override)
      : Date.now();
    const ttl = ttlForTriggerRule(normalized.trigger_rule);
    const signature = buildOpportunitySignature(
      normalized.symbol,
      normalized.trigger_rule,
      normalized.trigger_time?.getTime() || now,
      ttl
    );
    const dryRun = options.dry_run === true;
    const persist = options.persist !== false; // default true
    const targetGroups: OpportunityTargetGroup[] =
      options.target_groups && options.target_groups.length > 0
        ? options.target_groups
        : [OPPORTUNITY_TARGET_GROUPS.BUSINESS];
    const targetGroupsLabel = targetGroups.join(',');

    // ---- (2a) per-rule TTL dedup --------------------------------------------
    const existingBucket = this.dedupBuffer.find(r => r.signature === signature);
    if (existingBucket && !dryRun) {
      const result: PushResult = {
        ok: false,
        pushed_groups: [],
        skipped_reason: 'deduped',
        dedup_signature: signature,
      };
      // 仍写一行审计便于回查 (留痕)
      if (persist) {
        await this.safePersist(normalized, targetGroupsLabel, {
          ok: false,
          dedup_signature: signature,
          skipped_reason: 'deduped',
          pushed_groups: [],
        });
      }
      return result;
    }

    // ---- (2b) circuit breaker checks ---------------------------------------
    // per-symbol 1h cap
    this.symbolHistory = this.symbolHistory.filter(
      r => now - r.pushed_at_ms < PER_SYMBOL_WINDOW_MS
    );
    const sameSymbolCount = this.symbolHistory.filter(
      r => r.symbol === normalized.symbol
    ).length;
    if (sameSymbolCount >= PER_SYMBOL_HOURLY_CAP && !dryRun) {
      logger.warn(
        `[IntradayOpportunityPusher] circuit_breaker per-symbol cap symbol=${normalized.symbol} count=${sameSymbolCount}/${PER_SYMBOL_HOURLY_CAP} 1h`
      );
      const result: PushResult = {
        ok: false,
        pushed_groups: [],
        skipped_reason: 'circuit_breaker',
        dedup_signature: signature,
      };
      if (persist) {
        await this.safePersist(normalized, targetGroupsLabel, {
          ok: false,
          dedup_signature: signature,
          skipped_reason: 'circuit_breaker',
          circuit_breaker_kind: 'per_symbol_cap',
          pushed_groups: [],
        });
      }
      return result;
    }
    // global 1min cap
    this.globalHistory = this.globalHistory.filter(r => now - r.pushed_at_ms < GLOBAL_WINDOW_MS);
    if (this.globalHistory.length >= GLOBAL_MINUTE_CAP && !dryRun) {
      logger.warn(
        `[IntradayOpportunityPusher] circuit_breaker global cap count=${this.globalHistory.length}/${GLOBAL_MINUTE_CAP} 1min`
      );
      const result: PushResult = {
        ok: false,
        pushed_groups: [],
        skipped_reason: 'circuit_breaker',
        dedup_signature: signature,
      };
      if (persist) {
        await this.safePersist(normalized, targetGroupsLabel, {
          ok: false,
          dedup_signature: signature,
          skipped_reason: 'circuit_breaker',
          circuit_breaker_kind: 'global_cap',
          pushed_groups: [],
        });
      }
      return result;
    }

    // ---- (3) build card + sparkline ----------------------------------------
    let sparkline: SparklineResult | null = null;
    if (options.include_chart !== false) {
      sparkline = await this.dataSource.fetchSparkline(normalized.symbol);
    }
    const deeplinkBase =
      options.frontend_base_url ||
      process.env.FRONTEND_BASE_URL ||
      DEFAULT_FRONTEND_BASE;
    const deeplink_url = buildIntradayDeeplink(
      normalized.symbol,
      normalized.source_signal_id,
      deeplinkBase
    );
    const card = buildOpportunityCard(normalized, {
      deeplink_url,
      sparkline,
      include_chart: options.include_chart !== false,
    });

    // ---- (4) dry_run skip (return plan only) -------------------------------
    if (dryRun) {
      return {
        ok: true,
        pushed_groups: targetGroups.map(g => ({
          group: g,
          status: 'dry_run',
          ok: true,
        })),
        skipped_reason: 'dry_run',
        dedup_signature: signature,
        card_payload: card,
        sparkline,
      };
    }

    // ---- (5) fan-out multi-group Promise.allSettled ------------------------
    const groupTasks: Array<Promise<PushedGroupResult[]>> = targetGroups.map(g =>
      this.dispatchGroup(g, options.user_ids || [], card)
    );
    const settled = await Promise.allSettled(groupTasks);
    const pushed_groups: PushedGroupResult[] = [];
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        pushed_groups.push(...s.value);
      } else {
        // dispatchGroup 内已 try/catch, 这里几乎不到; 兜底
        pushed_groups.push({
          group: OPPORTUNITY_TARGET_GROUPS.BUSINESS,
          status: 'send_error',
          ok: false,
          message: `fallback: ${(s.reason as any)?.message || String(s.reason)}`,
        });
      }
    }

    const anySent = pushed_groups.some(g => g.ok && g.status === 'sent');
    const skippedReason: PushResult['skipped_reason'] | undefined = anySent
      ? undefined
      : 'no_webhook';

    // ---- (6) mark dedup + caps (only if at least one sent) ----------------
    if (anySent) {
      this.dedupBuffer = appendDedupRecord(this.dedupBuffer, {
        signature,
        pushed_at_ms: now,
      });
      this.symbolHistory.push({ symbol: normalized.symbol, pushed_at_ms: now });
      this.globalHistory.push({ pushed_at_ms: now });
    }

    // ---- (7) persist audit row (fail-OPEN) --------------------------------
    if (persist) {
      await this.safePersist(normalized, targetGroupsLabel, {
        ok: anySent,
        dedup_signature: signature,
        pushed_groups: pushed_groups.map(g => ({
          group: g.group,
          user_id: g.user_id,
          status: g.status,
          ok: g.ok,
        })),
        ...(skippedReason ? { skipped_reason: skippedReason } : {}),
      });
    }

    return {
      ok: anySent,
      pushed_groups,
      skipped_reason: skippedReason,
      dedup_signature: signature,
      card_payload: card,
      sparkline,
    };
  }

  /**
   * 单群 fan-out — business 走 env webhook, user 遍历 user_ids per-user webhook.
   * 任一 webhook URL 缺失 → warn + 返 no_webhook 不算 fail. 不 throw.
   */
  private async dispatchGroup(
    group: OpportunityTargetGroup,
    user_ids: number[],
    card: any
  ): Promise<PushedGroupResult[]> {
    if (group === OPPORTUNITY_TARGET_GROUPS.BUSINESS) {
      const url = String(process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK || '').trim();
      if (!url) {
        logger.warn(
          '[IntradayOpportunityPusher] business group 缺 FEISHU_RECOMMENDATION_BOT_WEBHOOK, skip'
        );
        return [{ group, status: 'no_webhook', ok: false, message: '缺 webhook URL' }];
      }
      return [await this.safeSend(group, undefined, url, card)];
    }
    if (group === OPPORTUNITY_TARGET_GROUPS.OPS) {
      const url = String(process.env.OPS_ALERT_FEISHU_WEBHOOK || '').trim();
      if (!url) {
        logger.warn('[IntradayOpportunityPusher] ops group 缺 OPS_ALERT_FEISHU_WEBHOOK, skip');
        return [{ group, status: 'no_webhook', ok: false, message: '缺 webhook URL' }];
      }
      return [await this.safeSend(group, undefined, url, card)];
    }
    if (group === OPPORTUNITY_TARGET_GROUPS.USER) {
      if (!Array.isArray(user_ids) || user_ids.length === 0) {
        return [
          {
            group,
            status: 'no_webhook',
            ok: false,
            message: 'target_groups 含 user 但缺 user_ids',
          },
        ];
      }
      const tasks = user_ids.map(async (uid): Promise<PushedGroupResult> => {
        const url = await this.dataSource.loadUserWebhook(uid);
        if (!url) {
          return { group, user_id: uid, status: 'no_webhook', ok: false };
        }
        return this.safeSend(group, uid, url, card);
      });
      const results = await Promise.allSettled(tasks);
      return results.map((r, idx) => {
        if (r.status === 'fulfilled') return r.value;
        return {
          group,
          user_id: user_ids[idx],
          status: 'send_error',
          ok: false,
          message: (r.reason as any)?.message || String(r.reason),
        };
      });
    }
    return [{ group, status: 'no_webhook', ok: false, message: `未知 group: ${group}` }];
  }

  private async safeSend(
    group: OpportunityTargetGroup,
    user_id: number | undefined,
    webhook_url: string,
    card: any
  ): Promise<PushedGroupResult> {
    try {
      const r = await this.dataSource.sendFeishuCard(card, webhook_url);
      if (r && r.success) {
        return {
          group,
          user_id,
          status: 'sent',
          ok: true,
          webhook_response: r.data,
        };
      }
      return {
        group,
        user_id,
        status: 'send_error',
        ok: false,
        message: r?.message || '未知失败',
        webhook_response: r?.data,
      };
    } catch (err: any) {
      logger.warn(
        `[IntradayOpportunityPusher] safeSend group=${group} user=${user_id ?? '-'} 异常: ${
          err?.message || err
        }`
      );
      return {
        group,
        user_id,
        status: 'send_error',
        ok: false,
        message: err?.message || String(err),
      };
    }
  }

  private toAuditRow(
    input: OpportunityInput,
    targetGroupsLabel: string,
    push_result: Record<string, unknown>
  ): AuditRowInput {
    return {
      symbol: input.symbol,
      name: input.name || '',
      trigger_rule: input.trigger_rule,
      trigger_time: input.trigger_time,
      decision: input.decision,
      reasons: input.reasons || [],
      source_signal_id: input.source_signal_id ?? null,
      target_groups: targetGroupsLabel,
      push_result,
    };
  }

  /**
   * persist 包装 — 即使 dataSource.persistAuditRow throw (任何 DI 实现都可能漏 try/catch),
   * 这里再兜底一层 try/catch + warn. 让"主推送 ok 但 audit DB 挂" 仅 warn 不阻塞用户.
   */
  private async safePersist(
    input: OpportunityInput,
    targetGroupsLabel: string,
    push_result: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.dataSource.persistAuditRow(
        this.toAuditRow(input, targetGroupsLabel, push_result)
      );
    } catch (err: any) {
      logger.warn(
        `[IntradayOpportunityPusher] safePersist 兜底 fail-OPEN: ${err?.message || err}`
      );
    }
  }

  /**
   * 查询最近 N 条推送 (基于 in-process buffer); DB 查询 caller 自己用
   * IntradayOpportunityPush model.
   *
   * 用途: 调试 / dashboard live view; 仅看当前进程的 dedup 窗口数据.
   */
  getRecentPushes(
    limit = 50,
    filter?: { symbol?: string; trigger_rule?: string }
  ): DedupRecord[] {
    let buf = [...this.dedupBuffer];
    if (filter?.symbol) {
      buf = buf.filter(r => r.signature.includes(`::${filter.symbol}::`));
    }
    if (filter?.trigger_rule) {
      buf = buf.filter(r => r.signature.includes(`::${filter.trigger_rule}::`));
    }
    return buf.slice(-limit);
  }

  /** 测试 / cron preview 用 — 清空 in-process state */
  resetBuffers(): void {
    this.dedupBuffer = [];
    this.symbolHistory = [];
    this.globalHistory = [];
  }
}

export const intradayOpportunityPusher = new IntradayOpportunityPusher();
