/**
 * GridSearchOptimizer 单元测试（US-037）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/backtest/grid-search-optimizer.test.ts
 *
 * 完全脱离 DB：通过 `runner` 选项注入纯内存 fake runner，且 `persist: false`
 * 让 optimize() 不写库。这种"双 injection"模式让所有测试在毫秒级跑完。
 *
 * 覆盖维度：
 *   - generateGrid (纯函数)：empty / single / multi 维度 / 空数组维度 /
 *     null/undefined / cartesian product 大小正确 / 键顺序稳定
 *   - computeCompositeScore (纯函数)：默认权重 / 自定义权重 / 缺指标返回 null /
 *     回撤取绝对值 / Infinity / NaN
 *   - sortByCompositeScoreDesc：DESC 顺序 / null 推到最末 / tie-break by combo_index
 *   - GridSearchOptimizer.optimize：
 *     - 基本 happy-path：3 combo 全成功
 *     - failure isolation：一个 combo 抛错不影响其他
 *     - 全 combo 失败时 best=null
 *     - max_combos 截断
 *     - custom weights 影响排序
 *     - persist=false 不写 DB，返回 in-memory 对象
 *     - 注入 runner 时跳过 strategyRegistry 校验
 *     - 空参数网格 {} 跑 1 个 combo
 *     - 维度有空数组时抛错（"网格为空"）
 *     - concurrency > 1 触发 chunked batching
 *     - composite_score 在排序中被正确使用（best 选 top）
 *     - runner 收到的 params 正确反映 combo
 *     - runner 收到的 options.params_by_strategy 正确注入
 *     - duration_seconds 被记录
 */

import {
  generateGrid,
  computeCompositeScore,
  sortByCompositeScoreDesc,
  GridSearchOptimizer,
  DEFAULT_COMPOSITE_WEIGHTS,
  BacktestRunner,
  OptimizationResultRecord,
} from '../../src/quant/backtest/GridSearchOptimizer';

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

// 构造 plain OptimizationResultRecord (无 Sequelize 初始化依赖)
function mockResult(
  combo_index: number,
  composite_score: number | null,
  status: 'completed' | 'failed' | 'pending' = 'completed'
): OptimizationResultRecord {
  return {
    id: 0,
    run_id: 0,
    combo_index,
    params_json: {},
    sharpe: null,
    annual_return: null,
    max_drawdown: null,
    total_return: null,
    win_rate: null,
    trade_count: null,
    composite_score,
    status,
    error_message: null,
    duration_seconds: null,
  };
}

/**
 * 创建一个 fake runner，根据 combo.params.topN 返回不同 sharpe，让排序可预测。
 * topN=30 是冠军（sharpe=1.8），topN=20 中等（1.2），topN=10/50 较差（0.5/0.3）。
 */
function makeRankedRunner(): BacktestRunner {
  return async ({ params }) => {
    const topN = Number(params.topN || 0);
    let sharpe: number;
    if (topN === 30) sharpe = 1.8;
    else if (topN === 20) sharpe = 1.2;
    else if (topN === 10) sharpe = 0.5;
    else sharpe = 0.3;
    return {
      sharpe,
      annual_return: 0.15 + sharpe * 0.05,
      max_drawdown: 0.15,
      total_return: 0.4,
      win_rate: 0.6,
      trade_count: 100,
    };
  };
}

// ============================================================
// 同步测试块（pure functions）
// ============================================================

function runSyncTests() {
  console.log('\n## generateGrid 纯函数');

  // (1) 空 grid
  expectEqual('empty grid {} → [{}]', generateGrid({}), [{}]);
  expectEqual('null grid → [{}]', generateGrid(null as any), [{}]);
  expectEqual('undefined grid → [{}]', generateGrid(undefined as any), [{}]);

  // (2) 单维度
  expectEqual(
    'single dim {topN:[10,20]}',
    generateGrid({ topN: [10, 20] }),
    [{ topN: 10 }, { topN: 20 }]
  );

  // (3) 二维 cartesian
  const grid2d = generateGrid({ topN: [10, 20], stopLossPct: [-5, -7] });
  expectEqual('2-dim grid size = 4', grid2d.length, 4);
  expectEqual('2-dim grid first', grid2d[0], { topN: 10, stopLossPct: -5 });
  expectEqual('2-dim grid second', grid2d[1], { topN: 10, stopLossPct: -7 });
  expectEqual('2-dim grid third', grid2d[2], { topN: 20, stopLossPct: -5 });
  expectEqual('2-dim grid fourth', grid2d[3], { topN: 20, stopLossPct: -7 });

  // (4) 三维：4 × 3 × 2 = 24
  const grid3d = generateGrid({
    topN: [10, 20, 30, 50],
    stopLossPct: [-5, -7, -10],
    industryNeutral: [true, false],
  });
  expectEqual('3-dim grid size = 24', grid3d.length, 24);
  expectEqual('3-dim first combo', grid3d[0], {
    topN: 10,
    stopLossPct: -5,
    industryNeutral: true,
  });
  expectEqual('3-dim last combo', grid3d[23], {
    topN: 50,
    stopLossPct: -10,
    industryNeutral: false,
  });

  // (5) 维度有空数组 → 整个 product 空
  expectEqual('any dim empty → []', generateGrid({ topN: [], stopLossPct: [-5] }), []);
  expectEqual('any dim empty 2nd → []', generateGrid({ topN: [10], stopLossPct: [] }), []);

  // (6) 维度有非数组（理论上类型禁止，但运行时防御） → 视为空 dim
  expectEqual('non-array dim treated as empty', generateGrid({ topN: 'oops' as any }), []);

  // (7) 键顺序保持插入顺序
  const orderedGrid = generateGrid({ a: [1], b: [2], c: [3] });
  expectEqual('键顺序遵守插入顺序', Object.keys(orderedGrid[0]), ['a', 'b', 'c']);

  // (8) 单元素维度
  expectEqual('single value dim', generateGrid({ topN: [42] }), [{ topN: 42 }]);

  console.log('\n## computeCompositeScore 纯函数');

  // (1) 默认权重：1.5 * 1.0 + 0.18 * 0.4 - 0.12 * 0.5 = 1.5 + 0.072 - 0.06 = 1.512
  expectClose(
    'default weights basic',
    computeCompositeScore({ sharpe: 1.5, annual_return: 0.18, max_drawdown: 0.12 })!,
    1.512
  );

  // (2) 自定义权重：sharpe-only
  expectClose(
    'custom weights sharpe-only',
    computeCompositeScore(
      { sharpe: 2.0, annual_return: 0.18, max_drawdown: 0.5 },
      { sharpe: 1.0, annual: 0, drawdown: 0 }
    )!,
    2.0
  );

  // (3) 部分权重 override → 其余 fall back default
  expectClose(
    'partial weights override',
    computeCompositeScore(
      { sharpe: 1.0, annual_return: 0.1, max_drawdown: 0.1 },
      { sharpe: 2.0 } // annual/drawdown 用默认
    )!,
    2.0 * 1.0 + 0.4 * 0.1 - 0.5 * 0.1
  );

  // (4) 回撤取绝对值（即使 caller 传负数）
  expectClose(
    'drawdown abs (negative input)',
    computeCompositeScore({ sharpe: 1.0, annual_return: 0.1, max_drawdown: -0.2 })!,
    computeCompositeScore({ sharpe: 1.0, annual_return: 0.1, max_drawdown: 0.2 })!
  );

  // (5) 缺指标 → null
  expectEqual(
    '缺 sharpe → null',
    computeCompositeScore({ annual_return: 0.1, max_drawdown: 0.1 }),
    null
  );
  expectEqual(
    '缺 annual → null',
    computeCompositeScore({ sharpe: 1.5, max_drawdown: 0.1 }),
    null
  );
  expectEqual('缺 drawdown → null', computeCompositeScore({ sharpe: 1.5, annual_return: 0.1 }), null);
  expectEqual('全空 metrics → null', computeCompositeScore({}), null);

  // (6) NaN / Infinity 输入 → null
  expectEqual(
    'NaN sharpe → null',
    computeCompositeScore({ sharpe: NaN, annual_return: 0.1, max_drawdown: 0.1 }),
    null
  );
  expectEqual(
    'Infinity sharpe → null',
    computeCompositeScore({ sharpe: Infinity, annual_return: 0.1, max_drawdown: 0.1 }),
    null
  );

  // (7) 全 0 输入 → 0
  expectClose(
    'all zero → 0',
    computeCompositeScore({ sharpe: 0, annual_return: 0, max_drawdown: 0 })!,
    0
  );

  // (8) 负 sharpe → 负分（差策略要能被 sort 推到底）
  const negScore = computeCompositeScore({ sharpe: -1.5, annual_return: -0.1, max_drawdown: 0.3 });
  assert('负 sharpe → 负分', negScore !== null && negScore < 0, `got ${negScore}`);

  // (9) DEFAULT_COMPOSITE_WEIGHTS 是 Object.freeze
  assert(
    'DEFAULT_COMPOSITE_WEIGHTS frozen',
    Object.isFrozen(DEFAULT_COMPOSITE_WEIGHTS),
    'frozen=true'
  );

  console.log('\n## sortByCompositeScoreDesc');

  const sortInput = [
    mockResult(0, 1.5),
    mockResult(1, 2.5),
    mockResult(2, 0.5),
    mockResult(3, null, 'failed'),
    mockResult(4, 1.5),
  ];
  const sorted = sortByCompositeScoreDesc(sortInput);
  expectEqual('sort: 1st combo_index=1 (score 2.5)', sorted[0].combo_index, 1);
  expectEqual(
    'sort: 2nd combo_index=0 (score 1.5 tie, lower combo_index wins)',
    sorted[1].combo_index,
    0
  );
  expectEqual(
    'sort: 3rd combo_index=4 (score 1.5 tie, higher combo_index)',
    sorted[2].combo_index,
    4
  );
  expectEqual('sort: 4th combo_index=2 (score 0.5)', sorted[3].combo_index, 2);
  expectEqual('sort: 5th combo_index=3 (null pushed to end)', sorted[4].combo_index, 3);

  // 全 null
  const allNull = [mockResult(0, null), mockResult(1, null), mockResult(2, null)];
  const sortedNull = sortByCompositeScoreDesc(allNull);
  expectEqual(
    'all null sort stable by combo_index',
    sortedNull.map(r => r.combo_index),
    [0, 1, 2]
  );

  // 空输入
  expectEqual('empty sort', sortByCompositeScoreDesc([]), []);

  // 单元素
  const single = [mockResult(0, 1.5)];
  expectEqual('single element', sortByCompositeScoreDesc(single).length, 1);

  // 不 mutate 原数组
  const original = [mockResult(0, 1.0), mockResult(1, 2.0)];
  const originalOrder = original.map(r => r.combo_index);
  sortByCompositeScoreDesc(original);
  expectEqual('原数组不被 mutate', original.map(r => r.combo_index), originalOrder);
}

// ============================================================
// 异步测试块（GridSearchOptimizer.optimize）
// ============================================================

async function testBasicHappyPath() {
  const optimizer = new GridSearchOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [10, 20, 30, 50] },
      base_config: {
        start_date: '2025-01-01',
        end_date: '2025-12-31',
        initial_capital: 1_000_000,
        benchmark_symbol: 'sh.000300',
      },
    },
    {
      runner: makeRankedRunner(),
      persist: false,
    }
  );

  assert('happy: combos_run = 4', out.combos_run === 4);
  assert('happy: failed_combos = 0', out.failed_combos === 0);
  assert('happy: run is null (persist=false)', out.run === null);
  assert('happy: results length = 4', out.results.length === 4);
  assert('happy: ranked length = 4', out.ranked.length === 4);
  assert('happy: best.params.topN = 30 (the 冠军)', out.best?.params_json?.topN === 30);
  assert(
    'happy: best.sharpe = 1.8',
    Number(out.best?.sharpe) === 1.8,
    `got ${out.best?.sharpe}`
  );
  assert('happy: ranked first = best', out.ranked[0].params_json.topN === 30);
  assert('happy: ranked second.topN = 20', out.ranked[1].params_json.topN === 20);
  assert(
    'happy: all results status=completed',
    out.results.every(r => r.status === 'completed')
  );
  assert(
    'happy: composite_score is non-null on all',
    out.results.every(r => r.composite_score !== null && r.composite_score !== undefined)
  );
}

async function testFailureIsolation() {
  const flakey: BacktestRunner = async ({ params }) => {
    if (params.topN === 20) throw new Error('synthetic failure for topN=20');
    return {
      sharpe: 1.0,
      annual_return: 0.1,
      max_drawdown: 0.1,
    };
  };
  const optimizer = new GridSearchOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [10, 20, 30] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner: flakey, persist: false }
  );
  assert('isolation: combos_run = 3 (all attempted)', out.combos_run === 3);
  assert('isolation: failed_combos = 1', out.failed_combos === 1);
  const failedRow = out.results.find(r => r.params_json.topN === 20);
  assert('isolation: 失败行 status=failed', failedRow?.status === 'failed');
  assert(
    'isolation: 失败行 error_message 含 synthetic',
    !!failedRow?.error_message?.includes('synthetic failure')
  );
  assert(
    'isolation: best 是成功的行（topN=10 或 30）',
    out.best !== null && out.best.params_json.topN !== 20
  );
  assert(
    'isolation: 失败行 sharpe = null',
    failedRow?.sharpe === null || failedRow?.sharpe === undefined
  );
  assert(
    'isolation: 失败行 composite_score = null',
    failedRow?.composite_score === null || failedRow?.composite_score === undefined
  );
}

async function testAllFailures() {
  const allFail: BacktestRunner = async () => {
    throw new Error('all-fail-runner');
  };
  const optimizer = new GridSearchOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [10, 20] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner: allFail, persist: false }
  );
  assert('all-fail: combos_run = 2', out.combos_run === 2);
  assert('all-fail: failed = 2', out.failed_combos === 2);
  assert('all-fail: best is null', out.best === null);
  assert(
    'all-fail: 所有 results.status=failed',
    out.results.every(r => r.status === 'failed')
  );
  assert(
    'all-fail: 所有 composite_score=null',
    out.results.every(r => r.composite_score === null || r.composite_score === undefined)
  );
}

async function testMaxCombosLimit() {
  const optimizer = new GridSearchOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, // 10 combos
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    {
      runner: makeRankedRunner(),
      persist: false,
      max_combos: 3, // 截到 3
    }
  );
  assert('max_combos: combos_run = 3', out.combos_run === 3);
  assert('max_combos: results length = 3', out.results.length === 3);
  const topNs = out.results.map(r => r.params_json.topN).sort((a, b) => a - b);
  expectEqual('max_combos: 截前 3 个 combos', topNs, [1, 2, 3]);
}

async function testCustomWeights() {
  // combo A: sharpe=2.0, dd=0.30 → default score = 2.0 + 0.4*0.15 - 0.5*0.30 = 1.91
  //                            → drawdown-heavy (w_dd=10): 2.0 + 0.4*0.15 - 10*0.30 = -0.94
  // combo B: sharpe=1.0, dd=0.05 → default score = 1.0 + 0.4*0.15 - 0.5*0.05 = 1.035
  //                            → drawdown-heavy (w_dd=10): 1.0 + 0.4*0.15 - 10*0.05 = 0.56
  const runner: BacktestRunner = async ({ params }) => {
    if (params.label === 'A') return { sharpe: 2.0, annual_return: 0.15, max_drawdown: 0.3 };
    return { sharpe: 1.0, annual_return: 0.15, max_drawdown: 0.05 };
  };
  const optimizer = new GridSearchOptimizer();

  const outDefault = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { label: ['A', 'B'] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner, persist: false }
  );
  assert('default weights: best = A', outDefault.best?.params_json.label === 'A');

  const outDDHeavy = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { label: ['A', 'B'] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner, persist: false, weights: { drawdown: 10 } }
  );
  assert('drawdown-heavy: best = B (drawdown 主导)', outDDHeavy.best?.params_json.label === 'B');
}

async function testInjectedRunnerSkipsRegistryCheck() {
  const optimizer = new GridSearchOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'this_strategy_definitely_does_not_exist',
      param_grid: { topN: [10, 20] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner: makeRankedRunner(), persist: false }
  );
  assert('injected-runner skips registry check', out.combos_run === 2 && out.failed_combos === 0);
}

async function testEmptyGrid() {
  const optimizer = new GridSearchOptimizer();
  let runnerCalls = 0;
  const runner: BacktestRunner = async () => {
    runnerCalls += 1;
    return { sharpe: 1.0, annual_return: 0.1, max_drawdown: 0.1 };
  };
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: {},
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner, persist: false }
  );
  assert('empty grid: 1 combo run', out.combos_run === 1);
  assert('empty grid: runner called exactly 1x', runnerCalls === 1);
  assert(
    'empty grid: 唯一行 params_json = {}',
    JSON.stringify(out.results[0].params_json) === '{}'
  );
}

async function testEmptyDimensionThrows() {
  const optimizer = new GridSearchOptimizer();
  let err: Error | null = null;
  try {
    await optimizer.optimize(
      {
        strategy_key: 'fake_strategy_for_test',
        param_grid: { topN: [] },
        base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
      },
      { runner: makeRankedRunner(), persist: false }
    );
  } catch (e) {
    err = e as Error;
  }
  assert('空维度 → 抛错', err !== null);
  assert('空维度错误消息含 "网格为空"', !!err?.message?.includes('网格为空'));
}

async function testConcurrencyExecutesAll() {
  const optimizer = new GridSearchOptimizer();
  let runnerCalls = 0;
  const runner: BacktestRunner = async () => {
    runnerCalls += 1;
    await new Promise(resolve => setImmediate(resolve));
    return { sharpe: 1.0, annual_return: 0.1, max_drawdown: 0.1 };
  };
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [1, 2, 3, 4, 5, 6, 7] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner, persist: false, concurrency: 3 }
  );
  assert('concurrency=3: 全部 7 个 combos 都跑', runnerCalls === 7 && out.combos_run === 7);
  // 验证结果顺序（按 combo_index ASC，不是按执行完成顺序）
  const indices = out.results.map(r => r.combo_index);
  expectEqual('concurrency: results 按 combo_index 顺序', indices, [0, 1, 2, 3, 4, 5, 6]);
}

async function testRunnerReceivesCorrectOptions() {
  const optimizer = new GridSearchOptimizer();
  const observed: Array<Record<string, any>> = [];
  const runner: BacktestRunner = async (combo, options) => {
    observed.push({
      combo_params: combo.params,
      combo_index: combo.index,
      params_by_strategy: options.params_by_strategy,
      strategy_keys: options.strategy_keys,
      start_date: options.start_date,
    });
    return { sharpe: 1.0, annual_return: 0.1, max_drawdown: 0.1 };
  };
  await optimizer.optimize(
    {
      strategy_key: 'multi_factor_alpha',
      param_grid: { topN: [20, 30] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner, persist: false }
  );
  assert('runner: 收到 2 次调用', observed.length === 2);
  assert(
    'runner: combo[0].params_by_strategy[strategy] = combo[0].params',
    JSON.stringify(observed[0].params_by_strategy['multi_factor_alpha']) ===
      JSON.stringify(observed[0].combo_params)
  );
  assert(
    'runner: combo[0].strategy_keys = [strategy]',
    JSON.stringify(observed[0].strategy_keys) === JSON.stringify(['multi_factor_alpha'])
  );
  assert('runner: base_config.start_date 透传', observed[0].start_date === '2025-01-01');
  assert(
    'runner: combo_index 正确',
    observed[0].combo_index === 0 && observed[1].combo_index === 1
  );
}

async function testDurationRecorded() {
  const optimizer = new GridSearchOptimizer();
  const slowRunner: BacktestRunner = async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return { sharpe: 1.0, annual_return: 0.1, max_drawdown: 0.1 };
  };
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [10] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner: slowRunner, persist: false }
  );
  const dur = Number(out.results[0].duration_seconds);
  assert('duration_seconds > 0', dur > 0, `got ${dur}`);
  assert('duration_seconds < 1s (reasonable)', dur < 1, `got ${dur}s`);
}

async function testNonInjectedRunnerRegistryFails() {
  const optimizer = new GridSearchOptimizer();
  let err: Error | null = null;
  try {
    await optimizer.optimize(
      {
        strategy_key: 'definitely_not_registered_xyz',
        param_grid: { topN: [10] },
        base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
      },
      { persist: false }
    );
  } catch (e) {
    err = e as Error;
  }
  assert('未注册 strategy + 无 runner → 抛错', err !== null);
  assert('错误消息含 "未在 StrategyRegistry"', !!err?.message?.includes('未在 StrategyRegistry'));
}

async function testInMemoryResultsHaveAllFields() {
  const optimizer = new GridSearchOptimizer();
  const runner: BacktestRunner = async () => ({
    sharpe: 1.5,
    annual_return: 0.2,
    max_drawdown: 0.1,
    total_return: 0.45,
    win_rate: 0.65,
    trade_count: 80,
  });
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [20] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner, persist: false }
  );
  const r = out.results[0];
  assert('in-memory: params_json 存在', !!r.params_json);
  assert('in-memory: sharpe = 1.5', Number(r.sharpe) === 1.5, `got ${r.sharpe}`);
  assert('in-memory: annual_return = 0.2', Number(r.annual_return) === 0.2);
  assert('in-memory: max_drawdown = 0.1', Number(r.max_drawdown) === 0.1);
  assert('in-memory: total_return = 0.45', Number(r.total_return) === 0.45);
  assert('in-memory: win_rate = 0.65', Number(r.win_rate) === 0.65);
  assert('in-memory: trade_count = 80', Number(r.trade_count) === 80);
  assert(
    'in-memory: composite_score 非 null',
    r.composite_score !== null && r.composite_score !== undefined
  );
}

async function testNegativeMaxDrawdownNormalized() {
  const optimizer = new GridSearchOptimizer();
  const runner: BacktestRunner = async () => ({
    sharpe: 1.0,
    annual_return: 0.1,
    max_drawdown: -0.25,
  });
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [10] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner, persist: false }
  );
  assert(
    'max_drawdown 存为正数 0.25',
    Math.abs(Number(out.results[0].max_drawdown) - 0.25) < 1e-9
  );
}

async function testRankedAndBestConsistent() {
  const optimizer = new GridSearchOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [10, 20, 30, 50] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner: makeRankedRunner(), persist: false }
  );
  assert('best == ranked[0]', out.best?.combo_index === out.ranked[0].combo_index);
  for (let i = 1; i < out.ranked.length; i++) {
    const prev = Number(out.ranked[i - 1].composite_score || -Infinity);
    const cur = Number(out.ranked[i].composite_score || -Infinity);
    assert(`ranked monotone non-increasing at ${i}`, prev >= cur, `${prev} → ${cur}`);
  }
}

async function testSingleComboFastPath() {
  const optimizer = new GridSearchOptimizer();
  const out = await optimizer.optimize(
    {
      strategy_key: 'fake_strategy_for_test',
      param_grid: { topN: [42] },
      base_config: { start_date: '2025-01-01', end_date: '2025-12-31' },
    },
    { runner: makeRankedRunner(), persist: false }
  );
  assert('single combo: combos_run = 1', out.combos_run === 1);
  assert('single combo: best non-null', out.best !== null);
  assert('single combo: best.params.topN = 42', out.best?.params_json.topN === 42);
}

// ============================================================
// 主入口（按顺序 await 所有测试以确保完成顺序确定）
// ============================================================

async function main() {
  runSyncTests();

  console.log('\n## GridSearchOptimizer.optimize 端到端');
  await testBasicHappyPath();
  await testFailureIsolation();
  await testAllFailures();
  await testMaxCombosLimit();
  await testCustomWeights();
  await testInjectedRunnerSkipsRegistryCheck();
  await testEmptyGrid();
  await testEmptyDimensionThrows();
  await testConcurrencyExecutesAll();
  await testRunnerReceivesCorrectOptions();
  await testDurationRecorded();
  await testNonInjectedRunnerRegistryFails();
  await testInMemoryResultsHaveAllFields();
  await testNegativeMaxDrawdownNormalized();
  await testRankedAndBestConsistent();
  await testSingleComboFastPath();

  console.log(`\n========================================`);
  console.log(`GridSearchOptimizer tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('UNCAUGHT TEST ERROR:', err);
  process.exit(2);
});
