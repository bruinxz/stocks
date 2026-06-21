/**
 * AttributionEngine 单元测试 (US-079 [PM-002] — Brinson-Fachler 拆解).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/attribution/attribution-engine.test.ts
 *
 * 覆盖维度:
 *   [1] safeFiniteNumber — NaN/Infinity/字符串/null → fallback
 *   [2] normalizeAttributionIndustry — string/null/empty/trim
 *   [3] mergeAttributionRowsByIndustry — 同 industry 合并 + return 加权平均
 *   [4] fillBenchmarkWeightsEqual — 全空等权 / 部分给 部分补 / 全给不变
 *   [5] computeRowAttribution — 三公式手算对照
 *   [6] computeBrinsonFachler:
 *       (a) AC 主验收: 已知 portfolio + benchmark → allocation/selection/interaction
 *            数值精确 (手算), total_active_return = 三者之和
 *       (b) ±5% 不变量 (AC §E.2): 与 PM-001 sixDimBreakdown 联动 — residual 重算
 *            让 sum ≈ total_pnl, tolerance < 5% × |total_pnl|
 *       (c) portfolio_value <= 0 → 全 0 fail-safe
 *       (d) rows 空 / 非数组 → 全 0
 *       (e) 等权 benchmark fallback — 单行业 + 多行业
 *       (f) 同 industry 重复合并行为
 *       (g) NaN/Infinity 输入 → 自动 0
 *   [7] sixDimBreakdown 与 engine_result 联动:
 *       (a) 不传 engine_result → 4 维仍 0 (向后兼容)
 *       (b) 传 engine_result → sizing/selection/timing 从 engine 填
 *       (c) residual = total - industry - 4维 + execution_cost (±5% 不变量)
 *   [8] buildDailyAttributionReport 接 attribution_engine_input → 全字段贯通
 *   [9] DailyAttributionService.generateDailyReport 支持 attribution_engine_input
 *   [10] META-GUARD fs+regex:
 *       (a) AttributionEngine.ts 含 5 个关键 export
 *       (b) DailyAttributionService.ts 含 import computeBrinsonFachler + 调用
 *       (c) sixDimBreakdown signature 含 attribution_engine_result
 *       (d) buildDailyAttributionReport signature 含 attribution_engine_input
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AttributionEngineInput,
  AttributionEngineResult,
  AttributionIndustryRow,
  computeBrinsonFachler,
  computeRowAttribution,
  fillBenchmarkWeightsEqual,
  mergeAttributionRowsByIndustry,
  normalizeAttributionIndustry,
  safeFiniteNumber,
} from '../../src/services/attribution/AttributionEngine';
import {
  DailyAttributionService,
  DailyAttributionDataSource,
  DailyAttributionTradeRow,
  DailyAttributionSnapshotRow,
  DailyAttributionPositionRow,
  buildDailyAttributionReport,
  sixDimBreakdown,
} from '../../src/services/attribution/DailyAttributionService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}
function approxEq(a: number, b: number, eps = 1e-2): boolean {
  return Math.abs(a - b) < eps;
}

// ---- [1] safeFiniteNumber --------------------------------------------------
assert('[1.1] number 透传', safeFiniteNumber(3.14) === 3.14);
assert('[1.2] NaN → fallback 0', safeFiniteNumber(NaN) === 0);
assert('[1.3] Infinity → 0', safeFiniteNumber(Infinity) === 0);
assert('[1.4] -Infinity → 0', safeFiniteNumber(-Infinity) === 0);
assert('[1.5] 字符串 → 0', safeFiniteNumber('3.14' as any) === 0);
assert('[1.6] null → 0', safeFiniteNumber(null as any) === 0);
assert('[1.7] 自定义 fallback', safeFiniteNumber(NaN, 42) === 42);

// ---- [2] normalizeAttributionIndustry --------------------------------------
assert('[2.1] 普通', normalizeAttributionIndustry('银行') === '银行');
assert('[2.2] trim', normalizeAttributionIndustry('  半导体  ') === '半导体');
assert('[2.3] null → 其它', normalizeAttributionIndustry(null) === '其它');
assert('[2.4] empty → 其它', normalizeAttributionIndustry('') === '其它');
assert('[2.5] 数字 → 其它', normalizeAttributionIndustry(123) === '其它');

// ---- [3] mergeAttributionRowsByIndustry ------------------------------------
{
  const rows: AttributionIndustryRow[] = [
    {
      industry: '银行',
      portfolio_weight: 0.3,
      benchmark_weight: 0.2,
      portfolio_return: 0.02,
      benchmark_return: 0.01,
    },
    {
      industry: '银行',
      portfolio_weight: 0.1,
      benchmark_weight: 0.1,
      portfolio_return: 0.04,
      benchmark_return: 0.02,
    },
    {
      industry: '半导体',
      portfolio_weight: 0.4,
      benchmark_weight: 0.5,
      portfolio_return: -0.01,
      benchmark_return: -0.005,
    },
  ];
  const merged = mergeAttributionRowsByIndustry(rows);
  assert('[3.1] 合并后 2 行', merged.length === 2);
  const bank = merged.find(r => r.industry === '银行')!;
  assert('[3.2] 银行 p_w=0.4', approxEq(bank.portfolio_weight, 0.4));
  assert('[3.3] 银行 b_w=0.3', approxEq(bank.benchmark_weight ?? 0, 0.3));
  // 加权 return = (0.02*0.3 + 0.04*0.1) / 0.4 = 0.025
  assert('[3.4] 银行 p_ret 加权 ≈ 0.025', approxEq(bank.portfolio_return, 0.025));
  // (0.01*0.2 + 0.02*0.1)/0.3 = 0.0133
  assert('[3.5] 银行 b_ret 加权 ≈ 0.01333', approxEq(bank.benchmark_return ?? 0, 0.04 / 3, 1e-4));
  assert('[3.6] empty array → []', mergeAttributionRowsByIndustry([]).length === 0);
}

// ---- [4] fillBenchmarkWeightsEqual -----------------------------------------
{
  const allMissing: AttributionIndustryRow[] = [
    { industry: 'A', portfolio_weight: 0.5, portfolio_return: 0, benchmark_return: 0 },
    { industry: 'B', portfolio_weight: 0.5, portfolio_return: 0, benchmark_return: 0 },
  ];
  const f1 = fillBenchmarkWeightsEqual(allMissing);
  assert('[4.1] 全空等权 → 0.5 / 0.5', f1.rows.every(r => approxEq(r.benchmark_weight ?? -1, 0.5)));
  assert('[4.2] used_equal=true', f1.used_equal === true);

  const allGiven: AttributionIndustryRow[] = [
    {
      industry: 'A',
      portfolio_weight: 0.5,
      benchmark_weight: 0.6,
      portfolio_return: 0,
      benchmark_return: 0,
    },
    {
      industry: 'B',
      portfolio_weight: 0.5,
      benchmark_weight: 0.4,
      portfolio_return: 0,
      benchmark_return: 0,
    },
  ];
  const f2 = fillBenchmarkWeightsEqual(allGiven);
  assert('[4.3] 全给不变', f2.rows[0].benchmark_weight === 0.6 && f2.rows[1].benchmark_weight === 0.4);
  assert('[4.4] used_equal=false', f2.used_equal === false);

  // 部分给, 部分补 — 给的 0.6 占, 剩 0.4 分给 1 个 missing
  const partial: AttributionIndustryRow[] = [
    {
      industry: 'A',
      portfolio_weight: 0.5,
      benchmark_weight: 0.6,
      portfolio_return: 0,
      benchmark_return: 0,
    },
    { industry: 'B', portfolio_weight: 0.5, portfolio_return: 0, benchmark_return: 0 },
  ];
  const f3 = fillBenchmarkWeightsEqual(partial);
  assert('[4.5] 部分 A 不动', approxEq(f3.rows[0].benchmark_weight ?? -1, 0.6));
  assert('[4.6] 部分 B 接 0.4 剩余', approxEq(f3.rows[1].benchmark_weight ?? -1, 0.4));
  assert('[4.7] used_equal=true (mixed)', f3.used_equal === true);

  assert('[4.8] 空 → 空', fillBenchmarkWeightsEqual([]).rows.length === 0);
}

// ---- [5] computeRowAttribution — 手算 3 公式 -----------------------------
{
  // ...alloc=(0.4-0.3)*0.01*100000 = 100
  // selection  = 0.3 * (0.02-0.01) * 100000 = 300
  // interaction= (0.4-0.3) * (0.02-0.01) * 100000 = 100
  const row: AttributionIndustryRow = {
    industry: '银行',
    portfolio_weight: 0.4,
    benchmark_weight: 0.3,
    portfolio_return: 0.02,
    benchmark_return: 0.01,
  };
  const det = computeRowAttribution(row, 100000);
  assert('[5.1] allocation=100', det.allocation === 100);
  assert('[5.2] selection=300', det.selection === 300);
  assert('[5.3] interaction=100', det.interaction === 100);
  assert('[5.4] industry pass-through', det.industry === '银行');
}

// ---- [6] computeBrinsonFachler --------------------------------------------
{
  // 6a 主验收 — 2 行业, V=1,000,000
  // 银行   p_w=0.6 b_w=0.4 p_ret=+0.02 b_ret=+0.01
  //   alloc = 0.2 * 0.01 * 1e6 = 2000
  //   sel   = 0.4 * 0.01 * 1e6 = 4000
  //   inter = 0.2 * 0.01 * 1e6 = 2000
  // 半导体 p_w=0.4 b_w=0.6 p_ret=-0.01 b_ret=-0.005
  //   alloc = -0.2 * -0.005 * 1e6 = 1000
  //   sel   = 0.6 * (-0.005) * 1e6 = -3000
  //   inter = -0.2 * -0.005 * 1e6 = 1000
  //
  // 合计: alloc=3000  sel=1000  inter=3000  total=7000
  const input: AttributionEngineInput = {
    portfolio_value: 1_000_000,
    rows: [
      {
        industry: '银行',
        portfolio_weight: 0.6,
        benchmark_weight: 0.4,
        portfolio_return: 0.02,
        benchmark_return: 0.01,
      },
      {
        industry: '半导体',
        portfolio_weight: 0.4,
        benchmark_weight: 0.6,
        portfolio_return: -0.01,
        benchmark_return: -0.005,
      },
    ],
  };
  const r = computeBrinsonFachler(input);
  assert('[6.a.1] allocation=3000', r.allocation_contrib === 3000);
  assert('[6.a.2] selection=1000', r.selection_contrib === 1000);
  assert('[6.a.3] interaction=3000', r.interaction_contrib === 3000);
  assert('[6.a.4] total_active=7000', r.total_active_return === 7000);
  assert('[6.a.5] industry_count=2', r.meta.industry_count === 2);
  assert('[6.a.6] used_equal=false', r.meta.used_equal_weight_benchmark === false);
  assert('[6.a.7] by_industry 2 条', r.by_industry.length === 2);
  // 银行 |alloc+sel+inter| = 8000 > 半导体 |1000-3000+1000|=1000 → 银行 first
  assert('[6.a.8] 排序 银行 first', r.by_industry[0].industry === '银行');
}

// 6b — ±5% 不变量 (AC §E.2): residual 重算让 PM-001 等式 trivially 成立
{
  // 构造 trades 让 industry_total = 200, total_pnl = 800 → engine 填 600
  // 等式: total = industry + alloc + sel + inter + factor + residual - execution_cost
  const trades: DailyAttributionTradeRow[] = [
    {
      id: 1,
      portfolio_id: 1,
      symbol: 'A',
      name: 'A',
      direction: 'SELL',
      execute_price: 100,
      quantity: 100,
      amount: 10000,
      commission: 5,
      realized_pnl: 200,
      created_at: '2026-06-19 10:00',
    },
  ];
  const engine: AttributionEngineResult = {
    allocation_contrib: 300,
    selection_contrib: 200,
    interaction_contrib: 100,
    total_active_return: 600,
    by_industry: [],
    meta: { industry_count: 1, used_equal_weight_benchmark: false, skipped_rows: 0 },
  };
  const breakdown = sixDimBreakdown({
    trades,
    symbolToIndustry: { A: '银行' },
    totalPnL: 800,
    attribution_engine_result: engine,
  });
  // industry_total (sell-only) = 200
  // 期望 residual = 800 - 200 - 300 - 200 - 100 + 5 = 5
  assert('[6.b.1] residual = 5', breakdown.residual === 5);
  // sum 等式: industry + alloc + sel + inter + factor + residual = total + execution
  const industryTotal = breakdown.industry_contrib.reduce((s, r) => s + r.pnl, 0);
  const sum =
    industryTotal +
    breakdown.sizing_contrib +
    breakdown.selection_contrib +
    breakdown.timing_contrib +
    breakdown.factor_contrib_total +
    breakdown.residual;
  // sum + execution_cost (支出) = total_pnl
  const reconstructed = sum - breakdown.execution_cost;
  const totalPnL = 800;
  const tolerance = Math.max(5, Math.abs(totalPnL) * 0.05);
  assert(
    `[6.b.2] AC ±5% 不变量 sum(${reconstructed}) ≈ total(${totalPnL}) tol=${tolerance}`,
    Math.abs(reconstructed - totalPnL) <= tolerance,
  );
  assert('[6.b.3] sizing=300', breakdown.sizing_contrib === 300);
  assert('[6.b.4] selection=200', breakdown.selection_contrib === 200);
  assert('[6.b.5] timing=100', breakdown.timing_contrib === 100);
}

// 6c — portfolio_value <= 0 fail-safe
{
  const r = computeBrinsonFachler({
    portfolio_value: 0,
    rows: [
      {
        industry: 'A',
        portfolio_weight: 0.5,
        benchmark_weight: 0.5,
        portfolio_return: 0.01,
        benchmark_return: 0,
      },
    ],
  });
  assert('[6.c.1] V=0 → 全 0', r.allocation_contrib === 0 && r.selection_contrib === 0);
  assert('[6.c.2] meta industry_count=0', r.meta.industry_count === 0);

  const r2 = computeBrinsonFachler({
    portfolio_value: -100,
    rows: [
      {
        industry: 'A',
        portfolio_weight: 0.5,
        benchmark_weight: 0.5,
        portfolio_return: 0.01,
        benchmark_return: 0,
      },
    ],
  });
  assert('[6.c.3] V<0 → 全 0', r2.allocation_contrib === 0 && r2.total_active_return === 0);
}

// 6d — rows 空/非数组
{
  const r1 = computeBrinsonFachler({ portfolio_value: 100, rows: [] });
  assert('[6.d.1] rows=[] → 全 0', r1.allocation_contrib === 0 && r1.by_industry.length === 0);
  const r2 = computeBrinsonFachler({ portfolio_value: 100, rows: null as any });
  assert('[6.d.2] rows=null → 全 0', r2.allocation_contrib === 0);
  const r3 = computeBrinsonFachler(null as any);
  assert('[6.d.3] input=null → 全 0', r3.allocation_contrib === 0);
}

// 6e — 等权 benchmark fallback
{
  // V=100000, 单行业, p_w=1.0, b_w 缺失 → 等权 1/1 = 1.0
  // alloc=(1-1)*0.02*1e5=0, sel=1*(0.03-0.02)*1e5=1000, inter=0
  const r = computeBrinsonFachler({
    portfolio_value: 100_000,
    rows: [
      {
        industry: 'A',
        portfolio_weight: 1.0,
        portfolio_return: 0.03,
        benchmark_return: 0.02,
      },
    ],
  });
  assert('[6.e.1] 单行业等权 alloc=0', r.allocation_contrib === 0);
  assert('[6.e.2] 单行业等权 sel=1000', r.selection_contrib === 1000);
  assert('[6.e.3] used_equal=true', r.meta.used_equal_weight_benchmark === true);
}

// 6f — 同 industry 重复合并行为 (engine 内部走 merge)
{
  const r = computeBrinsonFachler({
    portfolio_value: 1_000_000,
    rows: [
      {
        industry: 'X',
        portfolio_weight: 0.2,
        benchmark_weight: 0.1,
        portfolio_return: 0.02,
        benchmark_return: 0.01,
      },
      {
        industry: 'X', // 同 industry 重复
        portfolio_weight: 0.1,
        benchmark_weight: 0.1,
        portfolio_return: 0.04,
        benchmark_return: 0.02,
      },
    ],
  });
  // merge 后: p_w=0.3, b_w=0.2, p_ret=(0.02*0.2+0.04*0.1)/0.3=0.0267, b_ret=(0.01*0.1+0.02*0.1)/0.2=0.015
  // alloc=(0.3-0.2)*0.015*1e6 = 1500
  // sel  = 0.2*(0.02667-0.015)*1e6 ≈ 2333.33 → round2
  // inter= (0.3-0.2)*(0.02667-0.015)*1e6 ≈ 1166.67
  assert('[6.f.1] merge industry_count=1', r.meta.industry_count === 1);
  assert('[6.f.2] alloc=1500', r.allocation_contrib === 1500);
  assert(
    '[6.f.3] sel ≈ 2333.33',
    approxEq(r.selection_contrib, 2333.33, 0.5),
  );
  assert('[6.f.4] inter ≈ 1166.67', approxEq(r.interaction_contrib, 1166.67, 0.5));
  assert('[6.f.5] skipped_rows=1', r.meta.skipped_rows === 1);
}

// 6g — NaN/Infinity 输入自动 0
{
  const r = computeBrinsonFachler({
    portfolio_value: 100_000,
    rows: [
      {
        industry: 'A',
        portfolio_weight: NaN as any,
        benchmark_weight: Infinity as any,
        portfolio_return: 0.02,
        benchmark_return: 0.01,
      },
    ],
  });
  // safeFiniteNumber 兜底 → p_w=0, b_w=0, → alloc/sel/inter = 0
  assert('[6.g.1] NaN/Inf 输入 alloc=0', r.allocation_contrib === 0);
  assert('[6.g.2] NaN/Inf 输入 sel=0', r.selection_contrib === 0);
  assert('[6.g.3] NaN/Inf 输入 inter=0', r.interaction_contrib === 0);
}

// ---- [7] sixDimBreakdown 与 engine_result 联动 ---------------------------
{
  const trades: DailyAttributionTradeRow[] = [
    {
      id: 1,
      portfolio_id: 1,
      symbol: 'A',
      name: 'A',
      direction: 'SELL',
      execute_price: 100,
      quantity: 100,
      amount: 10000,
      commission: 8,
      realized_pnl: 500,
      created_at: '2026-06-19 10:00',
    },
  ];
  // 7a 不传 engine → 4 维 0 (向后兼容 PM-001 老测试)
  const b1 = sixDimBreakdown({ trades, symbolToIndustry: {}, totalPnL: 1000 });
  assert(
    '[7.a.1] 无 engine → 4 维 0',
    b1.sizing_contrib === 0 &&
      b1.selection_contrib === 0 &&
      b1.timing_contrib === 0 &&
      b1.factor_contrib_total === 0,
  );
  // residual = 1000 - 500 + 8 = 508 (PM-001 公式)
  assert('[7.a.2] 无 engine residual=508', b1.residual === 508);

  // 7b 传 engine → 三维填充
  const engine: AttributionEngineResult = {
    allocation_contrib: 100,
    selection_contrib: 200,
    interaction_contrib: 50,
    total_active_return: 350,
    by_industry: [],
    meta: { industry_count: 1, used_equal_weight_benchmark: false, skipped_rows: 0 },
  };
  const b2 = sixDimBreakdown({
    trades,
    symbolToIndustry: {},
    totalPnL: 1000,
    attribution_engine_result: engine,
  });
  assert('[7.b.1] sizing=100', b2.sizing_contrib === 100);
  assert('[7.b.2] selection=200', b2.selection_contrib === 200);
  assert('[7.b.3] timing=50', b2.timing_contrib === 50);
  // residual = 1000 - 500 - 100 - 200 - 50 + 8 = 158
  assert('[7.b.4] residual=158', b2.residual === 158);
}

// ---- [8] buildDailyAttributionReport 接 attribution_engine_input ----------
{
  const report = buildDailyAttributionReport({
    portfolio_id: 1,
    date: '2026-06-19',
    trades: [
      {
        id: 1,
        portfolio_id: 1,
        symbol: 'A',
        name: 'A',
        direction: 'SELL',
        execute_price: 100,
        quantity: 100,
        amount: 10000,
        commission: 5,
        realized_pnl: 1000,
        created_at: '2026-06-19 10:00',
      },
    ],
    snapshots: [
      { date: '2026-06-19', total_value: 105000, current_cash: 0, position_value: 105000 },
      { date: '2026-06-18', total_value: 100000, current_cash: 0, position_value: 100000 },
    ],
    positions: [],
    symbolToIndustry: { A: '银行' },
    attribution_engine_input: {
      portfolio_value: 100_000,
      rows: [
        {
          industry: '银行',
          portfolio_weight: 0.6,
          benchmark_weight: 0.4,
          portfolio_return: 0.02,
          benchmark_return: 0.01,
        },
        {
          industry: '半导体',
          portfolio_weight: 0.4,
          benchmark_weight: 0.6,
          portfolio_return: -0.01,
          benchmark_return: -0.005,
        },
      ],
    },
  });
  // total_pnl = 5000
  // engine (V=100000):
  //   银行   alloc=(0.6-0.4)*0.01*1e5=200  sel=0.4*0.01*1e5=400  inter=0.2*0.01*1e5=200
  //   半导体 alloc=(0.4-0.6)*-0.005*1e5=100 sel=0.6*-0.005*1e5=-300 inter=-0.2*-0.005*1e5=100
  //   合计: alloc=300, sel=100, inter=300
  // industry_total = 1000 (银行 sell pnl)
  // residual = 5000 - 1000 - 300 - 100 - 300 + 5 = 3305
  assert('[8.1] total_pnl=5000', report.total_pnl === 5000);
  assert('[8.2] sizing_contrib=300', report.breakdown.sizing_contrib === 300);
  assert('[8.3] selection_contrib=100', report.breakdown.selection_contrib === 100);
  assert('[8.4] timing_contrib=300', report.breakdown.timing_contrib === 300);
  assert('[8.5] execution_cost=5', report.breakdown.execution_cost === 5);
  assert('[8.6] residual=3305', report.breakdown.residual === 3305);

  // AC §E.2 ±5% 不变量
  const industryTotal = report.breakdown.industry_contrib.reduce((s, r) => s + r.pnl, 0);
  const sumNonExec =
    industryTotal +
    report.breakdown.sizing_contrib +
    report.breakdown.selection_contrib +
    report.breakdown.timing_contrib +
    report.breakdown.factor_contrib_total +
    report.breakdown.residual;
  const reconstructed = sumNonExec - report.breakdown.execution_cost;
  const tol = Math.max(5, Math.abs(report.total_pnl) * 0.05);
  assert(
    `[8.7] AC ±5% sum(${reconstructed}) ≈ total(${report.total_pnl})`,
    Math.abs(reconstructed - report.total_pnl) <= tol,
  );
}

// ---- [9] DailyAttributionService.generateDailyReport 支持 engine_input ----
function makeFake(o: {
  trades?: DailyAttributionTradeRow[];
  snapshots?: DailyAttributionSnapshotRow[];
  positions?: DailyAttributionPositionRow[];
  industry?: Record<string, string>;
}): DailyAttributionDataSource {
  return {
    async loadTrades() {
      return o.trades || [];
    },
    async loadSnapshots() {
      return o.snapshots || [];
    },
    async loadPositions() {
      return o.positions || [];
    },
    async loadSymbolIndustryMap() {
      return o.industry || {};
    },
  };
}

(async () => {
  // (9) engine_input 直接通过 service options 传
  const svc = new DailyAttributionService();
  const r = await svc.generateDailyReport(1, {
    date: '2026-06-19',
    data_source: makeFake({
      trades: [
        {
          id: 1,
          portfolio_id: 1,
          symbol: 'A',
          name: 'A',
          direction: 'SELL',
          execute_price: 100,
          quantity: 100,
          amount: 10000,
          commission: 5,
          realized_pnl: 500,
          created_at: '2026-06-19 10:00',
        },
      ],
      snapshots: [
        { date: '2026-06-19', total_value: 105000, current_cash: 0, position_value: 105000 },
        { date: '2026-06-18', total_value: 100000, current_cash: 0, position_value: 100000 },
      ],
      industry: { A: '银行' },
    }),
    attribution_engine_input: {
      portfolio_value: 100_000,
      rows: [
        {
          industry: '银行',
          portfolio_weight: 1.0,
          benchmark_weight: 1.0,
          portfolio_return: 0.03,
          benchmark_return: 0.01,
        },
      ],
    },
  });
  // alloc=(1-1)*0.01*1e5=0, sel=1*(0.03-0.01)*1e5=2000, inter=0
  assert('[9.1] status=ok', r.status === 'ok');
  assert('[9.2] sizing_contrib=0', r.report?.breakdown.sizing_contrib === 0);
  assert('[9.3] selection_contrib=2000', r.report?.breakdown.selection_contrib === 2000);
  assert('[9.4] timing_contrib=0', r.report?.breakdown.timing_contrib === 0);

  // [10] META-GUARD fs+regex
  const enginePath = join(__dirname, '../../src/services/attribution/AttributionEngine.ts');
  const engineSrc = readFileSync(enginePath, 'utf8');
  assert(
    '[10.1] AttributionEngine 含 export computeBrinsonFachler',
    /export\s+function\s+computeBrinsonFachler/.test(engineSrc),
  );
  assert(
    '[10.2] AttributionEngine 含 export computeRowAttribution',
    /export\s+function\s+computeRowAttribution/.test(engineSrc),
  );
  assert(
    '[10.3] AttributionEngine 含 mergeAttributionRowsByIndustry',
    /export\s+function\s+mergeAttributionRowsByIndustry/.test(engineSrc),
  );
  assert(
    '[10.4] AttributionEngine 含 fillBenchmarkWeightsEqual',
    /export\s+function\s+fillBenchmarkWeightsEqual/.test(engineSrc),
  );
  assert(
    '[10.5] AttributionEngine 含 AttributionEngineInput type',
    /export\s+interface\s+AttributionEngineInput/.test(engineSrc),
  );
  assert(
    '[10.6] AttributionEngine 含 PM-002 / US-079 标识',
    /PM-002|US-079/.test(engineSrc),
  );
  // 公式注释守
  assert(
    '[10.7] AttributionEngine 含 Brinson-Fachler 公式注释',
    /Brinson-Fachler/.test(engineSrc),
  );
  assert(
    '[10.8] AttributionEngine 含 allocation_i / selection_i / interaction_i 公式',
    /allocation_i/.test(engineSrc) && /selection_i/.test(engineSrc) && /interaction_i/.test(engineSrc),
  );

  const servicePath = join(__dirname, '../../src/services/attribution/DailyAttributionService.ts');
  const serviceSrc = readFileSync(servicePath, 'utf8');
  assert(
    '[10.9] DailyAttributionService 已 import computeBrinsonFachler',
    /import\s+\{[^}]*computeBrinsonFachler[^}]*\}\s+from\s+['"]\.\/AttributionEngine['"]/.test(
      serviceSrc,
    ),
  );
  assert(
    '[10.10] sixDimBreakdown signature 含 attribution_engine_result',
    /attribution_engine_result\??:\s*AttributionEngineResult/.test(serviceSrc),
  );
  assert(
    '[10.11] buildDailyAttributionReport 含 attribution_engine_input',
    /attribution_engine_input\??:\s*AttributionEngineInput/.test(serviceSrc),
  );
  assert(
    '[10.12] GenerateDailyReportOptions 含 attribution_engine_input',
    /attribution_engine_input/.test(serviceSrc) && /options\.attribution_engine_input/.test(serviceSrc),
  );

  console.log(`\nattribution-engine: ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
