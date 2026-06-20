/**
 * CounterfactualBaselineService — L4-Portfolio + Risk / US-103 [PR-014]
 * 黑天鹅复盘 4 baseline 模拟 (counterfactual_baselines 段)
 *
 * 4 段中第 2 段, 接力 PR-013 BlackSwanPostmortemService 后填. 主入口 cron
 * `BLACK_SWAN_BASELINE` 每 30min 扫最近 24h status='partial' 且
 * metadata.sections_filled 不含 'counterfactual_baselines' 的 BlackSwanPostmortemReport,
 * 对每行调 buildCounterfactualBaselines (pure engine) 算 4 种 baseline 模拟, UPSERT
 * 仅覆盖 counterfactual_baselines 段 + metadata.sections_filled 累加 (其它 JSONB 段
 * 不出现在 payload 里, sequelize 不动它们 — 与 [[多段 JSONB 报告分阶段 UPSERT]] 同款).
 *
 * ============================================================================
 * 4 baseline 语义 (来自 PRD US-103 AC + docs/trader-system/75_black_swan_postmortem.md)
 * ============================================================================
 *   - hold    — 持有不动 (任何信号都不处理, 看自然演进 baseline; portfolio_value
 *               走 PaperTradingSnapshot 实际曲线本身 — 真实曲线已经"什么都不做")
 *   - zero    — 满仓清空 (事件检出瞬间全部卖出, 仅留现金; 后续 portfolio_value
 *               = cash @ event_detect (不再波动); 看保命 baseline)
 *   - plan    — 按预案执行 (用户 risk_config 设定的 stop_loss_pct 触发: 跌过阈值
 *               即清仓; 模拟"如果当时止损规则生效会发生什么")
 *   - perfect — 完美执行 (事后视角最优: 提前 N 日清仓, 上限 baseline; N 默认 1)
 *
 * 4 baseline 都返 (pnl / pnl_pct / max_drawdown / peak_value / trough_value / samples).
 * 数据源 = event 触发前 N 日 + 后 M 日的 PaperTradingSnapshot 时间序列 (与 BlackSwanEvent
 * 的 scope_detail.portfolio_id 关联; scope!=portfolio 时返 baselines=[] + reason).
 *
 * ============================================================================
 * 调用方式 (cron 30min 巡)
 * ============================================================================
 *   - cron: `runCounterfactualBaselineService(getProductionBaselineRunner(), {})`;
 *   - 默认扫最近 24h detected 的 event 对应 partial postmortem
 *     (lookback_hours=24); already-filled (sections_filled 含
 *     'counterfactual_baselines') 走 skip 不重算;
 *   - dry_run=true → 仅返"会处理几条 partial postmortem"预演, 不调 upsert;
 *   - event_id (debug) → 仅处理指定事件 id 的 postmortem.
 *
 * ============================================================================
 * fail-OPEN (与 PR-013 PostmortemService / DbBackupService 同款)
 * ============================================================================
 *   - loadCandidates throw → 整次 service 返 success=false + error +
 *     candidates_total=0; 不让 SchedulerService cron tick 崩;
 *   - 单事件 loadSnapshots throw / engine throw / upsert throw → 该事件 skipped
 *     + reason 留痕, 整体继续; 最后 reports_failed 累计;
 *   - 全部 upsert throw → success=true (与 PR-013 同款 — events_total > 0 时整体
 *     不算 fail 因子, reports_failed 字段告知失败规模).
 *
 * ============================================================================
 * idempotent (30min 重跑同事件不会双填)
 * ============================================================================
 *   - 候选过滤 = metadata.sections_filled 不含 'counterfactual_baselines';
 *     已填 skip; 即使强制重跑 (event_id), upsert payload 只含本段, 不擦其它段;
 *   - sections_filled 累加用 array union (set 语义) 不重复;
 *   - status 升级: 4 段中已填 == 4 时升 'ok', 否则保持 'partial' (与 PR-015 / PR-016
 *     接力填段语义对齐).
 *
 * ============================================================================
 * SchedulerService 接入
 * ============================================================================
 *   `cronRegistry.ts`: type='BLACK_SWAN_BASELINE', recommendedCron='23,53 * * * *'
 *   (与 BLACK_SWAN_POSTMORTEM '13,43' 错峰 10min, 让 PR-013 先填 event_summary →
 *   本 service 再补 counterfactual_baselines).
 */

import { logger } from '../utils/logger';

// ============================================================================
// Types (engine input/output)
// ============================================================================

/** 单日 portfolio snapshot — 与 PaperTradingSnapshot 对齐 (字段子集). */
export interface BaselinePortfolioSnapshot {
  date: string; // YYYY-MM-DD
  total_value: number; // portfolio 总市值 (含 cash)
  current_cash: number;
  position_value: number;
}

/** 单条 baseline 模拟输出 (4 种 baseline 各一条). */
export interface BaselineResult {
  type: 'hold' | 'zero' | 'plan' | 'perfect';
  pnl: number;
  pnl_pct: number;
  max_drawdown: number; // 0..1 (1 = 100%)
  peak_value: number;
  trough_value: number;
  assumptions: Record<string, unknown>;
  /** ≤ 10 个采样点供前端画线 (date + value). */
  samples: Array<{ date: string; value: number }>;
}

/** counterfactual_baselines JSONB 段 (4 段第 2 段) */
export interface CounterfactualBaselinesSection {
  baselines: BaselineResult[];
  /** 实际 portfolio 表现作对比基准 (= hold baseline 但单独留 actual key). */
  actual: {
    pnl: number;
    pnl_pct: number;
    max_drawdown: number;
    peak_value: number;
    trough_value: number;
  };
  calculator_version: string;
  /** 模拟使用的 event 时间 + 窗口 (供 audit). */
  meta: {
    event_detected_at: string;
    window_days_pre: number;
    window_days_post: number;
    snapshots_total: number;
    perfect_lead_days: number;
    plan_stop_loss_pct: number | null;
  };
}

/** engine 主入口 input. */
export interface BuildCounterfactualBaselinesInput {
  /** 事件检测瞬间 (用于切分 pre/post 窗口). */
  event_detected_at: Date;
  /** 时间序列 (升序). 至少 2 条 (基准点 + ≥1 条 post). */
  snapshots: readonly BaselinePortfolioSnapshot[];
  /** plan baseline 使用的 stop_loss_pct (e.g. 0.05 = 5%; null = 跳过 plan). */
  plan_stop_loss_pct?: number | null;
  /** perfect baseline 提前 N 日清仓 (默认 1). */
  perfect_lead_days?: number;
  /** 窗口 (供 audit). */
  window_days_pre?: number;
  window_days_post?: number;
}

/** PR-013 已生成的 partial postmortem snapshot (本 service 候选输入). */
export interface PartialPostmortemSnapshot {
  id: number; // postmortem id
  black_swan_event_id: number;
  event_detected_at: Date;
  event_scope: string;
  event_scope_detail: Record<string, unknown>; // portfolio_id 在这里
  current_metadata: Record<string, unknown>; // 含 sections_filled[]
  current_status: string; // 'partial' / 'ok' / 'failed'
}

/** UPSERT payload — 只列 counterfactual_baselines + metadata + status + updated 字段. */
export interface BaselineReportUpdateRow {
  id: number; // postmortem id (做 UPDATE WHERE id)
  counterfactual_baselines: CounterfactualBaselinesSection;
  metadata: Record<string, unknown>;
  status: string; // 升级到 'ok' 仅当 4 段全 filled; 否则保 'partial'
  reason: string | null; // 升级到 'ok' 时清空; partial 时简短原因
  generated_at: Date;
}

/** runCounterfactualBaselineService 主返值. */
export interface CounterfactualBaselineResult {
  success: boolean;
  dry_run: boolean;
  candidates_total: number; // 扫到的待补 partial postmortem 数
  reports_updated: number; // 实际 upsert 成功的数量
  reports_failed: number; // upsert 抛错的数
  reports_skipped: number; // engine 返 skipped (snapshots 不足 / scope 不对) 的数
  error?: string;
  generated_at_iso: string;
}

/** 调用选项. */
export interface RunCounterfactualBaselineOptions {
  dry_run?: boolean;
  event_id?: number; // debug 单事件
  lookback_hours?: number; // 默认 24
  generated_at?: Date;
  metadata?: Record<string, unknown>;
}

/** BaselineRunner — DI 接口. */
export interface BaselineRunner {
  /**
   * 拉取候选 partial postmortem (status='partial' AND sections_filled 不含
   * 'counterfactual_baselines'). 永不 throw — 失败返 ok:false.
   */
  loadCandidates(input: {
    asOf: Date;
    lookback_hours: number;
    event_id?: number;
  }): Promise<{ ok: true; candidates: PartialPostmortemSnapshot[] } | { ok: false; error: string }>;

  /**
   * 拉取 portfolio 的 PaperTradingSnapshot 时间序列 (event_detected_at 前 N 日 +
   * 后 M 日). 失败返 [] 让本 service 走 skipped (snapshots 不足).
   */
  loadSnapshots(input: {
    portfolio_id: number;
    event_detected_at: Date;
    window_days_pre: number;
    window_days_post: number;
  }): Promise<BaselinePortfolioSnapshot[]>;

  /**
   * 拉取 user 的 risk_config.per_stock_stop_loss.default_pct (plan baseline 用).
   * 失败 / 缺失返 null → plan baseline skip.
   */
  loadUserPlanStopLossPct(user_id: number): Promise<number | null>;

  /**
   * UPDATE 一行 postmortem 仅覆盖 counterfactual_baselines 段 + metadata + status.
   * 失败返 ok:false (不抛, 本服务统一走 fail-OPEN 累计).
   */
  updateReport(row: BaselineReportUpdateRow): Promise<{ ok: true } | { ok: false; error: string }>;
}

// ============================================================================
// 常量
// ============================================================================

/** cron 推荐表达式 — 与 BLACK_SWAN_POSTMORTEM '13,43' 错峰 10min. */
export const BLACK_SWAN_BASELINE_RECOMMENDED_CRON = '23,53 * * * *';

/** 默认 lookback 窗口 (小时). cron 30min 跑, 24h 余量容忍漏跑. */
export const BLACK_SWAN_BASELINE_DEFAULT_LOOKBACK_HOURS = 24;

/** snapshot 窗口默认前后天数. */
export const BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_PRE = 5;
export const BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_POST = 5;

/** perfect baseline 默认提前清仓天数. */
export const BLACK_SWAN_BASELINE_DEFAULT_PERFECT_LEAD_DAYS = 1;

/** plan baseline 在 user 无配置时的 fallback stop_loss_pct. */
export const BLACK_SWAN_BASELINE_DEFAULT_PLAN_STOP_LOSS_PCT = 0.05;

/** samples cap (前端画线点数上限). */
export const BLACK_SWAN_BASELINE_SAMPLES_CAP = 10;

/** calculator 版本号 (debug 用). */
export const BLACK_SWAN_BASELINE_CALCULATOR_VERSION = 'PR-014/v1';

/** 4 段 sections_filled 集合 — 用于决定 status 升级 'ok'. */
export const ALL_POSTMORTEM_SECTIONS = Object.freeze([
  'event_summary',
  'counterfactual_baselines',
  'event_timeline',
  'improvement_suggestions',
] as const);

const SECTION_KEY = 'counterfactual_baselines';

// ============================================================================
// 纯函数 helpers (engine — 全 export 便于单测)
// ============================================================================

/** 安全数值 — 非有限数返 0 (fail-safe). */
export function safeNum(n: unknown, fallback = 0): number {
  const v = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * 从 snapshots 找 event 当日 (或最早 ≥ event_detected_at) 的索引.
 * 找不到返 -1 (snapshots 不足).
 */
export function findEventIndex(
  snapshots: readonly BaselinePortfolioSnapshot[],
  event_detected_at: Date
): number {
  const eventTs = event_detected_at.getTime();
  for (let i = 0; i < snapshots.length; i += 1) {
    // YYYY-MM-DD → Date (00:00 UTC); ≥ event_detected_at 时认为是"事件触发当日及之后"
    const dt = new Date(snapshots[i].date + 'T00:00:00Z').getTime();
    if (dt >= eventTs - 86_400_000) {
      // 允许 event 落在当日任意时刻; 取 detected_at 当日及之后第一个 snapshot
      const sameOrAfterDay = new Date(snapshots[i].date + 'T23:59:59Z').getTime() >= eventTs;
      if (sameOrAfterDay) return i;
    }
  }
  return -1;
}

/**
 * 给定一段价值曲线, 返 max_drawdown (0..1) + peak_value + trough_value.
 * 空 / 单点曲线返 0.
 */
export function computeDrawdown(values: readonly number[]): {
  max_drawdown: number;
  peak_value: number;
  trough_value: number;
} {
  if (!values.length) return { max_drawdown: 0, peak_value: 0, trough_value: 0 };
  let peak = values[0];
  let trough = values[0];
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) {
        maxDd = dd;
        trough = v;
      }
    } else if (v < trough) {
      trough = v;
    }
  }
  return {
    max_drawdown: Math.max(0, Math.min(1, maxDd)),
    peak_value: peak,
    trough_value: trough,
  };
}

/** 把任意长度曲线下采样到 ≤ N 个点 (含首尾, 等距取). */
export function downsampleSeries(
  series: readonly { date: string; value: number }[],
  cap: number
): Array<{ date: string; value: number }> {
  if (cap <= 0 || series.length === 0) return [];
  if (series.length <= cap) return series.map(s => ({ ...s }));
  const out: Array<{ date: string; value: number }> = [];
  // 包含首尾, 中间等距取 cap-2 个
  out.push({ ...series[0] });
  if (cap >= 3) {
    const step = (series.length - 1) / (cap - 1);
    for (let i = 1; i < cap - 1; i += 1) {
      const idx = Math.round(i * step);
      out.push({ ...series[idx] });
    }
  }
  if (cap >= 2) out.push({ ...series[series.length - 1] });
  return out;
}

// ----------------------------------------------------------------------------
// 4 baseline 算子 (pure)
// ----------------------------------------------------------------------------

/**
 * hold baseline — 持有不动. portfolio_value 走 PaperTradingSnapshot 实际曲线本身.
 * 不变 — 实际曲线就是"什么都不做". 主要用作 baseline reference.
 */
export function computeHoldBaseline(
  snapshots: readonly BaselinePortfolioSnapshot[],
  eventIdx: number
): BaselineResult {
  const series = snapshots.map(s => ({ date: s.date, value: safeNum(s.total_value) }));
  const values = series.map(s => s.value);
  const start = values[eventIdx] || values[0] || 0;
  const end = values[values.length - 1] || 0;
  const pnl = end - start;
  const pnl_pct = start > 0 ? pnl / start : 0;
  const dd = computeDrawdown(values);
  return {
    type: 'hold',
    pnl,
    pnl_pct,
    max_drawdown: dd.max_drawdown,
    peak_value: dd.peak_value,
    trough_value: dd.trough_value,
    assumptions: { strategy: 'do_nothing', basis: 'actual_paper_trading_snapshot' },
    samples: downsampleSeries(series, BLACK_SWAN_BASELINE_SAMPLES_CAP),
  };
}

/**
 * zero baseline — 满仓清空 @ event_detect. 后续 value = (current_cash + position_value
 * @ event_idx). 之后曲线平直.
 */
export function computeZeroBaseline(
  snapshots: readonly BaselinePortfolioSnapshot[],
  eventIdx: number
): BaselineResult {
  const baseSnap = snapshots[eventIdx];
  // 清仓后总价值 = 当日 total_value (= cash + position_value, 全部转 cash)
  const zeroValue = baseSnap ? safeNum(baseSnap.total_value) : 0;
  const series = snapshots.map((s, i) => ({
    date: s.date,
    value: i >= eventIdx ? zeroValue : safeNum(s.total_value),
  }));
  const start = series[eventIdx]?.value || 0;
  const end = series[series.length - 1]?.value || 0;
  const pnl = end - start;
  const pnl_pct = start > 0 ? pnl / start : 0;
  // drawdown 只看 event 之后段 (前段被覆盖为实际曲线, 不算)
  const postValues = series.slice(eventIdx).map(s => s.value);
  const dd = computeDrawdown(postValues);
  return {
    type: 'zero',
    pnl,
    pnl_pct,
    max_drawdown: dd.max_drawdown,
    peak_value: dd.peak_value,
    trough_value: dd.trough_value,
    assumptions: {
      strategy: 'sell_all_at_event',
      event_value: zeroValue,
      basis: 'snapshot_total_value_locks_to_cash',
    },
    samples: downsampleSeries(series, BLACK_SWAN_BASELINE_SAMPLES_CAP),
  };
}

/**
 * plan baseline — 按 user risk_config 设的 stop_loss_pct 触发清仓.
 * 简化模拟: event 之后曲线若 (peak - v)/peak 跌过阈值则在该点清仓后续平直.
 *
 * stop_loss_pct=null → 返 skipped 占位 (不参与 baselines[]).
 */
export function computePlanBaseline(
  snapshots: readonly BaselinePortfolioSnapshot[],
  eventIdx: number,
  stop_loss_pct: number | null
): BaselineResult | null {
  if (stop_loss_pct == null || !Number.isFinite(stop_loss_pct) || stop_loss_pct <= 0) {
    return null;
  }
  const series: Array<{ date: string; value: number }> = [];
  let peak = snapshots[eventIdx]?.total_value
    ? safeNum(snapshots[eventIdx].total_value)
    : safeNum(snapshots[0]?.total_value);
  let stopped = false;
  let stopValue = 0;
  for (let i = 0; i < snapshots.length; i += 1) {
    const s = snapshots[i];
    const v = safeNum(s.total_value);
    if (i < eventIdx) {
      series.push({ date: s.date, value: v });
      continue;
    }
    if (stopped) {
      series.push({ date: s.date, value: stopValue });
      continue;
    }
    if (v > peak) peak = v;
    if (peak > 0 && (peak - v) / peak >= stop_loss_pct) {
      stopped = true;
      stopValue = v;
      series.push({ date: s.date, value: v });
    } else {
      series.push({ date: s.date, value: v });
    }
  }
  const values = series.map(s => s.value);
  const start = values[eventIdx] || 0;
  const end = values[values.length - 1] || 0;
  const pnl = end - start;
  const pnl_pct = start > 0 ? pnl / start : 0;
  const dd = computeDrawdown(values.slice(eventIdx));
  return {
    type: 'plan',
    pnl,
    pnl_pct,
    max_drawdown: dd.max_drawdown,
    peak_value: dd.peak_value,
    trough_value: dd.trough_value,
    assumptions: {
      strategy: 'stop_loss_on_breach',
      stop_loss_pct,
      stopped,
      stopped_value: stopped ? stopValue : null,
    },
    samples: downsampleSeries(series, BLACK_SWAN_BASELINE_SAMPLES_CAP),
  };
}

/**
 * perfect baseline — 提前 N 日清仓 (事后视角最优).
 * leadDays=1 → 在 eventIdx-1 处清仓 (lock @ snapshot.total_value), 后续平直.
 *
 * snapshots 不足 lead_days 时 leadIdx = max(0, eventIdx - leadDays).
 */
export function computePerfectBaseline(
  snapshots: readonly BaselinePortfolioSnapshot[],
  eventIdx: number,
  leadDays: number
): BaselineResult {
  const safeLead = Number.isFinite(leadDays) && leadDays > 0 ? Math.floor(leadDays) : 1;
  const leadIdx = Math.max(0, eventIdx - safeLead);
  const lockValue = snapshots[leadIdx] ? safeNum(snapshots[leadIdx].total_value) : 0;
  const series = snapshots.map((s, i) => ({
    date: s.date,
    value: i >= leadIdx ? lockValue : safeNum(s.total_value),
  }));
  const start = series[eventIdx]?.value || lockValue;
  const end = series[series.length - 1]?.value || 0;
  const pnl = end - start;
  const pnl_pct = start > 0 ? pnl / start : 0;
  const dd = computeDrawdown(series.slice(eventIdx).map(s => s.value));
  return {
    type: 'perfect',
    pnl,
    pnl_pct,
    max_drawdown: dd.max_drawdown,
    peak_value: dd.peak_value,
    trough_value: dd.trough_value,
    assumptions: {
      strategy: 'sell_n_days_before_event',
      lead_days: safeLead,
      lock_value: lockValue,
      lock_index: leadIdx,
    },
    samples: downsampleSeries(series, BLACK_SWAN_BASELINE_SAMPLES_CAP),
  };
}

/**
 * 计算 actual portfolio 表现 (= 实际曲线 from event_idx 到末尾).
 * 与 hold baseline 数值上等价, 但单独留 actual key 让 UI 一眼看出 "实际 vs hold-do-nothing"
 * (两者数值会重叠 — 这是预期, hold-do-nothing 在 paper trading 没有自动止损时确实就是实际曲线).
 */
export function computeActual(
  snapshots: readonly BaselinePortfolioSnapshot[],
  eventIdx: number
): CounterfactualBaselinesSection['actual'] {
  const values = snapshots.map(s => safeNum(s.total_value));
  const start = values[eventIdx] || values[0] || 0;
  const end = values[values.length - 1] || 0;
  const pnl = end - start;
  const pnl_pct = start > 0 ? pnl / start : 0;
  const dd = computeDrawdown(values);
  return {
    pnl,
    pnl_pct,
    max_drawdown: dd.max_drawdown,
    peak_value: dd.peak_value,
    trough_value: dd.trough_value,
  };
}

/**
 * 主 engine — 构建完整 counterfactual_baselines 段.
 *
 * snapshots 不足返 baselines=[] + actual={0,0,...} + meta.snapshots_total=N
 * (caller 用 baselines.length === 0 判 skipped).
 */
export function buildCounterfactualBaselines(
  input: BuildCounterfactualBaselinesInput
): CounterfactualBaselinesSection {
  const snapshots = Array.isArray(input.snapshots) ? input.snapshots.slice() : [];
  const window_days_pre = Number.isFinite(input.window_days_pre)
    ? Math.max(0, Math.floor(input.window_days_pre as number))
    : BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_PRE;
  const window_days_post = Number.isFinite(input.window_days_post)
    ? Math.max(0, Math.floor(input.window_days_post as number))
    : BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_POST;
  const perfect_lead_days = Number.isFinite(input.perfect_lead_days)
    ? Math.max(1, Math.floor(input.perfect_lead_days as number))
    : BLACK_SWAN_BASELINE_DEFAULT_PERFECT_LEAD_DAYS;
  const plan_stop_loss_pct =
    input.plan_stop_loss_pct == null ? null : safeNum(input.plan_stop_loss_pct, NaN);

  const meta = {
    event_detected_at: input.event_detected_at.toISOString(),
    window_days_pre,
    window_days_post,
    snapshots_total: snapshots.length,
    perfect_lead_days,
    plan_stop_loss_pct: Number.isFinite(plan_stop_loss_pct) ? (plan_stop_loss_pct as number) : null,
  };

  // snapshots < 2 → 无法算 (至少需要 event 当日 + 1 个后续点)
  if (snapshots.length < 2) {
    return {
      baselines: [],
      actual: { pnl: 0, pnl_pct: 0, max_drawdown: 0, peak_value: 0, trough_value: 0 },
      calculator_version: BLACK_SWAN_BASELINE_CALCULATOR_VERSION,
      meta,
    };
  }

  const eventIdx = findEventIndex(snapshots, input.event_detected_at);
  // event 找不到 → 也无法算 (window 切不出 event 之前/之后)
  if (eventIdx < 0 || eventIdx >= snapshots.length - 1) {
    return {
      baselines: [],
      actual: { pnl: 0, pnl_pct: 0, max_drawdown: 0, peak_value: 0, trough_value: 0 },
      calculator_version: BLACK_SWAN_BASELINE_CALCULATOR_VERSION,
      meta,
    };
  }

  const baselines: BaselineResult[] = [
    computeHoldBaseline(snapshots, eventIdx),
    computeZeroBaseline(snapshots, eventIdx),
  ];
  const plan = computePlanBaseline(snapshots, eventIdx, meta.plan_stop_loss_pct);
  if (plan) baselines.push(plan);
  baselines.push(computePerfectBaseline(snapshots, eventIdx, perfect_lead_days));

  const actual = computeActual(snapshots, eventIdx);

  return {
    baselines,
    actual,
    calculator_version: BLACK_SWAN_BASELINE_CALCULATOR_VERSION,
    meta,
  };
}

// ============================================================================
// metadata.sections_filled 累加 + status 升级 helpers
// ============================================================================

/**
 * 取当前 metadata.sections_filled (兜底数组类型校验), append 'counterfactual_baselines'
 * 不重复.
 */
export function appendSectionFilled(
  current_metadata: Record<string, unknown>,
  section: string
): { sections_filled: string[]; merged_metadata: Record<string, unknown> } {
  const md = current_metadata && typeof current_metadata === 'object' ? current_metadata : {};
  const prev = Array.isArray((md as any).sections_filled) ? (md as any).sections_filled : [];
  const set = new Set<string>(prev.filter((s: unknown) => typeof s === 'string'));
  set.add(section);
  const sections_filled = Array.from(set);
  return { sections_filled, merged_metadata: { ...md, sections_filled } };
}

/**
 * 决定 upsert 后 status: sections_filled 包含全部 4 段 → 'ok'; 否则 'partial'.
 * reason: 'ok' 时返 null; partial 时返简短文案.
 */
export function decidePostmortemStatus(sections_filled: readonly string[]): {
  status: string;
  reason: string | null;
} {
  const set = new Set(sections_filled);
  const all = ALL_POSTMORTEM_SECTIONS.every(s => set.has(s));
  if (all) return { status: 'ok', reason: null };
  const missing = ALL_POSTMORTEM_SECTIONS.filter(s => !set.has(s));
  return { status: 'partial', reason: `pending_sections: ${missing.join(',')}`.slice(0, 200) };
}

// ============================================================================
// Service 主入口 (cron)
// ============================================================================

/**
 * runCounterfactualBaselineService — cron 主函数. 永不 throw.
 *
 * 流程:
 *   1. runner.loadCandidates (status='partial' 且 sections_filled 不含本段;
 *      lookback 24h 或 event_id 单条);
 *   2. 对每条 candidate:
 *      a) scope!='portfolio' 或 scope_detail.portfolio_id 缺 → skipped reason='not_portfolio';
 *      b) runner.loadSnapshots(portfolio_id, event_detected_at, 5d pre / 5d post)
 *         → snapshots; throw 或 [] → skipped reason='no_snapshots';
 *      c) runner.loadUserPlanStopLossPct(user_id) → plan_stop_loss_pct;
 *      d) buildCounterfactualBaselines(input) → section;
 *      e) section.baselines.length === 0 → skipped reason='insufficient_data';
 *      f) dry_run=true → 跳过 updateReport;
 *      g) updateReport(row), 失败 → failed +1.
 */
export async function runCounterfactualBaselineService(
  runner: BaselineRunner,
  options: RunCounterfactualBaselineOptions = {}
): Promise<CounterfactualBaselineResult> {
  const dryRun = Boolean(options.dry_run);
  const generated_at = options.generated_at instanceof Date ? options.generated_at : new Date();
  const lookback_hours =
    Number.isFinite(options.lookback_hours) && (options.lookback_hours as number) > 0
      ? Math.floor(options.lookback_hours as number)
      : BLACK_SWAN_BASELINE_DEFAULT_LOOKBACK_HOURS;
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};

  const baseResult: CounterfactualBaselineResult = {
    success: false,
    dry_run: dryRun,
    candidates_total: 0,
    reports_updated: 0,
    reports_failed: 0,
    reports_skipped: 0,
    generated_at_iso: generated_at.toISOString(),
  };

  // Step 1
  let cand: { ok: true; candidates: PartialPostmortemSnapshot[] } | { ok: false; error: string };
  try {
    cand = await runner.loadCandidates({
      asOf: generated_at,
      lookback_hours,
      event_id: options.event_id,
    });
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    logger.warn(`[BlackSwanBaseline] loadCandidates threw: ${errMsg}`);
    return { ...baseResult, error: `candidates_query_failed: ${errMsg}` };
  }
  if (!cand.ok) {
    const errMsg = (cand as { ok: false; error: string }).error;
    logger.warn(`[BlackSwanBaseline] loadCandidates failed: ${errMsg}`);
    return { ...baseResult, error: `candidates_query_failed: ${errMsg}` };
  }
  const candidates = cand.candidates || [];

  if (dryRun) {
    return { ...baseResult, success: true, candidates_total: candidates.length };
  }

  let updated = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of candidates) {
    try {
      // (a) scope check
      if (c.event_scope !== 'portfolio') {
        skipped += 1;
        continue;
      }
      const sd = c.event_scope_detail || {};
      const portfolio_id = Number((sd as any).portfolio_id);
      const user_id = Number((sd as any).user_id);
      if (!Number.isFinite(portfolio_id) || portfolio_id <= 0) {
        skipped += 1;
        continue;
      }

      // (b) snapshots
      let snapshots: BaselinePortfolioSnapshot[] = [];
      try {
        snapshots = await runner.loadSnapshots({
          portfolio_id,
          event_detected_at: c.event_detected_at,
          window_days_pre: BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_PRE,
          window_days_post: BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_POST,
        });
      } catch (err: any) {
        logger.warn(
          `[BlackSwanBaseline] loadSnapshots event_id=${c.black_swan_event_id} threw: ${
            err?.message || err
          }`
        );
        snapshots = [];
      }
      if (snapshots.length < 2) {
        skipped += 1;
        continue;
      }

      // (c) plan stop_loss_pct
      let plan_pct: number | null = null;
      if (Number.isFinite(user_id) && user_id > 0) {
        try {
          plan_pct = await runner.loadUserPlanStopLossPct(user_id);
        } catch (err: any) {
          logger.warn(
            `[BlackSwanBaseline] loadUserPlanStopLossPct user_id=${user_id} threw: ${
              err?.message || err
            }`
          );
          plan_pct = null;
        }
      }

      // (d) engine
      const section = buildCounterfactualBaselines({
        event_detected_at: c.event_detected_at,
        snapshots,
        plan_stop_loss_pct: plan_pct,
      });

      // (e) skipped if engine returned empty
      if (!section.baselines.length) {
        skipped += 1;
        continue;
      }

      // (f) metadata + status
      const { sections_filled, merged_metadata } = appendSectionFilled(
        c.current_metadata,
        SECTION_KEY
      );
      const { status, reason } = decidePostmortemStatus(sections_filled);

      // (g) upsert
      const row: BaselineReportUpdateRow = {
        id: c.id,
        counterfactual_baselines: section,
        metadata: {
          ...merged_metadata,
          ...metadata,
          calculator_version: BLACK_SWAN_BASELINE_CALCULATOR_VERSION,
          sections_filled, // ensure not clobbered by spread above
          counterfactual_baselines_filled_at_iso: generated_at.toISOString(),
        },
        status,
        reason,
        generated_at,
      };

      const r = await runner.updateReport(row);
      if (r.ok) {
        updated += 1;
      } else {
        failed += 1;
        logger.warn(
          `[BlackSwanBaseline] updateReport postmortem_id=${c.id} failed: ${
            (r as any).error || 'unknown'
          }`
        );
      }
    } catch (err: any) {
      failed += 1;
      logger.warn(
        `[BlackSwanBaseline] candidate postmortem_id=${c.id} threw: ${err?.message || err}`
      );
    }
  }

  return {
    success: true,
    dry_run: false,
    candidates_total: candidates.length,
    reports_updated: updated,
    reports_failed: failed,
    reports_skipped: skipped,
    generated_at_iso: generated_at.toISOString(),
  };
}

// ============================================================================
// Production runner — lazy-require models (与 PR-013 同款 lazy-require 模式)
// ============================================================================

/**
 * createProductionBaselineRunner — production singleton 工厂. 测试不调它.
 *
 * lazy-require 模式 (与 BlackSwanPostmortemService / BlackSwanDetectorService 同款):
 * 单测脱 DB 走 fake runner 时, 这些 require 不触发.
 */
export function createProductionBaselineRunner(): BaselineRunner {
  return {
    async loadCandidates({ asOf, lookback_hours, event_id }) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { BlackSwanPostmortemReport } = require('../models/BlackSwanPostmortemReport');
        const { BlackSwanEvent } = require('../models/BlackSwanEvent');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const since = new Date(asOf.getTime() - lookback_hours * 3_600_000);
        const where: Record<string, unknown> = { status: 'partial' };
        if (event_id !== undefined && event_id !== null) {
          (where as any).black_swan_event_id = Number(event_id);
        }
        const rows = await BlackSwanPostmortemReport.findAll({
          where,
          include: [
            {
              model: BlackSwanEvent,
              required: true,
              where: { detected_at: { [Op.between]: [since, asOf] } },
            },
          ],
          limit: 500,
        });
        const candidates: PartialPostmortemSnapshot[] = (Array.isArray(rows) ? rows : []).map(
          (r: any) => {
            const ev = r.black_swan_event || {};
            const md = r.metadata && typeof r.metadata === 'object' ? r.metadata : {};
            return {
              id: Number(r.id),
              black_swan_event_id: Number(r.black_swan_event_id),
              event_detected_at:
                ev.detected_at instanceof Date ? ev.detected_at : new Date(ev.detected_at),
              event_scope: String(ev.scope || ''),
              event_scope_detail:
                ev.scope_detail && typeof ev.scope_detail === 'object' ? ev.scope_detail : {},
              current_metadata: md,
              current_status: String(r.status || 'partial'),
            };
          }
        );
        // 客户端再过滤 — 把 sections_filled 已含本段的 skip 掉 (不在 SQL WHERE 里
        // 用 JSONB array contains, 与 dev/test SQLite 兼容)
        const filtered = candidates.filter(c => {
          const sf = Array.isArray((c.current_metadata as any).sections_filled)
            ? (c.current_metadata as any).sections_filled
            : [];
          return !sf.includes(SECTION_KEY);
        });
        return { ok: true as const, candidates: filtered };
      } catch (err: any) {
        return { ok: false as const, error: err?.message || String(err) };
      }
    },

    async loadSnapshots({ portfolio_id, event_detected_at, window_days_pre, window_days_post }) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { PaperTradingSnapshot } = require('../models/PaperTradingSnapshot');
        const { Op } = require('sequelize');
        /* eslint-enable @typescript-eslint/no-var-requires */
        const since = new Date(event_detected_at.getTime() - window_days_pre * 86_400_000);
        const until = new Date(event_detected_at.getTime() + window_days_post * 86_400_000);
        const sinceDate = since.toISOString().slice(0, 10);
        const untilDate = until.toISOString().slice(0, 10);
        const rows = await PaperTradingSnapshot.findAll({
          where: {
            portfolio_id,
            date: { [Op.between]: [sinceDate, untilDate] },
          },
          order: [['date', 'ASC']],
          limit: 100,
        });
        if (!Array.isArray(rows)) return [];
        return rows.map((r: any) => ({
          date: String(r.date),
          total_value: Number(r.total_value),
          current_cash: Number(r.current_cash),
          position_value: Number(r.position_value),
        }));
      } catch {
        return [];
      }
    },

    async loadUserPlanStopLossPct(user_id) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { User } = require('../models/User');
        /* eslint-enable @typescript-eslint/no-var-requires */
        if (!User) return null;
        const row = await User.findByPk(user_id, { attributes: ['risk_config'] });
        if (!row) return null;
        const cfg = (row as any).risk_config || {};
        const pct = cfg?.per_stock_stop_loss?.default_pct;
        if (typeof pct === 'number' && Number.isFinite(pct) && pct > 0 && pct < 1) return pct;
        return BLACK_SWAN_BASELINE_DEFAULT_PLAN_STOP_LOSS_PCT;
      } catch {
        return null;
      }
    },

    async updateReport(row) {
      try {
        /* eslint-disable @typescript-eslint/no-var-requires */
        const { BlackSwanPostmortemReport } = require('../models/BlackSwanPostmortemReport');
        /* eslint-enable @typescript-eslint/no-var-requires */
        // UPDATE WHERE id — 仅覆盖 counterfactual_baselines + metadata + status +
        // reason + generated_at 5 列 (其它 JSONB 段不出现在 row 里, sequelize 不动).
        await BlackSwanPostmortemReport.update(
          {
            counterfactual_baselines: row.counterfactual_baselines,
            metadata: row.metadata,
            status: row.status,
            reason: row.reason,
            generated_at: row.generated_at,
          },
          { where: { id: row.id } }
        );
        return { ok: true as const };
      } catch (err: any) {
        return { ok: false as const, error: err?.message || String(err) };
      }
    },
  };
}

let _prodRunner: BaselineRunner | null = null;
/** Singleton (lazy). SchedulerService 复用. */
export function getProductionBaselineRunner(): BaselineRunner {
  if (!_prodRunner) _prodRunner = createProductionBaselineRunner();
  return _prodRunner;
}
