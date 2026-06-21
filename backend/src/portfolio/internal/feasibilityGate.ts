/**
 * feasibilityGate.ts — US-015 (EX-001) 统一 ExecutionFeasibility pre-trade gate.
 *
 * 背景:
 *   ExecutionFeasibilityService (Sprint 1B) 给一笔候选订单算 4 个子分量
 *   (limit_proximity / volume_coverage / spread / status) 加权得 composite_score
 *   ∈ [0, 100], decision ∈ {fillable, risky, blocked}. 之前仅
 *   PaperTradingAutomationService.autoBuyFromSignals 一处接入, UI 手动 BUY /
 *   RebalanceEngine / CompositeRebalanceService / 实盘 bridge 审批均无 gate.
 *
 *   US-015 AC 要求 "composite_score < 60 不下单 + 接到 PaperTradingFacade + Bridge".
 *   本 helper 抽出三处共享的 gate 调用 / alert / audit 模板, 避免 inline 漂移.
 *
 * 决策矩阵 (gate vs service decision):
 *
 *   service decision='blocked'                                   → gate.ok=false MEDIUM 告警
 *   service composite_score < FEASIBILITY_BLOCK_THRESHOLD (60)   → gate.ok=false MEDIUM 告警
 *   service decision='risky' 且 composite_score ≥ 60             → gate.ok=true  LOW 告警 (放行留痕)
 *   service decision='fillable'                                  → gate.ok=true  无告警
 *
 *   注意: ExecutionFeasibilityService 内部阈值 (FILLABLE_THRESHOLD=70 / BLOCKED_THRESHOLD=30)
 *   保持不变 — 改 service 阈值会影响 automation 链路 + dashboard 历史聚合.
 *   gate 层加一道 60 cutoff 是 US-015 显式 AC, 严格按"< 60 不下单"实现 (60.0 严格放行).
 *
 * 设计契约:
 *   - DataSource DI seam: 可注入 fake service + alert sink, 单测脱离 DB / 网络
 *   - 纯函数 helpers 全 export: deriveFeasibilityGateOutcome / buildFeasibilityGateMessage
 *   - fail-OPEN: feasibility 计算抛错时 gate 默认放行 (logger.warn), 与
 *     PaperTradingAutomationService.autoBuyFromSignals 已生效的契约一致
 *   - **不**走 wrapFailClosed (US-011) — feasibility 是 wizard 软规则, 非
 *     fail-CLOSED 风控守卫; service 内部已 try/catch 兜底返 'blocked' 不抛
 *
 * 三入口接入清单 (任一新加 BUY 链路都该走本 helper, 别再 inline):
 *   1. PaperTradingFacade._placeOrderInner BUY 路径 (UI 手动 / Rebalance / CompositeRebalance)
 *   2. LiveTradingService.approveDraft (实盘 bridge 命令发送前)
 *   3. PaperTradingAutomationService.autoBuyFromSignals (历史既有, 沿用 inline 调
 *      computeFeasibility 不切换 — automation 用 service decision 而非 gate cutoff,
 *      因为 risky 仍要放行让 sizing 决策, 与 facade/bridge 用户体感语义不同)
 *
 *  对照 US-010 (PR-005 compliance 三入口) / US-011 (PR-006 risk guard fail-CLOSED) —
 *  三套独立 gate 并行保留, 不强行合并为一个 mega-gate. 触发场景 / 受众 / alert
 *  形态各异, 合并会让告警可追溯性下降.
 */

import { logger } from '../../utils/logger';
import {
  executionFeasibilityService,
  ExecutionFeasibilityReport,
  MarketSnapshot,
} from '../../services/execution/ExecutionFeasibilityService';
import { riskAlertService, RISK_ALERT_SEVERITY } from '../../services/RiskAlertService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * US-015 (EX-001) AC: composite_score < FEASIBILITY_BLOCK_THRESHOLD → 拒单.
 * 严格 < (60.0 放行) — 与 PRD 验收文本 "score < 60" 字面对齐.
 *
 * **不要改这个常量** — 改了让 facade/bridge gate 行为漂移, 也会让
 * tests/portfolio/feasibility-gate.test.ts 的 AC 守卫立挂.
 */
export const FEASIBILITY_BLOCK_THRESHOLD = 60;

/**
 * Alert rule_id — 在 RiskAlert.rule_id / dispatcher dedup signature 里都用同一个,
 * 避免 facade 一处叫 'feasibility' 另一处叫 'execution_feasibility' 让 dedup 失效.
 */
export const FEASIBILITY_GATE_RULE_ID = 'execution_feasibility';

/** RiskAlert.name 模板里的人类标签 — 与 RiskGuardFailClosed.GUARD_LABELS 风格一致. */
export const FEASIBILITY_GATE_LABEL = '可行性 gate';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeasibilityGateAlertLevel = 'LOW' | 'MEDIUM';

export interface FeasibilityGateInput {
  user_id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  target_qty: number;
  target_price?: number | null;
  /** YYYY-MM-DD; 缺省 = today (Asia/Shanghai 视角的 UTC date 已经足够 day-level 精度) */
  as_of_date?: string;
  /**
   * 已知行情快照 — caller (facade / automation) 通常有更新鲜的实时 quote,
   * 缺省走 service DataSource 自己 fetch DailyBar (有 fallback 到 Stock.current_price).
   */
  market_snapshot?: MarketSnapshot;
  /**
   * 是否持久化到 ExecutionFeasibilityRecord 表; 默认 true, 让 dashboard +
   * MetaLabel preCheckFeasibilityScore 都能消费历史. 仅 unit-test 可关.
   */
  persist?: boolean;
}

export interface FeasibilityGateResult {
  /** 是否放行下单. false → caller 必须 throw EXECUTION_FEASIBILITY_BLOCKED */
  ok: boolean;
  decision: 'fillable' | 'risky' | 'blocked';
  composite_score: number;
  block_reasons: string[];
  /** 人类可读 reason — 用于 throw error.message / audit metadata */
  reason: string;
  /**
   * 是否需要 emit RiskAlert. undefined = 不报警 (fillable 路径).
   * MEDIUM = 拒单告警 (写 inbox), LOW = 放行留痕告警.
   */
  alert_level?: FeasibilityGateAlertLevel;
  /** 完整 feasibility report — caller 可塞进 audit metadata / error.detail */
  report: ExecutionFeasibilityReport;
}

export interface FeasibilityGateOptions {
  /**
   * DataSource DI seam: 单测注入 fake feasibility service.
   * 默认走 production singleton executionFeasibilityService.
   */
  computeFeasibility?: typeof executionFeasibilityService.computeFeasibility;
  /**
   * 当 service throw 时是否 fail-OPEN. true (default) = 放行 + log warn;
   * false = 抛出 (仅供测试 fail-CLOSED 语义).
   */
  fail_open_on_error?: boolean;
}

export interface FeasibilityGateAlertInput {
  user_id: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  result: FeasibilityGateResult;
  /** caller 标签 — 用于 alert metadata + log, 例如 'facade.placeOrder' */
  callerLabel: string;
}

export interface FeasibilityGateAlertOptions {
  /**
   * DataSource DI seam: 单测注入 fake riskAlertService.
   * 默认走 production singleton riskAlertService.
   */
  writeRiskAlert?: typeof riskAlertService.write;
}

// ---------------------------------------------------------------------------
// Pure helpers (全 export 便于单测)
// ---------------------------------------------------------------------------

/**
 * 给定 service report, 派生 gate 输出 (纯函数, 无 IO).
 *
 * 决策表见文件顶部注释; 60.0 严格放行 (>= 60).
 */
export function deriveFeasibilityGateOutcome(
  report: ExecutionFeasibilityReport
): Pick<FeasibilityGateResult, 'ok' | 'reason' | 'alert_level'> {
  const score = Number(report.composite_score);
  const decision = report.decision;
  if (decision === 'blocked') {
    return {
      ok: false,
      alert_level: 'MEDIUM',
      reason: buildFeasibilityGateMessage(report, 'blocked_by_decision'),
    };
  }
  if (Number.isFinite(score) && score < FEASIBILITY_BLOCK_THRESHOLD) {
    return {
      ok: false,
      alert_level: 'MEDIUM',
      reason: buildFeasibilityGateMessage(report, 'score_below_threshold'),
    };
  }
  if (decision === 'risky') {
    return {
      ok: true,
      alert_level: 'LOW',
      reason: buildFeasibilityGateMessage(report, 'risky_passed'),
    };
  }
  return {
    ok: true,
    alert_level: undefined,
    reason: buildFeasibilityGateMessage(report, 'fillable'),
  };
}

/**
 * 构造 reason / message — 把 score + block_reasons + side/symbol 拼成一句话.
 * 给 alert.message / error.message / audit metadata 共用.
 */
export function buildFeasibilityGateMessage(
  report: ExecutionFeasibilityReport,
  variant: 'blocked_by_decision' | 'score_below_threshold' | 'risky_passed' | 'fillable'
): string {
  const score = Number(report.composite_score);
  const scoreText = Number.isFinite(score) ? score.toFixed(1) : 'N/A';
  const reasonsText =
    report.block_reasons && report.block_reasons.length > 0
      ? `, 原因: ${report.block_reasons.join(',')}`
      : '';
  const symbol = report.symbol || '—';
  const side = report.side;
  switch (variant) {
    case 'blocked_by_decision':
      return `${symbol} ${side} 可行性硬约束触发 (score=${scoreText})${reasonsText}`;
    case 'score_below_threshold':
      return `${symbol} ${side} 可行性评分 ${scoreText} < ${FEASIBILITY_BLOCK_THRESHOLD} 阈值, 拒单${reasonsText}`;
    case 'risky_passed':
      return `${symbol} ${side} 可行性偏低 (score=${scoreText}), 放行但留痕`;
    case 'fillable':
      return `${symbol} ${side} 可行性通过 (score=${scoreText})`;
  }
}

// ---------------------------------------------------------------------------
// Main gate entry
// ---------------------------------------------------------------------------

/**
 * evaluateFeasibilityGate — caller 入口.
 *
 * 行为:
 *   - 调 ExecutionFeasibilityService.computeFeasibility (注入 market_snapshot 优先)
 *   - 按 deriveFeasibilityGateOutcome 决策
 *   - service throw → fail-OPEN 默认放行 + 返 synthetic 'fillable' report (score=0)
 *     让 caller 主流程不被告警链阻塞 (与 PR-005 compliance / PR-006 risk guards 同款)
 *
 * caller 用法:
 *   const r = await evaluateFeasibilityGate({ user_id, symbol, side: 'BUY', target_qty, target_price, market_snapshot });
 *   if (!r.ok) {
 *     await emitFeasibilityGateAlert({ user_id, symbol, side: 'BUY', result: r, callerLabel: 'facade.placeOrder' });
 *     const err: any = new Error(`ExecutionFeasibility 拒单: ${r.reason}`);
 *     err.code = 'EXECUTION_FEASIBILITY_BLOCKED';
 *     err.statusCode = 400;
 *     err.detail = { decision: r.decision, composite_score: r.composite_score, block_reasons: r.block_reasons };
 *     throw err;
 *   }
 *   if (r.alert_level === 'LOW') await emitFeasibilityGateAlert({...});
 */
export async function evaluateFeasibilityGate(
  input: FeasibilityGateInput,
  options: FeasibilityGateOptions = {}
): Promise<FeasibilityGateResult> {
  const compute = options.computeFeasibility
    ? options.computeFeasibility.bind(executionFeasibilityService)
    : executionFeasibilityService.computeFeasibility.bind(executionFeasibilityService);
  const failOpenOnError = options.fail_open_on_error !== false;
  const as_of_date = input.as_of_date || new Date().toISOString().slice(0, 10);

  let report: ExecutionFeasibilityReport;
  try {
    report = await compute(
      {
        user_id: input.user_id,
        symbol: input.symbol,
        side: input.side,
        target_qty: input.target_qty,
        target_price: input.target_price ?? null,
        as_of_date,
        market_snapshot: input.market_snapshot,
      },
      {
        persist: input.persist !== false,
        // 与 PaperTradingAutomationService 沿用同款 Almgren-Chriss 开关 — env 一刀切关掉时全链路退 v1
        use_almgren_chriss: process.env.ALMGREN_CHRISS_ENABLED !== 'false',
      }
    );
  } catch (err: any) {
    if (!failOpenOnError) throw err;
    logger.warn(
      `[feasibility-gate] computeFeasibility threw (fail-open放行) for ${input.symbol} ${
        input.side
      }: ${err?.message || err}`
    );
    const synthetic: ExecutionFeasibilityReport = {
      symbol: input.symbol,
      side: input.side,
      target_qty: input.target_qty,
      target_price: input.target_price ?? null,
      as_of_date,
      composite_score: 0,
      limit_proximity_score: null,
      volume_coverage_score: null,
      spread_score: null,
      status_score: null,
      decision: 'fillable',
      block_reasons: [],
      summary: `ℹ️ ${input.symbol} feasibility 计算失败, fail-OPEN 放行`,
      metadata: { error: String(err?.message || err) },
      persisted_id: null,
      generated_at: new Date(),
    };
    return {
      ok: true,
      decision: 'fillable',
      composite_score: 0,
      block_reasons: [],
      reason: `${input.symbol} ${input.side} feasibility 计算失败, fail-OPEN 放行`,
      alert_level: undefined,
      report: synthetic,
    };
  }

  const derived = deriveFeasibilityGateOutcome(report);
  return {
    ok: derived.ok,
    decision: report.decision,
    composite_score: Number(report.composite_score) || 0,
    block_reasons: report.block_reasons || [],
    reason: derived.reason,
    alert_level: derived.alert_level,
    report,
  };
}

// ---------------------------------------------------------------------------
// Alert emission (统一走 RiskAlertService US-005)
// ---------------------------------------------------------------------------

/**
 * emitFeasibilityGateAlert — 把 gate 结果写一行 RiskAlert.
 *
 *   alert_level=MEDIUM → severity='medium' → 仅 inbox (DB RiskAlert.level='MEDIUM')
 *                       (拒单告警, 不想刷屏 OPS 群; 用户在 AlertsPanel 看到)
 *   alert_level=LOW    → severity='medium' (RiskAlertService 不支持 'low' severity,
 *                       LOW 也走 medium 路由, 但 metadata.tag='feasibility_passed_with_warning'
 *                       让前端 / 看板可以区分)
 *
 * 注: RiskAlertService.write 已 fail-OPEN; 本函数顶层再加 try/catch 不 re-throw,
 * 防御任何 catch 不到的同步 throw (例如 require 阶段挂掉).
 */
export async function emitFeasibilityGateAlert(
  input: FeasibilityGateAlertInput,
  options: FeasibilityGateAlertOptions = {}
): Promise<void> {
  const write = options.writeRiskAlert
    ? options.writeRiskAlert.bind(riskAlertService)
    : riskAlertService.write.bind(riskAlertService);
  const { user_id, symbol, side, result, callerLabel } = input;
  const isBlock = result.alert_level === 'MEDIUM';
  try {
    await write({
      user_id,
      symbol,
      name: `${FEASIBILITY_GATE_LABEL} — ${callerLabel}`,
      message: `⚠️ [${callerLabel}] ${result.reason}`,
      severity: RISK_ALERT_SEVERITY.MEDIUM,
      rule_id: FEASIBILITY_GATE_RULE_ID,
      metadata: {
        tag: isBlock ? 'feasibility_blocked' : 'feasibility_passed_with_warning',
        side,
        decision: result.decision,
        composite_score: result.composite_score,
        block_reasons: result.block_reasons,
        caller: callerLabel,
        report_id: result.report.persisted_id ?? null,
      },
    });
  } catch (err: any) {
    logger.warn(`[feasibility-gate] emit RiskAlert failed (吞错不抛): ${err?.message || err}`);
  }
}
