/**
 * WalkForwardValidator 单元测试（US-039）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/backtest/walk-forward-validator.test.ts
 *
 * 完全脱离 DB：注入 fake optimizer + fake testRunner + persist:false。
 *
 * 覆盖维度：
 *   - 纯函数：isoDateAddDays / isoDateAddMonths / compareIsoDate / sampleStddev /
 *     generateWalkForwardWindows / aggregateWindowMetrics
 *   - end-to-end validate()：
 *     - 基本 happy 5 windows 全部 completed
 *     - 1 个 train_failed 隔离
 *     - 1 个 test_failed 隔离（train 成功 + test runner 抛错）
 *     - 全部 train_failed 时 best_window=null
 *     - 总区间不足 train+test 抛错
 *     - 注入 testRunner 跳过 strategyRegistry 校验
 *     - 自定义 weights 影响 train 阶段 best_params 挑选
 *     - persist=false 不写 DB，返回 in-memory 对象
 *     - best_window 按 test_sharpe DESC + window_index 升序稳定 tie-break
 *     - summary 字段全部正确（mean / std / min / max / win_ratio / decay）
 *     - param_grid 透传到 optimizer.optimize() 不变
 *     - base_config 透传到 testRunner 时含 test_start_date / test_end_date 覆盖
 */

import {
  isoDateAddDays,
  isoDateAddMonths,
  compareIsoDate,
  sampleStddev,
  generateWalkForwardWindows,
  aggregateWindowMetrics,
  WalkForwardValidator,
  WalkForwardWindowResult,
  EmbeddedOptimizer,
  // Phase 1 exports
  daysBetweenInclusive,
  rankByValueDesc,
  generateCombinations,
  purgeTrainingDates,
  generateCpcvFolds,
} from '../../src/quant/backtest/WalkForwardValidator';
import { BacktestRunner } from '../../src/quant/backtest/GridSearchOptimizer';

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

function expectClose(name: string, actual: number, expected: number, eps = 1e-6) {
  assert(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected}, got=${actual}`
  );
}

function expectThrow(name: string, fn: () => any, substr?: string) {
  try {
    fn();
    assert(name, false, 'expected throw, none thrown');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (substr && !msg.includes(substr)) {
      assert(name, false, `expected msg to include '${substr}', got '${msg}'`);
    } else {
      assert(name, true);
    }
  }
}

async function expectThrowAsync(name: string, fn: () => Promise<any>, substr?: string) {
  try {
    await fn();
    assert(name, false, 'expected throw, none thrown');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (substr && !msg.includes(substr)) {
      assert(name, false, `expected msg to include '${substr}', got '${msg}'`);
    } else {
      assert(name, true);
    }
  }
}

// ============================================================
// Pure helper tests
// ============================================================

function runSyncTests() {
  console.log('\n## isoDateAddDays / isoDateAddMonths / compareIsoDate');

  expectEqual('addDays 0', isoDateAddDays('2024-01-15', 0), '2024-01-15');
  expectEqual('addDays +5', isoDateAddDays('2024-01-15', 5), '2024-01-20');
  expectEqual('addDays -5', isoDateAddDays('2024-01-15', -5), '2024-01-10');
  expectEqual('addDays 跨月', isoDateAddDays('2024-01-30', 5), '2024-02-04');
  expectEqual('addDays 跨年', isoDateAddDays('2024-12-30', 5), '2025-01-04');
  expectEqual('addDays 闰年 2-28+1', isoDateAddDays('2024-02-28', 1), '2024-02-29');
  expectEqual('addDays 平年 2-28+1', isoDateAddDays('2023-02-28', 1), '2023-03-01');
  expectThrow('addDays invalid date', () => isoDateAddDays('not-a-date', 1));
  expectThrow('addDays empty', () => isoDateAddDays('', 1));

  expectEqual('addMonths +1', isoDateAddMonths('2024-01-15', 1), '2024-02-15');
  expectEqual('addMonths +3', isoDateAddMonths('2024-01-15', 3), '2024-04-15');
  expectEqual('addMonths +12', isoDateAddMonths('2024-01-15', 12), '2025-01-15');
  expectEqual('addMonths -1', isoDateAddMonths('2024-02-15', -1), '2024-01-15');
  expectEqual('addMonths -12', isoDateAddMonths('2024-01-15', -12), '2023-01-15');
  expectEqual(
    'addMonths 月末 clamp 闰年 1-31→2-29',
    isoDateAddMonths('2024-01-31', 1),
    '2024-02-29'
  );
  expectEqual(
    'addMonths 月末 clamp 平年 1-31→2-28',
    isoDateAddMonths('2023-01-31', 1),
    '2023-02-28'
  );
  expectEqual(
    'addMonths 30→2 月 平年',
    isoDateAddMonths('2023-01-30', 1),
    '2023-02-28'
  );
  expectEqual(
    'addMonths 跨年 12→1',
    isoDateAddMonths('2024-12-15', 1),
    '2025-01-15'
  );
  expectThrow('addMonths invalid format', () => isoDateAddMonths('2024-1-15', 1));
  expectThrow('addMonths empty', () => isoDateAddMonths('', 1));

  expectEqual('compare 等', compareIsoDate('2024-01-15', '2024-01-15'), 0);
  expectEqual('compare a<b', compareIsoDate('2024-01-15', '2024-01-16'), -1);
  expectEqual('compare a>b', compareIsoDate('2024-01-16', '2024-01-15'), 1);
  expectEqual('compare 跨月', compareIsoDate('2024-01-31', '2024-02-01'), -1);

  console.log('\n## sampleStddev 纯函数');
  expectEqual('stddev 空数组 → null', sampleStddev([]), null);
  expectEqual('stddev 单元素 → null', sampleStddev([5]), null);
  expectClose('stddev [1,3]', sampleStddev([1, 3])!, Math.sqrt(2));
  // [1,2,3,4,5] mean=3 var=(4+1+0+1+4)/4=2.5 std=sqrt(2.5)
  expectClose('stddev [1..5]', sampleStddev([1, 2, 3, 4, 5])!, Math.sqrt(2.5));
  expectEqual('stddev 全 NaN → null', sampleStddev([NaN, NaN, NaN]), null);
  expectClose('stddev [1,2,NaN,3] → 同 [1,2,3]', sampleStddev([1, 2, NaN, 3])!, 1);
  expectClose('stddev 含 Infinity → 剔除', sampleStddev([1, 2, Infinity, 3])!, 1);

  console.log('\n## generateWalkForwardWindows 纯函数');

  // (1) 简单情形：12 个月区间，train=6, test=3 → 第 1 窗 train 1-6 月, test 7-9 月，第 2 窗 train 4-9 月, test 10-12 月
  const ws1 = generateWalkForwardWindows('2024-01-01', '2024-12-31', 6, 3);
  expectEqual('basic 2 windows', ws1.length, 2);
  expectEqual('w0 train_start', ws1[0].train_start_date, '2024-01-01');
  expectEqual('w0 train_end', ws1[0].train_end_date, '2024-06-30'); // 7-1 = 6-30
  expectEqual('w0 test_start', ws1[0].test_start_date, '2024-07-01');
  expectEqual('w0 test_end', ws1[0].test_end_date, '2024-09-30'); // 10-1 = 9-30
  expectEqual('w1 train_start', ws1[1].train_start_date, '2024-04-01'); // shift +3 months
  expectEqual('w1 train_end', ws1[1].train_end_date, '2024-09-30');
  expectEqual('w1 test_start', ws1[1].test_start_date, '2024-10-01');
  expectEqual('w1 test_end', ws1[1].test_end_date, '2024-12-31');

  // (2) 区间不足 → 返回空
  const ws2 = generateWalkForwardWindows('2024-01-01', '2024-06-30', 12, 3);
  expectEqual('insufficient range → []', ws2.length, 0);

  // (3) 边界：恰好够 1 个窗口
  const ws3 = generateWalkForwardWindows('2024-01-01', '2024-09-30', 6, 3);
  expectEqual('恰好 1 window', ws3.length, 1);
  expectEqual('w0 test_end clamped', ws3[0].test_end_date, '2024-09-30');

  // (4) train=12 test=3，覆盖 24 个月 → (24-12)/3 = 4 个完整窗口
  //   w0: train 2023-01..12, test 2024-01..03
  //   w1: train 2023-04..2024-03, test 2024-04..06
  //   w2: train 2023-07..2024-06, test 2024-07..09
  //   w3: train 2023-10..2024-09, test 2024-10..12
  //   w4 would have test_start = 2025-01-01 > endDate → 跳过
  const ws4 = generateWalkForwardWindows('2023-01-01', '2024-12-31', 12, 3);
  expectEqual('24m / train=12 test=3 → 4 windows', ws4.length, 4);
  expectEqual('ws4 w0 train', ws4[0].train_start_date, '2023-01-01');
  expectEqual('ws4 w0 train_end', ws4[0].train_end_date, '2023-12-31');
  expectEqual('ws4 w0 test', ws4[0].test_start_date, '2024-01-01');
  expectEqual('ws4 w0 test_end', ws4[0].test_end_date, '2024-03-31');
  expectEqual('ws4 w3 test_end fits exactly', ws4[3].test_end_date, '2024-12-31');

  // (5) trainMonths <= 0 / testMonths <= 0 抛错
  expectThrow('train=0 throws', () => generateWalkForwardWindows('2024-01-01', '2024-12-31', 0, 3));
  expectThrow(
    'test=-1 throws',
    () => generateWalkForwardWindows('2024-01-01', '2024-12-31', 6, -1)
  );
  expectThrow(
    'train=NaN throws',
    () => generateWalkForwardWindows('2024-01-01', '2024-12-31', NaN, 3)
  );

  // (6) start >= end 抛错
  expectThrow(
    'start>=end throws',
    () => generateWalkForwardWindows('2024-12-31', '2024-01-01', 6, 3),
    'startDate'
  );
  expectThrow(
    'start==end throws',
    () => generateWalkForwardWindows('2024-01-01', '2024-01-01', 6, 3)
  );

  // (7) 窗口 index 单调升 + 不重叠 test
  const ws5 = generateWalkForwardWindows('2024-01-01', '2025-12-31', 12, 3);
  for (let i = 1; i < ws5.length; i++) {
    assert(
      `w${i} index = ${i}`,
      ws5[i].index === i,
      `expected ${i}, got ${ws5[i].index}`
    );
    assert(
      `w${i} test_start > w${i - 1} test_end`,
      ws5[i].test_start_date > ws5[i - 1].test_end_date,
      `w${i}.test_start=${ws5[i].test_start_date} not > w${i - 1}.test_end=${
        ws5[i - 1].test_end_date
      }`
    );
  }

  console.log('\n## aggregateWindowMetrics 纯函数');

  // (1) 空数组
  const sumEmpty = aggregateWindowMetrics([]);
  expectEqual('agg empty total', sumEmpty.total_windows, 0);
  expectEqual('agg empty completed', sumEmpty.completed_windows, 0);
  expectEqual('agg empty mean_sharpe null', sumEmpty.mean_test_sharpe, null);
  expectEqual('agg empty win_ratio null', sumEmpty.win_ratio, null);

  // (2) 全 completed
  const ws: WalkForwardWindowResult[] = [
    mockWindow(0, 'completed', { train_sharpe: 2.0, test_sharpe: 1.5, test_return: 0.2, test_drawdown: 0.1 }),
    mockWindow(1, 'completed', { train_sharpe: 2.5, test_sharpe: 1.0, test_return: 0.15, test_drawdown: 0.12 }),
    mockWindow(2, 'completed', { train_sharpe: 1.8, test_sharpe: 0.5, test_return: 0.05, test_drawdown: 0.2 }),
    mockWindow(3, 'completed', { train_sharpe: 2.2, test_sharpe: -0.3, test_return: -0.05, test_drawdown: 0.25 }),
  ];
  const sum = aggregateWindowMetrics(ws);
  expectEqual('agg 4 total', sum.total_windows, 4);
  expectEqual('agg 4 completed', sum.completed_windows, 4);
  expectEqual('agg 4 failed', sum.failed_windows, 0);
  // mean test_sharpe = (1.5+1.0+0.5-0.3)/4 = 0.675
  expectClose('agg mean_test_sharpe', sum.mean_test_sharpe!, 0.675);
  expectClose('agg min_test_sharpe', sum.min_test_sharpe!, -0.3);
  expectClose('agg max_test_sharpe', sum.max_test_sharpe!, 1.5);
  // win_ratio = 3/4 (1.5, 1.0, 0.5 都 > 0; -0.3 不算)
  expectClose('agg win_ratio', sum.win_ratio!, 0.75);
  // out_of_sample_decay = mean(2-1.5, 2.5-1.0, 1.8-0.5, 2.2-(-0.3)) = mean(0.5, 1.5, 1.3, 2.5) = 1.45
  expectClose('agg decay 过拟合 +1.45', sum.out_of_sample_decay!, 1.45);

  // (3) 混合 train_failed + test_failed
  const wsMixed: WalkForwardWindowResult[] = [
    mockWindow(0, 'completed', { train_sharpe: 1.5, test_sharpe: 1.2, test_return: 0.18, test_drawdown: 0.1 }),
    mockWindow(1, 'train_failed', {}),
    mockWindow(2, 'test_failed', { train_sharpe: 1.8 }),
    mockWindow(3, 'completed', { train_sharpe: 2.0, test_sharpe: 0.8, test_return: 0.1, test_drawdown: 0.15 }),
  ];
  const sumMixed = aggregateWindowMetrics(wsMixed);
  expectEqual('mixed total', sumMixed.total_windows, 4);
  expectEqual('mixed completed', sumMixed.completed_windows, 2);
  expectEqual('mixed failed', sumMixed.failed_windows, 2);
  expectClose('mixed mean_sharpe', sumMixed.mean_test_sharpe!, 1.0); // (1.2+0.8)/2
  expectClose('mixed win_ratio', sumMixed.win_ratio!, 1.0); // 两个都 > 0
  // decay = mean(1.5-1.2, 2.0-0.8) = mean(0.3, 1.2) = 0.75；test_failed 窗口因 test_sharpe=null 不参与
  expectClose('mixed decay', sumMixed.out_of_sample_decay!, 0.75);

  // (4) 全部失败
  const wsAllFailed: WalkForwardWindowResult[] = [
    mockWindow(0, 'train_failed', {}),
    mockWindow(1, 'train_failed', {}),
  ];
  const sumAllFailed = aggregateWindowMetrics(wsAllFailed);
  expectEqual('all_failed total', sumAllFailed.total_windows, 2);
  expectEqual('all_failed completed', sumAllFailed.completed_windows, 0);
  expectEqual('all_failed mean_sharpe null', sumAllFailed.mean_test_sharpe, null);
  expectEqual('all_failed win_ratio null', sumAllFailed.win_ratio, null);
  expectEqual('all_failed decay null', sumAllFailed.out_of_sample_decay, null);

  // (5) std with single completed → null
  const wsSingle: WalkForwardWindowResult[] = [
    mockWindow(0, 'completed', { train_sharpe: 1.5, test_sharpe: 1.2, test_return: 0.1, test_drawdown: 0.1 }),
  ];
  const sumSingle = aggregateWindowMetrics(wsSingle);
  expectClose('single mean', sumSingle.mean_test_sharpe!, 1.2);
  expectEqual('single std null (n<2)', sumSingle.std_test_sharpe, null);

  // ========================================================
  // Phase 1: 新增纯函数测试
  // ========================================================

  console.log('\n## Phase 1: daysBetweenInclusive');
  expectEqual('单日', daysBetweenInclusive('2024-01-15', '2024-01-15'), 1);
  expectEqual('5 天', daysBetweenInclusive('2024-01-15', '2024-01-19'), 5);
  expectEqual('跨月 1 月', daysBetweenInclusive('2024-01-01', '2024-01-31'), 31);
  expectEqual('整年 闰年', daysBetweenInclusive('2024-01-01', '2024-12-31'), 366);
  expectEqual('整年 平年', daysBetweenInclusive('2023-01-01', '2023-12-31'), 365);
  expectEqual('end<start → 0', daysBetweenInclusive('2024-02-15', '2024-01-15'), 0);

  console.log('\n## Phase 1: rankByValueDesc');
  expectEqual('单调降序', rankByValueDesc([3, 2, 1]), [1, 2, 3]);
  expectEqual('单调升序', rankByValueDesc([1, 2, 3]), [3, 2, 1]);
  expectEqual('中间 max', rankByValueDesc([1, 3, 2]), [3, 1, 2]);
  expectEqual('tie 稳定（先出现的拿小 rank）', rankByValueDesc([1, 2, 2, 1]), [3, 1, 2, 4]);
  expectEqual('单元素', rankByValueDesc([5]), [1]);
  expectEqual('空数组', rankByValueDesc([]), []);

  console.log('\n## Phase 1: generateCombinations');
  expectEqual('C(4,2)', generateCombinations(4, 2), [
    [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
  ]);
  expectEqual('C(3,1)', generateCombinations(3, 1), [[0], [1], [2]]);
  expectEqual('C(3,3) 单 combo', generateCombinations(3, 3), [[0, 1, 2]]);
  expectEqual('C(3,0) 单空 combo', generateCombinations(3, 0), [[]]);
  expectEqual('C(2,5) k>n → 空', generateCombinations(2, 5), []);
  // C(6,2) = 15 paths
  const c62 = generateCombinations(6, 2);
  expectEqual('C(6,2).length = 15', c62.length, 15);

  console.log('\n## Phase 1: purgeTrainingDates');
  // train 2024-01-01..2024-12-31, test 起 2025-01-01, label horizon 5 天
  // 应 purge 2024-12-27..2024-12-31 共 5 天 (label 跨入 test)
  const purgeDates = purgeTrainingDates('2024-01-01', '2024-12-31', '2025-01-01', 5);
  expectEqual('purge 5 天 (label_horizon=5)', purgeDates.length, 5);
  expectEqual('第一个 purge 日期', purgeDates[0], '2024-12-27');
  expectEqual('最后一个 purge 日期', purgeDates[4], '2024-12-31');

  // label horizon 0 → 不 purge
  expectEqual('label_horizon=0 不 purge', purgeTrainingDates('2024-01-01', '2024-12-31', '2025-01-01', 0).length, 0);

  // train 集太短，全部都要 purge
  const allPurge = purgeTrainingDates('2024-12-27', '2024-12-31', '2025-01-01', 10);
  expectEqual('label_horizon 远大于 train 长度 → 全部 purge', allPurge.length, 5);

  // test_start 远离 train_end → 不 purge
  expectEqual(
    'test 离 train 远, 不 purge',
    purgeTrainingDates('2024-01-01', '2024-06-30', '2025-01-01', 5).length,
    0
  );

  console.log('\n## Phase 1: generateWalkForwardWindows with embargo');
  // 默认 embargo=0 应该匹配 US-039 原有行为
  const wsNoEmbargo = generateWalkForwardWindows('2024-01-01', '2024-12-31', 6, 1);
  expectEqual('embargo=0 时第一窗 train_end', wsNoEmbargo[0].train_end_date, '2024-06-30');
  expectEqual('embargo=0 时第一窗 test_start', wsNoEmbargo[0].test_start_date, '2024-07-01');

  // embargo=3 时 test_start 后挪 3 天
  const wsEmbargo3 = generateWalkForwardWindows('2024-01-01', '2024-12-31', 6, 1, 3);
  expectEqual('embargo=3 时第一窗 train_end', wsEmbargo3[0].train_end_date, '2024-06-30');
  expectEqual('embargo=3 时第一窗 test_start', wsEmbargo3[0].test_start_date, '2024-07-04');

  expectThrow('embargo<0 抛错', () => generateWalkForwardWindows('2024-01-01', '2024-12-31', 6, 1, -1));

  console.log('\n## Phase 1: generateCpcvFolds');
  // 6 个 group, k=2 应有 C(6,2)=15 paths
  const cpcvFolds = generateCpcvFolds('2024-01-01', '2024-12-31', { n_groups: 6, k_test_groups: 2 });
  expectEqual('CPCV(6,2) 应有 15 paths', cpcvFolds.length, 15);
  expectEqual('CPCV 路径每个有 path_index', cpcvFolds[0].path_index, 0);
  expectEqual('CPCV 路径最后一个 path_index', cpcvFolds[14].path_index, 14);
  // 路径都应有 train + test 日期
  for (let i = 0; i < cpcvFolds.length; i++) {
    assert(`CPCV path[${i}] has train`, cpcvFolds[i].train_start_date.length === 10);
    assert(`CPCV path[${i}] has test`, cpcvFolds[i].test_start_date.length === 10);
  }

  expectThrow('CPCV n_groups<2 抛错', () =>
    generateCpcvFolds('2024-01-01', '2024-12-31', { n_groups: 1, k_test_groups: 1 }));
  expectThrow('CPCV k>=n 抛错', () =>
    generateCpcvFolds('2024-01-01', '2024-12-31', { n_groups: 4, k_test_groups: 4 }));
}

// ============================================================
// E2E validate() tests (fake optimizer + fake testRunner)
// ============================================================

function mockWindow(
  window_index: number,
  status: 'pending' | 'completed' | 'train_failed' | 'test_failed',
  metrics: Partial<{
    train_sharpe: number;
    train_composite_score: number;
    test_sharpe: number;
    test_return: number;
    test_drawdown: number;
    best_params_json: Record<string, any>;
  }>
): WalkForwardWindowResult {
  return {
    id: 0,
    run_id: 0,
    window_index,
    train_start_date: '2024-01-01',
    train_end_date: '2024-06-30',
    test_start_date: '2024-07-01',
    test_end_date: '2024-09-30',
    best_params_json: metrics.best_params_json ?? {},
    train_composite_score:
      metrics.train_composite_score === undefined ? null : metrics.train_composite_score,
    train_sharpe: metrics.train_sharpe === undefined ? null : metrics.train_sharpe,
    test_sharpe: metrics.test_sharpe === undefined ? null : metrics.test_sharpe,
    test_return: metrics.test_return === undefined ? null : metrics.test_return,
    test_drawdown: metrics.test_drawdown === undefined ? null : metrics.test_drawdown,
    test_total_return: null,
    test_win_rate: null,
    test_trade_count: null,
    train_run_id: null,
    train_combos_count: null,
    train_failed_combos: null,
    status,
    error_message: null,
    duration_seconds: null,
  };
}

/**
 * 构造一个 fake EmbeddedOptimizer：依据 input.base_config.start_date 决定 best params。
 * 让不同 train 窗口选出不同 best params + train_sharpe，模拟真实场景。
 */
function makeFakeOptimizer(
  pickByStart: (startDate: string) => { params: Record<string, any>; sharpe: number } | null
): EmbeddedOptimizer {
  return {
    optimize: (async (input, options) => {
      const startDate = (input.base_config as any).start_date;
      const chosen = pickByStart(startDate);
      if (!chosen) {
        return {
          run: null,
          results: [],
          best: null,
          ranked: [],
          combos_run: 0,
          failed_combos: 1,
        };
      }
      const composite = chosen.sharpe * (options?.weights?.sharpe ?? 1.0);
      return {
        run: null,
        results: [
          {
            id: 0,
            run_id: 0,
            combo_index: 0,
            params_json: chosen.params,
            sharpe: chosen.sharpe,
            annual_return: 0.18,
            max_drawdown: 0.12,
            total_return: 0.4,
            win_rate: 0.6,
            trade_count: 100,
            composite_score: composite,
            status: 'completed',
            error_message: null,
            duration_seconds: 0.1,
          },
        ],
        best: {
          id: 0,
          run_id: 0,
          combo_index: 0,
          params_json: chosen.params,
          sharpe: chosen.sharpe,
          annual_return: 0.18,
          max_drawdown: 0.12,
          total_return: 0.4,
          win_rate: 0.6,
          trade_count: 100,
          composite_score: composite,
          status: 'completed',
          error_message: null,
          duration_seconds: 0.1,
        },
        ranked: [],
        combos_run: 1,
        failed_combos: 0,
      };
    }) as EmbeddedOptimizer['optimize'],
  };
}

function makeFakeTestRunner(
  bySharpe: (params: Record<string, any>, startDate: string) => number
): BacktestRunner {
  return async ({ params }, options) => {
    const sharpe = bySharpe(params, options.start_date);
    return {
      sharpe,
      annual_return: sharpe * 0.1,
      max_drawdown: 0.15,
      total_return: sharpe * 0.2,
      win_rate: 0.55,
      trade_count: 30,
    };
  };
}

async function runE2ETests() {
  console.log('\n## validate() end-to-end');

  // ========== (1) 基本 happy 5 windows 全部 completed ==========
  {
    const validator = new WalkForwardValidator();
    // 假 optimizer：每个 train 窗口都选 topN=30, train_sharpe=2.0
    const optimizer = makeFakeOptimizer(() => ({ params: { topN: 30 }, sharpe: 2.0 }));
    // 假 testRunner：test_sharpe 比 train 略低（典型样本外衰减）
    const testRunner = makeFakeTestRunner((p, _) => 1.5);
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [20, 30, 50] },
        base_config: { initial_capital: 1_000_000 },
        train_months: 12,
        test_months: 3,
        start_date: '2023-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    expectEqual('happy windows count', out.windows.length, 4);
    expectEqual('happy all completed', out.windows.every(w => w.status === 'completed'), true);
    expectEqual('happy summary completed', out.summary.completed_windows, 4);
    expectEqual('happy summary failed', out.summary.failed_windows, 0);
    expectClose('happy mean_test_sharpe = 1.5', out.summary.mean_test_sharpe!, 1.5);
    expectClose('happy win_ratio 1.0', out.summary.win_ratio!, 1.0);
    expectClose('happy decay = 2.0 - 1.5 = 0.5', out.summary.out_of_sample_decay!, 0.5);
    // best_window: 全部 test_sharpe=1.5 → tie-break by window_index ASC → index=0
    assert('happy best_window index=0', out.best_window?.window_index === 0);
    expectEqual('happy best_params', out.best_window?.best_params_json, { topN: 30 });
    // run=null because persist=false
    assert('happy run is null with persist=false', out.run === null);
  }

  // ========== (2) train_failed 隔离 ==========
  {
    const validator = new WalkForwardValidator();
    // 让 train_start=2023-04-01 那个窗口 train 失败（w1）
    const optimizer = makeFakeOptimizer(startDate => {
      if (startDate === '2023-04-01') return null;
      return { params: { topN: 30 }, sharpe: 2.0 };
    });
    const testRunner = makeFakeTestRunner(() => 1.5);
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 12,
        test_months: 3,
        start_date: '2023-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    const failedWindow = out.windows.find(w => w.status === 'train_failed');
    assert('one train_failed window exists', !!failedWindow);
    expectEqual('failed window has empty best_params', failedWindow!.best_params_json, {});
    assert(
      'failed window error_message present',
      typeof failedWindow!.error_message === 'string' && failedWindow!.error_message.length > 0
    );
    expectEqual('summary completed', out.summary.completed_windows, 3);
    expectEqual('summary failed', out.summary.failed_windows, 1);
  }

  // ========== (3) test_failed 隔离（train 成功 + test runner 抛错）==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => ({ params: { topN: 30 }, sharpe: 2.0 }));
    // testRunner 在第 3 个窗口（test_start_date='2024-07-01'）抛错
    const testRunner: BacktestRunner = async (_, options) => {
      if (options.start_date === '2024-07-01') {
        throw new Error('synthetic test failure');
      }
      return {
        sharpe: 1.2,
        annual_return: 0.18,
        max_drawdown: 0.15,
        total_return: 0.2,
        win_rate: 0.6,
        trade_count: 50,
      };
    };
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 12,
        test_months: 3,
        start_date: '2023-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    const failedWindow = out.windows.find(w => w.status === 'test_failed');
    assert('one test_failed window exists', !!failedWindow);
    expectEqual(
      'test_failed window has best_params',
      failedWindow!.best_params_json,
      { topN: 30 }
    );
    assert(
      'test_failed error message includes synthetic',
      failedWindow!.error_message?.includes('synthetic test failure') === true
    );
    expectEqual('test_failed test_sharpe = null', failedWindow!.test_sharpe, null);
    // train 阶段成功，所以 train_sharpe 仍然有值
    expectClose('test_failed train_sharpe still recorded', failedWindow!.train_sharpe!, 2.0);
    expectEqual('summary failed = 1', out.summary.failed_windows, 1);
  }

  // ========== (4) 全部 train_failed 时 best_window=null ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => null);
    const testRunner = makeFakeTestRunner(() => 1.0);
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 12,
        test_months: 3,
        start_date: '2023-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    expectEqual('all failed best_window null', out.best_window, null);
    expectEqual('all failed completed=0', out.summary.completed_windows, 0);
    expectEqual('all failed mean_sharpe null', out.summary.mean_test_sharpe, null);
  }

  // ========== (5) 总区间不足 train+test 抛错 ==========
  await expectThrowAsync(
    '总区间不足抛错',
    async () => {
      const v = new WalkForwardValidator();
      const opt = makeFakeOptimizer(() => ({ params: {}, sharpe: 1.0 }));
      const tr = makeFakeTestRunner(() => 1.0);
      await v.validate(
        {
          strategy_key: 'test_strategy',
          param_grid: { topN: [30] },
          base_config: {},
          train_months: 24,
          test_months: 6,
          start_date: '2024-01-01',
          end_date: '2024-06-30',
        },
        { persist: false, optimizer: opt, test_runner: tr }
      );
    },
    '未生成窗口'
  );

  // ========== (6) 注入 testRunner 跳过 strategyRegistry 校验 ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => ({ params: {}, sharpe: 1.0 }));
    const testRunner = makeFakeTestRunner(() => 0.8);
    // 'fake_unregistered_strategy_xyz' 没在 registry 中，但因为传了 test_runner 应该不抛
    const out = await validator.validate(
      {
        strategy_key: 'fake_unregistered_strategy_xyz',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    expectEqual('未注册 strategy 但 fake runner OK', out.windows.length > 0, true);
  }

  // ========== (7) 没有 testRunner 时未注册 strategy 抛错 ==========
  await expectThrowAsync(
    '未注册 strategy + 没 testRunner 抛错',
    async () => {
      const v = new WalkForwardValidator();
      await v.validate(
        {
          strategy_key: 'definitely_not_registered_strategy_q1z',
          param_grid: { topN: [30] },
          base_config: {},
          train_months: 6,
          test_months: 3,
          start_date: '2024-01-01',
          end_date: '2024-12-31',
        },
        { persist: false }
      );
    },
    '未在 StrategyRegistry 中注册'
  );

  // ========== (8) best_window 按 test_sharpe DESC + window_index 升序 tie-break ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => ({ params: { topN: 30 }, sharpe: 2.0 }));
    // 不同窗口不同 test_sharpe；让第 2 个窗口最高
    const sharpeByStart: Record<string, number> = {
      '2024-01-01': 0.5,
      '2024-04-01': 1.0,
      '2024-07-01': 1.8,
      '2024-10-01': 1.2,
    };
    const testRunner = makeFakeTestRunner((_, startDate) => sharpeByStart[startDate] ?? 0.1);
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2023-07-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    // best window 应该是 test_sharpe 最大的那个
    assert(
      'best_window has max test_sharpe',
      out.best_window !== null && out.best_window!.test_sharpe === 1.8
    );
  }

  // ========== (9) tie-break：两个窗口同 sharpe，取 index 较小者 ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => ({ params: { topN: 30 }, sharpe: 2.0 }));
    const testRunner = makeFakeTestRunner(() => 1.5); // 所有窗口都 1.5
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    expectEqual('tie-break first window wins', out.best_window?.window_index, 0);
  }

  // ========== (10) param_grid 透传到 optimizer ==========
  {
    const validator = new WalkForwardValidator();
    const calls: any[] = [];
    const optimizer: EmbeddedOptimizer = {
      optimize: (async (input, _options) => {
        calls.push({ param_grid: input.param_grid, strategy_key: input.strategy_key });
        return {
          run: null,
          results: [],
          best: {
            id: 0,
            run_id: 0,
            combo_index: 0,
            params_json: { topN: 30 },
            sharpe: 1.5,
            annual_return: 0.18,
            max_drawdown: 0.12,
            total_return: 0.4,
            win_rate: 0.6,
            trade_count: 100,
            composite_score: 1.5,
            status: 'completed',
            error_message: null,
            duration_seconds: 0.1,
          },
          ranked: [],
          combos_run: 1,
          failed_combos: 0,
        };
      }) as EmbeddedOptimizer['optimize'],
    };
    const testRunner = makeFakeTestRunner(() => 1.0);
    const myGrid = { topN: [20, 30, 50], stopLossPct: [-5, -7] };
    await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: myGrid,
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    expectEqual('optimizer 收到了 param_grid', calls[0]?.param_grid, myGrid);
    expectEqual('optimizer 收到了 strategy_key', calls[0]?.strategy_key, 'test_strategy');
    assert('optimizer 被调用了次数 = 窗口数', calls.length === 2);
  }

  // ========== (11) base_config 透传到 testRunner 时含 test 窗口时间 ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => ({ params: { topN: 30 }, sharpe: 2.0 }));
    const testCalls: any[] = [];
    const testRunner: BacktestRunner = async (combo, options) => {
      testCalls.push({
        start: options.start_date,
        end: options.end_date,
        initial: options.initial_capital,
        params: options.params_by_strategy?.['test_strategy'],
      });
      return {
        sharpe: 1.0,
        annual_return: 0.1,
        max_drawdown: 0.1,
        total_return: 0.1,
        win_rate: 0.5,
        trade_count: 20,
      };
    };
    await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: { initial_capital: 555_555 },
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    // 2 个窗口的 test
    assert('2 test runner calls', testCalls.length === 2);
    expectEqual('test#0 start = 2024-07-01', testCalls[0].start, '2024-07-01');
    expectEqual('test#0 end = 2024-09-30', testCalls[0].end, '2024-09-30');
    expectEqual('test#0 initial 透传', testCalls[0].initial, 555_555);
    expectEqual('test#0 params_by_strategy 含 best', testCalls[0].params, { topN: 30 });
  }

  // ========== (12) 自定义 weights 影响 train 阶段 best_params 挑选 ==========
  {
    const validator = new WalkForwardValidator();
    const weightSeen: any[] = [];
    const optimizer: EmbeddedOptimizer = {
      optimize: (async (_input, options) => {
        weightSeen.push(options?.weights);
        return {
          run: null,
          results: [],
          best: {
            id: 0,
            run_id: 0,
            combo_index: 0,
            params_json: { topN: 30 },
            sharpe: 1.5,
            annual_return: 0.18,
            max_drawdown: 0.12,
            total_return: 0.4,
            win_rate: 0.6,
            trade_count: 100,
            composite_score: 1.5,
            status: 'completed',
            error_message: null,
            duration_seconds: 0.1,
          },
          ranked: [],
          combos_run: 1,
          failed_combos: 0,
        };
      }) as EmbeddedOptimizer['optimize'],
    };
    const testRunner = makeFakeTestRunner(() => 1.0);
    await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
      {
        persist: false,
        optimizer,
        test_runner: testRunner,
        weights: { sharpe: 2.0, annual: 0.5, drawdown: 1.0 },
      }
    );
    expectClose('weights sharpe 透传', weightSeen[0]?.sharpe, 2.0);
    expectClose('weights annual 透传', weightSeen[0]?.annual, 0.5);
    expectClose('weights drawdown 透传', weightSeen[0]?.drawdown, 1.0);
  }

  // ========== (13) train_months / test_months 在 windows 中正确反映 ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => ({ params: { topN: 30 }, sharpe: 2.0 }));
    const testRunner = makeFakeTestRunner(() => 1.0);
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    // 第一个窗口：train 1-6 月, test 7-9 月
    expectEqual('w0 train_start', out.windows[0].train_start_date, '2024-01-01');
    expectEqual('w0 train_end', out.windows[0].train_end_date, '2024-06-30');
    expectEqual('w0 test_start', out.windows[0].test_start_date, '2024-07-01');
    expectEqual('w0 test_end', out.windows[0].test_end_date, '2024-09-30');
  }

  // ========== (14) 单窗口 train_sharpe / test_sharpe 双字段都正确填充 ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => ({ params: { topN: 50 }, sharpe: 2.4 }));
    const testRunner = makeFakeTestRunner(() => 1.6);
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [50] },
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-09-30',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    expectEqual('single window count', out.windows.length, 1);
    expectClose('train_sharpe filled', out.windows[0].train_sharpe!, 2.4);
    expectClose('test_sharpe filled', out.windows[0].test_sharpe!, 1.6);
    // decay = 2.4 - 1.6 = 0.8
    expectClose('decay single', out.summary.out_of_sample_decay!, 0.8);
  }

  // ========== (15) duration_seconds 被记录 ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => ({ params: {}, sharpe: 1.0 }));
    const testRunner = makeFakeTestRunner(() => 1.0);
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-09-30',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    assert(
      'duration_seconds non-null and finite',
      out.windows[0].duration_seconds !== null && Number.isFinite(out.windows[0].duration_seconds!)
    );
  }

  // ========== (16) test_failed 后续窗口仍正常 ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer = makeFakeOptimizer(() => ({ params: { topN: 30 }, sharpe: 2.0 }));
    let callCount = 0;
    const testRunner: BacktestRunner = async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('boom');
      return {
        sharpe: 1.2,
        annual_return: 0.18,
        max_drawdown: 0.15,
        total_return: 0.2,
        win_rate: 0.6,
        trade_count: 50,
      };
    };
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    expectEqual('windows count = 2', out.windows.length, 2);
    expectEqual('first window failed', out.windows[0].status, 'test_failed');
    expectEqual('second window completed', out.windows[1].status, 'completed');
    expectEqual('summary failed=1', out.summary.failed_windows, 1);
    expectEqual('summary completed=1', out.summary.completed_windows, 1);
  }

  // ========== (17) optimizer 返回 best=null 但 results 非空也算 train_failed ==========
  {
    const validator = new WalkForwardValidator();
    const optimizer: EmbeddedOptimizer = {
      optimize: (async () => ({
        run: null,
        results: [
          {
            id: 0,
            run_id: 0,
            combo_index: 0,
            params_json: { topN: 30 },
            sharpe: null,
            annual_return: null,
            max_drawdown: null,
            total_return: null,
            win_rate: null,
            trade_count: null,
            composite_score: null,
            status: 'failed',
            error_message: 'sample failure',
            duration_seconds: 0.1,
          },
        ],
        best: null,
        ranked: [],
        combos_run: 1,
        failed_combos: 1,
      })) as EmbeddedOptimizer['optimize'],
    };
    const testRunner = makeFakeTestRunner(() => 1.0);
    const out = await validator.validate(
      {
        strategy_key: 'test_strategy',
        param_grid: { topN: [30] },
        base_config: {},
        train_months: 6,
        test_months: 3,
        start_date: '2024-01-01',
        end_date: '2024-12-31',
      },
      { persist: false, optimizer, test_runner: testRunner }
    );
    assert(
      'all windows train_failed when best=null',
      out.windows.every(w => w.status === 'train_failed')
    );
    assert(
      'error_message mentions train 阶段',
      out.windows[0].error_message?.includes('全部') === true
    );
  }
}

// ============================================================
// Run
// ============================================================
async function main() {
  console.log('= WalkForwardValidator tests (US-039) =');
  runSyncTests();
  await runE2ETests();

  console.log('\n----------------------------------------');
  console.log(`Total: ${passed + failed}   ✅ ${passed}   ❌ ${failed}`);
  console.log('----------------------------------------\n');
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(2);
});
