/**
 * CounterfactualBaselineService 单元测试 (US-103 [PR-014]).
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/counterfactual-baseline-service.test.ts
 *
 * 覆盖维度:
 *   [1] safeNum — fallback / NaN / Infinity / 非数字字符串
 *   [2] findEventIndex — 事件落首/中/尾/找不到
 *   [3] computeDrawdown — 单点/平/单调升/单调跌/V 型/W 型 + 数值精度
 *   [4] downsampleSeries — 短于 cap / 等于 cap / 长于 cap 含首尾
 *   [5] 4 baseline 算子 — hold / zero / plan (含 null) / perfect (含 lead 越界)
 *   [6] buildCounterfactualBaselines engine —
 *        - snapshots<2 → baselines=[] + actual=0
 *        - 事件找不到 → baselines=[]
 *        - 事件落尾 (post 段=0) → baselines=[]
 *        - 全 4 baseline + plan_stop_loss_pct=null → 3 baseline (无 plan)
 *        - meta 字段 1:1
 *   [7] appendSectionFilled / decidePostmortemStatus
 *        - 空 metadata / 已含本段 / 4 段全填升 'ok' / 缺段返 'partial' + reason
 *   [8] runCounterfactualBaselineService e2e (fake runner):
 *        (a) loadCandidates ok=false → success=false + error
 *        (b) loadCandidates throw → success=false + error
 *        (c) 无 candidates → success=true + reports_updated=0
 *        (d) dry_run=true → 不调 loadSnapshots / updateReport
 *        (e) candidate.event_scope!='portfolio' → skipped + 不调 loadSnapshots
 *        (f) scope_detail.portfolio_id 缺/非法 → skipped
 *        (g) loadSnapshots throw → skipped + 不抛
 *        (h) snapshots<2 → skipped
 *        (i) engine 返 baselines=[] (event 找不到) → skipped
 *        (j) loadUserPlanStopLossPct throw → plan_pct=null 但仍跑其它 3 baseline
 *        (k) updateReport ok=false → failed 累计, 整体 success=true
 *        (l) updateReport throw → failed 累计, 整体 success=true
 *        (m) 全成功路径 → reports_updated=candidates / actual+meta 写入 payload /
 *            metadata.sections_filled 累加不重复 / status 升级逻辑正确
 *        (n) event_id + lookback_hours 透传到 loadCandidates
 *        (o) metadata 透传到 row.metadata + calculator_version 覆盖
 *   [9] PRODUCTION runner smoke — 工厂返对象 + singleton
 *   [10] META-GUARD: cron registry 含 BLACK_SWAN_BASELINE + SchedulerService 含
 *        dispatch 分支 + service jsdoc 含 4 baseline 语义 + US-103/PR-014 +
 *        fail-OPEN + 与 BLACK_SWAN_POSTMORTEM 错峰说明 + 不擦其它段
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALL_POSTMORTEM_SECTIONS,
  BLACK_SWAN_BASELINE_CALCULATOR_VERSION,
  BLACK_SWAN_BASELINE_DEFAULT_LOOKBACK_HOURS,
  BLACK_SWAN_BASELINE_DEFAULT_PERFECT_LEAD_DAYS,
  BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_POST,
  BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_PRE,
  BLACK_SWAN_BASELINE_RECOMMENDED_CRON,
  BLACK_SWAN_BASELINE_SAMPLES_CAP,
  BaselinePortfolioSnapshot,
  BaselineReportUpdateRow,
  BaselineRunner,
  PartialPostmortemSnapshot,
  appendSectionFilled,
  buildCounterfactualBaselines,
  computeActual,
  computeDrawdown,
  computeHoldBaseline,
  computePerfectBaseline,
  computePlanBaseline,
  computeZeroBaseline,
  createProductionBaselineRunner,
  decidePostmortemStatus,
  downsampleSeries,
  findEventIndex,
  getProductionBaselineRunner,
  runCounterfactualBaselineService,
  safeNum,
} from '../../src/services/CounterfactualBaselineService';

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

function assertNear(name: string, actual: number, expected: number, eps = 1e-9): void {
  assert(name, Math.abs(actual - expected) <= eps, `actual=${actual} expected≈${expected}`);
}

// ============================================================================
// Fakes
// ============================================================================

function snap(date: string, total: number, cash = total, position = 0): BaselinePortfolioSnapshot {
  return { date, total_value: total, current_cash: cash, position_value: position };
}

function makePartial(overrides: Partial<PartialPostmortemSnapshot> = {}): PartialPostmortemSnapshot {
  return {
    id: 1,
    black_swan_event_id: 11,
    event_detected_at: new Date('2026-06-10T03:30:00Z'),
    event_scope: 'portfolio',
    event_scope_detail: { portfolio_id: 7, user_id: 3 },
    current_metadata: { sections_filled: ['event_summary'] },
    current_status: 'partial',
    ...overrides,
  };
}

interface FakeRunnerState {
  loadCalls: Array<{ asOf: Date; lookback_hours: number; event_id?: number }>;
  snapshotCalls: Array<{
    portfolio_id: number;
    event_detected_at: Date;
    window_days_pre: number;
    window_days_post: number;
  }>;
  planPctCalls: number[];
  updateCalls: BaselineReportUpdateRow[];
  loadResult:
    | { ok: true; candidates: PartialPostmortemSnapshot[] }
    | { ok: false; error: string };
  loadShouldThrow?: Error;
  snapshotsByPortfolio: Map<number, BaselinePortfolioSnapshot[] | Error>;
  planPctByUser: Map<number, number | null | Error>;
  updateResults: Array<{ ok: true } | { ok: false; error: string } | Error>;
}

function makeFakeRunner(overrides: Partial<FakeRunnerState> = {}): {
  runner: BaselineRunner;
  state: FakeRunnerState;
} {
  const state: FakeRunnerState = {
    loadCalls: [],
    snapshotCalls: [],
    planPctCalls: [],
    updateCalls: [],
    loadResult: { ok: true, candidates: [] },
    snapshotsByPortfolio: new Map(),
    planPctByUser: new Map(),
    updateResults: [],
    ...overrides,
  };
  const runner: BaselineRunner = {
    async loadCandidates(input) {
      state.loadCalls.push(input);
      if (state.loadShouldThrow) throw state.loadShouldThrow;
      return state.loadResult;
    },
    async loadSnapshots(input) {
      state.snapshotCalls.push(input);
      const v = state.snapshotsByPortfolio.get(input.portfolio_id);
      if (v instanceof Error) throw v;
      return v ?? [];
    },
    async loadUserPlanStopLossPct(user_id) {
      state.planPctCalls.push(user_id);
      const v = state.planPctByUser.get(user_id);
      if (v instanceof Error) throw v;
      return v ?? null;
    },
    async updateReport(row) {
      state.updateCalls.push(row);
      const idx = state.updateCalls.length - 1;
      const r =
        idx < state.updateResults.length ? state.updateResults[idx] : { ok: true as const };
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { runner, state };
}

// ============================================================================
// [1] safeNum
// ============================================================================
console.log('\n[1] safeNum');
{
  assertEqual('1.1 number passthrough', safeNum(3.14), 3.14);
  assertEqual('1.2 numeric string → number', safeNum('42'), 42);
  assertEqual('1.3 NaN → fallback 0', safeNum(NaN), 0);
  assertEqual('1.4 Infinity → fallback 0', safeNum(Infinity), 0);
  assertEqual('1.5 -Infinity → fallback 0', safeNum(-Infinity), 0);
  assertEqual('1.6 非数字字符串 → fallback 0', safeNum('abc'), 0);
  assertEqual('1.7 自定义 fallback', safeNum('abc', -1), -1);
  assertEqual('1.8 null → 0 (Number(null)=0 是 finite, 非 fallback)', safeNum(null, 5), 0);
  assertEqual('1.9 undefined → fallback (Number(undefined)=NaN)', safeNum(undefined, 5), 5);
  assertEqual('1.10 0 → 0 (非 fallback)', safeNum(0, 99), 0);
}

// ============================================================================
// [2] findEventIndex
// ============================================================================
console.log('\n[2] findEventIndex');
{
  const snaps = [
    snap('2026-06-08', 100),
    snap('2026-06-09', 101),
    snap('2026-06-10', 102),
    snap('2026-06-11', 103),
    snap('2026-06-12', 104),
  ];
  assertEqual('2.1 事件 == 中间日 → idx=2', findEventIndex(snaps, new Date('2026-06-10T03:30:00Z')), 2);
  assertEqual('2.2 事件 == 首日 → idx=0', findEventIndex(snaps, new Date('2026-06-08T03:30:00Z')), 0);
  assertEqual('2.3 事件 == 末日 → idx=4', findEventIndex(snaps, new Date('2026-06-12T03:30:00Z')), 4);
  assertEqual('2.4 事件 < 首日 → idx=0', findEventIndex(snaps, new Date('2026-06-01T00:00:00Z')), 0);
  assertEqual('2.5 事件 > 末日 → idx=-1', findEventIndex(snaps, new Date('2026-06-13T00:00:00Z')), -1);
  assertEqual('2.6 空 snapshots → idx=-1', findEventIndex([], new Date()), -1);
}

// ============================================================================
// [3] computeDrawdown
// ============================================================================
console.log('\n[3] computeDrawdown');
{
  const empty = computeDrawdown([]);
  assertEqual('3.1 空 → 0/0/0', empty, { max_drawdown: 0, peak_value: 0, trough_value: 0 });

  const single = computeDrawdown([100]);
  assertEqual('3.2 单点 → 0/100/100', single, { max_drawdown: 0, peak_value: 100, trough_value: 100 });

  const flat = computeDrawdown([100, 100, 100]);
  assertEqual('3.3 持平 → maxDd=0 / peak=100', flat.max_drawdown, 0);
  assertEqual('3.3b 持平 peak', flat.peak_value, 100);

  const up = computeDrawdown([100, 110, 120]);
  assertEqual('3.4 单调升 maxDd=0', up.max_drawdown, 0);
  assertEqual('3.4b 单调升 peak=120', up.peak_value, 120);

  const down = computeDrawdown([100, 90, 80]);
  // peak=100, trough=80, dd = (100-80)/100 = 0.2
  assertNear('3.5 单调跌 maxDd=0.2', down.max_drawdown, 0.2);
  assertEqual('3.5b 单调跌 peak=100', down.peak_value, 100);
  assertEqual('3.5c 单调跌 trough=80', down.trough_value, 80);

  const v = computeDrawdown([100, 90, 80, 90, 100]);
  assertNear('3.6 V 型 maxDd=0.2', v.max_drawdown, 0.2);
  assertEqual('3.6b V 型 peak=100', v.peak_value, 100);
  assertEqual('3.6c V 型 trough=80', v.trough_value, 80);

  const w = computeDrawdown([100, 80, 110, 77]); // 110→77 dd=0.3 > 100→80 dd=0.2
  assertNear('3.7 W 型 maxDd=0.3 (取最大)', w.max_drawdown, 0.3);
  assertEqual('3.7b W 型 peak=110 (new high)', w.peak_value, 110);
  assertEqual('3.7c W 型 trough=77', w.trough_value, 77);
}

// ============================================================================
// [4] downsampleSeries
// ============================================================================
console.log('\n[4] downsampleSeries');
{
  const series = [
    { date: 'a', value: 1 },
    { date: 'b', value: 2 },
    { date: 'c', value: 3 },
    { date: 'd', value: 4 },
    { date: 'e', value: 5 },
  ];
  assertEqual('4.1 cap=0 → []', downsampleSeries(series, 0), []);
  assertEqual('4.2 空 series → []', downsampleSeries([], 5), []);
  const eq = downsampleSeries(series, 5);
  assertEqual('4.3 cap == len → 全返且为拷贝', eq.length, 5);
  // 拷贝校验: mutate src 不影响输出
  const src2 = [{ date: 'x', value: 99 }];
  const out2 = downsampleSeries(src2, 5);
  src2[0].value = -1;
  assertEqual('4.4 拷贝独立 (mutate src 不动 out)', out2[0].value, 99);

  const longSeries = Array.from({ length: 100 }, (_, i) => ({ date: 'd' + i, value: i }));
  const ds = downsampleSeries(longSeries, 10);
  assertEqual('4.5 长 series → cap=10', ds.length, 10);
  assertEqual('4.5b 首尾保留 (首点)', ds[0].date, 'd0');
  assertEqual('4.5c 首尾保留 (末点)', ds[ds.length - 1].date, 'd99');
}

// ============================================================================
// [5] 4 baseline 算子 (hold / zero / plan / perfect)
// ============================================================================
console.log('\n[5] 4 baseline 算子');
{
  // 数值场景: 事件前 100/100/100, 事件落 idx=2 (=100), 之后跌到 95→90→85.
  const snaps = [
    snap('2026-06-08', 100, 100, 0),
    snap('2026-06-09', 100, 100, 0),
    snap('2026-06-10', 100, 30, 70),
    snap('2026-06-11', 95, 30, 65),
    snap('2026-06-12', 90, 30, 60),
    snap('2026-06-13', 85, 30, 55),
  ];
  const eventIdx = 2;

  // ---- hold ----
  const hold = computeHoldBaseline(snaps, eventIdx);
  assertEqual('5.1 hold.type', hold.type, 'hold');
  assertEqual('5.2 hold.pnl = 85-100 = -15', hold.pnl, -15);
  assertNear('5.3 hold.pnl_pct = -0.15', hold.pnl_pct, -0.15);
  assertNear('5.4 hold.max_drawdown ≈ 0.15 (100→85)', hold.max_drawdown, 0.15);
  assertEqual('5.5 hold.peak_value=100', hold.peak_value, 100);
  assertEqual('5.6 hold.trough_value=85', hold.trough_value, 85);
  assert('5.7 hold.samples 非空 + cap ≤ 10', hold.samples.length > 0 && hold.samples.length <= 10);

  // ---- zero (事件检出瞬间清仓 → 后续平直) ----
  const zero = computeZeroBaseline(snaps, eventIdx);
  assertEqual('5.8 zero.type', zero.type, 'zero');
  assertEqual('5.9 zero.pnl = 0 (清仓后不波动)', zero.pnl, 0);
  assertEqual('5.10 zero.pnl_pct = 0', zero.pnl_pct, 0);
  assertEqual('5.11 zero.max_drawdown = 0 (后段平直)', zero.max_drawdown, 0);
  // assumption 字段
  assertEqual('5.12 zero.assumptions.strategy', (zero.assumptions as any).strategy, 'sell_all_at_event');
  assertEqual('5.13 zero.assumptions.event_value=100', (zero.assumptions as any).event_value, 100);

  // ---- plan stop_loss_pct=0.05 (peak=100, 跌 5% 触发) ----
  const plan = computePlanBaseline(snaps, eventIdx, 0.05);
  assert('5.14 plan 非 null', plan !== null);
  if (plan) {
    assertEqual('5.15 plan.type', plan.type, 'plan');
    // peak=100, idx=3 v=95 (100-95)/100=0.05 >= 0.05 → 在 95 处止损, 后续平直
    assertEqual('5.16 plan.pnl = 95-100 = -5', plan.pnl, -5);
    assertNear('5.17 plan.pnl_pct = -0.05', plan.pnl_pct, -0.05);
    assertEqual('5.18 plan.assumptions.stopped=true', (plan.assumptions as any).stopped, true);
    assertEqual('5.19 plan.assumptions.stop_loss_pct=0.05', (plan.assumptions as any).stop_loss_pct, 0.05);
    assertEqual('5.20 plan.assumptions.stopped_value=95', (plan.assumptions as any).stopped_value, 95);
  }
  // plan = null 情况
  assertEqual('5.21 plan stop_loss_pct=null → null', computePlanBaseline(snaps, eventIdx, null), null);
  assertEqual('5.22 plan stop_loss_pct=0 → null', computePlanBaseline(snaps, eventIdx, 0), null);
  assertEqual('5.23 plan stop_loss_pct=NaN → null', computePlanBaseline(snaps, eventIdx, NaN), null);
  // 阈值太大 → 不触发, 跑到末尾
  const planNoTrigger = computePlanBaseline(snaps, eventIdx, 0.5);
  assert('5.24 plan 阈值太大 → 未触发', planNoTrigger !== null);
  if (planNoTrigger) {
    assertEqual('5.24b plan.assumptions.stopped=false', (planNoTrigger.assumptions as any).stopped, false);
  }

  // ---- perfect (lead=1, 在 idx=1 处清仓 @100) ----
  const perfect = computePerfectBaseline(snaps, eventIdx, 1);
  assertEqual('5.25 perfect.type', perfect.type, 'perfect');
  // leadIdx=1 lockValue=100; 之后曲线平直 100; eventIdx=2 start=100 end=100 pnl=0
  assertEqual('5.26 perfect.pnl = 0 (提前清仓)', perfect.pnl, 0);
  assertEqual('5.27 perfect.assumptions.lead_days=1', (perfect.assumptions as any).lead_days, 1);
  assertEqual('5.28 perfect.assumptions.lock_value=100', (perfect.assumptions as any).lock_value, 100);
  assertEqual('5.29 perfect.assumptions.lock_index=1', (perfect.assumptions as any).lock_index, 1);

  // lead 越界 → leadIdx=0 (clamp)
  const perfectBig = computePerfectBaseline(snaps, eventIdx, 99);
  assertEqual('5.30 perfect lead=99 → lock_index=0 (clamp)', (perfectBig.assumptions as any).lock_index, 0);

  // lead<=0 → fallback 1
  const perfectZero = computePerfectBaseline(snaps, eventIdx, 0);
  assertEqual('5.31 perfect lead=0 → lead_days=1 (fallback)', (perfectZero.assumptions as any).lead_days, 1);
  const perfectNan = computePerfectBaseline(snaps, eventIdx, NaN);
  assertEqual('5.32 perfect lead=NaN → lead_days=1 (fallback)', (perfectNan.assumptions as any).lead_days, 1);
}

// ============================================================================
// [6] buildCounterfactualBaselines engine
// ============================================================================
console.log('\n[6] buildCounterfactualBaselines engine');
{
  const eventAt = new Date('2026-06-10T03:30:00Z');

  // 6.1 snapshots<2 → baselines=[] + actual=0 + meta.snapshots_total<2
  const empty = buildCounterfactualBaselines({
    event_detected_at: eventAt,
    snapshots: [snap('2026-06-10', 100)],
  });
  assertEqual('6.1a snapshots=1 → baselines=[]', empty.baselines.length, 0);
  assertEqual('6.1b actual.pnl=0', empty.actual.pnl, 0);
  assertEqual('6.1c meta.snapshots_total=1', empty.meta.snapshots_total, 1);

  const zeroSnaps = buildCounterfactualBaselines({
    event_detected_at: eventAt,
    snapshots: [],
  });
  assertEqual('6.2 snapshots=0 → baselines=[]', zeroSnaps.baselines.length, 0);

  // 6.3 事件远在未来 → findEventIndex=-1 → baselines=[]
  const notFound = buildCounterfactualBaselines({
    event_detected_at: new Date('2099-01-01T00:00:00Z'),
    snapshots: [snap('2026-06-08', 100), snap('2026-06-09', 99)],
  });
  assertEqual('6.3 事件找不到 → baselines=[]', notFound.baselines.length, 0);

  // 6.4 事件落末日 → eventIdx == snapshots.length-1 → baselines=[]
  const lastDay = buildCounterfactualBaselines({
    event_detected_at: new Date('2026-06-09T03:30:00Z'),
    snapshots: [snap('2026-06-08', 100), snap('2026-06-09', 99)],
  });
  assertEqual('6.4 事件落末日 → baselines=[] (无 post 段)', lastDay.baselines.length, 0);

  // 6.5 全 4 baseline (plan_stop_loss_pct=0.05)
  const full = buildCounterfactualBaselines({
    event_detected_at: eventAt,
    snapshots: [
      snap('2026-06-08', 100, 100, 0),
      snap('2026-06-09', 100, 100, 0),
      snap('2026-06-10', 100, 30, 70),
      snap('2026-06-11', 95),
      snap('2026-06-12', 90),
      snap('2026-06-13', 85),
    ],
    plan_stop_loss_pct: 0.05,
  });
  assertEqual('6.5a 全 4 baseline.length=4', full.baselines.length, 4);
  const types = full.baselines.map(b => b.type);
  assertEqual('6.5b types 顺序 hold/zero/plan/perfect', types, ['hold', 'zero', 'plan', 'perfect']);
  assertEqual('6.5c meta.snapshots_total=6', full.meta.snapshots_total, 6);
  assertEqual('6.5d meta.plan_stop_loss_pct=0.05', full.meta.plan_stop_loss_pct, 0.05);
  assertEqual(
    '6.5e meta.perfect_lead_days=default',
    full.meta.perfect_lead_days,
    BLACK_SWAN_BASELINE_DEFAULT_PERFECT_LEAD_DAYS
  );
  assertEqual('6.5f meta.event_detected_at ISO', full.meta.event_detected_at, eventAt.toISOString());
  assertEqual('6.5g calculator_version', full.calculator_version, BLACK_SWAN_BASELINE_CALCULATOR_VERSION);
  // actual 与 hold 数值上等价 (hold = do-nothing = actual 曲线)
  assertEqual('6.5h actual.pnl == hold.pnl', full.actual.pnl, full.baselines[0].pnl);

  // 6.6 plan_stop_loss_pct=null → 3 baseline (无 plan)
  const noPlan = buildCounterfactualBaselines({
    event_detected_at: eventAt,
    snapshots: [
      snap('2026-06-09', 100),
      snap('2026-06-10', 100),
      snap('2026-06-11', 95),
      snap('2026-06-12', 90),
    ],
    plan_stop_loss_pct: null,
  });
  assertEqual('6.6a 无 plan → baselines.length=3', noPlan.baselines.length, 3);
  assertEqual('6.6b 无 plan → types', noPlan.baselines.map(b => b.type), ['hold', 'zero', 'perfect']);
  assertEqual('6.6c meta.plan_stop_loss_pct=null', noPlan.meta.plan_stop_loss_pct, null);

  // 6.7 perfect_lead_days override
  const customLead = buildCounterfactualBaselines({
    event_detected_at: eventAt,
    snapshots: [
      snap('2026-06-08', 100),
      snap('2026-06-09', 100),
      snap('2026-06-10', 100),
      snap('2026-06-11', 90),
    ],
    perfect_lead_days: 2,
  });
  assertEqual('6.7 perfect_lead_days override=2', customLead.meta.perfect_lead_days, 2);

  // 6.8 window_days override + 默认
  assertEqual(
    '6.8a window_days_pre default',
    full.meta.window_days_pre,
    BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_PRE
  );
  assertEqual(
    '6.8b window_days_post default',
    full.meta.window_days_post,
    BLACK_SWAN_BASELINE_DEFAULT_WINDOW_DAYS_POST
  );
  const customWin = buildCounterfactualBaselines({
    event_detected_at: eventAt,
    snapshots: [snap('2026-06-09', 100), snap('2026-06-10', 100), snap('2026-06-11', 95)],
    window_days_pre: 3,
    window_days_post: 7,
  });
  assertEqual('6.8c window_days_pre override=3', customWin.meta.window_days_pre, 3);
  assertEqual('6.8d window_days_post override=7', customWin.meta.window_days_post, 7);
}

// ============================================================================
// [7] appendSectionFilled / decidePostmortemStatus
// ============================================================================
console.log('\n[7] appendSectionFilled / decidePostmortemStatus');
{
  // 7.1 空 metadata
  const r1 = appendSectionFilled({}, 'counterfactual_baselines');
  assertEqual('7.1a sections_filled=[本段]', r1.sections_filled, ['counterfactual_baselines']);
  assertEqual('7.1b merged_metadata.sections_filled', (r1.merged_metadata as any).sections_filled, [
    'counterfactual_baselines',
  ]);

  // 7.2 已含本段 → 不重复
  const r2 = appendSectionFilled(
    { sections_filled: ['event_summary', 'counterfactual_baselines'] },
    'counterfactual_baselines'
  );
  assertEqual('7.2 已含 → 不重复', r2.sections_filled.sort(), [
    'counterfactual_baselines',
    'event_summary',
  ]);

  // 7.3 含 event_summary, 累加本段
  const r3 = appendSectionFilled({ sections_filled: ['event_summary'] }, 'counterfactual_baselines');
  assertEqual('7.3 累加', r3.sections_filled.sort(), ['counterfactual_baselines', 'event_summary']);

  // 7.4 sections_filled 非数组 → 兜底成 [本段]
  const r4 = appendSectionFilled({ sections_filled: 'not-array' as unknown as string[] }, 'x');
  assertEqual('7.4 非数组兜底', r4.sections_filled, ['x']);

  // 7.5 数组内非 string 项 → 过滤
  const r5 = appendSectionFilled(
    { sections_filled: ['event_summary', 123 as unknown as string, null] },
    'counterfactual_baselines'
  );
  assertEqual('7.5 非 string 项过滤', r5.sections_filled.sort(), [
    'counterfactual_baselines',
    'event_summary',
  ]);

  // 7.6 保留其它 metadata key
  const r6 = appendSectionFilled({ foo: 'bar', sections_filled: [] }, 'event_summary');
  assertEqual('7.6 保留其它 key', (r6.merged_metadata as any).foo, 'bar');

  // 7.7 decidePostmortemStatus — 4 段全 → ok / reason=null
  const ok = decidePostmortemStatus(Array.from(ALL_POSTMORTEM_SECTIONS));
  assertEqual('7.7a 4 段全 → status=ok', ok.status, 'ok');
  assertEqual('7.7b 4 段全 → reason=null', ok.reason, null);

  // 7.8 缺段 → partial + reason 含 pending_sections
  const p = decidePostmortemStatus(['event_summary', 'counterfactual_baselines']);
  assertEqual('7.8a 缺段 → status=partial', p.status, 'partial');
  assert(
    '7.8b reason 含 pending_sections + 缺的段名',
    Boolean(p.reason && p.reason.includes('pending_sections') && p.reason.includes('event_timeline'))
  );

  // 7.9 空 sections_filled → partial
  const p2 = decidePostmortemStatus([]);
  assertEqual('7.9 空 → partial', p2.status, 'partial');

  // 7.10 ALL_POSTMORTEM_SECTIONS frozen
  assert('7.10 ALL_POSTMORTEM_SECTIONS 已 freeze', Object.isFrozen(ALL_POSTMORTEM_SECTIONS));
}

// ============================================================================
// [8] runCounterfactualBaselineService e2e (fake runner)
// ============================================================================
async function run8(): Promise<void> {
  console.log('\n[8] runCounterfactualBaselineService e2e');

  // (a) loadCandidates ok=false
  {
    const { runner } = makeFakeRunner({ loadResult: { ok: false, error: 'db_down' } });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8a.1 success=false', r.success, false);
    assert('8a.2 error 含 candidates_query_failed', Boolean(r.error && r.error.includes('candidates_query_failed')));
    assert('8a.3 error 含原 error', Boolean(r.error && r.error.includes('db_down')));
    assertEqual('8a.4 candidates_total=0', r.candidates_total, 0);
  }

  // (b) loadCandidates throw
  {
    const { runner } = makeFakeRunner({ loadShouldThrow: new Error('network_blown') });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8b.1 success=false', r.success, false);
    assert('8b.2 error 含 candidates_query_failed', Boolean(r.error && r.error.includes('candidates_query_failed')));
    assert('8b.3 error 含原 throw', Boolean(r.error && r.error.includes('network_blown')));
  }

  // (c) 无 candidates
  {
    const { runner } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8c.1 success=true', r.success, true);
    assertEqual('8c.2 candidates_total=0', r.candidates_total, 0);
    assertEqual('8c.3 reports_updated=0', r.reports_updated, 0);
  }

  // (d) dry_run=true → 不调 loadSnapshots / updateReport
  {
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial(), makePartial({ id: 2, black_swan_event_id: 12 })] },
    });
    const r = await runCounterfactualBaselineService(runner, { dry_run: true });
    assertEqual('8d.1 success=true', r.success, true);
    assertEqual('8d.2 dry_run=true', r.dry_run, true);
    assertEqual('8d.3 candidates_total=2', r.candidates_total, 2);
    assertEqual('8d.4 reports_updated=0 (dry)', r.reports_updated, 0);
    assertEqual('8d.5 不调 loadSnapshots', state.snapshotCalls.length, 0);
    assertEqual('8d.6 不调 updateReport', state.updateCalls.length, 0);
  }

  // (e) candidate.event_scope!='portfolio' → skipped + 不调 loadSnapshots
  {
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial({ event_scope: 'symbol' })] },
    });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8e.1 reports_skipped=1', r.reports_skipped, 1);
    assertEqual('8e.2 reports_updated=0', r.reports_updated, 0);
    assertEqual('8e.3 不调 loadSnapshots', state.snapshotCalls.length, 0);
    assertEqual('8e.4 success=true', r.success, true);
  }

  // (f) scope_detail.portfolio_id 缺/非法 → skipped
  {
    const { runner, state } = makeFakeRunner({
      loadResult: {
        ok: true,
        candidates: [
          makePartial({ id: 1, event_scope_detail: {} }),
          makePartial({ id: 2, event_scope_detail: { portfolio_id: -5 } }),
          makePartial({ id: 3, event_scope_detail: { portfolio_id: 'abc' } }),
        ],
      },
    });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8f.1 全部 3 条 skipped', r.reports_skipped, 3);
    assertEqual('8f.2 不调 loadSnapshots', state.snapshotCalls.length, 0);
  }

  // (g) loadSnapshots throw → skipped + 不抛
  {
    const snapsMap = new Map<number, BaselinePortfolioSnapshot[] | Error>();
    snapsMap.set(7, new Error('snap_db_down'));
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      snapshotsByPortfolio: snapsMap,
    });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8g.1 success=true (不抛)', r.success, true);
    assertEqual('8g.2 reports_skipped=1', r.reports_skipped, 1);
  }

  // (h) snapshots<2 → skipped
  {
    const snapsMap = new Map<number, BaselinePortfolioSnapshot[]>();
    snapsMap.set(7, [snap('2026-06-10', 100)]);
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      snapshotsByPortfolio: snapsMap as Map<number, BaselinePortfolioSnapshot[] | Error>,
    });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8h.1 snapshots<2 → skipped', r.reports_skipped, 1);
  }

  // (i) engine 返 baselines=[] (event 找不到 — 事件远在未来)
  {
    const snapsMap = new Map<number, BaselinePortfolioSnapshot[]>();
    snapsMap.set(7, [snap('2020-01-01', 100), snap('2020-01-02', 99), snap('2020-01-03', 98)]);
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      snapshotsByPortfolio: snapsMap as Map<number, BaselinePortfolioSnapshot[] | Error>,
    });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8i.1 engine baselines=[] → skipped', r.reports_skipped, 1);
  }

  // (j) loadUserPlanStopLossPct throw → plan_pct=null, 仍跑其它 3 baseline
  {
    const snapsMap = new Map<number, BaselinePortfolioSnapshot[]>();
    snapsMap.set(7, [
      snap('2026-06-08', 100),
      snap('2026-06-09', 100),
      snap('2026-06-10', 100),
      snap('2026-06-11', 90),
      snap('2026-06-12', 85),
    ]);
    const planMap = new Map<number, number | null | Error>();
    planMap.set(3, new Error('user_db_down'));
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      snapshotsByPortfolio: snapsMap as Map<number, BaselinePortfolioSnapshot[] | Error>,
      planPctByUser: planMap,
    });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8j.1 success=true (plan throw 不阻塞)', r.success, true);
    assertEqual('8j.2 reports_updated=1', r.reports_updated, 1);
    assertEqual('8j.3 调用了 updateReport 1 次', state.updateCalls.length, 1);
    const baselines = state.updateCalls[0].counterfactual_baselines.baselines;
    assertEqual('8j.4 baselines.length=3 (无 plan)', baselines.length, 3);
    assertEqual(
      '8j.5 types 不含 plan',
      baselines.map(b => b.type).sort(),
      ['hold', 'perfect', 'zero']
    );
    assertEqual(
      '8j.6 meta.plan_stop_loss_pct=null',
      state.updateCalls[0].counterfactual_baselines.meta.plan_stop_loss_pct,
      null
    );
  }

  // (k) updateReport ok=false → failed 累计, 整体 success=true
  {
    const snapsMap = new Map<number, BaselinePortfolioSnapshot[]>();
    snapsMap.set(7, [
      snap('2026-06-09', 100),
      snap('2026-06-10', 100),
      snap('2026-06-11', 90),
      snap('2026-06-12', 85),
    ]);
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      snapshotsByPortfolio: snapsMap as Map<number, BaselinePortfolioSnapshot[] | Error>,
      updateResults: [{ ok: false, error: 'unique_violation' }],
    });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8k.1 success=true', r.success, true);
    assertEqual('8k.2 reports_failed=1', r.reports_failed, 1);
    assertEqual('8k.3 reports_updated=0', r.reports_updated, 0);
  }

  // (l) updateReport throw → failed 累计, success=true
  {
    const snapsMap = new Map<number, BaselinePortfolioSnapshot[]>();
    snapsMap.set(7, [
      snap('2026-06-09', 100),
      snap('2026-06-10', 100),
      snap('2026-06-11', 90),
      snap('2026-06-12', 85),
    ]);
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      snapshotsByPortfolio: snapsMap as Map<number, BaselinePortfolioSnapshot[] | Error>,
      updateResults: [new Error('sequelize_explode')],
    });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8l.1 success=true (不抛)', r.success, true);
    assertEqual('8l.2 reports_failed=1', r.reports_failed, 1);
  }

  // (m) 全成功路径 + 多条 + sections_filled 累加 + status 升级
  {
    const snapsMap = new Map<number, BaselinePortfolioSnapshot[]>();
    snapsMap.set(7, [
      snap('2026-06-08', 100),
      snap('2026-06-09', 100),
      snap('2026-06-10', 100),
      snap('2026-06-11', 95),
      snap('2026-06-12', 90),
    ]);
    snapsMap.set(8, [
      snap('2026-06-08', 200),
      snap('2026-06-09', 200),
      snap('2026-06-10', 200),
      snap('2026-06-11', 195),
      snap('2026-06-12', 190),
    ]);
    const planMap = new Map<number, number | null | Error>();
    planMap.set(3, 0.05);
    planMap.set(4, null);
    const { runner, state } = makeFakeRunner({
      loadResult: {
        ok: true,
        candidates: [
          makePartial({ id: 100, event_scope_detail: { portfolio_id: 7, user_id: 3 } }),
          makePartial({
            id: 200,
            event_scope_detail: { portfolio_id: 8, user_id: 4 },
            // 3 段已填 → 加本段后 4 段全 → status 升 'ok'
            current_metadata: {
              sections_filled: ['event_summary', 'event_timeline', 'improvement_suggestions'],
            },
          }),
        ],
      },
      snapshotsByPortfolio: snapsMap as Map<number, BaselinePortfolioSnapshot[] | Error>,
      planPctByUser: planMap,
    });
    const r = await runCounterfactualBaselineService(runner, {});
    assertEqual('8m.1 success=true', r.success, true);
    assertEqual('8m.2 candidates_total=2', r.candidates_total, 2);
    assertEqual('8m.3 reports_updated=2', r.reports_updated, 2);
    assertEqual('8m.4 reports_failed=0', r.reports_failed, 0);
    assertEqual('8m.5 reports_skipped=0', r.reports_skipped, 0);
    assertEqual('8m.6 updateCalls.length=2', state.updateCalls.length, 2);

    // 行 1 (id=100): 2 段累加 → partial; 含 plan baseline (planPctByUser=0.05)
    const row1 = state.updateCalls[0];
    assertEqual('8m.7a id 透传', row1.id, 100);
    assertEqual('8m.7b status=partial (2/4 段)', row1.status, 'partial');
    assert('8m.7c reason 含 pending_sections', Boolean(row1.reason && row1.reason.includes('pending_sections')));
    assertEqual(
      '8m.7d sections_filled 累加 (event_summary + 本段)',
      (row1.metadata as any).sections_filled.sort(),
      ['counterfactual_baselines', 'event_summary']
    );
    assertEqual(
      '8m.7e calculator_version 覆盖到 metadata',
      (row1.metadata as any).calculator_version,
      BLACK_SWAN_BASELINE_CALCULATOR_VERSION
    );
    assert(
      '8m.7f counterfactual_baselines_filled_at_iso 已写',
      typeof (row1.metadata as any).counterfactual_baselines_filled_at_iso === 'string'
    );
    assertEqual('8m.7g baselines.length=4 (含 plan)', row1.counterfactual_baselines.baselines.length, 4);
    assertEqual(
      '8m.7h plan stop_loss_pct=0.05',
      row1.counterfactual_baselines.meta.plan_stop_loss_pct,
      0.05
    );
    assert(
      '8m.7i actual.pnl 已计算 (非默认 0)',
      row1.counterfactual_baselines.actual.pnl !== 0
    );

    // 行 2 (id=200): 4 段全填 → status='ok' / reason=null; planPct=null → 3 baseline
    const row2 = state.updateCalls[1];
    assertEqual('8m.8a id 透传', row2.id, 200);
    assertEqual('8m.8b status=ok (4/4 段)', row2.status, 'ok');
    assertEqual('8m.8c reason=null', row2.reason, null);
    assertEqual(
      '8m.8d sections_filled 4 段全',
      (row2.metadata as any).sections_filled.sort(),
      ['counterfactual_baselines', 'event_summary', 'event_timeline', 'improvement_suggestions']
    );
    assertEqual('8m.8e baselines.length=3 (无 plan)', row2.counterfactual_baselines.baselines.length, 3);

    // payload 只含约定的 5 列 — 不出现 event_summary/event_timeline/improvement_suggestions
    assert('8m.9a row 不含 event_summary key', !('event_summary' in row1));
    assert('8m.9b row 不含 event_timeline key', !('event_timeline' in row1));
    assert('8m.9c row 不含 improvement_suggestions key', !('improvement_suggestions' in row1));
  }

  // (n) event_id + lookback_hours 透传到 loadCandidates
  {
    const { runner, state } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    await runCounterfactualBaselineService(runner, { event_id: 42, lookback_hours: 72 });
    assertEqual('8n.1 loadCalls.length=1', state.loadCalls.length, 1);
    assertEqual('8n.2 event_id 透传', state.loadCalls[0].event_id, 42);
    assertEqual('8n.3 lookback_hours 透传', state.loadCalls[0].lookback_hours, 72);

    const { runner: r2, state: s2 } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    await runCounterfactualBaselineService(r2, {});
    assertEqual(
      '8n.4 lookback_hours 默认值',
      s2.loadCalls[0].lookback_hours,
      BLACK_SWAN_BASELINE_DEFAULT_LOOKBACK_HOURS
    );

    const { runner: r3, state: s3 } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    await runCounterfactualBaselineService(r3, { lookback_hours: -10 });
    assertEqual(
      '8n.5 非法 lookback_hours fallback 到默认',
      s3.loadCalls[0].lookback_hours,
      BLACK_SWAN_BASELINE_DEFAULT_LOOKBACK_HOURS
    );
  }

  // (o) metadata 透传到 row.metadata
  {
    const snapsMap = new Map<number, BaselinePortfolioSnapshot[]>();
    snapsMap.set(7, [
      snap('2026-06-09', 100),
      snap('2026-06-10', 100),
      snap('2026-06-11', 90),
      snap('2026-06-12', 85),
    ]);
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      snapshotsByPortfolio: snapsMap as Map<number, BaselinePortfolioSnapshot[] | Error>,
    });
    const customAt = new Date('2026-07-01T12:00:00Z');
    await runCounterfactualBaselineService(runner, {
      metadata: { cron_run_id: 999, service_version: 'PR-014/v1' },
      generated_at: customAt,
    });
    const md = state.updateCalls[0].metadata as any;
    assertEqual('8o.1 metadata.cron_run_id 透传', md.cron_run_id, 999);
    assertEqual('8o.2 metadata.service_version 透传', md.service_version, 'PR-014/v1');
    // calculator_version 由 service 强制写入, 不被 metadata 覆盖
    assertEqual(
      '8o.3 calculator_version 由 service 强制',
      md.calculator_version,
      BLACK_SWAN_BASELINE_CALCULATOR_VERSION
    );
    // generated_at 覆盖到 row
    assertEqual('8o.4 generated_at 覆盖', state.updateCalls[0].generated_at.toISOString(), customAt.toISOString());
  }
}

// ============================================================================
// [9] PRODUCTION runner smoke
// ============================================================================
async function run9(): Promise<void> {
  console.log('\n[9] PRODUCTION runner smoke');
  const r = createProductionBaselineRunner();
  assert('9.1 createProductionBaselineRunner 返对象', typeof r === 'object' && r !== null);
  assert('9.2 含 loadCandidates', typeof r.loadCandidates === 'function');
  assert('9.3 含 loadSnapshots', typeof r.loadSnapshots === 'function');
  assert('9.4 含 loadUserPlanStopLossPct', typeof r.loadUserPlanStopLossPct === 'function');
  assert('9.5 含 updateReport', typeof r.updateReport === 'function');
  // singleton
  const s1 = getProductionBaselineRunner();
  const s2 = getProductionBaselineRunner();
  assert('9.6 singleton 同一实例', s1 === s2);
  // loadCandidates 在脱 DB 环境下走 try/catch 返 ok:false (不抛)
  const lc = await s1.loadCandidates({ asOf: new Date(), lookback_hours: 24 });
  assert('9.7 loadCandidates 脱 DB → ok:false 或 ok:true (永不抛)', typeof lc === 'object' && 'ok' in lc);
}

// ============================================================================
// [10] META-GUARD (源文件正则扫 — 与 sister test 同款)
// ============================================================================
console.log('\n[10] META-GUARD');
{
  const ROOT = join(__dirname, '../..');
  const SCHEDULER_SRC = readFileSync(join(ROOT, 'src/services/SchedulerService.ts'), 'utf8');
  const SERVICE_SRC = readFileSync(
    join(ROOT, 'src/services/CounterfactualBaselineService.ts'),
    'utf8'
  );
  const REGISTRY_SRC = readFileSync(join(ROOT, 'src/constants/cronRegistry.ts'), 'utf8');

  // 10.1 cronRegistry 含 BLACK_SWAN_BASELINE type
  assert(
    '10.1 cronRegistry 含 BLACK_SWAN_BASELINE',
    REGISTRY_SRC.includes("type: 'BLACK_SWAN_BASELINE'")
  );
  // 10.2 cronRegistry recommendedCron 与常量一致
  assert(
    '10.2 cronRegistry recommendedCron 与常量一致',
    REGISTRY_SRC.includes(`recommendedCron: '${BLACK_SWAN_BASELINE_RECOMMENDED_CRON}'`)
  );
  // 10.3 cronRegistry 与 BLACK_SWAN_POSTMORTEM 错峰 10min (本 23,53 vs PR-013 13,43)
  assert(
    '10.3 错峰 BLACK_SWAN_POSTMORTEM (13,43 vs 23,53)',
    REGISTRY_SRC.includes("recommendedCron: '13,43 * * * *'") &&
      REGISTRY_SRC.includes("recommendedCron: '23,53 * * * *'")
  );
  // 10.4 SchedulerService 含 dispatch 分支
  assert(
    '10.4 SchedulerService dispatch 分支',
    SCHEDULER_SRC.includes("task.type === 'BLACK_SWAN_BASELINE'")
  );
  // 10.5 SchedulerService lazy-require
  assert(
    '10.5 SchedulerService lazy-require runCounterfactualBaselineService',
    SCHEDULER_SRC.includes('runCounterfactualBaselineService') &&
      SCHEDULER_SRC.includes("require('./CounterfactualBaselineService')")
  );
  // 10.6 SchedulerService 透传 dry_run + event_id + lookback_hours
  assert(
    '10.6 SchedulerService 透传 dry_run + event_id + lookback_hours',
    /dry_run:\s*dryRunBl/.test(SCHEDULER_SRC) &&
      /event_id:\s*eventIdBl/.test(SCHEDULER_SRC) &&
      /lookback_hours:/.test(SCHEDULER_SRC)
  );
  // 10.7 Service jsdoc 含 US-103 / PR-014
  assert(
    '10.7 Service jsdoc 含 US-103/PR-014',
    SERVICE_SRC.includes('US-103') && SERVICE_SRC.includes('PR-014')
  );
  // 10.8 Service jsdoc 含 4 baseline 语义
  assert(
    '10.8 Service jsdoc 含 hold/zero/plan/perfect 4 baseline',
    SERVICE_SRC.includes('hold') &&
      SERVICE_SRC.includes('zero') &&
      SERVICE_SRC.includes('plan') &&
      SERVICE_SRC.includes('perfect')
  );
  // 10.9 Service 标 fail-OPEN
  assert('10.9 Service 标 fail-OPEN', SERVICE_SRC.includes('fail-OPEN'));
  // 10.10 Service 标 idempotent (UNIQUE 复用 PR-013 表)
  assert(
    '10.10 Service 标 idempotent + sections_filled',
    SERVICE_SRC.includes('idempotent') && SERVICE_SRC.includes('sections_filled')
  );
  // 10.11 Service 标与 PR-015/016 分工
  assert(
    '10.11 Service 标 PR-015 / PR-016 分工',
    SERVICE_SRC.includes('PR-015') && SERVICE_SRC.includes('PR-016')
  );
  // 10.12 Service 标"其它段不擦" (payload 仅含本段)
  assert(
    '10.12 Service 标不擦其它 JSONB 段',
    /不动它们|不擦/.test(SERVICE_SRC)
  );
  // 10.13 Service 标与 BLACK_SWAN_POSTMORTEM 错峰
  assert(
    '10.13 Service 标错峰 BLACK_SWAN_POSTMORTEM',
    SERVICE_SRC.includes('BLACK_SWAN_POSTMORTEM') && SERVICE_SRC.includes('错峰')
  );
  // 10.14 cap 常量 = 10
  assertEqual('10.14 BLACK_SWAN_BASELINE_SAMPLES_CAP=10', BLACK_SWAN_BASELINE_SAMPLES_CAP, 10);
  // 10.15 ALL_POSTMORTEM_SECTIONS 4 段
  assertEqual('10.15 ALL_POSTMORTEM_SECTIONS.length=4', ALL_POSTMORTEM_SECTIONS.length, 4);
}

// ============================================================================
// Async wrapper
// ============================================================================
(async () => {
  await run8();
  await run9();

  console.log(`\n[CounterfactualBaselineService] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error('test crashed:', err);
  process.exit(1);
});
