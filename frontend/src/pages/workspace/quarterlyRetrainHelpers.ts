/**
 * quarterlyRetrainHelpers — LabWorkspace 季度参数重训 tab (US-050 / FE-011) 纯函数集合。
 *
 * 这个 tab 把"过去 N 个季度内、每个策略各自做过的参数搜索 (Walk-Forward / Bayesian / GridSearch) 的
 * 候选结果"按季度 + 策略两维聚合, 让用户回答两个问题:
 *
 *   1. "本季度有哪些策略被重训过, 跑出来的候选 top-K 参数组各自评分如何?"
 *   2. "目前生产环境里, 哪些策略实际上跑在 shadow (dry-run) 模式上?"
 *
 * 与 backend 解耦: 数据全部复用既有 listOptimizationRuns / listQuantStrategies 端点,
 * 不需要新加 API. 业务逻辑 (季度聚合 / 候选排序 / shadow 判定) 全部抽到本文件 pure helper,
 * 单测在 backend/tests/services/ 跑 ts-node 不依赖 jsdom (与 [[factorAIWeightHelpers]] /
 * [[factorPickReasonHelpers]] / [[etfFlowHelpers]] 同款 frontend pure helper 范式).
 *
 * 设计取舍:
 *  - "季度" 定义按自然年: Q1=1-3 月 / Q2=4-6 / Q3=7-9 / Q4=10-12, 与财报披露季度一致.
 *  - "候选" 定义: 一个 OptimizationRun 算一个候选 (而不是每条 OptimizationResult — 那是 sub-combo
 *    级的, UI 表格里展开 N×K 行不可读). 想看单 run 内具体最佳 param 走 "优化历史" tab 的 expandable
 *    行 (已存在).
 *  - "shadow 模式" 通过 `QuantStrategyItem.lifecycle_policy.dry_run === true` 判定, 与 US-083
 *    setStrategyDryRun 同源 (后端 typed shortcut), 不重复语义.
 *  - 排序优先级: walk_forward.dsr DESC > walk_forward.mean_test_sharpe DESC > metadata.deflated_sharpe.deflated_sharpe DESC > sharpe DESC > created_at DESC.
 *    DSR / mean_test_sharpe 比 raw sharpe 更抗过拟合, 用户调参时应该首选这些指标; 但兼容性兜底必须有,
 *    否则空数据期表格全是 "—".
 */

import type { OptimizationRunSummary, QuantStrategyItem } from '../../services/labService';

// ===========================================================================
// 常量
// ===========================================================================

/** 季度展示标签 (中文) — UI Tag / Statistic title 共用 */
export const QUARTER_LABELS = Object.freeze({
  Q1: 'Q1 一季度',
  Q2: 'Q2 二季度',
  Q3: 'Q3 三季度',
  Q4: 'Q4 四季度',
});

/** 默认展示最近 N 个季度 (含本季) */
export const DEFAULT_QUARTERS_WINDOW = 4;

/** 每个 (quarter, strategy) 桶里展示 top-K 候选 */
export const DEFAULT_CANDIDATES_PER_BUCKET = 5;

/** Shadow 徽标文案 */
export const SHADOW_BADGE_TEXT = 'Shadow';
/** 正式（hard / live）模式徽标文案 */
export const HARD_BADGE_TEXT = '生产';

// ===========================================================================
// 季度工具
// ===========================================================================

/** 'YYYY-Q1' 形式 */
export type QuarterKey = string;

/**
 * 把任意 Date / ISO string / undefined 归一到 quarter key (e.g. '2026-Q2').
 * 非法输入返 null — caller 负责丢弃, 不静默 fallback 到当前季度 (会污染历史季度聚合).
 */
export function getQuarterKey(input: Date | string | null | undefined): QuarterKey | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return null;
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-11
  const q = Math.floor(month / 3) + 1; // 1..4
  return `${year}-Q${q}`;
}

/**
 * 返回 [now, now-1Q, now-2Q, ...] 最近 count 个 quarter key, 倒序 (最新在前).
 * 用于 tab 顶部的 Select 选项 + 默认 activeQuarter 取数组首项.
 */
export function getRecentQuarters(now: Date, count: number): QuarterKey[] {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return [];
  const safeCount = Math.max(1, Math.min(20, Math.floor(count) || 0));
  const out: QuarterKey[] = [];
  let year = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) + 1;
  for (let i = 0; i < safeCount; i++) {
    out.push(`${year}-Q${q}`);
    q--;
    if (q < 1) {
      q = 4;
      year--;
    }
  }
  return out;
}

/** 把 quarter key 拆成 { year, quarter }; 非法返 null. */
export function parseQuarterKey(key: QuarterKey): { year: number; quarter: 1 | 2 | 3 | 4 } | null {
  if (typeof key !== 'string') return null;
  const m = /^(\d{4})-Q([1-4])$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), quarter: Number(m[2]) as 1 | 2 | 3 | 4 };
}

// ===========================================================================
// 候选聚合 / 排序
// ===========================================================================

/**
 * 单候选 (聚合维度: 一个 OptimizationRun = 一个候选).
 * 从 OptimizationRunSummary 推导, 保留 caller 想展示的所有字段.
 */
export interface RetrainCandidate {
  run_id: number;
  optimizer_type: 'grid_search' | 'bayesian' | 'walk_forward';
  strategy_name: string;
  status: string;
  /** primary metric for ranking — DSR (if WF) > mean_test_sharpe (if WF) > deflated_sharpe (if GS/Bayesian) > null */
  primary_metric: number | null;
  /** 哪个字段被选中作为 primary_metric — UI 用来标注 "DSR" / "mean test sharpe" / "deflated sharpe" / "—" */
  primary_metric_kind: 'dsr' | 'mean_test_sharpe' | 'deflated_sharpe' | 'none';
  /** WF verdict (PASS / FAIL / INSUFFICIENT), 非 WF 一律 null */
  verdict: 'PASS' | 'FAIL' | 'INSUFFICIENT' | null;
  total_combos: number;
  completed_combos: number;
  failed_combos: number;
  created_at: string | null;
  finished_at: string | null;
  quarter_key: QuarterKey | null;
}

/**
 * 把一个 OptimizationRunSummary 转成 RetrainCandidate (含 quarter 推导 + 主指标抽取).
 * created_at 非法时 quarter_key=null — caller 决定是否丢弃这种 "未归档" 候选.
 */
export function toRetrainCandidate(
  run: OptimizationRunSummary | null | undefined
): RetrainCandidate | null {
  if (!run || typeof run.id !== 'number') return null;
  const quarter_key = getQuarterKey(run.created_at);
  // 主指标抽取 — DSR / mean_test_sharpe / deflated_sharpe 三路兜底.
  let primary_metric: number | null = null;
  let primary_metric_kind: RetrainCandidate['primary_metric_kind'] = 'none';
  const wfSummary = run.summary || run.metadata_json?.wf_summary;
  if (wfSummary && typeof wfSummary.dsr === 'number' && Number.isFinite(wfSummary.dsr)) {
    primary_metric = wfSummary.dsr;
    primary_metric_kind = 'dsr';
  } else if (
    wfSummary &&
    typeof wfSummary.mean_test_sharpe === 'number' &&
    Number.isFinite(wfSummary.mean_test_sharpe)
  ) {
    primary_metric = wfSummary.mean_test_sharpe;
    primary_metric_kind = 'mean_test_sharpe';
  } else {
    const ds = run.metadata_json?.deflated_sharpe?.deflated_sharpe;
    if (typeof ds === 'number' && Number.isFinite(ds)) {
      primary_metric = ds;
      primary_metric_kind = 'deflated_sharpe';
    }
  }
  return {
    run_id: run.id,
    optimizer_type: run.optimizer_type,
    strategy_name: run.strategy_name || '',
    status: String(run.status || ''),
    primary_metric,
    primary_metric_kind,
    verdict: wfSummary?.verdict ?? null,
    total_combos: Number(run.total_combos) || 0,
    completed_combos: Number(run.completed_combos) || 0,
    failed_combos: Number(run.failed_combos) || 0,
    created_at: run.created_at || null,
    finished_at: run.finished_at || null,
    quarter_key,
  };
}

/**
 * 按 quarter_key 归组. 同时按 candidate 内的 strategy_name 二级分组, 返回:
 *   Map<quarter_key, Map<strategy_name, RetrainCandidate[]>>
 *
 * Map 顺序: quarter desc / strategy 字母升序 / 候选 primary_metric desc + finished_at desc tie-break.
 */
export function groupCandidatesByQuarterAndStrategy(
  candidates: RetrainCandidate[]
): Map<QuarterKey, Map<string, RetrainCandidate[]>> {
  const out = new Map<QuarterKey, Map<string, RetrainCandidate[]>>();
  if (!Array.isArray(candidates)) return out;
  // 先按 quarter 分桶
  for (const c of candidates) {
    if (!c || !c.quarter_key) continue;
    let qBucket = out.get(c.quarter_key);
    if (!qBucket) {
      qBucket = new Map<string, RetrainCandidate[]>();
      out.set(c.quarter_key, qBucket);
    }
    const sKey = c.strategy_name || '(未命名)';
    let sList = qBucket.get(sKey);
    if (!sList) {
      sList = [];
      qBucket.set(sKey, sList);
    }
    sList.push(c);
  }
  // 每个 (quarter, strategy) 桶内排序: primary_metric DESC tie -> finished_at DESC tie -> run_id DESC
  out.forEach(qBucket => {
    qBucket.forEach(arr => {
      arr.sort((a, b) => {
        const am = a.primary_metric;
        const bm = b.primary_metric;
        if (am !== null && bm !== null && am !== bm) return bm - am;
        if (am !== null && bm === null) return -1;
        if (am === null && bm !== null) return 1;
        // 再按 finished_at desc
        const at = a.finished_at ? Date.parse(a.finished_at) : 0;
        const bt = b.finished_at ? Date.parse(b.finished_at) : 0;
        if (at !== bt) return bt - at;
        return b.run_id - a.run_id;
      });
    });
  });
  return out;
}

/** 截 top-K 候选 (default 5) — 桶内已排好序, 仅 slice. */
export function topKCandidates(
  bucket: RetrainCandidate[] | undefined,
  k: number = DEFAULT_CANDIDATES_PER_BUCKET
): RetrainCandidate[] {
  if (!Array.isArray(bucket) || bucket.length === 0) return [];
  const safeK = Math.max(1, Math.min(50, Math.floor(k) || DEFAULT_CANDIDATES_PER_BUCKET));
  return bucket.slice(0, safeK);
}

// ===========================================================================
// Shadow 模式判定
// ===========================================================================

/**
 * 判定一个策略是否跑在 shadow 模式 (dry_run=true).
 * 与 setStrategyDryRun (US-083) 同源 — 后端 typed shortcut 把 dry_run 落到
 * lifecycle_policy.dry_run JSONB 子字段. 三态兼容:
 *   - lifecycle_policy.dry_run === true → shadow
 *   - lifecycle_policy 缺 dry_run / false / 任意非 boolean → 生产
 *   - strategy 本身为 null/undefined → 当作生产 (UI fallback 安全态)
 *
 * 这条逻辑 backend 测试也会引用, 不要 inline 写到组件里.
 */
export function isShadowStrategy(
  strategy: (QuantStrategyItem & { lifecycle_policy?: Record<string, any> }) | null | undefined
): boolean {
  if (!strategy) return false;
  const lp = (strategy as any).lifecycle_policy;
  if (!lp || typeof lp !== 'object') return false;
  return lp.dry_run === true;
}

/**
 * 用 strategies 列表里 strategy_key === strategy_name 做 lookup
 * (注: backend OptimizationRun.strategy_name 实际是 strategy_key 的别名 — 见
 * backend/src/quant/backtest/WalkForwardValidator.ts 第 884 行).
 * 找不到时返 false (当作生产).
 */
export function lookupShadowByStrategyName(
  strategies:
    | Array<QuantStrategyItem & { lifecycle_policy?: Record<string, any> }>
    | null
    | undefined,
  strategyName: string
): boolean {
  if (!Array.isArray(strategies) || !strategyName) return false;
  const hit = strategies.find(s => s && (s as any).strategy_key === strategyName);
  return isShadowStrategy(hit);
}

// ===========================================================================
// 主入口: build view model (caller 直接 useMemo 调一次)
// ===========================================================================

export interface QuarterlyRetrainViewModel {
  /** 用户可选的 quarter 列表 (倒序, 最新在前) */
  quarterOptions: QuarterKey[];
  /** {quarter_key → {strategy_name → top-K candidates}} */
  bucketsByQuarter: Map<QuarterKey, Map<string, RetrainCandidate[]>>;
  /** 所有候选总数 (info bar 显示) */
  totalCandidates: number;
  /** 当前 active quarter 桶里有多少策略被重训 */
  strategiesInActiveQuarter: number;
  /** 当前 active quarter 桶里多少策略仍处于 shadow 模式 (按 isShadow 判定) */
  shadowStrategiesInActiveQuarter: number;
}

/**
 * 主入口 — 给定 (runs, strategies, now, activeQuarter) 输出 view model.
 * 任何一路输入异常 / 空, 都安全返一个空 model (UI render `Empty` 即可).
 */
export function buildQuarterlyRetrainViewModel(input: {
  runs: OptimizationRunSummary[] | null | undefined;
  strategies:
    | Array<QuantStrategyItem & { lifecycle_policy?: Record<string, any> }>
    | null
    | undefined;
  now: Date;
  activeQuarter?: QuarterKey | null;
  windowSize?: number;
  topK?: number;
}): QuarterlyRetrainViewModel {
  const safeRuns: OptimizationRunSummary[] = Array.isArray(input.runs) ? input.runs : [];
  const candidates = safeRuns
    .map(toRetrainCandidate)
    .filter((c): c is RetrainCandidate => c !== null);
  const buckets = groupCandidatesByQuarterAndStrategy(candidates);
  const quarterOptions = getRecentQuarters(
    input.now,
    Math.max(1, input.windowSize ?? DEFAULT_QUARTERS_WINDOW)
  );
  const active = input.activeQuarter || quarterOptions[0] || null;
  // 仅留 top-K + 仅留落在 window 内的 quarter (历史长尾数据保留在 raw bucket, view model 限定 window)
  const limited = new Map<QuarterKey, Map<string, RetrainCandidate[]>>();
  for (const qKey of quarterOptions) {
    const qBucket = buckets.get(qKey);
    if (!qBucket) continue;
    const limitedStrategies = new Map<string, RetrainCandidate[]>();
    qBucket.forEach((arr, sKey) => {
      limitedStrategies.set(sKey, topKCandidates(arr, input.topK ?? DEFAULT_CANDIDATES_PER_BUCKET));
    });
    limited.set(qKey, limitedStrategies);
  }
  // KPI 计算: active quarter 桶
  const activeBucket = active ? limited.get(active) : undefined;
  const strategiesInActiveQuarter = activeBucket ? activeBucket.size : 0;
  let shadowStrategiesInActiveQuarter = 0;
  if (activeBucket) {
    activeBucket.forEach((_arr, sKey) => {
      if (lookupShadowByStrategyName(input.strategies, sKey)) shadowStrategiesInActiveQuarter++;
    });
  }
  return {
    quarterOptions,
    bucketsByQuarter: limited,
    totalCandidates: candidates.length,
    strategiesInActiveQuarter,
    shadowStrategiesInActiveQuarter,
  };
}
