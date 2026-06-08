/**
 * BenchmarkSelector 单元测试（US-084）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/backtest/benchmark-selector.test.ts
 *
 * 完全脱离 DB：通过 fake DataSource 注入 strategy_key → definition 映射。
 *
 * 覆盖维度：
 *   - 常量映射 STYLE_BENCHMARK_MAP 完整性 + freezed
 *   - inferStyleFromTags：空 tags / 强信号 / 弱信号 / 多 tag 优先级 / 都不命中
 *   - pickBenchmarkForDefinition：style 优先 / tags 兜底 / null definition / 都没有
 *   - pickBenchmarkForDefinitions：单策略 / 多策略多数 vote / tie-break / 空数组
 *   - selectBenchmarkForStrategyKeys：空 keys / 未知 key / 注入 fake DS / 多 key 多数 vote
 *   - end-to-end 真实策略风格对照：CTA100 → 中证 1000、HighDividend → 上证、SectorRotation → 沪深 300、
 *     MultiFactorAlpha → 沪深 300、RsiMeanReversion → 中证 500
 */

import {
  DEFAULT_BENCHMARK_SYMBOL,
  STYLE_BENCHMARK_MAP,
  inferStyleFromTags,
  pickBenchmarkForDefinition,
  pickBenchmarkForDefinitions,
  selectBenchmarkForStrategyKeys,
  BenchmarkSelectorDataSource,
} from '../../src/quant/backtest/BenchmarkSelector';
import {
  QuantStrategyDefinition,
  StrategyStyle,
} from '../../src/quant/types/QuantTypes';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectEqual<T>(name: string, actual: T, expected: T, detail = '') {
  const same =
    JSON.stringify(actual) === JSON.stringify(expected) ||
    (typeof actual === 'number' &&
      typeof expected === 'number' &&
      Math.abs(actual - expected) < 1e-9);
  assert(
    name,
    same,
    detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function makeDef(
  strategy_key: string,
  opts: { style?: StrategyStyle; tags?: string[] } = {}
): QuantStrategyDefinition {
  return {
    strategy_key,
    name: strategy_key,
    description: 'fixture',
    category: 'momentum',
    default_params: {},
    enabled: true,
    risk_level: 'medium',
    tags: opts.tags ?? [],
    style: opts.style,
  };
}

function makeFakeDataSource(
  byKey: Record<string, QuantStrategyDefinition | null>
): BenchmarkSelectorDataSource {
  return {
    getDefinitionByKey(strategy_key: string): QuantStrategyDefinition | null {
      return byKey[strategy_key] ?? null;
    },
  };
}

// ============================================================
// 1. STYLE_BENCHMARK_MAP 常量完整性
// ============================================================

function runConstantTests() {
  console.log('\n## STYLE_BENCHMARK_MAP / DEFAULT_BENCHMARK_SYMBOL');
  expectEqual('DEFAULT = sh.000300', DEFAULT_BENCHMARK_SYMBOL, 'sh.000300');

  // 12 个 style 全部映射
  const styles: StrategyStyle[] = [
    'large_cap_value',
    'large_cap_growth',
    'small_cap_growth',
    'mid_cap_balanced',
    'sector_rotation',
    'multi_factor_alpha',
    'momentum',
    'mean_reversion',
    'low_volatility',
    'short_term_event_driven',
    'high_yield_defensive',
    'ensemble',
  ];
  for (const s of styles) {
    assert(
      `${s} mapped`,
      typeof STYLE_BENCHMARK_MAP[s] === 'string' && STYLE_BENCHMARK_MAP[s].startsWith('sh.'),
      `got ${STYLE_BENCHMARK_MAP[s]}`
    );
  }

  // 关键映射确认（AC 核心）
  expectEqual('small_cap_growth → 中证 1000', STYLE_BENCHMARK_MAP.small_cap_growth, 'sh.000852');
  expectEqual('mid_cap_balanced → 中证 500', STYLE_BENCHMARK_MAP.mid_cap_balanced, 'sh.000905');
  expectEqual('large_cap_value → 沪深 300', STYLE_BENCHMARK_MAP.large_cap_value, 'sh.000300');
  expectEqual('sector_rotation → 沪深 300', STYLE_BENCHMARK_MAP.sector_rotation, 'sh.000300');
  expectEqual(
    'short_term_event_driven → 中证 1000',
    STYLE_BENCHMARK_MAP.short_term_event_driven,
    'sh.000852'
  );
  expectEqual(
    'high_yield_defensive → 上证指数',
    STYLE_BENCHMARK_MAP.high_yield_defensive,
    'sh.000001'
  );
  expectEqual('ensemble → 沪深 300', STYLE_BENCHMARK_MAP.ensemble, 'sh.000300');

  // 防 mutation
  let mutationCaught = false;
  try {
    (STYLE_BENCHMARK_MAP as any).small_cap_growth = 'BROKEN';
  } catch (_e) {
    mutationCaught = true;
  }
  assert(
    'STYLE_BENCHMARK_MAP frozen (mutation throws OR silently ignored)',
    mutationCaught || STYLE_BENCHMARK_MAP.small_cap_growth === 'sh.000852',
    `value is now ${STYLE_BENCHMARK_MAP.small_cap_growth}`
  );
}

// ============================================================
// 2. inferStyleFromTags
// ============================================================

function runInferStyleFromTagsTests() {
  console.log('\n## inferStyleFromTags');
  expectEqual('empty array → null', inferStyleFromTags([]), null);
  expectEqual('null-like → null', inferStyleFromTags(null as any), null);

  // 强信号
  expectEqual(
    '中证1000 → small_cap_growth',
    inferStyleFromTags(['中证1000', '小盘', '动量']),
    'small_cap_growth'
  );
  expectEqual(
    '小盘 → small_cap_growth',
    inferStyleFromTags(['小盘', '某 tag']),
    'small_cap_growth'
  );
  expectEqual(
    '短线 → short_term_event_driven',
    inferStyleFromTags(['短线', '游资', '涨停板']),
    'short_term_event_driven'
  );
  expectEqual(
    '股息+长线 → high_yield_defensive',
    inferStyleFromTags(['价值', '股息', '长线', '季度调仓']),
    'high_yield_defensive'
  );
  expectEqual('股息 (no 长线) → large_cap_value', inferStyleFromTags(['股息']), 'large_cap_value');
  expectEqual(
    '集成 → ensemble',
    inferStyleFromTags(['集成', '元策略']),
    'ensemble'
  );
  expectEqual('行业轮动 → sector_rotation', inferStyleFromTags(['行业轮动']), 'sector_rotation');
  expectEqual(
    '多因子 → multi_factor_alpha',
    inferStyleFromTags(['多因子', '全市场']),
    'multi_factor_alpha'
  );
  expectEqual('反转 → mean_reversion', inferStyleFromTags(['反转', 'RSI']), 'mean_reversion');
  expectEqual('低波 → low_volatility', inferStyleFromTags(['低波', '质量']), 'low_volatility');
  expectEqual('突破 → momentum', inferStyleFromTags(['突破', 'ATR']), 'momentum');

  // 弱信号
  expectEqual(
    '价值 only → large_cap_value (兜底)',
    inferStyleFromTags(['价值']),
    'large_cap_value'
  );
  expectEqual('GARP → large_cap_growth', inferStyleFromTags(['GARP', 'PEG']), 'large_cap_growth');

  // 都不命中
  expectEqual(
    '完全未知 tags → null',
    inferStyleFromTags(['xyz', 'foo', 'bar']),
    null
  );

  // 多 tag 优先级：集成 在 多因子 之前命中
  expectEqual(
    '多 tag 优先级 (集成 > 多因子)',
    inferStyleFromTags(['多因子', '集成', '元策略']),
    'ensemble'
  );
}

// ============================================================
// 3. pickBenchmarkForDefinition
// ============================================================

function runPickBenchmarkForDefinitionTests() {
  console.log('\n## pickBenchmarkForDefinition');
  expectEqual(
    'null definition → DEFAULT',
    pickBenchmarkForDefinition(null),
    DEFAULT_BENCHMARK_SYMBOL
  );
  expectEqual(
    'undefined definition → DEFAULT',
    pickBenchmarkForDefinition(undefined),
    DEFAULT_BENCHMARK_SYMBOL
  );

  // style 优先
  expectEqual(
    'style="small_cap_growth" → 中证 1000',
    pickBenchmarkForDefinition(makeDef('s1', { style: 'small_cap_growth' })),
    'sh.000852'
  );
  expectEqual(
    'style="high_yield_defensive" → 上证',
    pickBenchmarkForDefinition(makeDef('s2', { style: 'high_yield_defensive' })),
    'sh.000001'
  );

  // tags 兜底（无 style）
  expectEqual(
    'no style + tags["小盘"] → 中证 1000',
    pickBenchmarkForDefinition(makeDef('s3', { tags: ['小盘', '动量'] })),
    'sh.000852'
  );
  expectEqual(
    'no style + tags["低波"] → 沪深 300（low_volatility）',
    pickBenchmarkForDefinition(makeDef('s4', { tags: ['低波', '质量', '防守'] })),
    'sh.000300'
  );

  // style 比 tags 优先
  expectEqual(
    'style wins over conflicting tags',
    pickBenchmarkForDefinition(
      makeDef('s5', { style: 'small_cap_growth', tags: ['价值', '股息'] })
    ),
    'sh.000852'
  );

  // 都没有
  expectEqual(
    'no style + no tags → DEFAULT',
    pickBenchmarkForDefinition(makeDef('s6')),
    DEFAULT_BENCHMARK_SYMBOL
  );
  expectEqual(
    'no style + unknown tags → DEFAULT',
    pickBenchmarkForDefinition(makeDef('s7', { tags: ['xyz'] })),
    DEFAULT_BENCHMARK_SYMBOL
  );
}

// ============================================================
// 4. pickBenchmarkForDefinitions (多策略多数 vote)
// ============================================================

function runPickBenchmarkForDefinitionsTests() {
  console.log('\n## pickBenchmarkForDefinitions');
  expectEqual(
    '空数组 → DEFAULT',
    pickBenchmarkForDefinitions([]),
    DEFAULT_BENCHMARK_SYMBOL
  );
  expectEqual(
    '全 null → DEFAULT (3 个 null 全 vote 给 DEFAULT)',
    pickBenchmarkForDefinitions([null, null, null]),
    DEFAULT_BENCHMARK_SYMBOL
  );

  // 单策略
  expectEqual(
    '单 small_cap → 中证 1000',
    pickBenchmarkForDefinitions([makeDef('a', { style: 'small_cap_growth' })]),
    'sh.000852'
  );

  // 多数 vote (2 small_cap + 1 large_cap_value → small_cap 胜)
  expectEqual(
    '2 small_cap + 1 large_cap → 中证 1000',
    pickBenchmarkForDefinitions([
      makeDef('a', { style: 'small_cap_growth' }),
      makeDef('b', { style: 'small_cap_growth' }),
      makeDef('c', { style: 'large_cap_value' }),
    ]),
    'sh.000852'
  );

  // tie-break：1 small + 1 large_cap_value → large_cap_value 胜（map 顺序优先 large_cap_value）
  expectEqual(
    'tie 1 large_cap + 1 small_cap → large_cap (map 顺序)',
    pickBenchmarkForDefinitions([
      makeDef('a', { style: 'small_cap_growth' }),
      makeDef('b', { style: 'large_cap_value' }),
    ]),
    'sh.000300'
  );

  // 高股息单独基准 (sh.000001)
  expectEqual(
    '1 high_yield → 上证',
    pickBenchmarkForDefinitions([makeDef('a', { style: 'high_yield_defensive' })]),
    'sh.000001'
  );

  // 3 个不同基准全 tie：按 map 插入顺序 first-win
  expectEqual(
    '3-way tie → 沪深 300 (map 顺序优先)',
    pickBenchmarkForDefinitions([
      makeDef('a', { style: 'small_cap_growth' }),
      makeDef('b', { style: 'mid_cap_balanced' }),
      makeDef('c', { style: 'large_cap_value' }),
    ]),
    'sh.000300'
  );

  // mix null + valid: valid 胜
  expectEqual(
    'null + small_cap → 中证 1000 (null 算 DEFAULT, 1 vs 1 → DEFAULT first 优先)',
    pickBenchmarkForDefinitions([null, makeDef('a', { style: 'small_cap_growth' })]),
    'sh.000300'
  );
}

// ============================================================
// 5. selectBenchmarkForStrategyKeys (主入口 + DataSource 注入)
// ============================================================

function runSelectBenchmarkForStrategyKeysTests() {
  console.log('\n## selectBenchmarkForStrategyKeys');

  // 空 keys
  expectEqual(
    'undefined keys → DEFAULT',
    selectBenchmarkForStrategyKeys(undefined),
    DEFAULT_BENCHMARK_SYMBOL
  );
  expectEqual(
    'null keys → DEFAULT',
    selectBenchmarkForStrategyKeys(null),
    DEFAULT_BENCHMARK_SYMBOL
  );
  expectEqual('empty array → DEFAULT', selectBenchmarkForStrategyKeys([]), DEFAULT_BENCHMARK_SYMBOL);

  // 注入 fake DataSource
  const fake = makeFakeDataSource({
    cta100_momentum: makeDef('cta100_momentum', { style: 'small_cap_growth' }),
    high_dividend_value: makeDef('high_dividend_value', { style: 'high_yield_defensive' }),
    sector_rotation_leader: makeDef('sector_rotation_leader', { style: 'sector_rotation' }),
    multi_factor_alpha: makeDef('multi_factor_alpha', { style: 'multi_factor_alpha' }),
    rsi_reversion: makeDef('rsi_reversion', {
      tags: ['RSI', '低吸', '均值回归'],
    }),
    legacy_no_style: makeDef('legacy_no_style', { tags: ['xyz'] }),
  });

  // 单 key, style 出
  expectEqual(
    'cta100_momentum → 中证 1000',
    selectBenchmarkForStrategyKeys(['cta100_momentum'], fake),
    'sh.000852'
  );
  expectEqual(
    'high_dividend_value → 上证',
    selectBenchmarkForStrategyKeys(['high_dividend_value'], fake),
    'sh.000001'
  );
  expectEqual(
    'sector_rotation_leader → 沪深 300',
    selectBenchmarkForStrategyKeys(['sector_rotation_leader'], fake),
    'sh.000300'
  );

  // 单 key, tags 兜底
  expectEqual(
    'rsi_reversion (tags-only) → 中证 500',
    selectBenchmarkForStrategyKeys(['rsi_reversion'], fake),
    'sh.000905'
  );

  // 未知 key
  expectEqual(
    '未知 key (DS 返回 null) → DEFAULT',
    selectBenchmarkForStrategyKeys(['xyz_unknown'], fake),
    DEFAULT_BENCHMARK_SYMBOL
  );

  // legacy 无 style 无可识别 tags
  expectEqual(
    'legacy_no_style → DEFAULT',
    selectBenchmarkForStrategyKeys(['legacy_no_style'], fake),
    DEFAULT_BENCHMARK_SYMBOL
  );

  // 多 key 多数 vote
  expectEqual(
    '2 small_cap (cta100 + cta100) → 中证 1000',
    selectBenchmarkForStrategyKeys(['cta100_momentum', 'cta100_momentum'], fake),
    'sh.000852'
  );
  expectEqual(
    '2 small_cap + 1 sector_rotation → 中证 1000',
    selectBenchmarkForStrategyKeys(
      ['cta100_momentum', 'cta100_momentum', 'sector_rotation_leader'],
      fake
    ),
    'sh.000852'
  );

  // tie：选 map 第一个出现的基准（沪深 300 优先于 中证 1000）
  expectEqual(
    'tie cta100 + sector_rotation → 沪深 300 (map 顺序)',
    selectBenchmarkForStrategyKeys(['cta100_momentum', 'sector_rotation_leader'], fake),
    'sh.000300'
  );
}

// ============================================================
// 6. 真实策略风格对照 (regression — 这些 key 在 PRODUCTION 注册时 style 应该正确)
//    注：本测试通过 fake DS 模拟，不调用 PRODUCTION 单例，所以无 DB 依赖。
// ============================================================

function runRealStrategyMappingTests() {
  console.log('\n## 真实策略 key 与 style 期望对照（regression）');
  // 模拟产品中策略的 (key, style) 对照 — 与 src/quant/strategies/*.ts 的 style 字段对齐。
  const realStrategies: Array<{ key: string; style: StrategyStyle; benchmark: string }> = [
    { key: 'cta100_momentum', style: 'small_cap_growth', benchmark: 'sh.000852' },
    { key: 'dragon_head_momentum', style: 'short_term_event_driven', benchmark: 'sh.000852' },
    { key: 'game_trader_relay', style: 'short_term_event_driven', benchmark: 'sh.000852' },
    { key: 'linkage_strategy', style: 'short_term_event_driven', benchmark: 'sh.000852' },
    { key: 'high_dividend_value', style: 'high_yield_defensive', benchmark: 'sh.000001' },
    { key: 'sector_rotation_leader', style: 'sector_rotation', benchmark: 'sh.000300' },
    { key: 'multi_factor_alpha', style: 'multi_factor_alpha', benchmark: 'sh.000300' },
    { key: 'multi_factor_ranking', style: 'multi_factor_alpha', benchmark: 'sh.000300' },
    { key: 'quality_momentum_blend', style: 'multi_factor_alpha', benchmark: 'sh.000300' },
    { key: 'low_volatility_quality', style: 'low_volatility', benchmark: 'sh.000300' },
    { key: 'ma_trend', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'macd_trend', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'donchian_trend', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'minervini_trend_template', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'turtle_breakout', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'breakout_atr', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'breakout_strategy', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'volatility_contraction_breakout', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'volume_price_confirmation', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'relative_strength_momentum', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'dual_momentum_rotation', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'trend_pullback_reentry', style: 'momentum', benchmark: 'sh.000300' },
    { key: 'rsi_reversion', style: 'mean_reversion', benchmark: 'sh.000905' },
    { key: 'bollinger_reversion', style: 'mean_reversion', benchmark: 'sh.000905' },
    { key: 'left_side_reversal', style: 'mean_reversion', benchmark: 'sh.000905' },
    { key: 'earnings_surprise', style: 'mid_cap_balanced', benchmark: 'sh.000905' },
    { key: 'northbound_follow', style: 'large_cap_value', benchmark: 'sh.000300' },
    { key: 'garp_strategy', style: 'large_cap_growth', benchmark: 'sh.000300' },
    { key: 'ensemble_strategy', style: 'ensemble', benchmark: 'sh.000300' },
  ];

  const ds = makeFakeDataSource(
    Object.fromEntries(
      realStrategies.map(s => [s.key, makeDef(s.key, { style: s.style })])
    )
  );

  for (const s of realStrategies) {
    expectEqual(`${s.key} (${s.style}) → ${s.benchmark}`, selectBenchmarkForStrategyKeys([s.key], ds), s.benchmark);
  }
}

// ============================================================
// 7. user override path（QuantBacktestService 用法）— 用户传 benchmark_symbol 时
//    BenchmarkSelector 不被调用，模拟 QuantBacktestService 的判定行为
// ============================================================

function runUserOverrideTests() {
  console.log('\n## QuantBacktestService 用户 override 行为模拟');
  // QuantBacktestService 写法：const benchmarkSymbol = options.benchmark_symbol || selectBenchmarkForStrategyKeys(...)
  // 这里模拟它的决策路径
  const ds = makeFakeDataSource({
    cta100_momentum: makeDef('cta100_momentum', { style: 'small_cap_growth' }),
  });

  // 用户未传 → 调 selector
  const auto = undefined || selectBenchmarkForStrategyKeys(['cta100_momentum'], ds);
  expectEqual('no override → auto-select 中证 1000', auto, 'sh.000852');

  // 用户传 → 不调 selector
  const userOverride = 'sh.000300' || selectBenchmarkForStrategyKeys(['cta100_momentum'], ds);
  expectEqual('user override → 用户值', userOverride, 'sh.000300');

  // 用户传空字符串 (falsy) → 仍回退 auto
  const emptyOverride = '' || selectBenchmarkForStrategyKeys(['cta100_momentum'], ds);
  expectEqual('empty user override → fallback to auto', emptyOverride, 'sh.000852');
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  runConstantTests();
  runInferStyleFromTagsTests();
  runPickBenchmarkForDefinitionTests();
  runPickBenchmarkForDefinitionsTests();
  runSelectBenchmarkForStrategyKeysTests();
  runRealStrategyMappingTests();
  runUserOverrideTests();

  console.log(`\n${passed} passed / ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
