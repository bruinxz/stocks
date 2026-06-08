/**
 * BenchmarkSelector — 按策略风格自动匹配回测基准指数（US-084）
 *
 * 之前 QuantBacktestService.resolveBenchmarkReturn 固定走 sh.000300（沪深 300），
 * 让中证 1000 / 中证 500 风格的策略与不匹配的基准比较 → "超额" 是错觉。
 * 本模块在用户**未**显式传 `benchmark_symbol` 时，按 strategy_key → 风格
 * → 默认基准的映射输出基准代码，让对比公平。
 *
 * 设计要点：
 *   1. 纯函数为主，所有判定都 export 让单测能脱 DB 覆盖每个分支。
 *   2. DataSource 接口注入 —— 生产从 strategyRegistry 拉 definition；
 *      测试注入 fake 直接给定 {key: style/tags} map。
 *   3. 优先级：用户 override > style 字段 > tags 推断 > DEFAULT_BENCHMARK_SYMBOL。
 *   4. 多策略选基准用**多数 vote** —— 同一回测跑 3 个策略，2 个 small_cap、
 *      1 个 large_cap，应该按 small_cap 出基准；tie 时按 STYLE_BENCHMARK_MAP
 *      列出顺序 first-win（稳定 + 可预测）。
 *
 * 与既有 benchmarkIndexService.resolveBenchmarkForStock 区别：
 *   - 后者按**单只股票代码**（前缀 sh.688 / sz.300 / 总市值）推基准 —— 行业
 *     归因 / per-trade 基准用；
 *   - 本模块按**策略元数据**（style/tags）推基准 —— 整次回测用。
 *
 * 适用场景：QuantBacktestService.resolveBenchmarkReturn 调用前先调本模块。
 */

import { QuantStrategyDefinition, StrategyStyle } from '../types/QuantTypes';

/** 默认基准 —— 推断失败的兜底。沪深 300 作为 A 股最通用大盘基准。 */
export const DEFAULT_BENCHMARK_SYMBOL = 'sh.000300';

/**
 * 风格 → 基准指数映射。
 *
 * - 沪深 300 (sh.000300)：大盘价值/成长、多因子 alpha、低波防守、动量、ensemble、行业轮动
 * - 中证 500 (sh.000905)：中盘均衡、均值反转（mid-cap 反转往往更有效）
 * - 中证 1000 (sh.000852)：小盘成长、短线事件驱动/游资接力（小盘弹性大）
 * - 上证指数 (sh.000001)：高股息防守长线（蓝筹偏价值的市场感知基准）
 *
 * 注：tie-break 时按本对象插入顺序（v8 Map 保留 insert order）first-win，
 *     所以 large_cap_value 在前 = 整数据 tie 时更倾向沪深 300。
 */
export const STYLE_BENCHMARK_MAP: Readonly<Record<StrategyStyle, string>> = Object.freeze({
  large_cap_value: 'sh.000300',
  large_cap_growth: 'sh.000300',
  multi_factor_alpha: 'sh.000300',
  momentum: 'sh.000300',
  low_volatility: 'sh.000300',
  sector_rotation: 'sh.000300',
  ensemble: 'sh.000300',
  mid_cap_balanced: 'sh.000905',
  mean_reversion: 'sh.000905',
  small_cap_growth: 'sh.000852',
  short_term_event_driven: 'sh.000852',
  high_yield_defensive: 'sh.000001',
});

/**
 * 由 tags 推断 style（老策略 definition 没填 style 字段时兜底）。
 *
 * 规则按"信号强度"顺序逐条匹配，命中即返回；都不命中返回 null。
 * 这是 lossy heuristic — 永远建议给策略 definition 明确填 `style`。
 */
export function inferStyleFromTags(tags: string[]): StrategyStyle | null {
  if (!tags?.length) return null;
  const set = new Set(tags.map(t => String(t).trim()));

  // 强信号：明确风格关键词
  if (set.has('集成') || set.has('元策略') || set.has('ensemble')) return 'ensemble';
  if (set.has('中证1000') || set.has('小盘')) return 'small_cap_growth';
  if (set.has('短线') || set.has('游资') || set.has('涨停板') || set.has('题材扩散')) {
    return 'short_term_event_driven';
  }
  if (set.has('股息') || set.has('高股息') || set.has('低 PE')) {
    // 高股息 + 长线特征 → 防守
    if (set.has('长线') || set.has('季度调仓')) return 'high_yield_defensive';
    return 'large_cap_value';
  }
  if (set.has('行业轮动')) return 'sector_rotation';
  if (set.has('多因子') || set.has('alpha')) return 'multi_factor_alpha';
  if (set.has('反转') || set.has('均值回归') || set.has('低吸')) return 'mean_reversion';
  if (set.has('低波') || set.has('防守')) return 'low_volatility';
  if (set.has('趋势') || set.has('动量') || set.has('突破') || set.has('启动')) return 'momentum';

  // 弱信号（兜底）
  if (set.has('价值')) return 'large_cap_value';
  if (set.has('成长')) return 'large_cap_growth';
  if (set.has('GARP') || set.has('PEG')) return 'large_cap_growth';

  return null;
}

/**
 * 单策略 → 基准。
 * 优先级：definition.style → inferStyleFromTags(tags) → DEFAULT_BENCHMARK_SYMBOL。
 */
export function pickBenchmarkForDefinition(
  def: QuantStrategyDefinition | null | undefined
): string {
  if (!def) return DEFAULT_BENCHMARK_SYMBOL;
  if (def.style && STYLE_BENCHMARK_MAP[def.style]) return STYLE_BENCHMARK_MAP[def.style];
  const inferred = inferStyleFromTags(def.tags || []);
  if (inferred) return STYLE_BENCHMARK_MAP[inferred];
  return DEFAULT_BENCHMARK_SYMBOL;
}

/**
 * 多策略 → 单一基准（多数 vote）。
 *
 * 算法：
 *   1. 每个策略调 pickBenchmarkForDefinition 得到候选基准。
 *   2. 按 (count DESC, STYLE_BENCHMARK_MAP 顺序) 排序选第一个。
 *      tie-break 用 map 插入顺序而非 stock_code 字母序 —— 让"沪深 300 + 中证 1000"
 *      tie 时偏向通用沪深 300（更具说服力的市场对比）。
 *   3. 空数组返回 DEFAULT_BENCHMARK_SYMBOL（不抛错，让上层平稳兜底）。
 *
 * tags-based inference 没覆盖到的策略也不抛错（pickBenchmarkForDefinition 会
 * 返回 DEFAULT_BENCHMARK_SYMBOL）。
 */
export function pickBenchmarkForDefinitions(
  defs: ReadonlyArray<QuantStrategyDefinition | null | undefined>
): string {
  if (!defs?.length) return DEFAULT_BENCHMARK_SYMBOL;

  const counts = new Map<string, number>();
  for (const def of defs) {
    const benchmark = pickBenchmarkForDefinition(def);
    counts.set(benchmark, (counts.get(benchmark) ?? 0) + 1);
  }

  // tie-break 顺序：先看 STYLE_BENCHMARK_MAP 出现的基准（按 map 插入顺序），
  // 再 fallback 到原始遇见顺序。
  const benchmarkOrder = Array.from(new Set(Object.values(STYLE_BENCHMARK_MAP)));
  let bestBenchmark = DEFAULT_BENCHMARK_SYMBOL;
  let bestCount = -1;
  for (const benchmark of benchmarkOrder) {
    const count = counts.get(benchmark) ?? 0;
    if (count > bestCount) {
      bestCount = count;
      bestBenchmark = benchmark;
    }
  }
  return bestBenchmark;
}

// ============================================================
// DataSource injection (生产 + 测试 fake)
// ============================================================

/**
 * 抽象 strategy definition lookup —— 让测试不依赖 strategyRegistry singleton。
 */
export interface BenchmarkSelectorDataSource {
  getDefinitionByKey(strategy_key: string): QuantStrategyDefinition | null;
}

/**
 * 生产实现 —— lazy require strategyRegistry 避免顶层 import 让测试启动
 * 整个 quant/engine/ 子系统。
 */
class DefaultBenchmarkSelectorDataSource implements BenchmarkSelectorDataSource {
  getDefinitionByKey(strategy_key: string): QuantStrategyDefinition | null {
    if (!strategy_key) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../engine/StrategyRegistry');
    const registry = mod.strategyRegistry as {
      get: (key: string) => { definition: QuantStrategyDefinition } | undefined;
    };
    const strategy = registry.get(strategy_key);
    return strategy?.definition ?? null;
  }
}

export const PRODUCTION_BENCHMARK_SELECTOR_DATA_SOURCE: BenchmarkSelectorDataSource =
  new DefaultBenchmarkSelectorDataSource();

/**
 * 主入口 —— 按 strategy_keys 选基准。
 *
 * 调用方传入策略 key 列表，本函数：
 *   1. 通过 dataSource lookup 每个 key 对应的 definition；
 *   2. 调 pickBenchmarkForDefinitions 多数 vote 得到基准；
 *   3. 找不到任一 definition（全部 null）返回 DEFAULT_BENCHMARK_SYMBOL。
 *
 * 用法（QuantBacktestService.resolveBenchmarkReturn）：
 *   const benchmark = options.benchmark_symbol
 *     ?? selectBenchmarkForStrategyKeys(options.strategy_keys);
 */
export function selectBenchmarkForStrategyKeys(
  strategy_keys: string[] | undefined | null,
  dataSource: BenchmarkSelectorDataSource = PRODUCTION_BENCHMARK_SELECTOR_DATA_SOURCE
): string {
  if (!strategy_keys?.length) return DEFAULT_BENCHMARK_SYMBOL;
  const defs = strategy_keys.map(key => dataSource.getDefinitionByKey(key));
  return pickBenchmarkForDefinitions(defs);
}
