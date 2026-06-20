/**
 * StrategyCapacityEstimator 单元测试 (US-124 PM-013 WK-005)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/strategy-capacity-estimator.test.ts
 *
 * 完全脱离 DB / 网络 — pure helpers + 显式 Map 注入.
 *
 * 覆盖维度:
 *   - 常量冻结 / 默认值
 *   - strategyLabel: 已知 enum / sentinel / 未知 fallback
 *   - safeFiniteNumber 内部行为通过外部 helper 间接验证
 *   - computeStockCapacity: adv=0 / negative / NaN / 正常 / 默认参数兜底
 *   - gradeCapacity: high / medium / low / unknown / Infinity / NaN
 *   - bucketPositionsByStrategy: 空 / 同 strategy 同 symbol 合并 / sentinel 兜底
 *     / 负市值 skip
 *   - computeStrategyCapacity: 空 / 全缺 ADV / 部分缺 ADV / bottleneck 稳定排序
 *   - estimateCapacities: 端到端 — 多策略 / over_capacity 触发 / 排序 / pct null
 *   - meanTurnoverFromBars: 空 / 全无效 / 部分有效 / 字符串数字
 */

import {
  ALERT_USED_PCT,
  CAPACITY_GRADE_THRESHOLDS,
  CapacityEstimatorInput,
  CapacityRow,
  DEFAULT_HOLDING_DAYS,
  DEFAULT_PARTICIPATION_RATE,
  DEFAULT_TARGET_POS_PCT,
  STRATEGY_SENTINEL,
  StrategyPositionRow,
  bucketPositionsByStrategy,
  computeStockCapacity,
  computeStrategyCapacity,
  estimateCapacities,
  gradeCapacity,
  meanTurnoverFromBars,
  strategyLabel,
} from '../../src/services/StrategyCapacityEstimator';
import { AISignalSourceType } from '../../src/models/AIInvestmentSignal';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function assertClose(name: string, actual: number, expected: number, eps = 1e-6): void {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= eps;
  assert(name, ok, `actual=${actual} expected≈${expected}`);
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

function testConstants(): void {
  assertEqual('DEFAULT_PARTICIPATION_RATE', DEFAULT_PARTICIPATION_RATE, 0.1);
  assertEqual('DEFAULT_HOLDING_DAYS', DEFAULT_HOLDING_DAYS, 5);
  assertEqual('DEFAULT_TARGET_POS_PCT', DEFAULT_TARGET_POS_PCT, 0.05);
  assertEqual('ALERT_USED_PCT', ALERT_USED_PCT, 80);
  assertEqual('STRATEGY_SENTINEL.MANUAL', STRATEGY_SENTINEL.MANUAL, '__MANUAL__');
  assertEqual('STRATEGY_SENTINEL.UNKNOWN', STRATEGY_SENTINEL.UNKNOWN, '__UNKNOWN__');
  assertEqual('CAPACITY_GRADE_THRESHOLDS.HIGH_CNY', CAPACITY_GRADE_THRESHOLDS.HIGH_CNY, 1e9);
  assertEqual('CAPACITY_GRADE_THRESHOLDS.MEDIUM_CNY', CAPACITY_GRADE_THRESHOLDS.MEDIUM_CNY, 1e8);
}

// ---------------------------------------------------------------------------
// strategyLabel
// ---------------------------------------------------------------------------

function testStrategyLabel(): void {
  assertEqual('quant → 量化推荐', strategyLabel(AISignalSourceType.QUANT_RECOMMENDATION), '量化推荐');
  assertEqual('trading_agents → TradingAgents', strategyLabel(AISignalSourceType.TRADING_AGENTS), 'TradingAgents');
  assertEqual('daily → AI每日优选', strategyLabel(AISignalSourceType.DAILY_SCREENER), 'AI每日优选');
  assertEqual('manual analysis → 人工分析', strategyLabel(AISignalSourceType.MANUAL_ANALYSIS), '人工分析');
  assertEqual('analysis engine', strategyLabel(AISignalSourceType.ANALYSIS_ENGINE), '多维分析引擎');
  assertEqual('__MANUAL__', strategyLabel(STRATEGY_SENTINEL.MANUAL), '手动交易');
  assertEqual('__UNKNOWN__', strategyLabel(STRATEGY_SENTINEL.UNKNOWN), '未标注策略');
  assertEqual('未知 key 回显', strategyLabel('custom_strategy_abc'), 'custom_strategy_abc');
  assertEqual('空串兜底', strategyLabel(''), '未标注策略');
}

// ---------------------------------------------------------------------------
// computeStockCapacity
// ---------------------------------------------------------------------------

function testComputeStockCapacity(): void {
  // ADV=10 亿, participation=0.10, days=5, pos=0.05
  //   max_daily   = 1e9 * 0.10 = 1e8
  //   max_pos     = 1e8 * 5 = 5e8
  //   stock_cap   = 5e8 / 0.05 = 1e10 (100 亿)
  assertClose('large-cap 1e10', computeStockCapacity(1e9, 0.1, 5, 0.05) as number, 1e10);
  // ADV=1000 万, 同参数 → max_daily=1e6, max_pos=5e6, cap=1e8 (1 亿)
  assertClose('small-cap 1e8', computeStockCapacity(1e7, 0.1, 5, 0.05) as number, 1e8);

  // adv=0 / negative / NaN → null
  assertEqual('adv=0 → null', computeStockCapacity(0), null);
  assertEqual('adv 负 → null', computeStockCapacity(-100), null);
  assertEqual('adv NaN → null', computeStockCapacity(NaN), null);
  assertEqual('adv Infinity → null (非有限正)', computeStockCapacity(Infinity), null);

  // 缺参数走默认 — adv=1e9 默认参数 → 同 1e10
  assertClose('默认参数 → 1e10', computeStockCapacity(1e9) as number, 1e10);

  // 非正参数走默认兜底 (caller 防呆) — adv=1e9, participation=0 / days=0 / pos=0
  // 应回退默认值得 1e10
  assertClose(
    '0 参数走默认',
    computeStockCapacity(1e9, 0, 0, 0) as number,
    1e10
  );
  // 负参数同样兜底
  assertClose(
    '负参数走默认',
    computeStockCapacity(1e9, -1, -1, -1) as number,
    1e10
  );

  // 自定义参数 — 高频策略 days=1, pos=0.10
  //   max_daily = 1e9 * 0.10 = 1e8
  //   max_pos   = 1e8 * 1 = 1e8
  //   cap       = 1e8 / 0.10 = 1e9
  assertClose('高频策略', computeStockCapacity(1e9, 0.1, 1, 0.1) as number, 1e9);
}

// ---------------------------------------------------------------------------
// gradeCapacity
// ---------------------------------------------------------------------------

function testGradeCapacity(): void {
  assertEqual('10 亿 → high', gradeCapacity(1e9), 'high');
  assertEqual('100 亿 → high', gradeCapacity(1e10), 'high');
  assertEqual('1 亿 → medium', gradeCapacity(1e8), 'medium');
  assertEqual('5 亿 → medium', gradeCapacity(5e8), 'medium');
  assertEqual('1 千万 → low', gradeCapacity(1e7), 'low');
  assertEqual('1 → low', gradeCapacity(1), 'low');
  assertEqual('0 → unknown', gradeCapacity(0), 'unknown');
  assertEqual('负 → unknown', gradeCapacity(-100), 'unknown');
  assertEqual('Infinity → high (无瓶颈)', gradeCapacity(Infinity), 'high');
  assertEqual('NaN → unknown', gradeCapacity(NaN), 'unknown');
  assertEqual('-Infinity → unknown', gradeCapacity(-Infinity), 'unknown');
}

// ---------------------------------------------------------------------------
// bucketPositionsByStrategy
// ---------------------------------------------------------------------------

function testBucketPositionsByStrategy(): void {
  // 空
  const b0 = bucketPositionsByStrategy([]);
  assertEqual('空 → 0 桶', b0.size, 0);

  // 同 strategy 同 symbol 合并
  const positions: StrategyPositionRow[] = [
    { strategy_key: 'quant_recommendation', symbol: '600000.SH', market_value_cny: 100000 },
    { strategy_key: 'quant_recommendation', symbol: '600000.SH', market_value_cny: 50000 }, // 加仓
    { strategy_key: 'quant_recommendation', symbol: '000001.SZ', market_value_cny: 80000 },
    { strategy_key: 'tradingagents', symbol: '600519.SH', market_value_cny: 200000 },
  ];
  const b1 = bucketPositionsByStrategy(positions);
  assertEqual('2 桶', b1.size, 2);
  assertEqual('quant.600000 合并', b1.get('quant_recommendation')?.get('600000.SH'), 150000);
  assertEqual('quant.000001', b1.get('quant_recommendation')?.get('000001.SZ'), 80000);
  assertEqual('tradingagents.600519', b1.get('tradingagents')?.get('600519.SH'), 200000);

  // sentinel 兜底
  const b2 = bucketPositionsByStrategy([
    { strategy_key: '', symbol: '600000.SH', market_value_cny: 1000 },
    { strategy_key: '   ', symbol: '600000.SH', market_value_cny: 500 },
  ]);
  assertEqual('空 / 空白 strategy_key 进 __UNKNOWN__', b2.get('__UNKNOWN__')?.get('600000.SH'), 1500);

  // 负 / 0 市值 skip; 空 symbol skip
  const b3 = bucketPositionsByStrategy([
    { strategy_key: 'k1', symbol: 'A', market_value_cny: 0 },
    { strategy_key: 'k1', symbol: 'A', market_value_cny: -100 },
    { strategy_key: 'k1', symbol: '', market_value_cny: 1000 },
    { strategy_key: 'k1', symbol: 'B', market_value_cny: 200 },
  ]);
  assertEqual('skip 0/负市值 + 空 symbol', b3.size, 1);
  assertEqual('剩 B=200', b3.get('k1')?.get('B'), 200);
  assert('A 不进', !b3.get('k1')?.has('A'));
}

// ---------------------------------------------------------------------------
// computeStrategyCapacity
// ---------------------------------------------------------------------------

function testComputeStrategyCapacityEmpty(): void {
  const out = computeStrategyCapacity(new Map(), new Map(), 0.1, 5, 0.05);
  assertEqual('空 → capacity=Infinity', out.capacity_cny, Infinity);
  assertEqual('空 → deployed=0', out.deployed_cny, 0);
  assertEqual('空 → bottleneck=null', out.bottleneck_symbol, null);
}

function testComputeStrategyCapacityAllMissingAdv(): void {
  const symMap = new Map([
    ['600000.SH', 100000],
    ['000001.SZ', 80000],
  ]);
  const advMap = new Map<string, number>(); // 全缺
  const out = computeStrategyCapacity(symMap, advMap, 0.1, 5, 0.05);
  assertEqual('全缺 ADV → capacity=Infinity', out.capacity_cny, Infinity);
  assertEqual('全缺 ADV → deployed=180000', out.deployed_cny, 180000);
  assertEqual('全缺 ADV → bottleneck=null', out.bottleneck_symbol, null);
}

function testComputeStrategyCapacityPartialAdv(): void {
  const symMap = new Map([
    ['600000.SH', 100000],
    ['000001.SZ', 80000],
    ['600519.SH', 50000],
  ]);
  // 600519 缺 ADV;
  // 600000 ADV=1e9 → stock_cap = 1e10
  // 000001 ADV=1e7 → stock_cap = 1e8 (bottleneck)
  const advMap = new Map([
    ['600000.SH', 1e9],
    ['000001.SZ', 1e7],
  ]);
  const out = computeStrategyCapacity(symMap, advMap, 0.1, 5, 0.05);
  assertEqual('bottleneck=000001.SZ', out.bottleneck_symbol, '000001.SZ');
  assertClose('capacity=1e8', out.capacity_cny, 1e8);
  assertEqual('deployed 全计入 (含缺 ADV symbol)', out.deployed_cny, 230000);
  assertEqual('bottleneck_adv=1e7', out.bottleneck_adv_cny, 1e7);
}

function testComputeStrategyCapacityStableTie(): void {
  // 两个 symbol 同 ADV → 字母靠前的为 bottleneck (排序稳定)
  const symMap = new Map([
    ['B.SH', 100],
    ['A.SH', 100],
  ]);
  const advMap = new Map([
    ['A.SH', 1e8],
    ['B.SH', 1e8],
  ]);
  const out = computeStrategyCapacity(symMap, advMap, 0.1, 5, 0.05);
  assertEqual('tie → 字母靠前', out.bottleneck_symbol, 'A.SH');
}

// ---------------------------------------------------------------------------
// estimateCapacities (主入口端到端)
// ---------------------------------------------------------------------------

function testEstimateCapacitiesEmpty(): void {
  const out = estimateCapacities({
    strategy_positions: [],
    stock_adv_cny: new Map(),
  });
  assertEqual('空 → 空 rows', out, []);
}

function testEstimateCapacitiesHappy(): void {
  // 两个策略:
  //   quant: 持仓 600000(800万 mv) + 000001(200 万 mv), ADV 都是 1e9 → cap=1e10, deployed=1000万
  //          → used_pct = 1000万 / 1e10 = 0.1%  (远低于 80% → over_capacity=false, grade=high)
  //   tradingagents: 持仓 002000(500 万 mv), ADV=1e7 → cap=1e8 (1 亿)
  //                  → used_pct = 500万 / 1e8 = 5%  (low capacity 警示线高 → over=false)
  const positions: StrategyPositionRow[] = [
    { strategy_key: 'quant_recommendation', symbol: '600000.SH', market_value_cny: 8_000_000 },
    { strategy_key: 'quant_recommendation', symbol: '000001.SZ', market_value_cny: 2_000_000 },
    { strategy_key: 'tradingagents', symbol: '002000.SZ', market_value_cny: 5_000_000 },
  ];
  const adv = new Map([
    ['600000.SH', 1e9],
    ['000001.SZ', 1e9],
    ['002000.SZ', 1e7],
  ]);
  const rows = estimateCapacities({ strategy_positions: positions, stock_adv_cny: adv });
  assertEqual('2 rows', rows.length, 2);
  // tradingagents 5% 比 quant 0.1% 高 → 排第一
  assertEqual('排序: tradingagents 在前', rows[0].strategy_key, 'tradingagents');
  assertEqual('tradingagents capacity_used_pct=5', rows[0].capacity_used_pct, 5);
  assertEqual('tradingagents grade=medium (1e8)', rows[0].capacity_grade, 'medium');
  assertEqual('tradingagents bottleneck=002000.SZ', rows[0].bottleneck_symbol, '002000.SZ');
  assertEqual('tradingagents over=false', rows[0].over_capacity, false);

  assertEqual('quant 第二', rows[1].strategy_key, 'quant_recommendation');
  assertEqual('quant grade=high', rows[1].capacity_grade, 'high');
  assertEqual('quant deployed', rows[1].deployed_cny, 10_000_000);
  // 1000万 / 1e10 = 0.001 → 0.1%
  assertClose('quant used_pct ≈ 0.1', rows[1].capacity_used_pct as number, 0.1);
}

function testEstimateCapacitiesOverCapacityAlert(): void {
  // 单策略持仓远超 ADV-derived capacity
  //   ADV=1e7, days=5, part=0.10, pos=0.05 → cap = 1e7*0.10*5/0.05 = 1e8
  //   持仓 9000 万 → used_pct=90 → over_capacity=true
  const positions: StrategyPositionRow[] = [
    { strategy_key: 'manual_analysis', symbol: 'X.SH', market_value_cny: 9_000_000 * 10 },
  ];
  const adv = new Map([['X.SH', 1e7]]);
  const rows = estimateCapacities({ strategy_positions: positions, stock_adv_cny: adv });
  assertEqual('1 row', rows.length, 1);
  assertEqual('over_capacity=true', rows[0].over_capacity, true);
  assertClose('used_pct=90', rows[0].capacity_used_pct as number, 90);
  assertEqual('strategy_label=人工分析', rows[0].strategy_label, '人工分析');
}

function testEstimateCapacitiesNullPct(): void {
  // 全缺 ADV → capacity=Infinity → used_pct=null, over=false, grade=high (Infinity 走 high)
  const positions: StrategyPositionRow[] = [
    { strategy_key: 'kx', symbol: 'A', market_value_cny: 1000 },
  ];
  const rows = estimateCapacities({
    strategy_positions: positions,
    stock_adv_cny: new Map(),
  });
  assertEqual('1 row', rows.length, 1);
  assertEqual('capacity=Infinity', rows[0].capacity_cny, Infinity);
  assertEqual('used_pct=null', rows[0].capacity_used_pct, null);
  assertEqual('over_capacity=false', rows[0].over_capacity, false);
  assertEqual('grade=high (Infinity)', rows[0].capacity_grade, 'high');
}

function testEstimateCapacitiesDefaults(): void {
  // 不传 participation/days/pos → 默认值仍能算
  const positions: StrategyPositionRow[] = [
    { strategy_key: 'k1', symbol: 'A', market_value_cny: 1_000_000 },
  ];
  const adv = new Map([['A', 1e9]]);
  const rows = estimateCapacities({ strategy_positions: positions, stock_adv_cny: adv });
  // cap=1e10, used_pct = 1e6 / 1e10 * 100 = 0.01 → 1 位小数 round → 0
  assertEqual('1 row', rows.length, 1);
  assertEqual('默认参数 used_pct (1 dec round → 0)', rows[0].capacity_used_pct, 0);
}

function testEstimateCapacitiesSentinel(): void {
  // strategy_key 空 → sentinel UNKNOWN; 标签=未标注策略
  const positions: StrategyPositionRow[] = [
    { strategy_key: '', symbol: 'A', market_value_cny: 100 },
  ];
  const rows = estimateCapacities({
    strategy_positions: positions,
    stock_adv_cny: new Map([['A', 1e9]]),
  });
  assertEqual('1 row', rows.length, 1);
  assertEqual('sentinel UNKNOWN', rows[0].strategy_key, '__UNKNOWN__');
  assertEqual('label 未标注策略', rows[0].strategy_label, '未标注策略');
}

function testEstimateCapacitiesNonMapAdv(): void {
  // 传非 Map (null / object) → 内部回退空 Map, 不抛
  const positions: StrategyPositionRow[] = [
    { strategy_key: 'k1', symbol: 'A', market_value_cny: 100 },
  ];
  const rows = estimateCapacities({
    strategy_positions: positions,
    stock_adv_cny: null as any,
  });
  assertEqual('1 row', rows.length, 1);
  // 无 ADV → capacity=Infinity
  assertEqual('null ADV map → Infinity', rows[0].capacity_cny, Infinity);
}

function testEstimateCapacitiesStableSort(): void {
  // tie 排序 → strategy_key 字母升序
  const positions: StrategyPositionRow[] = [
    { strategy_key: 'b_strategy', symbol: 'A', market_value_cny: 100 },
    { strategy_key: 'a_strategy', symbol: 'A', market_value_cny: 100 },
  ];
  const adv = new Map([['A', 1e9]]);
  const rows = estimateCapacities({ strategy_positions: positions, stock_adv_cny: adv });
  assertEqual('2 rows', rows.length, 2);
  assertEqual('tie tie → a_strategy 在前', rows[0].strategy_key, 'a_strategy');
  assertEqual('b_strategy 在后', rows[1].strategy_key, 'b_strategy');
}

// ---------------------------------------------------------------------------
// meanTurnoverFromBars
// ---------------------------------------------------------------------------

function testMeanTurnoverFromBars(): void {
  assertEqual('空 → null', meanTurnoverFromBars([]), null);
  assertEqual('非数组 → null', meanTurnoverFromBars(null as any), null);
  assertEqual('全无效 → null', meanTurnoverFromBars([{ turnover: 0 }, { turnover: NaN as any }]), null);
  assertEqual('全负 → null', meanTurnoverFromBars([{ turnover: -10 }, { turnover: -20 }]), null);
  assertClose('1000+2000+3000 mean=2000', meanTurnoverFromBars([
    { turnover: 1000 },
    { turnover: 2000 },
    { turnover: 3000 },
  ]) as number, 2000);
  // 部分无效 — 0/NaN skip, mean 只算有效
  assertClose('部分无效', meanTurnoverFromBars([
    { turnover: 100 },
    { turnover: 0 },
    { turnover: 300 },
  ]) as number, 200);
  // 字符串数字
  assertClose('字符串数字解析', meanTurnoverFromBars([
    { turnover: '500' as any },
    { turnover: '1500' as any },
  ]) as number, 1000);
}

// ---------------------------------------------------------------------------
// meta-guard: ALERT_USED_PCT 与 over_capacity 同步
// ---------------------------------------------------------------------------

function testAlertUsedPctSynced(): void {
  // 边界 — 恰好等于 ALERT_USED_PCT 触发
  const positions: StrategyPositionRow[] = [
    { strategy_key: 'k', symbol: 'A', market_value_cny: 8_000_000 * 10 }, // 8000 万
  ];
  // cap = 1e7 * 0.10 * 5 / 0.05 = 1e8 → used_pct = 8000万 / 1e8 = 80%
  const adv = new Map([['A', 1e7]]);
  const rows = estimateCapacities({ strategy_positions: positions, stock_adv_cny: adv });
  assertEqual('边界 used_pct=80', rows[0].capacity_used_pct, 80);
  assertEqual('边界 over_capacity=true (=ALERT)', rows[0].over_capacity, true);

  // 略低 (持仓 = 7900 万, used_pct=79)
  const rows2 = estimateCapacities({
    strategy_positions: [{ strategy_key: 'k', symbol: 'A', market_value_cny: 79_000_000 }],
    stock_adv_cny: adv,
  });
  assertEqual('used_pct=79 → over=false', rows2[0].over_capacity, false);
}

// ---------------------------------------------------------------------------
// run all
// ---------------------------------------------------------------------------

testConstants();
testStrategyLabel();
testComputeStockCapacity();
testGradeCapacity();
testBucketPositionsByStrategy();
testComputeStrategyCapacityEmpty();
testComputeStrategyCapacityAllMissingAdv();
testComputeStrategyCapacityPartialAdv();
testComputeStrategyCapacityStableTie();
testEstimateCapacitiesEmpty();
testEstimateCapacitiesHappy();
testEstimateCapacitiesOverCapacityAlert();
testEstimateCapacitiesNullPct();
testEstimateCapacitiesDefaults();
testEstimateCapacitiesSentinel();
testEstimateCapacitiesNonMapAdv();
testEstimateCapacitiesStableSort();
testMeanTurnoverFromBars();
testAlertUsedPctSynced();

console.log(`\n[strategy-capacity-estimator] ${passed} ok / ${failed} failed`);
if (failed > 0) process.exit(1);
