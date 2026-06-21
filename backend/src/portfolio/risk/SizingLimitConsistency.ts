/**
 * SizingLimitConsistency — US-008 / PR-003
 *
 * `SizingPolicyService` 和 `PositionLimitGuard` 都管 "**单股最大仓位百分比**"，但
 * 单位 / 字段名 / 默认值都不同：
 *
 *   |                      | SizingPolicyConfig          | PositionLimitsConfig          |
 *   |---------------------|------------------------------|--------------------------------|
 *   | 字段                 | `max_position_pct`           | `max_single_stock_pct`        |
 *   | 单位                 | percent (1-50, 默认 12)      | fraction (0-1, 默认 0.10)     |
 *   | 角色                 | sizing decideSizing cap      | pre-trade guard 单股拦截      |
 *   | 持久化               | `User.risk_config.sizing_policy.max_position_pct` | `User.risk_config.position_limits.max_single_stock_pct` |
 *
 * **当前不一致风险**：用户从 UI 把 sizing `max_position_pct` 提到 25%，但 limit
 * `max_single_stock_pct` 还停在默认 10%。`decideSizing` 出 25% 目标仓位 → 走到
 * `PaperTradingFacade.placeOrder` → `positionLimitGuard.checkBuyOrder` 立刻
 * 拒单 "单股仓位超过 10%"。用户体感是"我明明配了 25%，怎么不让买"。
 *
 * 这条 PR-003 的目标是：让这种漂移在**入口**就被发现并 log，而不是等真信号
 * 走到 placeOrder 才被拒。具体策略：
 *
 *   1. 提供**纯函数** `compareSingleStockThresholds(sizing, limit)` —
 *      返回 `ConsistencyReport`：`{ in_sync, sizing_pct_fraction,
 *      limit_pct_fraction, diff_fraction, severity, message }`。
 *      单位都换算成 fraction 后比较，差值绝对值 < 1e-6 视为 in_sync。
 *
 *   2. 提供 `severity` 三级：
 *      - `info`   — sizing ≤ limit（理想：sizing 算出的仓位永远不会顶到 limit）
 *      - `warn`   — sizing > limit 且差 ≤ 0.02（小漂移；buy 仍能下，但 sizing
 *        值被 limit 阻挡裁切，sizing 配置的"意图"未生效）
 *      - `critical` — sizing > limit 且差 > 0.02（严重漂移；用户每笔 buy
 *        都会被 limit guard 拒单或被 capped_by_max 触顶）
 *
 *   3. 提供 `assertConsistencyOnUpdate` hook — 任一 service 的 `updateConfig`
 *      在持久化之后调一次（pull the other side 的 effective config，比较，
 *      severity ≥ warn 时 `logger.warn` + 返回 report 给上层）。**hook 自身
 *      不抛错、不阻塞**：仍走 fail-open，避免 PUT /api/risk/* 因为另一边
 *      读 DB 失败就 5xx。
 *
 *   4. 提供 `runDriftAudit({ sizingLoader, limitLoader, user_ids })` — 批量
 *      巡检 entry point，可由 SchedulerService 后续 cron 化（PR 范围只提供
 *      函数，不主动 register cron — register 留给运维）。
 *
 * **设计取舍**：
 *   - 不去做"自动同步"（A 改了 B 跟着改）—— 两边语义不同（sizing 是
 *     `desired` 上限、limit 是 `hard wall`），自动同步会让用户的 UI 配置
 *     被悄悄改写。**只 log + report**，让 ops / UI 看到后由用户主动 reconcile。
 *   - `severity=warn` threshold = 0.02 (2%)：低于这个的差异通常是用户故意
 *     留一点 safety margin（如 sizing 12% + limit 10% = 2pp 缓冲），不该
 *     被当 critical 报噪音。
 *   - 比较只看 `max_position_pct` ↔ `max_single_stock_pct` 一对（**单股**仓位
 *     上限），因为 limit guard 的 `max_positions` 和 `max_single_industry_pct`
 *     在 sizing policy 没有对应字段。
 *
 * **配套测试**：`tests/risk/sizing-limit-consistency.test.ts` 覆盖
 *   (1) compareSingleStockThresholds 三 severity 分支 + 边界 (sizing == limit /
 *       sizing 小 / sizing 大 0.01 / sizing 大 0.05 / 极端 0 / NaN);
 *   (2) assertConsistencyOnUpdate fake loader 两边都通 → 返 in_sync;
 *       一边 loader throw → fail-open 返 null + logger.warn;
 *   (3) runDriftAudit 多 user 部分失败的隔离;
 *   (4) 单元换算契约 (sizing_pct_to_fraction(12) === 0.12, 12.5 → 0.125)；
 *   (5) META-TEST: SizingPolicyService.updateConfig + PositionLimitGuard.updateConfig
 *       源文件都必须 call assertConsistencyOnUpdate（防 refactor 删掉 hook）。
 */

import { logger } from '../../utils/logger';
import {
  DEFAULT_SIZING_POLICY,
  SizingPolicyConfig,
  normalizeSizingPolicyConfig,
} from '../PositionSizingPolicy';
import {
  DEFAULT_POSITION_LIMITS,
  PositionLimitsConfig,
  normalizePositionLimitsConfig,
} from './PositionLimitGuard';

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

/** 视作 "完全一致" 的 fraction 差异容忍 — 任何小于这个的 diff = in_sync。 */
export const SYNC_TOLERANCE_FRACTION = 1e-6;

/** sizing > limit 但漂移 ≤ 此阈值 → severity=warn；超过 → critical。 */
export const WARN_DRIFT_THRESHOLD_FRACTION = 0.02;

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

export type DriftSeverity = 'info' | 'warn' | 'critical';

export interface ConsistencyReport {
  /** True 当 |sizing_fraction - limit_fraction| < SYNC_TOLERANCE_FRACTION。 */
  in_sync: boolean;
  /** sizing.max_position_pct 换算到 fraction (0-1)。例 12 → 0.12。 */
  sizing_pct_fraction: number;
  /** limit.max_single_stock_pct (本身就是 fraction)。 */
  limit_pct_fraction: number;
  /** `sizing_fraction - limit_fraction`，正值 = sizing 比 limit 宽。 */
  diff_fraction: number;
  /** info | warn | critical — 详见模块顶部 jsdoc。 */
  severity: DriftSeverity;
  /** 人类可读中文 message，便于 logger 打印 / RiskAlert / UI 展示。 */
  message: string;
}

export interface BatchDriftAuditResult {
  user_id: number;
  /** 该 user 对比成功时填；失败时为 null + error 设置。 */
  report: ConsistencyReport | null;
  error?: string;
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB)
// ---------------------------------------------------------------------------

/**
 * 把 sizing policy 的百分比单位（1-50 percent）换算成 fraction (0-1)。
 *
 * 防御性：非有限数 → 用 DEFAULT_SIZING_POLICY.max_position_pct 兜底。
 */
export function sizingMaxPctToFraction(sizingMaxPositionPct: number): number {
  if (!Number.isFinite(sizingMaxPositionPct)) {
    return DEFAULT_SIZING_POLICY.max_position_pct / 100;
  }
  return sizingMaxPositionPct / 100;
}

/**
 * 比较两边阈值并产出 ConsistencyReport。
 *
 * 核心：把两边都换算到 fraction 后用 `diff = sizing - limit` 判定 severity。
 *
 *   - `diff ≤ 0`                                                → info（sizing 不会触 limit）
 *   - `0 < diff ≤ WARN_DRIFT_THRESHOLD_FRACTION`               → warn（小漂移）
 *   - `diff > WARN_DRIFT_THRESHOLD_FRACTION`                   → critical（每笔 buy 都被裁）
 *
 * **不**做"limit > sizing 也是 critical" 的相反方向报警，因为 limit > sizing
 * 时 limit 本身就是松上限、对 buy 没影响，这种"limit 多余宽"是用户主动
 * 留 buffer，不该被 flag 成漂移。
 */
export function compareSingleStockThresholds(
  sizing: SizingPolicyConfig,
  limit: PositionLimitsConfig
): ConsistencyReport {
  const sizingFraction = sizingMaxPctToFraction(sizing.max_position_pct);
  const limitFraction = Number.isFinite(limit.max_single_stock_pct)
    ? limit.max_single_stock_pct
    : DEFAULT_POSITION_LIMITS.max_single_stock_pct;
  const diff = sizingFraction - limitFraction;
  const inSync = Math.abs(diff) < SYNC_TOLERANCE_FRACTION;

  let severity: DriftSeverity;
  let message: string;
  if (inSync) {
    severity = 'info';
    message =
      `阈值一致：sizing max_position_pct=${(sizingFraction * 100).toFixed(2)}% ` +
      `≈ limit max_single_stock_pct=${(limitFraction * 100).toFixed(2)}%`;
  } else if (diff <= 0) {
    severity = 'info';
    message =
      `阈值无冲突：sizing max_position_pct=${(sizingFraction * 100).toFixed(2)}% ` +
      `≤ limit max_single_stock_pct=${(limitFraction * 100).toFixed(2)}% ` +
      `(sizing 不会触发 limit guard 拒单)`;
  } else if (diff <= WARN_DRIFT_THRESHOLD_FRACTION) {
    severity = 'warn';
    message =
      `阈值轻微漂移：sizing max_position_pct=${(sizingFraction * 100).toFixed(2)}% > ` +
      `limit max_single_stock_pct=${(limitFraction * 100).toFixed(2)}% ` +
      `(差 ${(diff * 100).toFixed(2)}pp，buy 会被 limit guard cap 到 limit 值)`;
  } else {
    severity = 'critical';
    message =
      `阈值严重漂移：sizing max_position_pct=${(sizingFraction * 100).toFixed(2)}% >> ` +
      `limit max_single_stock_pct=${(limitFraction * 100).toFixed(2)}% ` +
      `(差 ${(diff * 100).toFixed(2)}pp，超过 ${(WARN_DRIFT_THRESHOLD_FRACTION * 100).toFixed(
        0
      )}pp 阈值；用户配置意图未生效，建议同步两侧或上调 limit guard)`;
  }

  return {
    in_sync: inSync,
    sizing_pct_fraction: sizingFraction,
    limit_pct_fraction: limitFraction,
    diff_fraction: diff,
    severity,
    message,
  };
}

/**
 * 给 normalize 之前的 raw input 也准备一个 entry — 让 controller 在用户
 * PUT 还没持久化时也能预览漂移（dry-run preview UI）。
 */
export function compareRawInputs(sizingRaw: unknown, limitRaw: unknown): ConsistencyReport {
  return compareSingleStockThresholds(
    normalizeSizingPolicyConfig(sizingRaw),
    normalizePositionLimitsConfig(limitRaw)
  );
}

// ---------------------------------------------------------------------------
//  Async hooks (DI loaders — no DB import)
// ---------------------------------------------------------------------------

export interface SizingLoader {
  (user_id: number): Promise<SizingPolicyConfig>;
}

export interface LimitLoader {
  (user_id: number): Promise<PositionLimitsConfig>;
}

/**
 * `SizingPolicyService.updateConfig` / `PositionLimitGuard.updateConfig` 都
 * 在 persist 完之后调一次这个。
 *
 * **fail-open 契约**：任一 loader throw → 返 null + logger.warn 吞错，
 * 调用方主流程绝不被这个一致性检查阻塞。
 *
 * @returns ConsistencyReport 或 null（任一 loader 失败）
 */
export async function assertConsistencyOnUpdate(input: {
  user_id: number;
  sizingLoader: SizingLoader;
  limitLoader: LimitLoader;
  /** 调用方标识（"sizing_policy_update" / "position_limit_update"），仅用于 log 标签。 */
  triggered_by?: string;
}): Promise<ConsistencyReport | null> {
  try {
    const [sizing, limit] = await Promise.all([
      input.sizingLoader(input.user_id),
      input.limitLoader(input.user_id),
    ]);
    const report = compareSingleStockThresholds(sizing, limit);
    if (report.severity === 'warn' || report.severity === 'critical') {
      logger.warn(
        `[SizingLimitConsistency] user=${input.user_id} ` +
          `triggered_by=${input.triggered_by || 'unknown'} ` +
          `severity=${report.severity} ${report.message}`
      );
    }
    return report;
  } catch (err: any) {
    logger.warn(
      `[SizingLimitConsistency] user=${input.user_id} ` +
        `triggered_by=${input.triggered_by || 'unknown'} ` +
        `loader failed (fail-open): ${err?.message || err}`
    );
    return null;
  }
}

/**
 * 批量巡检 entry point — 拿一组 user_id，逐个跑 assertConsistencyOnUpdate。
 * per-user try/catch 隔离，单个失败不阻塞其余。
 *
 * **当前**仅作为 helper export，未注册 cron。后续如要 scheduler 化：
 * 加 `SCHEDULER_TASK_TYPE = 'SIZING_LIMIT_CONSISTENCY_AUDIT'` + 在
 * SchedulerService._executeTaskLogic 接入 + 在 CRON_REGISTRY 登记。
 */
export async function runDriftAudit(input: {
  user_ids: number[];
  sizingLoader: SizingLoader;
  limitLoader: LimitLoader;
}): Promise<BatchDriftAuditResult[]> {
  const results: BatchDriftAuditResult[] = [];
  for (const user_id of input.user_ids) {
    try {
      const [sizing, limit] = await Promise.all([
        input.sizingLoader(user_id),
        input.limitLoader(user_id),
      ]);
      const report = compareSingleStockThresholds(sizing, limit);
      results.push({ user_id, report });
    } catch (err: any) {
      results.push({
        user_id,
        report: null,
        error: err?.message || String(err),
      });
    }
  }
  return results;
}
