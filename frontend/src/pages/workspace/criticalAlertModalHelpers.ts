/**
 * US-074 [FE-035] CriticalAlertModal — 强制弹窗 pure helpers.
 *
 * 目的:
 *   - 任何"严重风控告警"在 [[useAlertsRealtime]] 实时推送 (alert.new) 或 polling
 *     兜底场景下抵达前端时, 主动弹出 antd Modal 阻塞用户操作, 必须点击 "我已知悉"
 *     才能继续 — 与 Bell Badge (US-070) / AlertsPanel (US-071) 的"被动展示" 形成
 *     对偶 (推 vs 拉, 强制 vs 浏览).
 *   - 真正决定"哪些告警值得强制弹窗"的判定全部在本 helper 内, JSX 与 hook 都只
 *     消费 view-model, 与 [[alertsBellHelpers]] / [[shadowRunHelpers]]
 *     "前端 pure helper 范式"一脉相承.
 *
 * Critical 判定背景 (US-005 RiskAlertService 落库语义):
 *   - DB `RiskAlert.level` 只持久化 'HIGH' | 'MEDIUM' | 'LOW' 三档, 不写
 *     'CRITICAL' (severity→level 映射表 critical/high 同落 'HIGH').
 *   - broadcaster.ts buildBroadcastPayload 把 level 强制 toUpperCase, 前端永远
 *     看到 'HIGH' 而不是 'critical'.
 *   - 因此前端没办法仅靠 level === 'CRITICAL' 区分; 改用 (level === 'HIGH'
 *     AND rule_id ∈ CRITICAL_RULE_IDS) ∪ (symbol startsWith 'SYSTEM:') 启发式.
 *     允许后端未来落 'CRITICAL' (向上扩展兼容) 也走 critical 分支.
 *
 * 边界:
 *   - dedup 用 sessionStorage 持久化 acknowledged_alert_id 集合, 同 session 内
 *     用户切页面 / Bell 已经标记已读 / Modal 已确认过 → 不二次弹.
 *   - 单 session 累积 ack 上限 ACK_CACHE_MAX = 500 (FIFO 淘汰), 防止长会话
 *     storage 无界增长 (与 backend MAX_CLIENTS_PER_USER 防泄漏同思想).
 *   - sessionStorage 不可用 (无 window / 隐私模式) → 全部走内存 fallback, 不抛错.
 *
 * 单测策略:
 *   - 本文件 100% pure (零 React / 零 DOM / 零 fetch), 跨 monorepo 单测从
 *     backend/tests/services/critical-alert-modal-helpers.test.ts 直接 import
 *     (与 alertsBellHelpers / alertsRealtimeClient 同款 ts-node 范式).
 *   - 真 Modal 渲染留浏览器手工 smoke.
 */

import type { AlertsRealtimeMessage } from '../../services/alertsRealtimeClient';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * rule_id 白名单 — 命中即视为 critical 触发强制弹窗.
 *
 * 收录依据:
 *   - drawdown_breaker (US-011 PR-006 账户级 dd 熔断, 触发说明已 fail-CLOSED 拒单)
 *   - position_limit (US-010/US-047 仓位上限, 突破后 backend 已拒新单)
 *   - black_swan (US-013 PR-008 黑天鹅事件 — ST/退市/重大诉讼)
 *   - per_stock_stop_loss (US-058 个股止损线, 必须用户感知去手工平仓)
 *   - kill_switch (US-068 策略 kill-switch 触发, 需用户立即决策)
 *   - reconciliation (US-017 对账 alignment_score 异常, 实盘 bridge 已暂停)
 *   - restricted_share_unlock (US-014 限售解禁前 5 日提示, 仓位减半建议)
 *
 * 反例 (故意不收, 走 Bell + Panel 即可, 不强制弹):
 *   - trailing_stop (常规移动止盈, 用户无需立即决策)
 *   - market_regime_alert (大盘环境提示, 信息性)
 *   - factor_correlation (因子相关性, 研究侧)
 *   - industry_concentration (行业集中度, 再平衡时自然处理)
 */
export const CRITICAL_RULE_IDS: ReadonlyArray<string> = Object.freeze([
  'drawdown_breaker',
  'position_limit',
  'black_swan',
  'per_stock_stop_loss',
  'kill_switch',
  'reconciliation',
  'restricted_share_unlock',
]);

/**
 * symbol 前缀白名单 — backend 用 SYSTEM:XXX 表示系统级 (与单股无关) 严重告警.
 * 命中即 critical, 即使 rule_id 未列入 CRITICAL_RULE_IDS.
 *
 * 收录依据 (US-011 GUARD_LABELS):
 *   - SYSTEM:RISK_GUARD_UNAVAILABLE — 任何 guard 不可用 (fail-CLOSED 已拒单)
 *   - SYSTEM:BRIDGE_DOWN — 实盘 bridge 失联 (KillSwitch 已触发)
 */
export const CRITICAL_SYMBOL_PREFIXES: ReadonlyArray<string> = Object.freeze(['SYSTEM:']);

/** 强制弹窗最多排队的待 ack 告警 — 防止用户离开过夜 N 百条全排进 modal. */
export const CRITICAL_MODAL_MAX_QUEUE = 5;

/** session 内 ack 缓存上限 — FIFO 淘汰防 storage 无界增长. */
export const ACK_CACHE_MAX = 500;

/** sessionStorage key — 与 [[sessionCleanup]] 注册的所有 key 同前缀便于 logout 一键清. */
export const ACK_CACHE_SESSION_KEY = 'criticalAlertModal_acked_v1';

/** 模态弹窗主标题 — 中文用户视觉锚点. */
export const CRITICAL_MODAL_TITLE = '⚠ 严重风控告警';

/** 强制 ack 按钮文案 — 比"确认"更强语气, 让用户清楚此动作 = 我已读且承担后果. */
export const CRITICAL_MODAL_OK_TEXT = '我已知悉';

// ---------------------------------------------------------------------------
// View model types
// ---------------------------------------------------------------------------

/**
 * 强制弹窗 view model — 渲染层只读这一个对象, 不再消费 raw realtime payload.
 */
export interface CriticalAlertViewModel {
  alert_id: number;
  user_id: number;
  symbol: string;
  level: string;
  message: string;
  rule_id: string | null;
  ruleLabel: string;
  createdAtIso: string | null;
  /** 人类可读简要描述 — 头部标题旁副标题用. */
  headline: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — critical detection
// ---------------------------------------------------------------------------

/**
 * 判定 RealtimeAlertsMessage 是否触发强制弹窗.
 *
 * 决策表 (任一命中即 true):
 *   - alert_id 必须为正整数 (无 id 没法 markRead);
 *   - level === 'CRITICAL' (后端未来兼容);
 *   - level === 'HIGH' AND rule_id ∈ CRITICAL_RULE_IDS;
 *   - symbol startsWith CRITICAL_SYMBOL_PREFIXES (e.g. 'SYSTEM:');
 *   - 其它一律 false (Bell + Panel 已覆盖).
 */
export function isCriticalAlert(msg: AlertsRealtimeMessage | null | undefined): boolean {
  if (!msg || msg.type !== 'alert.new') return false;
  if (typeof msg.alert_id !== 'number' || !Number.isFinite(msg.alert_id) || msg.alert_id <= 0) {
    return false;
  }
  const level = String(msg.level || '').toUpperCase();
  const ruleId = String((msg.rule_id as string | undefined) || '').toLowerCase();
  const symbol = String(msg.symbol || '');

  // 前缀命中 — 系统级告警永远 critical, 与 level 无关 (兜底防 backend 漏标 HIGH).
  for (const prefix of CRITICAL_SYMBOL_PREFIXES) {
    if (symbol.startsWith(prefix)) return true;
  }

  if (level === 'CRITICAL') return true;
  if (level === 'HIGH' && ruleId && CRITICAL_RULE_IDS.includes(ruleId)) return true;
  return false;
}

/**
 * 把 rule_id 翻译成中文 label — modal 标题副语 + tag 显示用.
 * 未知 rule_id 返 rule_id 本身 (而非 '其它'), 让用户至少看到原始 key 便于报修.
 */
export function ruleIdToLabel(ruleId: string | null | undefined): string {
  const key = String(ruleId || '').toLowerCase();
  switch (key) {
    case 'drawdown_breaker':
      return '账户回撤熔断';
    case 'position_limit':
      return '仓位上限';
    case 'black_swan':
      return '黑天鹅事件';
    case 'per_stock_stop_loss':
      return '个股止损';
    case 'kill_switch':
      return '策略 kill-switch';
    case 'reconciliation':
      return '对账异常';
    case 'restricted_share_unlock':
      return '限售解禁';
    case 'trailing_stop':
      return '移动止盈止损';
    case 'industry_concentration':
      return '行业集中度';
    case 'market_regime_alert':
      return '大盘环境';
    case 'factor_correlation':
      return '因子相关性';
    default:
      return key ? key : '风控告警';
  }
}

/**
 * 拼 modal 顶部副标题 — 让用户一眼知道"是哪只股 + 哪个规则触发".
 *
 * 形态:
 *   - SYSTEM:XXX 类: 'XXX · <ruleLabel>'
 *   - 普通股: '<symbol> · <ruleLabel>'
 *   - 缺 symbol: '<ruleLabel>'
 */
export function buildCriticalAlertHeadline(input: {
  symbol?: string | null;
  rule_id?: string | null;
}): string {
  const symbol = String(input.symbol || '').trim();
  const label = ruleIdToLabel(input.rule_id);
  if (symbol.startsWith('SYSTEM:')) {
    return `${symbol.replace(/^SYSTEM:/, '')} · ${label}`;
  }
  if (symbol) return `${symbol} · ${label}`;
  return label;
}

/**
 * 把 raw realtime payload 归一化成 view model.
 * 返 null 表示数据不够 (无 alert_id) — caller 应跳过.
 */
export function buildCriticalAlertViewModel(
  msg: AlertsRealtimeMessage | null | undefined
): CriticalAlertViewModel | null {
  if (!msg) return null;
  if (typeof msg.alert_id !== 'number' || !Number.isFinite(msg.alert_id) || msg.alert_id <= 0) {
    return null;
  }
  const symbol = String(msg.symbol || '');
  const rule_id = msg.rule_id ? String(msg.rule_id) : null;
  const created_at = typeof (msg as any).created_at === 'string' ? (msg as any).created_at : null;
  return {
    alert_id: Math.floor(msg.alert_id),
    user_id: typeof msg.user_id === 'number' && Number.isFinite(msg.user_id) ? msg.user_id : 0,
    symbol,
    level: String(msg.level || '').toUpperCase(),
    message: String(msg.message || ''),
    rule_id,
    ruleLabel: ruleIdToLabel(rule_id),
    createdAtIso: created_at,
    headline: buildCriticalAlertHeadline({ symbol, rule_id }),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — queue management
// ---------------------------------------------------------------------------

/**
 * 把新 view model 加入待 ack 队列.
 *
 * 规则:
 *   - 重复 alert_id 自动 dedup (Modal 已经在显示同一条不允许再排一次);
 *   - 超过 CRITICAL_MODAL_MAX_QUEUE → 砍掉尾部老的 (保留最新), 与 acked 缓存 FIFO
 *     淘汰相反方向是有意 — 用户更关心最新告警而非历史堆积;
 *   - 已被 acked 的 alert_id (ackedSet) 直接 skip.
 */
export function enqueueCriticalAlert(
  queue: ReadonlyArray<CriticalAlertViewModel>,
  next: CriticalAlertViewModel,
  ackedSet: ReadonlySet<number>
): CriticalAlertViewModel[] {
  if (ackedSet.has(next.alert_id)) return queue.slice();
  if (queue.some(item => item.alert_id === next.alert_id)) return queue.slice();
  const merged = queue.concat([next]);
  if (merged.length <= CRITICAL_MODAL_MAX_QUEUE) return merged;
  // 砍头部 (老的)、保留尾部 (新的)
  return merged.slice(merged.length - CRITICAL_MODAL_MAX_QUEUE);
}

/** 从队列取下一条 — Modal close 时 caller 用 [next, rest] 解构. */
export function popCriticalAlert(
  queue: ReadonlyArray<CriticalAlertViewModel>
): [CriticalAlertViewModel | null, CriticalAlertViewModel[]] {
  if (!queue || queue.length === 0) return [null, []];
  const [head, ...rest] = queue;
  return [head, rest];
}

// ---------------------------------------------------------------------------
// Pure helpers — sessionStorage-backed ack cache
// ---------------------------------------------------------------------------

/**
 * 读 sessionStorage ack 缓存. 失败 / 不可用 / 损坏 JSON / 不是数组 → 返空 Set
 * (fail-OPEN 与 alertsRealtimeClient.fetchUnreadCount 同思想 — 缓存不可用不该让 modal 退化成永不弹).
 */
export function loadAckedAlertIds(storage?: Pick<Storage, 'getItem'> | null): Set<number> {
  const s = storage === undefined ? safeSessionStorage() : storage;
  if (!s) return new Set<number>();
  try {
    const raw = s.getItem(ACK_CACHE_SESSION_KEY);
    if (!raw) return new Set<number>();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<number>();
    const out = new Set<number>();
    for (const v of parsed) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        out.add(Math.floor(v));
      }
    }
    return out;
  } catch {
    return new Set<number>();
  }
}

/**
 * 把 alert_id 追加到 ack 缓存 (FIFO cap ACK_CACHE_MAX) 并持久化.
 * 失败静默 (fail-OPEN, 与 load 同).
 */
export function recordAckedAlertId(
  alertId: number,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
): Set<number> {
  const s = storage === undefined ? safeSessionStorage() : storage;
  const current = loadAckedAlertIds(s as Pick<Storage, 'getItem'>);
  if (!Number.isFinite(alertId) || alertId <= 0) return current;
  if (current.has(alertId)) return current;
  current.add(Math.floor(alertId));
  // FIFO cap
  if (current.size > ACK_CACHE_MAX) {
    const arr = Array.from(current);
    const trimmed = arr.slice(arr.length - ACK_CACHE_MAX);
    current.clear();
    trimmed.forEach(v => current.add(v));
  }
  if (s) {
    try {
      s.setItem(ACK_CACHE_SESSION_KEY, JSON.stringify(Array.from(current)));
    } catch {
      /* quota exceeded / 隐私模式 — 静默 fail-OPEN, 内存仍准 */
    }
  }
  return current;
}

/**
 * 返 globalThis.sessionStorage 兼容引用. 不可用返 null.
 * 抽出来便于单测注入 fake.
 */
function safeSessionStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.sessionStorage) return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}
