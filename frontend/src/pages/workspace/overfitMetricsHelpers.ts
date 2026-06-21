/**
 * overfitMetricsHelpers — LabWorkspace OverfitMetrics 区块 (US-052 / FE-013) 纯函数集合.
 *
 * 业务背景 — Sprint 1A 起后端 GridSearch / Bayesian / Walk-Forward 三类 optimizer
 * 都在 metadata_json 里持久化两个学术界过拟合指标:
 *   - DSR (Deflated Sharpe Ratio, Bailey & López de Prado 2014):
 *       修正 sharpe 因多次试验 / 样本长度 / 偏斜度 / 峰度引入的过拟合偏差.
 *       DSR ≥ 0.95 = 大概率非过拟合; < 0.95 警惕 (默认阈值 [[DSR_PASS_THRESHOLD]]).
 *   - PBO (Probability of Backtest Overfitting, López de Prado 2018):
 *       CPCV 多路径下 "in-sample 冠军 → out-of-sample 排名 < median" 的频率.
 *       PBO < 0.5 = 通过; ≥ 0.5 = 大概率过拟合 (默认阈值 [[PBO_FAIL_THRESHOLD]]).
 *
 * 这个 tab 让操盘手在 LabWorkspace 一眼看清整批 optimization run 的 DSR/PBO 通过率,
 * 把"光看 sharpe = 1.4 就 promote 参数"的过拟合风险显式化, 与 promotion gate (US-049)
 * 的 verdict 字段对齐. 与既有 Walk-Forward tab (FE-009) 关注单 run 详情形成互补:
 *   - WalkForward tab → 单 run 的 KPI strip + fold 表
 *   - 本 tab → 跨 run / 跨 optimizer 的 verdict 分布 + 最近 N 个 run 的 DSR/PBO 一览
 *
 * 数据流向:
 *   labService.listOptimizationRuns({...}) → buildOverfitMetricsViewModel(runs) → UI
 *
 * 设计取舍 (与 [[shadowRunHelpers]] / [[quarterlyRetrainHelpers]] 同款 frontend
 * pure helper 范式):
 *  - 阈值常量全 export + Object.freeze + 单测守 sanity, 运维一处调参.
 *  - 三态分级 (healthy / degraded / critical / unknown) 与 [[shadowRunHelpers]]
 *    HealthLevel 命名一致, 让 UI Tag color 跨 tab 直觉统一.
 *  - 提取 DSR/PBO 兼容三类 optimizer 的 metadata 形状差异:
 *      * walk_forward → metadata_json.wf_summary.{dsr,pbo}
 *      * grid_search / bayesian → metadata_json.deflated_sharpe.deflated_sharpe (无 PBO)
 *    抽到 extractOverfitMetric() 一处, 加 fold 不同 optimizer 复用本 helper 不踩坑.
 *  - 空数据 / null 输入安全返 'unknown' / 0, 不静默 fallback 'healthy' (避免空表
 *    被误读为"全绿".), 与 shadowRunHelpers 同款 fail-LOUD 默认.
 *  - 不依赖 React / antd, 单测在 backend/tests/services 跑 ts-node 即可.
 */

// ===========================================================================
// 常量 — 与 backend OverfitMetrics.ts 同源
// ===========================================================================

/**
 * DSR 通过阈值 — 与 backend backend/src/quant/backtest/OverfitMetrics.ts
 * `DSR_PASS_THRESHOLD` 同值. 调一处必须同步另一端 (META-GUARD 不强制因跨语言难,
 * 但单测会断常量本身的 sanity).
 */
export const DSR_PASS_THRESHOLD = 0.95;

/** DSR degraded 阈值 — 介于 [DSR_DEGRADED_MIN, DSR_PASS_THRESHOLD) 为 degraded */
export const DSR_DEGRADED_MIN = 0.8;

/**
 * PBO 失败阈值 (越低越好) — 与 backend OverfitMetrics.ts `PBO_FAIL_THRESHOLD` 同值.
 * PBO ≥ PBO_FAIL_THRESHOLD → critical; ≥ PBO_DEGRADED_MIN → degraded; 否则 healthy.
 */
export const PBO_FAIL_THRESHOLD = 0.5;

/** PBO degraded 阈值 — 介于 [PBO_DEGRADED_MIN, PBO_FAIL_THRESHOLD) 为 degraded */
export const PBO_DEGRADED_MIN = 0.3;

/** UI 最近 N 个 run 列表默认上限 */
export const DEFAULT_RUNS_LIMIT = 50;

/** 单测 / 健康度计算时最小样本量 — 少于此数 ratio 不参与 promote 评估 */
export const PROMOTE_MIN_RUNS = 5;

// ===========================================================================
// 类型 — 与 frontend/src/services/labService.ts OptimizationRunSummary 对齐
// ===========================================================================

export type OverfitVerdict = 'PASS' | 'FAIL' | 'INSUFFICIENT';

export type HealthLevel = 'healthy' | 'degraded' | 'critical' | 'unknown';

/**
 * 提取自 OptimizationRunSummary 的过拟合摘要 — 把三类 optimizer 的 metadata 形状差异
 * 屏蔽掉, UI 只需关心 dsr / pbo / verdict 三个字段.
 */
export interface OverfitMetric {
  /** Deflated Sharpe Ratio, null 表示该 run 未计算 (e.g. 旧版本数据) */
  dsr: number | null;
  /** Probability of Backtest Overfitting, 仅 CPCV walk_forward 才有 */
  pbo: number | null;
  /** verdict: 优先取 wf_summary.verdict, 否则按 DSR/PBO 阈值推导 */
  verdict: OverfitVerdict;
  /** DSR 单项分级 */
  dsrLevel: HealthLevel;
  /** PBO 单项分级 (无 PBO 时为 'unknown') */
  pboLevel: HealthLevel;
}

/** 与 labService.OptimizationRunSummary 的精简结构等价 (避免循环 import) */
export interface OptimizationRunLike {
  id: number;
  optimizer_type: 'grid_search' | 'bayesian' | 'walk_forward' | string;
  strategy_name: string;
  status: string;
  total_combos?: number;
  completed_combos?: number;
  failed_combos?: number;
  created_at: string;
  metadata_json?: {
    wf_summary?: {
      dsr?: number | null;
      pbo?: number | null;
      verdict?: OverfitVerdict | null;
      mean_test_sharpe?: number | null;
      [k: string]: any;
    };
    deflated_sharpe?: {
      deflated_sharpe?: number;
      is_significant?: boolean;
      explanation?: string;
      [k: string]: any;
    };
    [k: string]: any;
  };
  summary?: {
    dsr?: number | null;
    pbo?: number | null;
    verdict?: OverfitVerdict | null;
    [k: string]: any;
  };
}

export interface OverfitMetricRow {
  id: number;
  optimizer_type: string;
  strategy_name: string;
  status: string;
  created_at: string;
  metric: OverfitMetric;
}

export interface OverfitDistribution {
  /** verdict=PASS 的 run 数 */
  pass: number;
  /** verdict=FAIL 的 run 数 */
  fail: number;
  /** verdict=INSUFFICIENT 的 run 数 (DSR/PBO 缺失或不可计算) */
  insufficient: number;
  /** 三档合计 (= rows.length) */
  total: number;
  /** PASS / (PASS+FAIL) — INSUFFICIENT 不计入分母; 分母为 0 时返 null */
  passRate: number | null;
}

export interface OverfitPromotionReadiness {
  ready: boolean;
  blockers: string[];
  level: HealthLevel;
}

export interface OverfitMetricsViewModel {
  /** 总 run 数 (输入 rows.length) */
  total: number;
  /** verdict 分布 + passRate */
  distribution: OverfitDistribution;
  /** 平均 DSR (仅含 dsr 非 null), 不足样本返 null */
  meanDsr: number | null;
  /** 平均 PBO (仅含 pbo 非 null), 不足样本返 null */
  meanPbo: number | null;
  /** 加 metric 字段并按 (verdict FAIL → PASS → INSUFFICIENT) + created_at desc 排序 */
  rows: OverfitMetricRow[];
  /** 综合 fleet 是否可批量 promote (PASS ratio 高 + 无 PBO critical) */
  promotion: OverfitPromotionReadiness;
}

// ===========================================================================
// 分级与 verdict 推导
// ===========================================================================

/**
 * DSR 单项分级. NaN / null / undefined / Infinity → 'unknown' (避免被误判 healthy).
 */
export function classifyDsrLevel(dsr: number | null | undefined): HealthLevel {
  if (dsr == null || !Number.isFinite(Number(dsr))) return 'unknown';
  const v = Number(dsr);
  if (v >= DSR_PASS_THRESHOLD) return 'healthy';
  if (v >= DSR_DEGRADED_MIN) return 'degraded';
  return 'critical';
}

/**
 * PBO 单项分级 (越低越好). NaN / null / undefined / Infinity → 'unknown'.
 * 阈值约定 (与 backend deriveWalkForwardVerdict 对齐):
 *   pbo < PBO_DEGRADED_MIN → healthy
 *   pbo ∈ [PBO_DEGRADED_MIN, PBO_FAIL_THRESHOLD) → degraded
 *   pbo ≥ PBO_FAIL_THRESHOLD → critical
 */
export function classifyPboLevel(pbo: number | null | undefined): HealthLevel {
  if (pbo == null || !Number.isFinite(Number(pbo))) return 'unknown';
  const v = Number(pbo);
  if (v < PBO_DEGRADED_MIN) return 'healthy';
  if (v < PBO_FAIL_THRESHOLD) return 'degraded';
  return 'critical';
}

/**
 * 综合 DSR + PBO 推导 verdict, 与 backend deriveWalkForwardVerdict 规则一致:
 *   - PASS: DSR ≥ 0.95 且 (PBO 缺失 或 PBO < 0.5)
 *   - FAIL: DSR < 0.95 或 PBO ≥ 0.5
 *   - INSUFFICIENT: DSR 为 null/NaN 时无法判断
 *
 * 这是 backend 同名 helper 的前端镜像, 单测会守阈值常量与之同步.
 */
export function deriveOverfitVerdict(input: {
  dsr: number | null | undefined;
  pbo: number | null | undefined;
}): OverfitVerdict {
  const dsr = input.dsr;
  const pbo = input.pbo;
  if (dsr == null || !Number.isFinite(Number(dsr))) return 'INSUFFICIENT';
  if (pbo != null && !Number.isFinite(Number(pbo))) return 'INSUFFICIENT';
  const dsrPass = Number(dsr) >= DSR_PASS_THRESHOLD;
  const pboPass = pbo == null || Number(pbo) < PBO_FAIL_THRESHOLD;
  return dsrPass && pboPass ? 'PASS' : 'FAIL';
}

// ===========================================================================
// 提取 OptimizationRun 的 OverfitMetric
// ===========================================================================

/**
 * 把 OptimizationRunLike 里的 DSR/PBO 抠出来, 屏蔽 walk_forward vs grid/bayesian
 * 的 metadata 形状差异:
 *
 *   walk_forward → metadata_json.wf_summary.{dsr, pbo, verdict}
 *                  (BacktestEngine.ts:157 已把 wf_summary 抠到 summary 顶层别名)
 *   grid_search / bayesian → metadata_json.deflated_sharpe.deflated_sharpe (无 PBO)
 *
 * verdict 优先级:
 *   1. wf_summary.verdict (后端直接给的最权威)
 *   2. deriveOverfitVerdict(dsr, pbo) 兜底 (DSR/PBO 都有时按阈值推导)
 *
 * 输入 null / undefined / 缺 metadata 返"全 unknown / INSUFFICIENT" 安全态, 不抛.
 */
export function extractOverfitMetric(run: OptimizationRunLike | null | undefined): OverfitMetric {
  if (!run || typeof run !== 'object') {
    return {
      dsr: null,
      pbo: null,
      verdict: 'INSUFFICIENT',
      dsrLevel: 'unknown',
      pboLevel: 'unknown',
    };
  }
  // wf_summary 优先 (walk_forward 自带完整 verdict; summary 顶层别名等价)
  const wf = run.metadata_json?.wf_summary || run.summary;
  let dsr: number | null = null;
  let pbo: number | null = null;
  let verdictHint: OverfitVerdict | null = null;

  if (wf) {
    if (wf.dsr != null && Number.isFinite(Number(wf.dsr))) dsr = Number(wf.dsr);
    if (wf.pbo != null && Number.isFinite(Number(wf.pbo))) pbo = Number(wf.pbo);
    if (wf.verdict === 'PASS' || wf.verdict === 'FAIL' || wf.verdict === 'INSUFFICIENT') {
      verdictHint = wf.verdict;
    }
  }
  // grid_search / bayesian 的 DSR 在 metadata_json.deflated_sharpe.deflated_sharpe
  // 仅当 wf_summary 没给 DSR 时才回退, 防止双源覆盖
  if (dsr == null) {
    const ds = run.metadata_json?.deflated_sharpe?.deflated_sharpe;
    if (ds != null && Number.isFinite(Number(ds))) dsr = Number(ds);
  }

  const verdict = verdictHint || deriveOverfitVerdict({ dsr, pbo });
  return {
    dsr,
    pbo,
    verdict,
    dsrLevel: classifyDsrLevel(dsr),
    pboLevel: classifyPboLevel(pbo),
  };
}

// ===========================================================================
// UI 颜色 / 标签
// ===========================================================================

export const HEALTH_LEVEL_COLOR: Readonly<Record<HealthLevel, string>> = Object.freeze({
  healthy: 'green',
  degraded: 'gold',
  critical: 'red',
  unknown: 'default',
});

export const HEALTH_LEVEL_LABEL: Readonly<Record<HealthLevel, string>> = Object.freeze({
  healthy: '健康',
  degraded: '降级',
  critical: '严重',
  unknown: '—',
});

/** verdict 颜色 (与 [[LabWorkspace.WalkForwardTab]] 已用色一致, 用户认色不断裂) */
export const VERDICT_COLOR: Readonly<Record<OverfitVerdict, string>> = Object.freeze({
  PASS: 'green',
  FAIL: 'red',
  INSUFFICIENT: 'default',
});

export const VERDICT_LABEL: Readonly<Record<OverfitVerdict, string>> = Object.freeze({
  PASS: '通过',
  FAIL: '过拟合',
  INSUFFICIENT: '数据不足',
});

// ===========================================================================
// "fleet 可批量 promote" 综合结论
// ===========================================================================

/**
 * 评估整批 optimization run 的过拟合健康度. 与 [[evaluateShadowPromotionReadiness]]
 * 同款 AND 短路链 — 任一不满足 push 到 blockers, hasCritical 标志决定 level:
 *
 *   1. rows 数 ≥ PROMOTE_MIN_RUNS (少于此数说明评测样本不够, 不能下"批量 promote"结论)
 *   2. passRate ≥ 0.5 (至少一半 run 验证通过)
 *   3. 没有任何 row 的 pboLevel='critical' (PBO ≥ 0.5 触发立即 critical, 单 run 严重过拟合就 block)
 *
 * caller (UI Alert) 拿 ready+blockers+level 直接渲染, 不二次推理.
 */
export function evaluatePromotionReadiness(
  rows: OverfitMetricRow[] | null | undefined
): OverfitPromotionReadiness {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ready: false, blockers: ['尚未拉取到 optimization run 数据'], level: 'unknown' };
  }
  const blockers: string[] = [];
  let hasCritical = false;

  // 1. 样本量
  if (rows.length < PROMOTE_MIN_RUNS) {
    blockers.push(`run 样本量 ${rows.length} < 评测门槛 ${PROMOTE_MIN_RUNS}`);
  }

  // 2. passRate
  const pass = rows.filter(r => r.metric.verdict === 'PASS').length;
  const fail = rows.filter(r => r.metric.verdict === 'FAIL').length;
  const decided = pass + fail;
  if (decided > 0) {
    const passRate = pass / decided;
    if (passRate < 0.5) {
      blockers.push(
        `验证通过率 ${(passRate * 100).toFixed(
          1
        )}% < 50% (${pass}/${decided}); 多数 run 触发 DSR/PBO 失败`
      );
      hasCritical = true;
    }
  } else {
    blockers.push('全部 run 都是 INSUFFICIENT — 缺 DSR/PBO 字段, 检查 optimizer 配置');
  }

  // 3. PBO critical (任何单 run PBO ≥ 0.5 立刻严重)
  const pboCritRows = rows.filter(r => r.metric.pboLevel === 'critical');
  if (pboCritRows.length > 0) {
    blockers.push(
      `PBO 严重 (≥ ${PBO_FAIL_THRESHOLD}) 的 run: ${pboCritRows
        .slice(0, 3)
        .map(r => `#${r.id} ${r.strategy_name}`)
        .join(', ')}${pboCritRows.length > 3 ? ` 等 ${pboCritRows.length} 个` : ''}`
    );
    hasCritical = true;
  }

  const ready = blockers.length === 0;
  let level: HealthLevel = 'healthy';
  if (!ready) level = hasCritical ? 'critical' : 'degraded';
  return { ready, blockers, level };
}

// ===========================================================================
// 主入口 — buildOverfitMetricsViewModel
// ===========================================================================

/**
 * verdict 排序优先级 — FAIL 最前让用户优先关注; PASS 次之; INSUFFICIENT 最后.
 * (与 [[shadowRunHelpers]] LEVEL_ORDER 同思想 — 最差/最需关注的先看到.)
 */
const VERDICT_ORDER: Record<OverfitVerdict, number> = {
  FAIL: 0,
  PASS: 1,
  INSUFFICIENT: 2,
};

/**
 * 主入口 — 给定 OptimizationRun 列表输出 view model. caller 直接 render, 无二次计算.
 * 任何 null / 空 / 异常输入返"零数据安全态" + promotion=ready:false.
 */
export function buildOverfitMetricsViewModel(
  runs: OptimizationRunLike[] | null | undefined
): OverfitMetricsViewModel {
  const list = Array.isArray(runs) ? runs.filter((r): r is OptimizationRunLike => !!r) : [];
  const rows: OverfitMetricRow[] = list.map(r => ({
    id: r.id,
    optimizer_type: r.optimizer_type || 'unknown',
    strategy_name: r.strategy_name || '—',
    status: r.status || 'unknown',
    created_at: r.created_at || '',
    metric: extractOverfitMetric(r),
  }));
  // 排序: verdict (FAIL → PASS → INSUFFICIENT) → created_at desc → id desc
  rows.sort((a, b) => {
    const va = VERDICT_ORDER[a.metric.verdict] ?? 99;
    const vb = VERDICT_ORDER[b.metric.verdict] ?? 99;
    if (va !== vb) return va - vb;
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (!Number.isFinite(ta) || !Number.isFinite(tb) || ta === tb) return b.id - a.id;
    return tb - ta;
  });

  // 分布
  let pass = 0,
    fail = 0,
    insufficient = 0;
  for (const r of rows) {
    if (r.metric.verdict === 'PASS') pass++;
    else if (r.metric.verdict === 'FAIL') fail++;
    else insufficient++;
  }
  const decided = pass + fail;
  const distribution: OverfitDistribution = {
    pass,
    fail,
    insufficient,
    total: rows.length,
    passRate: decided > 0 ? pass / decided : null,
  };

  // 均值 (仅有效)
  const dsrValues = rows
    .map(r => r.metric.dsr)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const pboValues = rows
    .map(r => r.metric.pbo)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const meanDsr =
    dsrValues.length > 0 ? dsrValues.reduce((s, v) => s + v, 0) / dsrValues.length : null;
  const meanPbo =
    pboValues.length > 0 ? pboValues.reduce((s, v) => s + v, 0) / pboValues.length : null;

  return {
    total: rows.length,
    distribution,
    meanDsr,
    meanPbo,
    rows,
    promotion: evaluatePromotionReadiness(rows),
  };
}

// ===========================================================================
// UI 格式化 helper
// ===========================================================================

/** dsr/pbo 通用 3 位小数 fmt; null/NaN → '—' */
export function formatRatio(value: number | null | undefined, digits = 3): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

/** ratio 0-1 → '85.0%'; null/NaN → '—' (与 [[shadowRunHelpers.formatPercent]] 同款) */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}
