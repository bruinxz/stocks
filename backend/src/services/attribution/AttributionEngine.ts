/**
 * AttributionEngine — Brinson-Fachler 拆解 (US-079 [PM-002], 依赖 PM-001)
 *
 * 把每日 portfolio 的盈亏拆成"行业 β + 选股 α + 交互项"三部分, 配合 PM-001
 * DailyAttributionService 已经做的 industry_contrib (sell-only realized) + execution_cost,
 * 让 sixDimBreakdown 的 timing/selection/sizing/factor 4 个 placeholder 维度第一次"真"
 * 有数 — 用 portfolio EOD 持仓权重 + 当日行业基准收益率 + 单股持仓日收益率三路输入
 * 拆出来.
 *
 * 本 story (PM-002) 只交付 pure helper, 不接 DB, 不接 model; 由 PM-001 主入口
 * `buildDailyAttributionReport` 决定何时调 (caller 准备好 industry benchmark map 时
 * 才传 attribution_engine_input, 否则照旧 placeholder = 0).
 *
 * ─── Brinson-Fachler 公式 ─────────────────────────────────────────────
 *
 *   每个行业 i:
 *     allocation_i   = (w_p,i - w_b,i)          ×  r_b,i        × V    # 行业 β
 *     selection_i    = w_b,i                    × (r_p,i - r_b,i) × V  # 行业内 α
 *     interaction_i  = (w_p,i - w_b,i)          × (r_p,i - r_b,i) × V  # 交叉项
 *
 *   总:
 *     allocation_contrib  = Σ allocation_i
 *     selection_contrib   = Σ selection_i
 *     interaction_contrib = Σ interaction_i
 *
 *   单位: w 是权重小数 (0..1), r 是百分比小数 (e.g. 0.012 = +1.2%), V 是 portfolio 总值 (元).
 *   返回的 allocation/selection/interaction 单位 = 元.
 *
 *   benchmark 权重 w_b,i — 当没有外部 benchmark 时, 退化为"等权 within universe"
 *   (universe = portfolio 持仓行业 ∪ benchmark 行业, 平摊到每个行业 = 1/N).
 *
 * ─── 与 PM-001 sixDimBreakdown 的关系 ─────────────────────────────────
 *
 *   PM-001 `sixDimBreakdown` 输出 8 字段:
 *     factor_contrib_total / industry_contrib (sell-only realized) /
 *     timing_contrib / selection_contrib / sizing_contrib / execution_cost /
 *     residual / factor_contrib
 *
 *   本 engine 填的字段:
 *     - selection_contrib  ← Σ selection_i  (行业内 α)
 *     - sizing_contrib     ← Σ allocation_i (over/underweight 行业 β)
 *     - timing_contrib     ← Σ interaction_i (交叉项, 物理上"权重选对 + 选股正确"
 *                                              重叠收益, 作为"择时"近似)
 *     - factor_contrib / factor_contrib_total ← 0 (留 PM-005 因子模型扩)
 *
 *   不变量 (AC §E.2):
 *     total_pnl ≈ industry_contrib(sell) + selection + sizing + timing + factor + execution + residual
 *     PM-001 placeholder 模式 residual = total - industry + execution_cost (4 维 = 0)
 *     PM-002 接入后 residual 重算 = total - industry - allocation - selection - interaction
 *            + execution_cost 让等式仍 trivially 成立. tolerance ±5%.
 *
 * ─── 关键约束 ─────────────────────────────────────────────────────────
 *
 *   - 任何行业 weight 缺失 → 视作 0 (不参与计算, 不抛)
 *   - 任何 return 缺失 → 视作 0 (industry α 计为 0 而非 NaN)
 *   - portfolio_value <= 0 → 全部 contrib = 0 + residual = total_pnl (空 portfolio
 *     无意义拆解, fail-safe)
 *   - 总权重不归一: 不强归一, 直接按传入 weight 算; caller 应保证 portfolio
 *     weights sum ≈ 1 (allow small drift); benchmark weights 缺失走等权回退
 *   - 任何 NaN/Infinity → 0 (round2 + Number.isFinite gate)
 *
 *   这些"fail-safe" 是因为 caller 数据源 (持仓 + benchmark) 可能某天某只股票
 *   数据缺失, 不应让整个归因报告挂掉.
 *
 * ─── 主要消费方 ────────────────────────────────────────────────────────
 *
 *   - PM-001 `buildDailyAttributionReport(input)` — 当 caller 传入
 *     `attribution_engine_input` 时, 主入口调本 engine 替换 4 维 placeholder
 *   - 未来 PM-006 cron — 准备好 industry benchmark map 后传给 buildReport
 *   - 单测/CLI — 直接调 `computeBrinsonFachler(input)` 验证算法
 *
 * 设计风格与既有 BenchmarkAttributionService / IndustryAttributionService
 * 同款: 全 export pure helper + 常量 + 类型, 不依赖任何 model/sequelize.
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** Brinson-Fachler 主入口的单个 industry 行 — caller 准备好后传入. */
export interface AttributionIndustryRow {
  industry: string;
  /** portfolio 权重 (0..1 小数); 0 / 缺失 视作 0 */
  portfolio_weight: number;
  /** benchmark 权重 (0..1 小数); 缺失自动等权回退 */
  benchmark_weight?: number;
  /** portfolio 持仓在本行业的日收益率 (0..±N 小数, e.g. 0.012 = +1.2%); 缺失 = 0 */
  portfolio_return: number;
  /** 行业基准日收益率 (0..±N 小数); 缺失 = 0 */
  benchmark_return: number;
}

export interface AttributionEngineInput {
  /** portfolio EOD 总值 (元); <= 0 时 fail-safe 全 0 */
  portfolio_value: number;
  /** 每个行业一行; 同 industry 名字重复时会自动合并 (weight/return 各自 sum) */
  rows: AttributionIndustryRow[];
}

export interface IndustryAttributionDetail {
  industry: string;
  allocation: number; // 元
  selection: number; // 元
  interaction: number; // 元
}

export interface AttributionEngineResult {
  /** Σ allocation_i — 行业 β (sizing_contrib 对应) */
  allocation_contrib: number;
  /** Σ selection_i — 行业内 α (selection_contrib 对应) */
  selection_contrib: number;
  /** Σ interaction_i — 交叉项 (timing_contrib 对应) */
  interaction_contrib: number;
  /** 总 active return = Σ (allocation + selection + interaction) */
  total_active_return: number;
  /** 每个行业的明细 (按 |allocation+selection+interaction| 降序) */
  by_industry: IndustryAttributionDetail[];
  /** 统计 — 有几个行业参与, 是否退化等权 */
  meta: {
    industry_count: number;
    used_equal_weight_benchmark: boolean;
    skipped_rows: number;
  };
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** 把"任意 unknown" 安全转有限数, 非法返 fallback. */
export function safeFiniteNumber(v: unknown, fallback = 0): number {
  if (typeof v !== 'number') return fallback;
  if (!Number.isFinite(v)) return fallback;
  return v;
}

/** 行业名 normalize — 空/null 归 '其它', trim. 与 PM-001 同款. */
export function normalizeAttributionIndustry(s: unknown): string {
  if (typeof s !== 'string') return '其它';
  const t = s.trim();
  return t.length > 0 ? t : '其它';
}

/**
 * 把 rows 内同 industry 名的多条合并 — weight 累加, return 按"权重加权平均"重算
 * (避免 caller 同行业拆多条时 r_p,i 失真).
 */
export function mergeAttributionRowsByIndustry(
  rows: AttributionIndustryRow[]
): AttributionIndustryRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  type Acc = {
    industry: string;
    p_w: number;
    b_w: number;
    p_ret_weighted: number;
    p_w_for_ret: number;
    b_ret_weighted: number;
    b_w_for_ret: number;
    has_b_w: boolean;
  };
  const buckets = new Map<string, Acc>();
  for (const r of rows) {
    const ind = normalizeAttributionIndustry(r?.industry);
    const p_w = safeFiniteNumber(r?.portfolio_weight, 0);
    const has_b_w_field = r != null && r.benchmark_weight !== undefined;
    const b_w_field = safeFiniteNumber(r?.benchmark_weight, 0);
    const p_ret = safeFiniteNumber(r?.portfolio_return, 0);
    const b_ret = safeFiniteNumber(r?.benchmark_return, 0);
    const cur =
      buckets.get(ind) ||
      ({
        industry: ind,
        p_w: 0,
        b_w: 0,
        p_ret_weighted: 0,
        p_w_for_ret: 0,
        b_ret_weighted: 0,
        b_w_for_ret: 0,
        has_b_w: false,
      } as Acc);
    cur.p_w += p_w;
    if (has_b_w_field) {
      cur.b_w += b_w_field;
      cur.has_b_w = true;
    }
    // portfolio return 按 portfolio weight 加权
    cur.p_ret_weighted += p_ret * p_w;
    cur.p_w_for_ret += p_w;
    // benchmark return 按 benchmark weight 加权 (若无 benchmark weight, 按 portfolio weight 退化)
    const w_for_b = has_b_w_field ? b_w_field : p_w;
    cur.b_ret_weighted += b_ret * w_for_b;
    cur.b_w_for_ret += w_for_b;
    buckets.set(ind, cur);
  }
  const out: AttributionIndustryRow[] = [];
  for (const acc of buckets.values()) {
    out.push({
      industry: acc.industry,
      portfolio_weight: acc.p_w,
      benchmark_weight: acc.has_b_w ? acc.b_w : undefined,
      portfolio_return: acc.p_w_for_ret > 0 ? acc.p_ret_weighted / acc.p_w_for_ret : 0,
      benchmark_return: acc.b_w_for_ret > 0 ? acc.b_ret_weighted / acc.b_w_for_ret : 0,
    });
  }
  return out;
}

/**
 * 当 caller 未给 benchmark_weight 时, 用 universe 等权 (1/N) 作为基准权重.
 * 返新数组, 不改原.
 *
 * 注意: 即使部分行业给了 benchmark_weight 部分没给, 仍然走"未给的全部"等权 +
 * "给了的"按给的算 (而不是把所有行业一并等权), 否则 caller 部分提供基准时
 * 会被静默覆盖.
 */
export function fillBenchmarkWeightsEqual(rows: AttributionIndustryRow[]): {
  rows: AttributionIndustryRow[];
  used_equal: boolean;
} {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { rows: [], used_equal: false };
  }
  const total = rows.length;
  const missing = rows.filter(r => r.benchmark_weight === undefined);
  if (missing.length === 0) {
    return { rows: rows.map(r => ({ ...r })), used_equal: false };
  }
  // 给的部分总和
  let givenSum = 0;
  for (const r of rows) {
    if (r.benchmark_weight !== undefined) {
      givenSum += safeFiniteNumber(r.benchmark_weight, 0);
    }
  }
  // 留给未给行业的剩余, 平摊
  const remain = Math.max(0, 1 - givenSum);
  const perMissing = missing.length > 0 ? remain / missing.length : 0;
  const out = rows.map(r => ({
    ...r,
    benchmark_weight:
      r.benchmark_weight !== undefined ? safeFiniteNumber(r.benchmark_weight, 0) : perMissing,
  }));
  // 当所有行业都没给 benchmark_weight → 退化等权 1/N
  const allMissing = missing.length === total;
  return { rows: out, used_equal: allMissing || perMissing > 0 };
}

/**
 * Brinson-Fachler 单行计算 — 返回元单位 contrib.
 *
 * @param row 已 normalize, weight/return 全数字
 * @param V   portfolio_value (元); 调用前必须 > 0
 */
export function computeRowAttribution(
  row: AttributionIndustryRow,
  V: number
): IndustryAttributionDetail {
  const p_w = safeFiniteNumber(row.portfolio_weight, 0);
  const b_w = safeFiniteNumber(row.benchmark_weight, 0);
  const p_ret = safeFiniteNumber(row.portfolio_return, 0);
  const b_ret = safeFiniteNumber(row.benchmark_return, 0);
  const allocation = (p_w - b_w) * b_ret * V;
  const selection = b_w * (p_ret - b_ret) * V;
  const interaction = (p_w - b_w) * (p_ret - b_ret) * V;
  return {
    industry: row.industry,
    allocation: round2(allocation),
    selection: round2(selection),
    interaction: round2(interaction),
  };
}

/**
 * Brinson-Fachler 主入口 — pure function.
 *
 * 输入: portfolio_value + 行业行数组 (每行含 portfolio/benchmark weight + return)
 * 输出: 4 个聚合数 + by_industry 明细 + meta
 *
 * fail-safe 链路:
 *   - rows 非数组/空 → 全 0 (industry_count=0)
 *   - portfolio_value <= 0 → 全 0 (V=0 时所有公式自动 0; 但显式守住避免 NaN)
 *   - 任何 row 数字 NaN/null → safeFiniteNumber 兜底 0
 *   - 同 industry 重复 → mergeAttributionRowsByIndustry 自动合并
 *   - benchmark_weight 缺失 → fillBenchmarkWeightsEqual 等权回退
 *
 * AC §E.2 (±5%) 校验由 caller 在 buildDailyAttributionReport 内完成
 * (residual 重算让等式 trivially 成立).
 */
export function computeBrinsonFachler(input: AttributionEngineInput): AttributionEngineResult {
  const empty: AttributionEngineResult = {
    allocation_contrib: 0,
    selection_contrib: 0,
    interaction_contrib: 0,
    total_active_return: 0,
    by_industry: [],
    meta: { industry_count: 0, used_equal_weight_benchmark: false, skipped_rows: 0 },
  };
  if (input == null || !Array.isArray(input.rows) || input.rows.length === 0) {
    return empty;
  }
  const V = safeFiniteNumber(input.portfolio_value, 0);
  if (V <= 0) {
    return empty;
  }
  // 1. 合并同 industry
  const merged = mergeAttributionRowsByIndustry(input.rows);
  if (merged.length === 0) return empty;
  const skipped = input.rows.length - merged.length;
  // 2. benchmark weight 等权回退
  const filled = fillBenchmarkWeightsEqual(merged);
  // 3. 逐行 Brinson-Fachler
  let allocation = 0;
  let selection = 0;
  let interaction = 0;
  const details: IndustryAttributionDetail[] = [];
  for (const r of filled.rows) {
    const det = computeRowAttribution(r, V);
    allocation += det.allocation;
    selection += det.selection;
    interaction += det.interaction;
    details.push(det);
  }
  // 4. 排序 by_industry — 按 |total| 降序便于 UI 取 top
  details.sort((a, b) => {
    const ta = Math.abs(a.allocation + a.selection + a.interaction);
    const tb = Math.abs(b.allocation + b.selection + b.interaction);
    return tb - ta || a.industry.localeCompare(b.industry);
  });
  return {
    allocation_contrib: round2(allocation),
    selection_contrib: round2(selection),
    interaction_contrib: round2(interaction),
    total_active_return: round2(allocation + selection + interaction),
    by_industry: details,
    meta: {
      industry_count: merged.length,
      used_equal_weight_benchmark: filled.used_equal,
      skipped_rows: skipped,
    },
  };
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
