/**
 * StrategyLeaderboardHelpers — 策略排行榜 pure helpers（US-054 [FE-015] 超额列）
 *
 * QuantController.getStrategyLeaderboard 的 4 步链路全部抽出来：
 *   1. dedupLatestByStrategyKey  —— 按 strategy_key 去重保留最新 backtest（rows 已按 created_at DESC）
 *   2. filterByFinitePrimarySort —— 过滤掉主排序字段非 finite 的行（NaN/null/undefined 不参与排名）
 *   3. sortLeaderboardItems      —— 按主排序字段 DESC（sharpe / annual / total）稳定排序
 *   4. enrichWithBenchmarkAttributions —— **本 story 新增**：把 BenchmarkAttributionResult 行
 *      按 run_id 分组后挂到每个 leaderboard item 的 `benchmark_attributions` 字段，
 *      让前端一列一基准展示「策略 vs 沪深 300 / 中证 500 / 中证 1000 的超额」。
 *
 * 设计要点：
 *   - 全部纯函数 + 类型显式 export，便于 ts-node 单测脱 DB 全覆盖（与 [[portfolio-construction-adapter]] 同款）。
 *   - 主入口 `buildStrategyLeaderboardItems({rows, attributions, sort_by})` 串起 4 步，
 *     controller 只负责"DB 查 + 调本主入口 + 序列化 response"，不再写业务逻辑。
 *   - benchmark attribution 只读取已物化的 BenchmarkAttributionResult，
 *     不触发新计算（避免 leaderboard 请求拖一遍 CAPM 回归 → 几秒延迟）。
 *     冷启动 / 历史回测没归因行时, item.benchmark_attributions = []。前端兜底 '—'。
 *   - 与 US-028 yoy% 抽取 / US-029 priority 决策表 同款"决策表 + 阈值常量 export"思路，
 *     `BENCHMARK_DISPLAY_ORDER` + `BENCHMARK_NAME_MAP` 双 frozen 让前端列顺序/中文标签稳定。
 *
 * 与既有 BenchmarkAttributionService 区别：
 *   - 后者: 物化 CAPM 回归 alpha/beta/IR → 写库（一次回测可能算几百 ms 到几秒）。
 *   - 本 helper: 纯读取 + 排序 + JOIN，response < 50ms (leaderboard 用)。
 */

/** 主排序字段（PRD AC：sharpe / annual / total 三选一） */
export type LeaderboardSortBy = 'sharpe' | 'annual' | 'total';

/** 主排序字段 → row 字段名映射；export 让单测 + 业务一处定义 */
export const SORT_BY_FIELD_MAP: Readonly<Record<LeaderboardSortBy, string>> = Object.freeze({
  sharpe: 'sharpe_ratio',
  annual: 'annual_return_pct',
  total: 'total_return_pct',
});

/**
 * 前端列展示顺序 —— 沪深 300 → 中证 500 → 中证 1000。
 * 与 BenchmarkAttributionService.DEFAULT_BENCHMARK_SYMBOLS 保持同序，方便交叉对比。
 */
export const BENCHMARK_DISPLAY_ORDER: ReadonlyArray<string> = Object.freeze([
  'sh.000300', // 沪深 300
  'sh.000905', // 中证 500
  'sh.000852', // 中证 1000
]);

/**
 * 基准 symbol → 中文短名，与 BenchmarkAttributionService.BENCHMARK_NAME_MAP 同源。
 * 前端 column title 直接用，避免 frontend 内写死中文容易漂移。
 */
export const BENCHMARK_NAME_MAP: Readonly<Record<string, string>> = Object.freeze({
  'sh.000300': '沪深300',
  'sh.000905': '中证500',
  'sh.000852': '中证1000',
  'sh.000001': '上证指数',
  'sh.000688': '科创50',
  'sz.399001': '深证成指',
  'sz.399006': '创业板指',
});

/** 1 条 backtest 行（QuantBacktestResult.findAll raw 出来的形状） */
export interface BacktestRow {
  id?: number; // run_id 用 (JOIN benchmark_attribution_results.run_id)
  strategy_key: string;
  strategy_name?: string | null;
  task_id: number;
  total_return_pct: number | string | null;
  annual_return_pct: number | string | null;
  max_drawdown_pct: number | string | null;
  sharpe_ratio: number | string | null;
  win_rate: number | string | null;
  profit_factor?: number | string | null;
  trade_count: number;
  benchmark_return_pct?: number | string | null;
  excess_return_pct?: number | string | null;
  created_at: string | Date;
  [k: string]: unknown;
}

/** 1 条 benchmark attribution 行（BenchmarkAttributionResult raw 形状） */
export interface BenchmarkAttributionRow {
  run_id: number;
  benchmark_symbol: string;
  benchmark_name?: string | null;
  alpha_annual_pct?: number | string | null;
  beta?: number | string | null;
  information_ratio?: number | string | null;
  excess_return_pct?: number | string | null;
  excess_drawdown_pct?: number | string | null;
  sample_count: number;
  r_squared?: number | string | null;
  strategy_return_pct?: number | string | null;
  benchmark_return_pct?: number | string | null;
  period_start?: string | null;
  period_end?: string | null;
  [k: string]: unknown;
}

/**
 * 1 条 attribution 在 leaderboard 上的展示形态（数字化 + 截掉 raw）。
 * 前端按 BENCHMARK_DISPLAY_ORDER 取出对应 symbol 渲染 1 列。
 */
export interface LeaderboardBenchmarkAttribution {
  benchmark_symbol: string;
  benchmark_name?: string;
  excess_return_pct: number | null;
  alpha_annual_pct: number | null;
  information_ratio: number | null;
  beta: number | null;
  sample_count: number;
  period_start: string | null;
  period_end: string | null;
}

/** 1 条最终输出 item（leaderboard 行） */
export interface LeaderboardItem extends BacktestRow {
  /** 按 BENCHMARK_DISPLAY_ORDER 排好序的 attribution 列；空数组表示该 run 无归因 */
  benchmark_attributions: LeaderboardBenchmarkAttribution[];
}

/** 主入口入参 */
export interface BuildLeaderboardItemsInput {
  rows: BacktestRow[];
  attributions: BenchmarkAttributionRow[];
  sort_by: LeaderboardSortBy;
}

/**
 * 把可能是 string/null/undefined/NaN 的数字字段稳健解析成 number|null。
 * 与 frontend num() helper 同语义 — 用于 sort / compare 前的 sanitize。
 */
export function toFiniteNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 按 strategy_key 去重保留最新 backtest。
 *
 * **前置**: rows 已按 created_at DESC 排好（QuantController 的 SQL order by 已保证）。
 * 若顺序变了, 这里会保留"看到的第一条" — 不依赖 created_at 字段做二次排序，
 * 因为 DB 时间戳可能因 race 落同一毫秒，DB 端 order by 才是真相。
 *
 * 返回数组保留 rows 顺序（即 created_at DESC）—— 后续 sort 一次性按主排序字段重排。
 */
export function dedupLatestByStrategyKey<T extends BacktestRow>(rows: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (!r?.strategy_key) continue;
    if (seen.has(r.strategy_key)) continue;
    seen.add(r.strategy_key);
    out.push(r);
  }
  return out;
}

/**
 * 过滤掉主排序字段非 finite 的行 — 让 NaN/null 不参与排名（与原 controller 行为一致）。
 *
 * **注意**: 即使主排序字段为 finite, 其它指标 (max_drawdown / win_rate) 仍可能为 null,
 * 这是允许的 — UI 端 render 时各列单独兜底 '—'。这里只守主排序字段, 不级联校验。
 */
export function filterByFinitePrimarySort<T extends BacktestRow>(
  rows: ReadonlyArray<T>,
  sort_by: LeaderboardSortBy
): T[] {
  const field = SORT_BY_FIELD_MAP[sort_by];
  return rows.filter(r => toFiniteNumber((r as any)[field]) !== null);
}

/**
 * 按主排序字段 DESC 排序（稳定 — JS Array.sort 在 V8 是 TimSort，等值时保留入参顺序）。
 *
 * tie-break: 等值时保留 rows 入参顺序（即 dedup 后的 created_at DESC），让 UI 翻页/刷新稳定。
 */
export function sortLeaderboardItems<T extends BacktestRow>(
  rows: ReadonlyArray<T>,
  sort_by: LeaderboardSortBy
): T[] {
  const field = SORT_BY_FIELD_MAP[sort_by];
  const copy = rows.slice();
  copy.sort((a, b) => {
    const va = toFiniteNumber((a as any)[field]) ?? 0;
    const vb = toFiniteNumber((b as any)[field]) ?? 0;
    return vb - va;
  });
  return copy;
}

/**
 * 把 BenchmarkAttributionResult 行按 run_id 分组 → 按 BENCHMARK_DISPLAY_ORDER 排好序 →
 * 挂到对应 row 的 `benchmark_attributions` 字段。
 *
 * Row 与 attribution 的 JOIN key 是 `row.id === attribution.run_id`（BenchmarkAttributionResult.run_id
 * 引用 QuantBacktestResult.id；与 BenchmarkAttributionResult.ts L80-86 注释一致）。
 *
 * 边界：
 *   - row.id 缺失 → benchmark_attributions = [] (历史数据 / raw select 漏 id 时不抛错)。
 *   - 同 (run_id, benchmark_symbol) 多个 period_start/period_end → 取首条
 *     (rows 已按 period_end DESC 排好 + caller 应该已经 dedup; 这里只保最新)。
 *   - 同 run_id 有多个 benchmark → 按 BENCHMARK_DISPLAY_ORDER 排好。
 *   - 未知 benchmark_symbol (不在 DISPLAY_ORDER) → 放到列尾按 symbol 字母序兜底 (避免丢数据)。
 */
export function enrichWithBenchmarkAttributions<T extends BacktestRow>(
  rows: ReadonlyArray<T>,
  attributions: ReadonlyArray<BenchmarkAttributionRow>
): (T & { benchmark_attributions: LeaderboardBenchmarkAttribution[] })[] {
  // 按 (run_id, benchmark_symbol) 折叠取首条
  const grouped = new Map<number, Map<string, LeaderboardBenchmarkAttribution>>();
  for (const a of attributions) {
    if (!a?.run_id || !a?.benchmark_symbol) continue;
    let perRun = grouped.get(a.run_id);
    if (!perRun) {
      perRun = new Map();
      grouped.set(a.run_id, perRun);
    }
    if (perRun.has(a.benchmark_symbol)) continue; // 首条 wins
    perRun.set(a.benchmark_symbol, {
      benchmark_symbol: a.benchmark_symbol,
      benchmark_name: a.benchmark_name ?? BENCHMARK_NAME_MAP[a.benchmark_symbol] ?? undefined,
      excess_return_pct: toFiniteNumber(a.excess_return_pct),
      alpha_annual_pct: toFiniteNumber(a.alpha_annual_pct),
      information_ratio: toFiniteNumber(a.information_ratio),
      beta: toFiniteNumber(a.beta),
      sample_count: Number(a.sample_count) || 0,
      period_start: a.period_start ?? null,
      period_end: a.period_end ?? null,
    });
  }

  return rows.map(r => {
    const perRun = r?.id != null ? grouped.get(r.id as number) : undefined;
    const ordered: LeaderboardBenchmarkAttribution[] = [];
    if (perRun) {
      // 1) 主基准按 DISPLAY_ORDER
      for (const sym of BENCHMARK_DISPLAY_ORDER) {
        const hit = perRun.get(sym);
        if (hit) ordered.push(hit);
      }
      // 2) 未在 DISPLAY_ORDER 的兜底按 symbol 字母序
      const extras: LeaderboardBenchmarkAttribution[] = [];
      perRun.forEach((v, sym) => {
        if (!BENCHMARK_DISPLAY_ORDER.includes(sym)) extras.push(v);
      });
      extras.sort((a, b) => a.benchmark_symbol.localeCompare(b.benchmark_symbol));
      ordered.push(...extras);
    }
    return { ...(r as any), benchmark_attributions: ordered };
  });
}

/**
 * 主入口 — 串起 4 步：去重 → 过滤 → 排序 → enrich。
 *
 * controller 只负责 DB 查询和 response 包装，不再写业务逻辑。
 */
export function buildStrategyLeaderboardItems(
  input: BuildLeaderboardItemsInput
): LeaderboardItem[] {
  const { rows, attributions, sort_by } = input;
  const deduped = dedupLatestByStrategyKey(rows);
  const filtered = filterByFinitePrimarySort(deduped, sort_by);
  const sorted = sortLeaderboardItems(filtered, sort_by);
  return enrichWithBenchmarkAttributions(sorted, attributions);
}
