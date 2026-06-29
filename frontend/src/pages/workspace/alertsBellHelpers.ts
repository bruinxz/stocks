/**
 * US-070 [FE-031] AlertsBell 顶 nav bar — 纯函数 helper.
 *
 * 让用户在任何 workspace 都能在右上角 Header 一眼看到风控告警未读数,
 * 点击 Bell 跳到 `/workspace/today` 并落到 "风控中心" tab. 与 backend
 * `/api/risk-alerts/list` 的 `unread_count` 字段对齐 — 本组件只显示数字,
 * 不展示告警内容 (内容详情仍属 RiskAlertCenterPanel / 未来 US-071
 * AlertsPanel 的职责).
 *
 * 数据形态:
 *   - source: GET /api/risk-alerts/list?limit=1 → listRiskAlerts({limit:1})
 *     返 `RiskAlertListResponse.unread_count`. limit=1 让响应 body 极小 (≈ 200B)
 *     适合 60s 高频轮询 — 我们只关心 unread_count 不关心 items.
 *   - 后续 US-073 切到 WebSocket /ws/alerts 推送, 本 helper 的 formatXxx
 *     工具仍复用 (badge 显示规则与传输方式正交).
 *
 * 设计原则 (与 [[strategyKillSwitchHelpers]] / [[shadowRunHelpers]] 同款"前端 pure helper 模板"):
 *   - 任何"决策表 / 阈值 / 格式化"全抽到本文件, JSX 永远只读 helper 返值不算逻辑.
 *   - 阈值常量 export 让单测可直接 import 守 sanity (e.g. CRITICAL_UNREAD_THRESHOLD < MAX_BADGE_COUNT).
 *   - null / undefined / NaN / 负数 全部兜底成"安全态" (0 未读 + dot=false) 不报错.
 *   - 轮询间隔常量 export — caller 用 window.setInterval(load, DEFAULT_POLL_INTERVAL_MS),
 *     单测可断言常量在合理范围 [30s, 5min] 防误改 (太短 DDoS backend, 太长用户感知滞后).
 *
 * 纯函数, 不依赖 React / antd / fetch. 单测在
 * backend/tests/services/alerts-bell-helpers.test.ts (跨 monorepo import).
 */

/** Badge 显示上限 — antd Badge.count 超过此值显示 "99+". */
export const MAX_BADGE_COUNT = 99;

/** 未读 ≥ 该阈值时 Badge 变红 (status='error') — 超过算"高频告警, 必看". */
export const CRITICAL_UNREAD_THRESHOLD = 10;

/** 默认轮询间隔 (ms) — 60s, 与 backend /risk-alerts/list 后端 cron 5min 节奏对齐 (用户感知 ≤ 1min). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/** 最小允许轮询间隔 — 防止某 caller 误传 1s DDoS 后端. */
export const MIN_POLL_INTERVAL_MS = 30_000;

/** 最大允许轮询间隔 — 防止某 caller 误传 1h 让 badge 完全失效. */
export const MAX_POLL_INTERVAL_MS = 300_000;

/** Badge 颜色档 — 与 antd Badge `status` 字段对齐. */
export type AlertsBellSeverity = 'none' | 'normal' | 'critical';

/**
 * 把任意 input 规范化为 ≥ 0 整数未读数.
 *
 * 兜底规则:
 *   - null / undefined / NaN / 非 number → 0
 *   - 负数 → 0 (不可能负, 防 backend 算错负值泄漏)
 *   - 小数 → Math.floor (告警条数是整数)
 *   - Infinity → MAX_BADGE_COUNT (兜底防溢出)
 */
export function normalizeUnreadCount(input: unknown): number {
  if (typeof input !== 'number') return 0;
  if (!Number.isFinite(input)) return input > 0 ? MAX_BADGE_COUNT : 0;
  if (input <= 0) return 0;
  return Math.floor(input);
}

/**
 * 按未读数返 Badge severity.
 *
 * 决策表:
 *   - count === 0          → 'none'      (UI 显示空心 Bell, 不显示数字)
 *   - 0 < count < CRITICAL → 'normal'    (蓝色 Badge — antd 默认)
 *   - count >= CRITICAL    → 'critical'  (红色 Badge — antd status='error')
 */
export function classifyAlertsBellSeverity(count: number): AlertsBellSeverity {
  const safe = normalizeUnreadCount(count);
  if (safe <= 0) return 'none';
  if (safe >= CRITICAL_UNREAD_THRESHOLD) return 'critical';
  return 'normal';
}

/**
 * 把未读数格式化为 Badge 显示字符串.
 *
 * 规则:
 *   - 0 → '' (空字符串, caller 把 Badge.showZero=false 让 dot 隐藏)
 *   - 1..99 → 数字本身
 *   - >= 100 → '99+'
 */
export function formatBadgeText(count: number): string {
  const safe = normalizeUnreadCount(count);
  if (safe <= 0) return '';
  if (safe > MAX_BADGE_COUNT) return `${MAX_BADGE_COUNT}+`;
  return String(safe);
}

/**
 * Tooltip 文案 — Bell 悬停时显示, 让用户不点也能感知状态.
 *
 * 规则:
 *   - 0     → '当前无未读告警'
 *   - 1..   → 'N 条未读告警 · 点击查看'
 *   - >=10  → 'N 条未读告警 · 高频告警, 建议立即查看'
 */
export function buildBellTooltip(count: number): string {
  const safe = normalizeUnreadCount(count);
  const severity = classifyAlertsBellSeverity(safe);
  if (severity === 'none') return '当前无未读告警';
  if (severity === 'critical') return `${safe} 条未读告警 · 高频告警, 建议立即查看`;
  return `${safe} 条未读告警 · 点击查看`;
}

/**
 * 校验 + clamp 轮询间隔到 [MIN, MAX] 范围.
 *
 * - 非 number / NaN / Infinity → DEFAULT_POLL_INTERVAL_MS
 * - < MIN → MIN
 * - > MAX → MAX
 * - 合法 → 原值
 */
export function clampPollInterval(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  if (input < MIN_POLL_INTERVAL_MS) return MIN_POLL_INTERVAL_MS;
  if (input > MAX_POLL_INTERVAL_MS) return MAX_POLL_INTERVAL_MS;
  return Math.floor(input);
}

/**
 * 点击 Bell 后的目标路径 — 风控中心 sub-tab in TodayWorkspace.
 *
 * 抽成常量 + helper 让单测能守"点击落点不会被未来 refactor 改错地方".
 * 与 [[strategyKillSwitchHelpers]] 同款"路径单一事实源"思想.
 */
export const ALERTS_BELL_TARGET_PATH = '/workspace/today';
export const ALERTS_BELL_TARGET_TAB_KEY = 'risk_center';

/**
 * 完整目标 URL — caller 用 navigate(buildAlertsBellHref()) 即可.
 *
 * TodayWorkspace 用 `?tab=<key>` query string 接 sub-tab 切换 (与 SettingsWorkspace
 * 模式一致). 已存在 tab 不被 query 覆盖 — 这与 useEffect 内 `searchParams.get('tab')`
 * 一次性应用语义对齐.
 */
export function buildAlertsBellHref(): string {
  return `${ALERTS_BELL_TARGET_PATH}?tab=${ALERTS_BELL_TARGET_TAB_KEY}`;
}

/**
 * 普通用户的目标路径 — PortfolioWorkspace "我的提醒" tab.
 *
 * PR-C 风控中心 v2: admin 仍落 TodayWorkspace risk_center (含 6 tab 全部 admin 工具),
 * 普通用户落 PortfolioWorkspace?tab=alerts (持仓 view 默认 + 仅看自己关心的告警).
 * 后者复用同款 RiskAlertCenterPanel 组件, 仅传不同 initialView + positionSymbols.
 *
 * 抽 const 让单测能守 "未来 refactor 改路径不会偷偷把普通用户带到 admin 页".
 */
export const ALERTS_BELL_USER_TARGET_PATH = '/workspace/portfolio';
export const ALERTS_BELL_USER_TARGET_TAB_KEY = 'alerts';

/**
 * 普通用户的完整目标 URL.
 *
 * Caller 用 navigate(buildAlertsBellHrefForUser()) 即可.
 */
export function buildAlertsBellHrefForUser(): string {
  return `${ALERTS_BELL_USER_TARGET_PATH}?tab=${ALERTS_BELL_USER_TARGET_TAB_KEY}`;
}

/**
 * 按角色取目标 URL — admin → 风控中心 (含全部规则), 其它 → 我的提醒 (按持仓过滤).
 *
 * isAdmin 缺省 / undefined / null → 普通用户 (默认更保守, 避免把普通用户误带到 admin 页).
 */
export function buildAlertsBellHrefForRole(isAdmin: boolean | null | undefined): string {
  return isAdmin === true ? buildAlertsBellHref() : buildAlertsBellHrefForUser();
}
