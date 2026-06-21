/**
 * 实盘审计事件枚举。
 *
 * 上线 launch-helper：把散落在各 service 的 audit event_type 字符串集中。
 * 好处：
 *   1. 改名 / 加新事件时 IDE 能 grep 引用，避免 typo 让监控、告警、对账规则失效
 *   2. 监控/告警接入方（飞书机器人、对账脚本、前端筛选）可以引枚举做白名单
 *   3. CI 可以 lint 出散在外的硬编码字面量（见本文件末注释里的 grep 规则）
 *
 * 命名规约：
 *   - 全部小写 + 下划线
 *   - 以 `live_` 开头表示实盘领域
 *   - 子域：`live_kill_switch_*` / `live_order_*` / `live_account_*` / `live_bridge_*`
 *
 * 改动这里时，请同步 docs/live_trading_state_machine.md 的事件名。
 */

export const LIVE_AUDIT_EVENT_TYPES = {
  // ----- Kill switch 生命周期 -----
  KILL_SWITCH_TRIGGERED: 'live_kill_switch_triggered',
  KILL_SWITCH_REPEAT_TRIGGERED: 'live_kill_switch_repeat_triggered',
  KILL_SWITCH_RESOLVED: 'live_kill_switch_resolved',

  // ----- 订单草稿 -----
  ORDER_DRAFT_CREATED: 'live_order_draft_created',
  ORDER_DRAFT_REJECTED: 'live_order_draft_rejected',
  ORDER_DRAFT_APPROVED: 'live_order_draft_approved',
  ORDER_SHADOW_EXECUTED: 'live_order_shadow_executed',
  ORDER_UNATTENDED_REAL_SUBMIT_BLOCKED: 'live_order_unattended_real_submit_blocked',
  ORDER_PRE_SUBMIT_RECHECK_BLOCKED: 'live_order_pre_submit_recheck_blocked',
  // US-015 (EX-001) — ExecutionFeasibility gate 在 approveDraft 内的两个出口.
  // BLOCKED = composite_score < 60 / decision='blocked' 直接拒草稿; WARN = risky 放行留痕.
  ORDER_BLOCKED_BY_FEASIBILITY: 'live_order_blocked_by_feasibility',
  ORDER_FEASIBILITY_WARN: 'live_order_feasibility_warn',
  // US-010 (PR-005) — TradeComplianceChecker pre-trade gate 在 approveDraft 的出口.
  // BLOCKED_BY_COMPLIANCE = severity=high 直接拒; COMPLIANCE_WARN = severity=medium 放行留痕.
  ORDER_BLOCKED_BY_COMPLIANCE: 'live_order_blocked_by_compliance',
  ORDER_COMPLIANCE_WARN: 'live_order_compliance_warn',
  // US-011 (PR-006) — DrawdownCircuitBreaker / pre-trade guard chain 任一不可用 (fail-closed) 拒草稿.
  ORDER_BLOCKED_BY_PRE_TRADE_GATE: 'live_order_blocked_by_pre_trade_gate',

  // ----- 命令队列 / bridge -----
  ORDER_ENQUEUED: 'live_order_enqueued',
  ORDER_ENQUEUE_FAILED: 'live_order_enqueue_failed',
  ORDER_CANCEL_REQUESTED: 'live_order_cancel_requested',
  ORDER_CANCEL_DEDUP: 'live_order_cancel_dedup',
  ORDER_BRIDGE_EXPIRED: 'live_order_bridge_expired',
  BROKER_COMMAND_EXPIRED: 'live_broker_command_expired',
  BRIDGE_REQUEST: 'live_bridge_request',

  // ----- bridge 状态推进（动态前缀） -----
  // 实际值：`live_bridge_status_${appliedStatus}`
  // 其中 appliedStatus 来自 BridgeService.advanceCommandStatus 的 patch.status：
  //   submitted | partially_filled | filled | cancelled | failed | expired
  BRIDGE_STATUS_PREFIX: 'live_bridge_status_',
  BRIDGE_STATUS_SUBMITTED: 'live_bridge_status_submitted',
  BRIDGE_STATUS_PARTIALLY_FILLED: 'live_bridge_status_partially_filled',
  BRIDGE_STATUS_FILLED: 'live_bridge_status_filled',
  BRIDGE_STATUS_CANCELLED: 'live_bridge_status_cancelled',
  BRIDGE_STATUS_FAILED: 'live_bridge_status_failed',
  BRIDGE_STATUS_EXPIRED: 'live_bridge_status_expired',

  // ----- 账户同步 -----
  ACCOUNT_READONLY_SYNCED: 'live_account_readonly_synced',
  ACCOUNT_READONLY_SYNC_FAILED: 'live_account_readonly_sync_failed',

  // ----- 影子预算（与 SchedulerService 联动） -----
  SHADOW_BUDGET_SUGGESTION: 'live_shadow_budget_suggestion',
  SHADOW_BUDGET_APPLIED: 'live_shadow_budget_applied',

  // ----- 影子执行 -----
  SHADOW_AUTOPILOT_DRY_RUN: 'live_shadow_autopilot_dry_run',
  SHADOW_AUTOPILOT_COMPLETED: 'live_shadow_autopilot_completed',
} as const;

export type LiveAuditEventType =
  (typeof LIVE_AUDIT_EVENT_TYPES)[keyof typeof LIVE_AUDIT_EVENT_TYPES];

/**
 * 返回所有已知 event_type 字面量。
 * 用于 lint / 测试 / 监控订阅。
 */
export function listLiveAuditEventTypes(): string[] {
  return Object.values(LIVE_AUDIT_EVENT_TYPES);
}

/**
 * 校验一个 event_type 是否被枚举认可（含动态前缀）。
 * 监控 / 告警 / 飞书机器人订阅可以用它判断是不是要拦的事件。
 */
export function isKnownLiveAuditEvent(eventType: string | null | undefined): boolean {
  if (!eventType) return false;
  const known = new Set<string>(Object.values(LIVE_AUDIT_EVENT_TYPES));
  if (known.has(eventType)) return true;
  // 动态：live_bridge_status_*
  if (eventType.startsWith(LIVE_AUDIT_EVENT_TYPES.BRIDGE_STATUS_PREFIX)) return true;
  return false;
}

/* ----------------------------------------------------------------------------
 * CI lint 建议（CI 跑一遍 grep；不在本文件内执行）：
 *   ! grep -rE "event_type:\s*['\"]live_[a-z_]+['\"]" backend/src \
 *       --exclude-dir=node_modules --exclude-dir=dist \
 *       --exclude=**'/'auditEvents.ts \
 *       --exclude=**'/'*.test.ts \
 *     | grep -v 'LIVE_AUDIT_EVENT_TYPES'
 *
 * 期望输出 0 行。命中即说明又有人在 service 里硬编码 event_type，请改用枚举。
 * -------------------------------------------------------------------------- */
