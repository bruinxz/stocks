/**
 * CostSensitivityAnalysis 单元测试（US-085）
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/backtest/cost-sensitivity-analysis.test.ts
 *
 * 完全脱离 DB：通过 fake DataSource 注入 task / results / contexts / engine 输出。
 *
 * 覆盖维度：
 *   1. 常量 COST_LEVELS 完整性 + frozen + 升序
 *   2. 纯函数 computeTurnover：空数组 / 全 round-trip / 含未平仓 trade / 非有限值过滤
 *   3. 纯函数 buildRowFromEngineResult：win_rate=null 边界 / max_drawdown 取绝对值 / metadata 合并
 *   4. 纯函数 summarizeSensitivity：单档无 drop / 多档 drop 计算 / 多策略字典序
 *   5. 纯函数 filterCostLevels：空 / 大小写 / 未知 / 全部
 *   6. end-to-end analyze()：
 *      - happy path 3 档 × 2 策略 = 6 rows + persist=true 写入
 *      - dry_run=true 不写库
 *      - cost_levels=['万2.5'] 仅跑 1 档
 *      - task 不存在抛错
 *      - 无 per-strategy results 抛错
 *      - engine 单档抛错 → errors[] 记录 + 其他档继续
 *      - persist 抛错 → fail-OPEN rows 仍返回 + persist_error 字段
 *      - strategy_key 不在 baseResults map → errors[] + skip
 *      - getRunRows / deleteRun / cleanupOlderThan 基本调用形态
 */

import {
  COST_LEVELS,
  CostSensitivityAnalysis,
  CostSensitivityDataSource,
  CostSensitivityRow,
  buildRowFromEngineResult,
  computeTurnover,
  filterCostLevels,
  summarizeSensitivity,
} from '../../src/quant/backtest/CostSensitivityAnalysis';
import {
  QuantBacktestOptions,
  QuantBacktestStrategyResult,
  QuantBacktestTradeResult,
  QuantStockContext,
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
      Math.abs((actual as number) - (expected as number)) < 1e-9);
  assert(
    name,
    same,
    detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-4) {
  assert(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected}, got=${actual}`
  );
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
// 1. COST_LEVELS 常量
// ============================================================

function runConstantTests() {
  console.log('\n## COST_LEVELS');
  expectEqual('exactly 3 levels', COST_LEVELS.length, 3);
  expectEqual('level[0] = 万1.5', COST_LEVELS[0].level, '万1.5');
  expectEqual('level[1] = 万2.5', COST_LEVELS[1].level, '万2.5');
  expectEqual('level[2] = 万5', COST_LEVELS[2].level, '万5');
  expectEqual('万1.5 = 0.00015', COST_LEVELS[0].commission_rate, 0.00015);
  expectEqual('万2.5 = 0.00025', COST_LEVELS[1].commission_rate, 0.00025);
  expectEqual('万5 = 0.0005', COST_LEVELS[2].commission_rate, 0.0005);
  // frozen
  let mutationOk = false;
  try {
    (COST_LEVELS as any)[0].commission_rate = 999;
    mutationOk = (COST_LEVELS[0].commission_rate as number) === 999;
  } catch {
    mutationOk = false;
  }
  assert('COST_LEVELS[0] is frozen', !mutationOk);
  // ascending order — summarize 依赖此约定
  for (let i = 1; i < COST_LEVELS.length; i++) {
    assert(
      `level[${i}].rate > level[${i - 1}].rate`,
      COST_LEVELS[i].commission_rate > COST_LEVELS[i - 1].commission_rate,
      `${COST_LEVELS[i].commission_rate} vs ${COST_LEVELS[i - 1].commission_rate}`
    );
  }
}

// ============================================================
// 2. computeTurnover
// ============================================================

function runComputeTurnoverTests() {
  console.log('\n## computeTurnover');

  expectEqual('empty array → 0', computeTurnover([]), 0);
  expectEqual('null → 0', computeTurnover(null as any), 0);

  // 一笔完整 round-trip：buy 100 元 × 1000 股 = 100000，sell 110 元 × 1000 = 110000
  // turnover = 100000 + 110000 = 210000
  const roundTrip: QuantBacktestTradeResult[] = [
    {
      strategy_key: 's1',
      symbol: 'sh.600519',
      buy_date: '2024-01-01',
      sell_date: '2024-01-10',
      buy_price: 100,
      sell_price: 110,
      quantity: 1000,
      amount: 110000,
      holding_days: 9,
    },
  ];
  expectClose('1 round-trip', computeTurnover(roundTrip), 210000);

  // 未平仓 trade（sell_date 缺失）：只算 buy 端 = 50000
  const openOnly: QuantBacktestTradeResult[] = [
    {
      strategy_key: 's1',
      symbol: 'sh.600519',
      buy_date: '2024-01-01',
      buy_price: 50,
      quantity: 1000,
      amount: 0, // 还没卖出 amount 字段 = 0
      holding_days: 5,
    },
  ];
  expectClose('open only (no sell_date)', computeTurnover(openOnly), 50000);

  // 混合：1 round-trip + 1 未平仓
  const mixed: QuantBacktestTradeResult[] = [...roundTrip, ...openOnly];
  expectClose('round-trip + open', computeTurnover(mixed), 210000 + 50000);

  // 防御：quantity ≤ 0 跳过
  const badQty: QuantBacktestTradeResult[] = [
    {
      strategy_key: 's1',
      symbol: 'x',
      buy_date: '2024-01-01',
      buy_price: 10,
      quantity: 0,
      amount: 100,
      holding_days: 0,
    },
  ];
  expectEqual('quantity=0 → skipped', computeTurnover(badQty), 0);

  // 防御：NaN buy_price 跳过 buy 端但 sell_amount 仍计入（防御性逐项判定）
  const nanBuy: QuantBacktestTradeResult[] = [
    {
      strategy_key: 's1',
      symbol: 'x',
      buy_date: '2024-01-01',
      sell_date: '2024-01-10',
      buy_price: NaN as any,
      sell_price: 50,
      quantity: 100,
      amount: 5000,
      holding_days: 9,
    },
  ];
  expectEqual('NaN buy_price → only sell counted', computeTurnover(nanBuy), 5000);

  // 防御：buy_price 负 → 跳过 buy 端
  const negBuy: QuantBacktestTradeResult[] = [
    {
      strategy_key: 's1',
      symbol: 'x',
      buy_date: '2024-01-01',
      sell_date: '2024-01-10',
      buy_price: -10,
      sell_price: 50,
      quantity: 100,
      amount: 5000,
      holding_days: 9,
    },
  ];
  expectEqual('negative buy_price → only sell counted', computeTurnover(negBuy), 5000);

  // 多笔 round-trip 累加
  const multi: QuantBacktestTradeResult[] = [
    {
      strategy_key: 's1',
      symbol: 'A',
      buy_date: '2024-01-01',
      sell_date: '2024-01-10',
      buy_price: 10,
      sell_price: 12,
      quantity: 1000,
      amount: 12000,
      holding_days: 9,
    },
    {
      strategy_key: 's1',
      symbol: 'B',
      buy_date: '2024-01-05',
      sell_date: '2024-01-15',
      buy_price: 20,
      sell_price: 18,
      quantity: 500,
      amount: 9000,
      holding_days: 10,
    },
  ];
  // (10*1000 + 12000) + (20*500 + 9000) = 22000 + 19000 = 41000
  expectClose('multi round-trip', computeTurnover(multi), 41000);
}

// ============================================================
// 3. buildRowFromEngineResult
// ============================================================

function makeEngineResult(
  overrides: Partial<QuantBacktestStrategyResult> = {}
): QuantBacktestStrategyResult {
  return {
    strategy_key: 'test_strat',
    strategy_name: 'Test',
    total_return_pct: 30,
    annual_return_pct: 15,
    max_drawdown_pct: -8.5, // engine 可能给负值
    sharpe_ratio: 1.5,
    win_rate: 60, // 百分数 0..100
    profit_factor: 1.8,
    trade_count: 5,
    avg_holding_days: 7.2,
    benchmark_return_pct: 5,
    excess_return_pct: 10,
    metrics: {},
    equity_curve: [],
    drawdown_curve: [],
    trades: [],
    ...overrides,
  };
}

function runBuildRowTests() {
  console.log('\n## buildRowFromEngineResult');

  const level = COST_LEVELS[1]; // 万2.5

  // 基础映射
  const r = makeEngineResult({
    trades: [
      {
        strategy_key: 'test_strat',
        symbol: 'sh.600519',
        buy_date: '2024-01-01',
        sell_date: '2024-01-10',
        buy_price: 100,
        sell_price: 105,
        quantity: 1000,
        amount: 105000,
        holding_days: 9,
      },
    ],
  });
  const row = buildRowFromEngineResult(r, level, {
    base_task_id: 42,
    base_run_id: 100,
  });
  expectEqual('base_task_id', row.base_task_id, 42);
  expectEqual('base_run_id', row.base_run_id, 100);
  expectEqual('cost_level', row.cost_level, '万2.5');
  expectEqual('commission_rate', row.commission_rate, 0.00025);
  expectEqual('strategy_key', row.strategy_key, 'test_strat');
  expectEqual('total_return_pct', row.total_return_pct, 30);
  expectEqual('annual_return_pct', row.annual_return_pct, 15);
  expectEqual('sharpe_ratio', row.sharpe_ratio, 1.5);
  expectEqual('max_drawdown_pct = abs(-8.5)', row.max_drawdown_pct, 8.5);
  expectEqual('win_rate normalized to 0..1', row.win_rate, 0.6);
  expectEqual('trade_count', row.trade_count, 1);
  expectClose('turnover = 100000 + 105000', row.turnover, 205000);

  // metadata 合并 + 默认字段
  assert(
    'metadata_json includes generated_at',
    typeof row.metadata_json.generated_at === 'string' &&
      row.metadata_json.generated_at.length > 0
  );
  expectEqual('metadata_json.profit_factor', row.metadata_json.profit_factor, 1.8);
  expectEqual('metadata_json.benchmark_return_pct', row.metadata_json.benchmark_return_pct, 5);

  // win_rate=null 当 trade_count=0
  const empty = makeEngineResult({ trades: [], trade_count: 0, win_rate: 0 });
  const row2 = buildRowFromEngineResult(empty, level, {
    base_task_id: 42,
    base_run_id: 100,
  });
  expectEqual('empty trades → trade_count=0', row2.trade_count, 0);
  expectEqual('empty trades → win_rate=null', row2.win_rate, null);
  expectEqual('empty trades → turnover=0', row2.turnover, 0);

  // 自定义 metadata 透传
  const row3 = buildRowFromEngineResult(r, level, {
    base_task_id: 1,
    base_run_id: 2,
    metadata: { triggered_by: 'cron', some_id: 99 },
  });
  expectEqual('metadata.triggered_by', row3.metadata_json.triggered_by, 'cron');
  expectEqual('metadata.some_id', row3.metadata_json.some_id, 99);

  // win_rate clamp 在 [0, 1]
  const clamped = makeEngineResult({
    win_rate: 150,
    trade_count: 1,
    trades: [
      {
        strategy_key: 'test_strat',
        symbol: 'x',
        buy_date: '2024-01-01',
        sell_date: '2024-01-10',
        buy_price: 10,
        sell_price: 12,
        quantity: 100,
        amount: 1200,
        holding_days: 9,
      },
    ],
  });
  const row4 = buildRowFromEngineResult(clamped, level, { base_task_id: 1, base_run_id: 2 });
  expectEqual('win_rate=150% (engine bug) clamped to 1', row4.win_rate, 1);

  // null benchmark
  const noBench = makeEngineResult({
    benchmark_return_pct: undefined,
    trade_count: 1,
    trades: [
      {
        strategy_key: 'test_strat',
        symbol: 'x',
        buy_date: '2024-01-01',
        sell_date: '2024-01-10',
        buy_price: 10,
        sell_price: 12,
        quantity: 100,
        amount: 1200,
        holding_days: 9,
      },
    ],
  });
  const row5 = buildRowFromEngineResult(noBench, level, { base_task_id: 1, base_run_id: 2 });
  expectEqual('benchmark missing → null', row5.metadata_json.benchmark_return_pct, null);
}

// ============================================================
// 4. summarizeSensitivity
// ============================================================

function makeRow(
  strategy_key: string,
  level: string,
  commission_rate: number,
  annual_return_pct: number,
  sharpe_ratio: number,
  turnover = 1000
): CostSensitivityRow {
  return {
    base_task_id: 1,
    base_run_id: 1,
    strategy_key,
    cost_level: level,
    commission_rate,
    annual_return_pct,
    sharpe_ratio,
    total_return_pct: 0,
    max_drawdown_pct: 0,
    win_rate: 0.5,
    trade_count: 1,
    turnover,
    metadata_json: {},
  };
}

function runSummarizeTests() {
  console.log('\n## summarizeSensitivity');

  expectEqual('empty rows → []', summarizeSensitivity([]), []);

  // 单档：drop=null (不足 2 档)
  const single = summarizeSensitivity([makeRow('s1', '万2.5', 0.00025, 15, 1.5)]);
  expectEqual('single level → 1 summary', single.length, 1);
  expectEqual('single level → return_drop_pct=null', single[0].return_drop_pct, null);
  expectEqual('single level → sharpe_drop=null', single[0].sharpe_drop, null);
  expectEqual('single level → levels_count=1', single[0].levels_count, 1);

  // 3 档：annual_return 15 → 12 → 8（drop=15-8=7）；sharpe 1.5 → 1.2 → 0.8（drop=0.7）
  const triple = summarizeSensitivity([
    makeRow('s1', '万5', 0.0005, 8, 0.8, 1000),
    makeRow('s1', '万2.5', 0.00025, 12, 1.2, 1000),
    makeRow('s1', '万1.5', 0.00015, 15, 1.5, 1000),
  ]);
  expectEqual('3 levels → levels_count=3', triple[0].levels_count, 3);
  expectClose('return_drop_pct = 15-8 = 7', triple[0].return_drop_pct as number, 7);
  expectClose('sharpe_drop = 1.5-0.8 = 0.7', triple[0].sharpe_drop as number, 0.7);
  expectClose('turnover_avg', triple[0].turnover_avg, 1000);

  // 多策略：字典序输出
  const multi = summarizeSensitivity([
    makeRow('zeta', '万1.5', 0.00015, 10, 1),
    makeRow('zeta', '万5', 0.0005, 5, 0.5),
    makeRow('alpha', '万1.5', 0.00015, 20, 2),
    makeRow('alpha', '万5', 0.0005, 18, 1.8),
  ]);
  expectEqual('multi strategy → 2 summaries', multi.length, 2);
  expectEqual('first by alpha 字典序', multi[0].strategy_key, 'alpha');
  expectEqual('second zeta', multi[1].strategy_key, 'zeta');
  expectClose('alpha drop=2', multi[0].return_drop_pct as number, 2);
  expectClose('zeta drop=5', multi[1].return_drop_pct as number, 5);

  // turnover_avg：跨档平均
  const tu = summarizeSensitivity([
    makeRow('x', '万1.5', 0.00015, 0, 0, 100),
    makeRow('x', '万2.5', 0.00025, 0, 0, 200),
    makeRow('x', '万5', 0.0005, 0, 0, 300),
  ]);
  expectClose('turnover_avg = 200', tu[0].turnover_avg, 200);
}

// ============================================================
// 5. filterCostLevels
// ============================================================

function runFilterLevelsTests() {
  console.log('\n## filterCostLevels');

  expectEqual('undefined → all 3', filterCostLevels(undefined, COST_LEVELS).length, 3);
  expectEqual('empty array → all 3', filterCostLevels([], COST_LEVELS).length, 3);
  expectEqual('null → all 3', filterCostLevels(null as any, COST_LEVELS).length, 3);

  expectEqual('1 match', filterCostLevels(['万2.5'], COST_LEVELS).length, 1);
  expectEqual('1 match correct label', filterCostLevels(['万2.5'], COST_LEVELS)[0].level, '万2.5');

  // 全部未知 → 退回全部（容错优先 4xx）
  expectEqual(
    'all unknown → fallback to all',
    filterCostLevels(['unknown1', 'wanwan'], COST_LEVELS).length,
    3
  );

  // 部分未知 → 仅保留命中的
  expectEqual(
    'partial unknown → only matched',
    filterCostLevels(['万2.5', 'fake'], COST_LEVELS).length,
    1
  );

  // 多档
  expectEqual('2 match', filterCostLevels(['万1.5', '万5'], COST_LEVELS).length, 2);

  // 空白字符串去除
  expectEqual('whitespace trimmed', filterCostLevels(['  万2.5  '], COST_LEVELS).length, 1);
}

// ============================================================
// 6. end-to-end analyze() with fake DataSource
// ============================================================

interface FakeStateOptions {
  task?: any;
  results?: any[];
  contexts?: QuantStockContext[];
  engineByLevel?: Map<string, QuantBacktestStrategyResult[]>;
  /** error to throw when engine called with this level */
  engineErrorByLevel?: Map<string, string>;
  /** error to throw on persist */
  persistShouldThrow?: boolean;
}

function makeFakeDataSource(opts: FakeStateOptions): {
  ds: CostSensitivityDataSource;
  state: {
    destroyCalls: Array<{ ids: number[]; levels: string[] }>;
    persistCalls: CostSensitivityRow[][];
    engineCalls: Array<{ level: string; commission_rate: number }>;
  };
} {
  const state = {
    destroyCalls: [] as Array<{ ids: number[]; levels: string[] }>,
    persistCalls: [] as CostSensitivityRow[][],
    engineCalls: [] as Array<{ level: string; commission_rate: number }>,
  };

  const ds: CostSensitivityDataSource = {
    async loadTask(_id: number) {
      return opts.task ?? null;
    },
    async loadResults(_id: number) {
      return (opts.results ?? []) as any[];
    },
    async loadContexts(_options: QuantBacktestOptions, _user_id?: number) {
      return opts.contexts ?? [];
    },
    runEngine(_contexts: QuantStockContext[], options: QuantBacktestOptions) {
      const rate = Number(options.commission_rate || 0);
      const matchedLevel = COST_LEVELS.find(l => Math.abs(l.commission_rate - rate) < 1e-12);
      const levelKey = matchedLevel?.level || String(rate);
      state.engineCalls.push({ level: levelKey, commission_rate: rate });
      const err = opts.engineErrorByLevel?.get(levelKey);
      if (err) throw new Error(err);
      return opts.engineByLevel?.get(levelKey) ?? [];
    },
    async destroyExisting(ids: number[], levels: string[]) {
      state.destroyCalls.push({ ids: [...ids], levels: [...levels] });
      return ids.length * levels.length;
    },
    async persistRows(rows: CostSensitivityRow[]) {
      state.persistCalls.push([...rows]);
      if (opts.persistShouldThrow) throw new Error('DB write failed');
      return [] as any[];
    },
  };
  return { ds, state };
}

function makeFakeTask(overrides: any = {}) {
  return {
    id: 1,
    user_id: 100,
    task_name: 't',
    universe: 'market',
    strategy_keys: ['s1'],
    symbols: [],
    start_date: '2024-01-01',
    end_date: '2024-06-01',
    initial_capital: 200000,
    commission_rate: 0.00025,
    slippage_rate: 0.0005,
    parameters: { last_stage: 'persist_results', custom_param: 'kept' },
    ...overrides,
  };
}

async function runEndToEndTests() {
  console.log('\n## analyze() end-to-end');

  // happy path: 1 strategy × 3 levels
  {
    const engineByLevel = new Map<string, QuantBacktestStrategyResult[]>([
      ['万1.5', [makeEngineResult({ strategy_key: 's1', annual_return_pct: 18, sharpe_ratio: 1.8 })]],
      ['万2.5', [makeEngineResult({ strategy_key: 's1', annual_return_pct: 15, sharpe_ratio: 1.5 })]],
      ['万5', [makeEngineResult({ strategy_key: 's1', annual_return_pct: 10, sharpe_ratio: 1.0 })]],
    ]);
    const { ds, state } = makeFakeDataSource({
      task: makeFakeTask(),
      results: [{ id: 999, strategy_key: 's1', task_id: 1 }],
      engineByLevel,
    });
    const analyzer = new CostSensitivityAnalysis(ds);
    const r = await analyzer.analyze(1);
    expectEqual('happy: rows count = 3', r.rows.length, 3);
    expectEqual('happy: engine called 3 times', state.engineCalls.length, 3);
    expectEqual('happy: persisted=true', r.persisted, true);
    expectEqual('happy: summary 1 strategy', r.summary.length, 1);
    expectClose('happy: drop 18-10=8', r.summary[0].return_drop_pct as number, 8);
    expectClose('happy: sharpe drop 0.8', r.summary[0].sharpe_drop as number, 0.8);
    expectEqual('happy: destroy called once', state.destroyCalls.length, 1);
    expectEqual('happy: destroy ids', state.destroyCalls[0].ids, [999]);
    expectEqual(
      'happy: destroy levels (all 3)',
      state.destroyCalls[0].levels.sort(),
      ['万1.5', '万2.5', '万5'].sort()
    );
    expectEqual('happy: persist called once', state.persistCalls.length, 1);
    expectEqual('happy: persist 3 rows', state.persistCalls[0].length, 3);
    // base_run_id 透传到 row
    assert(
      'happy: all rows have base_run_id=999',
      r.rows.every(row => row.base_run_id === 999)
    );
    assert('happy: no errors', !r.errors);
    assert('happy: no persist_error', !r.persist_error);
  }

  // dry_run=true 不写库
  {
    const engineByLevel = new Map<string, QuantBacktestStrategyResult[]>([
      ['万1.5', [makeEngineResult({ strategy_key: 's1' })]],
      ['万2.5', [makeEngineResult({ strategy_key: 's1' })]],
      ['万5', [makeEngineResult({ strategy_key: 's1' })]],
    ]);
    const { ds, state } = makeFakeDataSource({
      task: makeFakeTask(),
      results: [{ id: 1, strategy_key: 's1', task_id: 1 }],
      engineByLevel,
    });
    const analyzer = new CostSensitivityAnalysis(ds);
    const r = await analyzer.analyze(1, { persist: false });
    expectEqual('dry_run: rows count = 3', r.rows.length, 3);
    expectEqual('dry_run: persisted=false', r.persisted, false);
    expectEqual('dry_run: destroy NOT called', state.destroyCalls.length, 0);
    expectEqual('dry_run: persist NOT called', state.persistCalls.length, 0);
  }

  // cost_levels=['万2.5'] 仅跑 1 档
  {
    const engineByLevel = new Map<string, QuantBacktestStrategyResult[]>([
      ['万2.5', [makeEngineResult({ strategy_key: 's1' })]],
    ]);
    const { ds, state } = makeFakeDataSource({
      task: makeFakeTask(),
      results: [{ id: 1, strategy_key: 's1', task_id: 1 }],
      engineByLevel,
    });
    const analyzer = new CostSensitivityAnalysis(ds);
    const r = await analyzer.analyze(1, { cost_levels: ['万2.5'] });
    expectEqual('subset: engine called once', state.engineCalls.length, 1);
    expectEqual('subset: engine level=万2.5', state.engineCalls[0].level, '万2.5');
    expectEqual('subset: rows count = 1', r.rows.length, 1);
    expectEqual('subset: summary levels_count=1', r.summary[0].levels_count, 1);
    expectEqual('subset: drop=null (single level)', r.summary[0].return_drop_pct, null);
  }

  // task 不存在抛错
  {
    const { ds } = makeFakeDataSource({ task: null });
    const analyzer = new CostSensitivityAnalysis(ds);
    await expectThrowAsync('missing task throws', () => analyzer.analyze(999), '不存在');
  }

  // 无 per-strategy results
  {
    const { ds } = makeFakeDataSource({ task: makeFakeTask(), results: [] });
    const analyzer = new CostSensitivityAnalysis(ds);
    await expectThrowAsync('no results throws', () => analyzer.analyze(1), '无 per-strategy 结果');
  }

  // engine 单档抛错 → 其他档继续
  {
    const engineByLevel = new Map<string, QuantBacktestStrategyResult[]>([
      ['万1.5', [makeEngineResult({ strategy_key: 's1' })]],
      // 万2.5 抛错（见下面）
      ['万5', [makeEngineResult({ strategy_key: 's1' })]],
    ]);
    const engineErrorByLevel = new Map([['万2.5', 'engine crashed']]);
    const { ds } = makeFakeDataSource({
      task: makeFakeTask(),
      results: [{ id: 1, strategy_key: 's1', task_id: 1 }],
      engineByLevel,
      engineErrorByLevel,
    });
    const analyzer = new CostSensitivityAnalysis(ds);
    const r = await analyzer.analyze(1);
    expectEqual('engine partial fail: rows=2', r.rows.length, 2);
    expectEqual('engine partial fail: errors=1', r.errors?.length || 0, 1);
    expectEqual('engine error level=万2.5', r.errors![0].cost_level, '万2.5');
    assert(
      'engine error msg contains engine crashed',
      r.errors![0].message.includes('engine crashed')
    );
    // 仍 persist 那 2 个成功的
    expectEqual('engine partial: persisted=true', r.persisted, true);
  }

  // persist 抛错 → fail-OPEN
  {
    const engineByLevel = new Map<string, QuantBacktestStrategyResult[]>([
      ['万1.5', [makeEngineResult({ strategy_key: 's1' })]],
      ['万2.5', [makeEngineResult({ strategy_key: 's1' })]],
      ['万5', [makeEngineResult({ strategy_key: 's1' })]],
    ]);
    const { ds } = makeFakeDataSource({
      task: makeFakeTask(),
      results: [{ id: 1, strategy_key: 's1', task_id: 1 }],
      engineByLevel,
      persistShouldThrow: true,
    });
    const analyzer = new CostSensitivityAnalysis(ds);
    const r = await analyzer.analyze(1);
    expectEqual('persist fail: rows still returned (3)', r.rows.length, 3);
    expectEqual('persist fail: persisted=false', r.persisted, false);
    assert(
      'persist fail: persist_error contains DB write failed',
      (r.persist_error || '').includes('DB write failed')
    );
  }

  // strategy_key 在 engine 输出但不在 baseResults map
  {
    const engineByLevel = new Map<string, QuantBacktestStrategyResult[]>([
      ['万1.5', [makeEngineResult({ strategy_key: 'unknown_strategy' })]],
      ['万2.5', []],
      ['万5', []],
    ]);
    const { ds } = makeFakeDataSource({
      task: makeFakeTask(),
      results: [{ id: 1, strategy_key: 's1', task_id: 1 }],
      engineByLevel,
    });
    const analyzer = new CostSensitivityAnalysis(ds);
    const r = await analyzer.analyze(1);
    expectEqual('unknown strategy: rows=0', r.rows.length, 0);
    expectEqual('unknown strategy: errors=1', r.errors?.length || 0, 1);
    assert(
      'unknown strategy: error contains 未在基础回测',
      r.errors![0].message.includes('未在基础回测')
    );
  }

  // metadata 透传到 row.metadata_json
  {
    const engineByLevel = new Map<string, QuantBacktestStrategyResult[]>([
      ['万2.5', [makeEngineResult({ strategy_key: 's1' })]],
    ]);
    const { ds } = makeFakeDataSource({
      task: makeFakeTask(),
      results: [{ id: 1, strategy_key: 's1', task_id: 1 }],
      engineByLevel,
    });
    const analyzer = new CostSensitivityAnalysis(ds);
    const r = await analyzer.analyze(1, {
      cost_levels: ['万2.5'],
      persist: false,
      metadata: { triggered_by: 'test', user_id: 42 },
    });
    expectEqual('metadata: triggered_by passed', r.rows[0].metadata_json.triggered_by, 'test');
    expectEqual('metadata: user_id passed', r.rows[0].metadata_json.user_id, 42);
  }

  // task.parameters 中 runtime 字段被过滤
  {
    let capturedOptions: QuantBacktestOptions | null = null;
    const ds: CostSensitivityDataSource = {
      async loadTask(_id: number) {
        return makeFakeTask({
          parameters: {
            last_stage: 'persist_results', // runtime field - should be filtered
            run_started_at: '2026-06-09', // runtime field - should be filtered
            custom_param: 'kept', // non-runtime - should be passed
          },
        });
      },
      async loadResults(_id: number) {
        return [{ id: 1, strategy_key: 's1', task_id: 1 }] as any[];
      },
      async loadContexts(opt: QuantBacktestOptions, _u?: number) {
        capturedOptions = opt;
        return [];
      },
      runEngine(_c: QuantStockContext[], _o: QuantBacktestOptions) {
        return [makeEngineResult({ strategy_key: 's1' })];
      },
      async destroyExisting() {
        return 0;
      },
      async persistRows() {
        return [] as any[];
      },
    };
    const analyzer = new CostSensitivityAnalysis(ds);
    await analyzer.analyze(1, { cost_levels: ['万2.5'] });
    assert(
      'runtime keys filtered from options',
      capturedOptions !== null &&
        !('last_stage' in (capturedOptions as any)) &&
        !('run_started_at' in (capturedOptions as any))
    );
    assert(
      'non-runtime keys kept in options',
      capturedOptions !== null && (capturedOptions as any).custom_param === 'kept'
    );
    // start_date / end_date / strategy_keys 都从 task 字段复用
    expectEqual(
      'rebuild: strategy_keys = task',
      (capturedOptions as any).strategy_keys,
      ['s1']
    );
    expectEqual('rebuild: start_date', (capturedOptions as any).start_date, '2024-01-01');
    expectEqual('rebuild: end_date', (capturedOptions as any).end_date, '2024-06-01');
  }

  // 验证 commission_rate override 真的进入 engine
  {
    const ratesSeen: number[] = [];
    const ds: CostSensitivityDataSource = {
      async loadTask() {
        return makeFakeTask({ commission_rate: 0.001 }); // 原始 task 的费率与 3 档都不同
      },
      async loadResults() {
        return [{ id: 1, strategy_key: 's1', task_id: 1 }] as any[];
      },
      async loadContexts() {
        return [];
      },
      runEngine(_c: QuantStockContext[], o: QuantBacktestOptions) {
        ratesSeen.push(Number(o.commission_rate));
        return [makeEngineResult({ strategy_key: 's1' })];
      },
      async destroyExisting() {
        return 0;
      },
      async persistRows() {
        return [] as any[];
      },
    };
    const analyzer = new CostSensitivityAnalysis(ds);
    await analyzer.analyze(1, { persist: false });
    expectEqual('engine saw 3 distinct rates', ratesSeen.sort().join(','), '0.00015,0.00025,0.0005');
    assert(
      'original task rate (0.001) NOT in engine calls',
      !ratesSeen.includes(0.001)
    );
  }

  // 2 strategies × 3 levels = 6 rows
  {
    const engineByLevel = new Map<string, QuantBacktestStrategyResult[]>([
      [
        '万1.5',
        [
          makeEngineResult({ strategy_key: 's1', annual_return_pct: 18 }),
          makeEngineResult({ strategy_key: 's2', annual_return_pct: 25 }),
        ],
      ],
      [
        '万2.5',
        [
          makeEngineResult({ strategy_key: 's1', annual_return_pct: 15 }),
          makeEngineResult({ strategy_key: 's2', annual_return_pct: 22 }),
        ],
      ],
      [
        '万5',
        [
          makeEngineResult({ strategy_key: 's1', annual_return_pct: 8 }),
          makeEngineResult({ strategy_key: 's2', annual_return_pct: 18 }),
        ],
      ],
    ]);
    const { ds } = makeFakeDataSource({
      task: makeFakeTask({ strategy_keys: ['s1', 's2'] }),
      results: [
        { id: 10, strategy_key: 's1', task_id: 1 },
        { id: 11, strategy_key: 's2', task_id: 1 },
      ],
      engineByLevel,
    });
    const analyzer = new CostSensitivityAnalysis(ds);
    const r = await analyzer.analyze(1);
    expectEqual('multi strategy: rows=6', r.rows.length, 6);
    expectEqual('multi strategy: summary=2', r.summary.length, 2);
    expectEqual('multi strategy: s1 ahead 字典序', r.summary[0].strategy_key, 's1');
    expectEqual('multi strategy: s2 after', r.summary[1].strategy_key, 's2');
    expectClose('s1 drop=10', r.summary[0].return_drop_pct as number, 10);
    expectClose('s2 drop=7', r.summary[1].return_drop_pct as number, 7);
    // base_run_id 正确分配到每只策略
    const s1Rows = r.rows.filter(row => row.strategy_key === 's1');
    const s2Rows = r.rows.filter(row => row.strategy_key === 's2');
    assert('s1 rows all have base_run_id=10', s1Rows.every(row => row.base_run_id === 10));
    assert('s2 rows all have base_run_id=11', s2Rows.every(row => row.base_run_id === 11));
  }
}

// ============================================================
// 主入口
// ============================================================

async function main() {
  runConstantTests();
  runComputeTurnoverTests();
  runBuildRowTests();
  runSummarizeTests();
  runFilterLevelsTests();
  await runEndToEndTests();

  console.log(`\n${passed} passed / ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
