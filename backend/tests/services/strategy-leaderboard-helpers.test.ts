/**
 * strategy-leaderboard-helpers.test.ts — US-054 [FE-015] LabWorkspace 超额列
 *
 * 覆盖 5 个纯函数 (不涉及 DB):
 *   - toFiniteNumber: null/undefined/NaN/string/number 全分支
 *   - dedupLatestByStrategyKey: 同 key 保留首条
 *   - filterByFinitePrimarySort: NaN/null 主排序字段过滤
 *   - sortLeaderboardItems: DESC + 稳定
 *   - enrichWithBenchmarkAttributions: JOIN + DISPLAY_ORDER + extras 排序 + 缺 run_id
 *   - buildStrategyLeaderboardItems: 主入口端到端
 *
 * + META-GUARD: QuantController.getStrategyLeaderboard 必须 import 并调用 helper,
 *   反向断 controller 不再 inline 写 dedup/sort 逻辑 (与 portfolio-construction-adapter 同款)。
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  toFiniteNumber,
  dedupLatestByStrategyKey,
  filterByFinitePrimarySort,
  sortLeaderboardItems,
  enrichWithBenchmarkAttributions,
  buildStrategyLeaderboardItems,
  SORT_BY_FIELD_MAP,
  BENCHMARK_DISPLAY_ORDER,
  BENCHMARK_NAME_MAP,
  type BacktestRow,
  type BenchmarkAttributionRow,
} from '../../src/api/controllers/internal/StrategyLeaderboardHelpers';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

// ============================================================
// [1] 常量 / 冻结
// ============================================================
function testConstants() {
  console.log('\n## [1] SORT_BY_FIELD_MAP / BENCHMARK_DISPLAY_ORDER / BENCHMARK_NAME_MAP 冻结');
  assert('SORT_BY_FIELD_MAP frozen', Object.isFrozen(SORT_BY_FIELD_MAP));
  assert('SORT_BY_FIELD_MAP.sharpe = sharpe_ratio', SORT_BY_FIELD_MAP.sharpe === 'sharpe_ratio');
  assert('SORT_BY_FIELD_MAP.annual = annual_return_pct', SORT_BY_FIELD_MAP.annual === 'annual_return_pct');
  assert('SORT_BY_FIELD_MAP.total = total_return_pct', SORT_BY_FIELD_MAP.total === 'total_return_pct');

  assert('BENCHMARK_DISPLAY_ORDER frozen', Object.isFrozen(BENCHMARK_DISPLAY_ORDER));
  assert(
    'BENCHMARK_DISPLAY_ORDER 顺序 HS300 → ZZ500 → CSI1000',
    BENCHMARK_DISPLAY_ORDER[0] === 'sh.000300' &&
      BENCHMARK_DISPLAY_ORDER[1] === 'sh.000905' &&
      BENCHMARK_DISPLAY_ORDER[2] === 'sh.000852'
  );

  assert('BENCHMARK_NAME_MAP frozen', Object.isFrozen(BENCHMARK_NAME_MAP));
  assert('BENCHMARK_NAME_MAP HS300 = 沪深300', BENCHMARK_NAME_MAP['sh.000300'] === '沪深300');
  assert('BENCHMARK_NAME_MAP ZZ500 = 中证500', BENCHMARK_NAME_MAP['sh.000905'] === '中证500');
  assert('BENCHMARK_NAME_MAP CSI1000 = 中证1000', BENCHMARK_NAME_MAP['sh.000852'] === '中证1000');
}

// ============================================================
// [2] toFiniteNumber
// ============================================================
function testToFiniteNumber() {
  console.log('\n## [2] toFiniteNumber');
  assert('number 直通', toFiniteNumber(1.23) === 1.23);
  assert('0 不被吞', toFiniteNumber(0) === 0);
  assert('负数', toFiniteNumber(-5) === -5);
  assert('string number 解析', toFiniteNumber('3.14') === 3.14);
  // Number("") === 0 是 JS spec — toFiniteNumber 不特判, 空串 → 0 (finite)
  assert('string 空 → 0 (Number("")=0)', toFiniteNumber('') === 0);
  assert('null → null', toFiniteNumber(null) === null);
  assert('undefined → null', toFiniteNumber(undefined) === null);
  assert('NaN → null', toFiniteNumber(NaN) === null);
  assert('Infinity → null', toFiniteNumber(Infinity) === null);
  assert('非数字 string → null', toFiniteNumber('abc') === null);
}

// ============================================================
// [3] dedupLatestByStrategyKey
// ============================================================
function makeRow(overrides: Partial<BacktestRow>): BacktestRow {
  return {
    strategy_key: overrides.strategy_key || 'foo',
    task_id: overrides.task_id ?? 1,
    total_return_pct: overrides.total_return_pct ?? 10,
    annual_return_pct: overrides.annual_return_pct ?? 15,
    max_drawdown_pct: overrides.max_drawdown_pct ?? -8,
    sharpe_ratio: overrides.sharpe_ratio ?? 1.2,
    win_rate: overrides.win_rate ?? 0.55,
    trade_count: overrides.trade_count ?? 100,
    created_at: overrides.created_at ?? '2026-06-19T00:00:00Z',
    ...overrides,
  };
}

function testDedup() {
  console.log('\n## [3] dedupLatestByStrategyKey');

  // 空数组
  assert('空数组 → 空', dedupLatestByStrategyKey([]).length === 0);

  // 同 key 保留首条 (rows 已按 created_at DESC, 首条 = 最新)
  const rows = [
    makeRow({ strategy_key: 'a', task_id: 100, created_at: '2026-06-19' }),
    makeRow({ strategy_key: 'b', task_id: 200 }),
    makeRow({ strategy_key: 'a', task_id: 99, created_at: '2026-06-18' }), // 老的, 应被去掉
    makeRow({ strategy_key: 'c', task_id: 300 }),
  ];
  const deduped = dedupLatestByStrategyKey(rows);
  assert('3 个 key → 3 行', deduped.length === 3);
  assert('a 取 task_id=100 (首条/最新)', deduped.find(r => r.strategy_key === 'a')?.task_id === 100);
  assert('b 保留', deduped.some(r => r.strategy_key === 'b'));
  assert('c 保留', deduped.some(r => r.strategy_key === 'c'));

  // 无 strategy_key 的行被跳过 (防御性)
  const rows2 = [makeRow({ strategy_key: '' }), makeRow({ strategy_key: 'x' })];
  assert('空 key 跳过', dedupLatestByStrategyKey(rows2).length === 1);
}

// ============================================================
// [4] filterByFinitePrimarySort
// ============================================================
function testFilter() {
  console.log('\n## [4] filterByFinitePrimarySort');
  const rows = [
    makeRow({ strategy_key: 'a', sharpe_ratio: 1.5 }),
    makeRow({ strategy_key: 'b', sharpe_ratio: null }),
    makeRow({ strategy_key: 'c', sharpe_ratio: 'NaN' as any }),
    makeRow({ strategy_key: 'd', sharpe_ratio: 0 }), // 0 应保留
    makeRow({ strategy_key: 'e', sharpe_ratio: -1 }), // 负数应保留
  ];
  const f = filterByFinitePrimarySort(rows, 'sharpe');
  assert('过滤 NaN / null', f.length === 3);
  assert('0 保留', f.some(r => r.strategy_key === 'd'));
  assert('负数保留', f.some(r => r.strategy_key === 'e'));

  // annual / total 字段名映射也对
  const rowsAnnual = [
    makeRow({ strategy_key: 'a', annual_return_pct: 10 }),
    makeRow({ strategy_key: 'b', annual_return_pct: null }),
  ];
  assert('annual 字段映射', filterByFinitePrimarySort(rowsAnnual, 'annual').length === 1);
}

// ============================================================
// [5] sortLeaderboardItems
// ============================================================
function testSort() {
  console.log('\n## [5] sortLeaderboardItems');
  const rows = [
    makeRow({ strategy_key: 'a', sharpe_ratio: 0.5 }),
    makeRow({ strategy_key: 'b', sharpe_ratio: 2.0 }),
    makeRow({ strategy_key: 'c', sharpe_ratio: 1.0 }),
  ];
  const sorted = sortLeaderboardItems(rows, 'sharpe');
  assert('DESC: b 第一 (sharpe=2.0)', sorted[0].strategy_key === 'b');
  assert('DESC: c 第二 (sharpe=1.0)', sorted[1].strategy_key === 'c');
  assert('DESC: a 第三 (sharpe=0.5)', sorted[2].strategy_key === 'a');

  // 稳定: tie 时保留入参顺序
  const tied = [
    makeRow({ strategy_key: 'first', sharpe_ratio: 1.0 }),
    makeRow({ strategy_key: 'second', sharpe_ratio: 1.0 }),
    makeRow({ strategy_key: 'third', sharpe_ratio: 1.0 }),
  ];
  const sortedTied = sortLeaderboardItems(tied, 'sharpe');
  assert(
    'tie 时稳定 (first / second / third 顺序)',
    sortedTied[0].strategy_key === 'first' &&
      sortedTied[1].strategy_key === 'second' &&
      sortedTied[2].strategy_key === 'third'
  );

  // 不修改入参
  const rows2 = [makeRow({ strategy_key: 'a', sharpe_ratio: 1 }), makeRow({ strategy_key: 'b', sharpe_ratio: 2 })];
  const rows2Copy = rows2.slice();
  sortLeaderboardItems(rows2, 'sharpe');
  assert('不修改入参', rows2[0].strategy_key === rows2Copy[0].strategy_key);
}

// ============================================================
// [6] enrichWithBenchmarkAttributions
// ============================================================
function makeAttr(overrides: Partial<BenchmarkAttributionRow>): BenchmarkAttributionRow {
  return {
    run_id: overrides.run_id ?? 1,
    benchmark_symbol: overrides.benchmark_symbol ?? 'sh.000300',
    benchmark_name: overrides.benchmark_name ?? '沪深300',
    excess_return_pct: overrides.excess_return_pct ?? 5,
    alpha_annual_pct: overrides.alpha_annual_pct ?? 3,
    information_ratio: overrides.information_ratio ?? 0.8,
    beta: overrides.beta ?? 0.95,
    sample_count: overrides.sample_count ?? 100,
    period_start: overrides.period_start ?? '2026-01-01',
    period_end: overrides.period_end ?? '2026-06-19',
    ...overrides,
  };
}

function testEnrich() {
  console.log('\n## [6] enrichWithBenchmarkAttributions');

  const rows: BacktestRow[] = [
    makeRow({ strategy_key: 'a', id: 100 }),
    makeRow({ strategy_key: 'b', id: 200 }),
    makeRow({ strategy_key: 'c', id: 300 }), // 没有归因
  ];
  const attrs: BenchmarkAttributionRow[] = [
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000300', excess_return_pct: 5 }),
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000905', excess_return_pct: 3 }),
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000852', excess_return_pct: -1 }),
    makeAttr({ run_id: 200, benchmark_symbol: 'sh.000300', excess_return_pct: 8 }),
  ];

  const enriched = enrichWithBenchmarkAttributions(rows, attrs);
  const a = enriched.find(r => r.strategy_key === 'a')!;
  assert('a: 3 个基准全部归因', a.benchmark_attributions.length === 3);
  assert(
    'a: 顺序 HS300 → ZZ500 → CSI1000',
    a.benchmark_attributions[0].benchmark_symbol === 'sh.000300' &&
      a.benchmark_attributions[1].benchmark_symbol === 'sh.000905' &&
      a.benchmark_attributions[2].benchmark_symbol === 'sh.000852'
  );
  assert('a: HS300 超额 = 5', a.benchmark_attributions[0].excess_return_pct === 5);

  const b = enriched.find(r => r.strategy_key === 'b')!;
  assert('b: 仅 1 个归因 (HS300)', b.benchmark_attributions.length === 1);
  assert('b: HS300 超额 = 8', b.benchmark_attributions[0].excess_return_pct === 8);

  const c = enriched.find(r => r.strategy_key === 'c')!;
  assert('c: 无归因 → 空数组', c.benchmark_attributions.length === 0);

  // 缺 run_id 的 attr 跳过 (防御)
  const attrsBad: BenchmarkAttributionRow[] = [
    makeAttr({ run_id: 0, benchmark_symbol: 'sh.000300' }),
    makeAttr({ run_id: 100, benchmark_symbol: '' }),
  ];
  const enriched2 = enrichWithBenchmarkAttributions(rows, attrsBad);
  assert(
    '缺 run_id/benchmark_symbol 全跳过',
    enriched2.every(r => r.benchmark_attributions.length === 0)
  );

  // 同 (run_id, benchmark_symbol) 多 period — 取首条 wins (caller order by period_end DESC)
  const attrsDup: BenchmarkAttributionRow[] = [
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000300', excess_return_pct: 99, period_end: '2026-06-19' }),
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000300', excess_return_pct: 1, period_end: '2026-01-01' }),
  ];
  const enriched3 = enrichWithBenchmarkAttributions(
    [makeRow({ strategy_key: 'a', id: 100 })],
    attrsDup
  );
  assert('同 key 多 period: 首条 wins', enriched3[0].benchmark_attributions[0].excess_return_pct === 99);

  // 未知 benchmark_symbol → 放到列尾按 symbol 字母序
  const attrsExtra: BenchmarkAttributionRow[] = [
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000688', excess_return_pct: 7 }), // 科创50 不在 DISPLAY_ORDER
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000300', excess_return_pct: 5 }),
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000001', excess_return_pct: 2 }), // 上证 不在 DISPLAY_ORDER
  ];
  const enriched4 = enrichWithBenchmarkAttributions(
    [makeRow({ strategy_key: 'a', id: 100 })],
    attrsExtra
  );
  const order = enriched4[0].benchmark_attributions.map(a => a.benchmark_symbol);
  assert('未知 symbol 兜底排列尾', order[0] === 'sh.000300');
  assert('extras 内部字母序: sh.000001 在前', order[1] === 'sh.000001');
  assert('extras 内部字母序: sh.000688 在后', order[2] === 'sh.000688');

  // row.id 缺失 → 空 attributions (不抛错)
  const rowNoId: BacktestRow[] = [makeRow({ strategy_key: 'a' })];
  const enriched5 = enrichWithBenchmarkAttributions(rowNoId, attrs);
  assert('row 缺 id → 空 attributions', enriched5[0].benchmark_attributions.length === 0);

  // benchmark_name 缺失走 BENCHMARK_NAME_MAP 兜底
  const attrNoName: BenchmarkAttributionRow[] = [
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000300', benchmark_name: null }),
  ];
  const enriched6 = enrichWithBenchmarkAttributions(
    [makeRow({ strategy_key: 'a', id: 100 })],
    attrNoName
  );
  assert(
    'benchmark_name 缺失 → BENCHMARK_NAME_MAP 兜底',
    enriched6[0].benchmark_attributions[0].benchmark_name === '沪深300'
  );

  // 数字字段 sanitize: string → number
  const attrStr: BenchmarkAttributionRow[] = [
    makeAttr({
      run_id: 100,
      benchmark_symbol: 'sh.000300',
      excess_return_pct: '3.14' as any,
      alpha_annual_pct: 'NaN' as any,
    }),
  ];
  const enriched7 = enrichWithBenchmarkAttributions(
    [makeRow({ strategy_key: 'a', id: 100 })],
    attrStr
  );
  assert('string 数字解析', enriched7[0].benchmark_attributions[0].excess_return_pct === 3.14);
  assert('NaN string → null', enriched7[0].benchmark_attributions[0].alpha_annual_pct === null);
}

// ============================================================
// [7] buildStrategyLeaderboardItems 主入口端到端
// ============================================================
function testMainEntry() {
  console.log('\n## [7] buildStrategyLeaderboardItems 主入口');

  const rows: BacktestRow[] = [
    makeRow({ strategy_key: 'a', id: 100, sharpe_ratio: 1.5, created_at: '2026-06-19' }),
    makeRow({ strategy_key: 'b', id: 200, sharpe_ratio: 2.5, created_at: '2026-06-19' }),
    makeRow({ strategy_key: 'a', id: 99, sharpe_ratio: 0.5, created_at: '2026-06-18' }), // 老 a, 应去
    makeRow({ strategy_key: 'c', id: 300, sharpe_ratio: null, created_at: '2026-06-19' }), // 应过滤
  ];
  const attrs: BenchmarkAttributionRow[] = [
    makeAttr({ run_id: 100, benchmark_symbol: 'sh.000300', excess_return_pct: 5 }),
    makeAttr({ run_id: 200, benchmark_symbol: 'sh.000300', excess_return_pct: 8 }),
    makeAttr({ run_id: 99, benchmark_symbol: 'sh.000300', excess_return_pct: 999 }), // 老 a 的归因, 应不出现
  ];

  const items = buildStrategyLeaderboardItems({ rows, attributions: attrs, sort_by: 'sharpe' });
  assert('dedup + filter + sort + enrich → 2 行', items.length === 2);
  assert('b 第一 (sharpe=2.5)', items[0].strategy_key === 'b');
  assert('a 第二 (sharpe=1.5)', items[1].strategy_key === 'a');
  assert('b 含归因', items[0].benchmark_attributions.length === 1);
  assert('a 含归因 (新 run_id=100)', items[1].benchmark_attributions[0].excess_return_pct === 5);
  assert('老 a (run_id=99) 归因不出现', !items.some(i => i.benchmark_attributions.some(a => a.excess_return_pct === 999)));

  // 空 rows
  const empty = buildStrategyLeaderboardItems({ rows: [], attributions: [], sort_by: 'sharpe' });
  assert('空 rows → 空结果', empty.length === 0);

  // annual / total 排序也工作
  const rows2: BacktestRow[] = [
    makeRow({ strategy_key: 'a', id: 1, annual_return_pct: 10 }),
    makeRow({ strategy_key: 'b', id: 2, annual_return_pct: 30 }),
  ];
  const itemsAnnual = buildStrategyLeaderboardItems({ rows: rows2, attributions: [], sort_by: 'annual' });
  assert('annual 排序: b 第一', itemsAnnual[0].strategy_key === 'b');
}

// ============================================================
// [8] META-GUARD: QuantController 必须 import + 调用 helper, 不再 inline
// ============================================================
function testMetaGuard() {
  console.log('\n## [8] META-GUARD: QuantController.getStrategyLeaderboard wire-in');

  const ctrlPath = path.resolve(__dirname, '../../src/api/controllers/QuantController.ts');
  assert('QuantController 文件存在', fs.existsSync(ctrlPath));
  const src = fs.readFileSync(ctrlPath, 'utf-8');

  // [8a] 正向: import + 调用
  assert(
    '[8a] 文件包含 buildStrategyLeaderboardItems 引用',
    /buildStrategyLeaderboardItems/.test(src)
  );
  assert(
    '[8a] 文件包含 internal/StrategyLeaderboardHelpers 引用',
    /internal\/StrategyLeaderboardHelpers/.test(src)
  );
  assert(
    '[8a] 文件包含 BenchmarkAttributionResult require (拉归因)',
    /BenchmarkAttributionResult/.test(src)
  );

  // [8b] getStrategyLeaderboard 方法定位
  const methodMatch = src.match(/async\s+getStrategyLeaderboard\s*\([\s\S]*?\n  \}/);
  assert('[8b] getStrategyLeaderboard 方法可定位', !!methodMatch);
  if (methodMatch) {
    const body = methodMatch[0];
    assert(
      '[8c] 方法体调用 buildStrategyLeaderboardItems(',
      /\bbuildStrategyLeaderboardItems\s*\(/.test(body)
    );
    // [8d] 反向: 不再 inline 写 dedup Map + 也不再 inline 写 sort 逻辑
    assert(
      '[8d-1] 不再 inline 写 latestByKey Map',
      !/latestByKey\s*=\s*new\s+Map/.test(body)
    );
    assert(
      '[8d-2] 不再 inline 写 items.sort 主排序',
      !/items\.sort\(\(a,\s*b\)/.test(body)
    );
    // [8e] 必须查 BenchmarkAttributionResult.findAll 拉归因
    assert(
      '[8e] 查 BenchmarkAttributionResult.findAll',
      /BenchmarkAttributionResult\.findAll/.test(body)
    );
    // [8f] 必须查 run_ids
    assert('[8f] 查 run_ids 限制 attribution 查询范围', /runIds|run_id:/.test(body));
  }
}

function main() {
  testConstants();
  testToFiniteNumber();
  testDedup();
  testFilter();
  testSort();
  testEnrich();
  testMainEntry();
  testMetaGuard();
  console.log(`\n========================================`);
  console.log(`strategy-leaderboard-helpers tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
