/**
 * ThemeFermentationDetector 单元测试 (PR-O5 / 2026-06-30)
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/theme-fermentation-detector.test.ts
 *
 * 完全脱 DB — ThemeFermentationDataSource 全 stub.
 *
 * 覆盖维度 (~80 case):
 *   - 纯 helpers: safeNum / classifyPhase 5 阶段全分支 + 边界 + 阈值守卫
 *   - rankIndustriesByHeat (top-N + 空 / 同分)
 *   - detectMainlineSwitch (主线切换 + 空昨日 + 配对正确性)
 *   - runOnce e2e: 空 / 多 industry / 单 industry throw / dry_run /
 *     昨日缺失退化 / phase distribution / mainline 标记 / mainline switch events
 *   - 阈值守卫 — PHASE_THRESHOLDS export 不变, 防回归
 *   - 标签 / icon export 字典完整 (5 个)
 *   - meta-guard: model 列定义 / migration SQL / config/database.ts 注册
 */

import {
  ThemeFermentationDetector,
  ThemeFermentationDataSource,
  ThemeFermentationRecord,
  IndustrySentimentSnapshot,
  PhaseClassification,
  FermentationPhase,
  MainlineSwitchEvent,
  PHASE_THRESHOLDS,
  FERMENTATION_PHASES,
  FERMENTATION_PHASE_LABELS,
  FERMENTATION_PHASE_ICONS,
  classifyPhase,
  detectMainlineSwitch,
  rankIndustriesByHeat,
  safeNum,
} from '../../src/services/ThemeFermentationDetector';
import * as fs from 'fs';
import * as path from 'path';

let ok = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function assertEqual(name: string, got: any, want: any): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`);
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeDSData {
  todaySentiment?: IndustrySentimentSnapshot[];
  prevPhases?: Array<{ industry: string; phase: FermentationPhase; lim_up_count: number }>;
  listSentimentThrow?: string;
  listPrevPhasesThrow?: string;
  upsertThrowIndustries?: Set<string>;
}

interface FakeDSCalls {
  upserted: ThemeFermentationRecord[];
}

function makeFakeDS(data: FakeDSData = {}): {
  ds: ThemeFermentationDataSource;
  calls: FakeDSCalls;
} {
  const calls: FakeDSCalls = { upserted: [] };
  const ds: ThemeFermentationDataSource = {
    async listSentimentByDate() {
      if (data.listSentimentThrow) throw new Error(data.listSentimentThrow);
      return data.todaySentiment || [];
    },
    async listPreviousPhases() {
      if (data.listPrevPhasesThrow) throw new Error(data.listPrevPhasesThrow);
      return data.prevPhases || [];
    },
    async upsertPhase(rec: ThemeFermentationRecord) {
      if (data.upsertThrowIndustries && data.upsertThrowIndustries.has(rec.industry)) {
        throw new Error(`upsert mock fail: ${rec.industry}`);
      }
      calls.upserted.push(rec);
    },
  };
  return { ds, calls };
}

/** 标准 snapshot 工厂 — 覆盖默认值, 便于 case 仅覆盖差异. */
function snap(overrides: Partial<IndustrySentimentSnapshot> = {}): IndustrySentimentSnapshot {
  return {
    trade_date: '2026-06-29',
    industry: '半导体',
    lim_up_count: 0,
    consecutive_max: 0,
    seal_rate: 0,
    lim_up_failure_rate: 0,
    industry_momentum_30d: null,
    composite_score: 0,
    top_codes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test: safeNum
// ---------------------------------------------------------------------------
function testSafeNum() {
  assertEqual('safeNum int', safeNum(5), 5);
  assertEqual('safeNum string num', safeNum('3.14'), 3.14);
  assertEqual('safeNum null', safeNum(null), 0);
  assertEqual('safeNum undefined', safeNum(undefined), 0);
  assertEqual('safeNum NaN', safeNum(NaN), 0);
  assertEqual('safeNum Infinity', safeNum(Infinity), 0);
  assertEqual('safeNum garbage', safeNum('abc'), 0);
  assertEqual('safeNum fallback custom', safeNum(undefined, -1), -1);
  assertEqual('safeNum 0 is 0', safeNum(0), 0);
  assertEqual('safeNum negative', safeNum(-3.5), -3.5);
}

// ---------------------------------------------------------------------------
// Test: classifyPhase — 5 阶段 + 边界
// ---------------------------------------------------------------------------
function testClassifyPhase() {
  // -- germinate --
  assertEqual(
    'germinate — lim_up=0',
    classifyPhase(snap({ lim_up_count: 0 })).phase,
    'germinate'
  );
  assertEqual(
    'germinate — lim_up=0 even with high composite',
    classifyPhase(snap({ lim_up_count: 0, composite_score: 4 })).phase,
    'germinate'
  );

  // -- launch -- 1-4 涨停 (< outbreak_lim_up_min=5)
  assertEqual(
    'launch — 1 涨停',
    classifyPhase(snap({ lim_up_count: 1 })).phase,
    'launch'
  );
  assertEqual(
    'launch — 3 涨停',
    classifyPhase(snap({ lim_up_count: 3 })).phase,
    'launch'
  );
  assertEqual(
    'launch — 4 涨停 boundary',
    classifyPhase(snap({ lim_up_count: 4, consecutive_max: 1 })).phase,
    'launch'
  );

  // -- outbreak --
  assertEqual(
    'outbreak — 5 涨停 + 2 连板',
    classifyPhase(snap({ lim_up_count: 5, consecutive_max: 2 })).phase,
    'outbreak'
  );
  assertEqual(
    'outbreak — 8 涨停 + 3 连板',
    classifyPhase(snap({ lim_up_count: 8, consecutive_max: 3 })).phase,
    'outbreak'
  );
  // outbreak 用 composite 通道触发 (consecutive_max 不够但 composite 高)
  assertEqual(
    'outbreak — composite 高通道',
    classifyPhase(snap({ lim_up_count: 6, consecutive_max: 1, composite_score: 3 })).phase,
    'outbreak'
  );
  // lim_up 够但 consecutive + composite 都不够 → launch fallback
  assertEqual(
    'outbreak fallback — lim_up=5 但 cons=1 + comp=0 → launch',
    classifyPhase(snap({ lim_up_count: 5, consecutive_max: 1, composite_score: 0 })).phase,
    'launch'
  );

  // -- climax --
  assertEqual(
    'climax — 10+ 涨停 + 4 连板',
    classifyPhase(snap({ lim_up_count: 10, consecutive_max: 4 })).phase,
    'climax'
  );
  assertEqual(
    'climax — 15 涨停 + 6 连板',
    classifyPhase(snap({ lim_up_count: 15, consecutive_max: 6 })).phase,
    'climax'
  );
  // climax 单 fail (涨停够但 cons 不够) → outbreak
  assertEqual(
    'climax fail — 10 涨停 + 3 连板 → outbreak',
    classifyPhase(snap({ lim_up_count: 10, consecutive_max: 3 })).phase,
    'outbreak'
  );
  // climax 单 fail (cons 够但涨停不够) → outbreak (5+, 2+ 仍满足) or recession
  assertEqual(
    'climax fail — 9 涨停 + 5 连板 → outbreak',
    classifyPhase(snap({ lim_up_count: 9, consecutive_max: 5 })).phase,
    'outbreak'
  );

  // -- recession 触发 1: 炸板率 > 50% 且 lim_up < 5 --
  assertEqual(
    'recession — 3 涨停 + 60% 炸板',
    classifyPhase(snap({ lim_up_count: 3, lim_up_failure_rate: 0.6 })).phase,
    'recession'
  );
  // 炸板率不够 (50% 边界, 严格 >) → launch
  assertEqual(
    'recession 边界 — 3 涨停 + 50% 炸板 (严格 > 守卫) → launch',
    classifyPhase(snap({ lim_up_count: 3, lim_up_failure_rate: 0.5 })).phase,
    'launch'
  );
  // lim_up=0 + 高炸板率: 但 lim_up=0 ⇒ recession 触发 1 要求 lim_up > 0
  assertEqual(
    'recession 触发1 — lim_up=0 不算 (没有涨停就没有炸板可言) → germinate',
    classifyPhase(snap({ lim_up_count: 0, lim_up_failure_rate: 0.8 })).phase,
    'germinate'
  );

  // -- recession 触发 2: 较昨日减半 --
  assertEqual(
    'recession 触发2 — 今日 2 / 昨日 10 (减半)',
    classifyPhase(
      snap({ lim_up_count: 2 }),
      { lim_up_count: 10, phase: 'outbreak' }
    ).phase,
    'recession'
  );
  assertEqual(
    'recession 触发2 — 今日 4 / 昨日 8 (减半)',
    classifyPhase(
      snap({ lim_up_count: 3 }),
      { lim_up_count: 8, phase: 'outbreak' }
    ).phase,
    'recession'
  );
  // 减半不够 — 今日 4 / 昨日 8 → 4 < 8*0.5=4 严格 < 不满足 → launch
  assertEqual(
    'recession 触发2 不满足边界 — 今日 4 / 昨日 8 (不严格小于 4) → launch',
    classifyPhase(
      snap({ lim_up_count: 4 }),
      { lim_up_count: 8, phase: 'outbreak' }
    ).phase,
    'launch'
  );
  // 昨日基数太小 (< 5) 不触发 recession 触发 2
  assertEqual(
    'recession 触发2 — 昨日 4 不算 base (< recession_yesterday_lim_up_min=5)',
    classifyPhase(
      snap({ lim_up_count: 1 }),
      { lim_up_count: 4, phase: 'launch' }
    ).phase,
    'launch'
  );

  // recession 优先于 outbreak 判定 — 今日 6 涨停 + 高炸板率 → 仍 outbreak (因 recession 触发条件 lim_up < 5)
  assertEqual(
    'recession 优先性 — lim_up=6 高炸板 不算 recession (lim_up 仍多)',
    classifyPhase(snap({ lim_up_count: 6, consecutive_max: 2, lim_up_failure_rate: 0.8 })).phase,
    'outbreak'
  );

  // -- 阈值精确 boundary --
  assertEqual(
    'launch 边界下 — lim_up=1',
    classifyPhase(snap({ lim_up_count: 1 })).phase,
    'launch'
  );
  assertEqual(
    'outbreak 边界 — lim_up=5 + cons=2',
    classifyPhase(snap({ lim_up_count: 5, consecutive_max: 2 })).phase,
    'outbreak'
  );
  assertEqual(
    'climax 边界 — lim_up=10 + cons=4',
    classifyPhase(snap({ lim_up_count: 10, consecutive_max: 4 })).phase,
    'climax'
  );

  // -- decision_inputs 透传 --
  const cls = classifyPhase(snap({ lim_up_count: 7, consecutive_max: 3, composite_score: 2.8 }), {
    lim_up_count: 5,
    phase: 'launch',
  });
  assert('decision_inputs lim_up', cls.decision_inputs.lim_up_count === 7);
  assert('decision_inputs cons', cls.decision_inputs.consecutive_max === 3);
  assert('decision_inputs y_lim_up', cls.decision_inputs.yesterday_lim_up_count === 5);
  assert('decision_inputs y_phase', cls.decision_inputs.yesterday_phase === 'launch');

  // -- yesterday null 安全 --
  assertEqual(
    'no yesterday — 仍 launch',
    classifyPhase(snap({ lim_up_count: 3 }), null).phase,
    'launch'
  );
  assertEqual(
    'no yesterday — 仍 launch (undefined)',
    classifyPhase(snap({ lim_up_count: 3 })).phase,
    'launch'
  );

  // -- 异常 inputs (NaN-safe) --
  assertEqual(
    'NaN lim_up → germinate',
    classifyPhase(snap({ lim_up_count: NaN as any })).phase,
    'germinate'
  );
}

// ---------------------------------------------------------------------------
// Test: rankIndustriesByHeat
// ---------------------------------------------------------------------------
function testRankIndustriesByHeat() {
  const ss = [
    snap({ industry: 'A', composite_score: 1 }),
    snap({ industry: 'B', composite_score: 3 }),
    snap({ industry: 'C', composite_score: 2 }),
    snap({ industry: 'D', composite_score: -1 }),
  ];
  const top2 = rankIndustriesByHeat(ss, 2);
  assertEqual('rank top2 — order B,C', top2.map(s => s.industry), ['B', 'C']);

  const top10 = rankIndustriesByHeat(ss, 10);
  assertEqual('rank — top10 caps at length 4', top10.length, 4);
  assertEqual('rank — top10 order BCAD', top10.map(s => s.industry), ['B', 'C', 'A', 'D']);

  assertEqual('rank — empty', rankIndustriesByHeat([], 3), []);
  assertEqual('rank — n=0 returns []', rankIndustriesByHeat(ss, 0), []);
  assertEqual('rank — n=-1 treated as 0', rankIndustriesByHeat(ss, -5), []);

  // tie 处理 — sort stable 但内部不保证, 至少长度对
  const sameScore = [
    snap({ industry: 'X', composite_score: 1 }),
    snap({ industry: 'Y', composite_score: 1 }),
  ];
  assertEqual('rank tie — n=1 length=1', rankIndustriesByHeat(sameScore, 1).length, 1);
}

// ---------------------------------------------------------------------------
// Test: detectMainlineSwitch
// ---------------------------------------------------------------------------
function testDetectMainlineSwitch() {
  // 场景: 昨日 半导体=outbreak / 电力=climax → 今日 半导体=recession / 电力=germinate (退潮)
  // 今日 新能源 launch (昨日 germinate), 储能 outbreak (昨日 germinate) → 新主线
  const todaySent = [
    snap({ industry: '半导体', composite_score: -0.5, lim_up_count: 1 }),
    snap({ industry: '电力', composite_score: -1, lim_up_count: 0 }),
    snap({ industry: '新能源', composite_score: 3.5, lim_up_count: 2, top_codes: ['600519', '000001'] }),
    snap({ industry: '储能', composite_score: 4.5, lim_up_count: 6, top_codes: ['300750'] }),
  ];
  const todayClass = new Map<string, FermentationPhase>([
    ['半导体', 'recession'],
    ['电力', 'germinate'],
    ['新能源', 'launch'],
    ['储能', 'outbreak'],
  ]);
  const yPhases = new Map<string, FermentationPhase>([
    ['半导体', 'outbreak'],
    ['电力', 'climax'],
    ['新能源', 'germinate'],
    ['储能', 'germinate'],
  ]);
  const events = detectMainlineSwitch(todaySent, todayClass, yPhases);
  // 2 old × 2 new = 4 events
  assertEqual('switch — 2x2=4 events', events.length, 4);
  // 第 1 event 排序后 new = 储能 (heat 4.5)
  const firstByNewIndustry = events.find(e => e.new_industry === '储能');
  assert('switch — found 储能 as new', !!firstByNewIndustry);
  assertEqual('switch — top_codes 透传', firstByNewIndustry!.new_industry_top_codes, ['300750']);
  // old industries
  const oldInds = events.map(e => e.old_industry).sort();
  assertEqual('switch — old industries 半导体 + 电力', oldInds, ['半导体', '半导体', '电力', '电力']);

  // 空昨日 → 空 events
  const emptyY = detectMainlineSwitch(todaySent, todayClass, new Map());
  assertEqual('switch — empty yesterday → []', emptyY, []);
  // 空 today → 空 events
  const emptyT = detectMainlineSwitch([], new Map(), yPhases);
  assertEqual('switch — empty today → []', emptyT, []);

  // 老主线没退潮 → 不算 switch
  const noOldRecession = new Map<string, FermentationPhase>([
    ['半导体', 'outbreak'],  // 仍 outbreak, 没退潮
    ['新能源', 'launch'],
  ]);
  const noOldYPhases = new Map<string, FermentationPhase>([
    ['半导体', 'outbreak'],
    ['新能源', 'germinate'],
  ]);
  const noOldEvents = detectMainlineSwitch(todaySent, noOldRecession, noOldYPhases);
  assertEqual('switch — 老主线没退潮 → 0', noOldEvents.length, 0);

  // 新主线昨日已经是 launch → 不算 "新崛起"
  const oldNewMainline = new Map<string, FermentationPhase>([
    ['半导体', 'recession'],
    ['新能源', 'launch'],
  ]);
  const oldNewYPhases = new Map<string, FermentationPhase>([
    ['半导体', 'outbreak'],
    ['新能源', 'launch'],  // 昨日已经 launch
  ]);
  const oldNewEvents = detectMainlineSwitch(todaySent, oldNewMainline, oldNewYPhases);
  assertEqual('switch — 新主线昨日已 launch → 0 (不算崛起)', oldNewEvents.length, 0);

  // 限制 top-N 为 3
  const manyNew = [
    snap({ industry: 'N1', composite_score: 5, lim_up_count: 3 }),
    snap({ industry: 'N2', composite_score: 4, lim_up_count: 3 }),
    snap({ industry: 'N3', composite_score: 3, lim_up_count: 3 }),
    snap({ industry: 'N4', composite_score: 2.5, lim_up_count: 3 }),
    snap({ industry: 'OLD', composite_score: -1, lim_up_count: 0 }),
  ];
  const manyClass = new Map<string, FermentationPhase>([
    ['N1', 'launch'], ['N2', 'launch'], ['N3', 'launch'], ['N4', 'launch'],
    ['OLD', 'germinate'],
  ]);
  const manyY = new Map<string, FermentationPhase>([
    ['OLD', 'outbreak'],
    ['N1', 'germinate'], ['N2', 'germinate'], ['N3', 'germinate'], ['N4', 'germinate'],
  ]);
  const manyEvents = detectMainlineSwitch(manyNew, manyClass, manyY);
  // 1 old × 3 new (top-3) = 3 events
  assertEqual('switch — top-3 限制', manyEvents.length, 3);
  const newInds = manyEvents.map(e => e.new_industry).sort();
  assertEqual('switch — top-3 取 N1 N2 N3', newInds, ['N1', 'N2', 'N3']);
}

// ---------------------------------------------------------------------------
// Test: runOnce e2e
// ---------------------------------------------------------------------------
async function testEmptyToday() {
  const { ds, calls } = makeFakeDS({ todaySentiment: [] });
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assert('empty — ok', r.ok === true);
  assertEqual('empty — scanned 0', r.industries_scanned, 0);
  assertEqual('empty — written 0', r.industries_written, 0);
  assertEqual('empty — no upsert', calls.upserted.length, 0);
}

async function testMultiIndustryHit() {
  const { ds, calls } = makeFakeDS({
    todaySentiment: [
      snap({ industry: '半导体', lim_up_count: 12, consecutive_max: 5, composite_score: 4.5, top_codes: ['600519'] }),
      snap({ industry: '储能', lim_up_count: 6, consecutive_max: 3, composite_score: 3.5 }),
      snap({ industry: '新能源', lim_up_count: 2, consecutive_max: 1, composite_score: 1 }),
      snap({ industry: '电力', lim_up_count: 0, composite_score: -1.5 }),
    ],
  });
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assert('multi — ok', r.ok === true);
  assertEqual('multi — scanned 4', r.industries_scanned, 4);
  assertEqual('multi — written 4', r.industries_written, 4);

  // distribution
  assertEqual('multi — dist climax 1', r.phase_distribution.climax, 1);
  assertEqual('multi — dist outbreak 1', r.phase_distribution.outbreak, 1);
  assertEqual('multi — dist launch 1', r.phase_distribution.launch, 1);
  assertEqual('multi — dist germinate 1', r.phase_distribution.germinate, 1);
  assertEqual('multi — dist recession 0', r.phase_distribution.recession, 0);

  // upserts verify
  const semi = calls.upserted.find(u => u.industry === '半导体');
  assertEqual('multi — 半导体 phase climax', semi?.phase, 'climax');
  // mainline = composite_score top-3 + 阶段 ∈ launch/outbreak/climax
  // top-3 by composite: 半导体(4.5) 储能(3.5) 新能源(1)
  // 新能源 phase=launch → is_mainline=true
  assertEqual('multi — 半导体 is_mainline true', semi?.is_mainline, true);
  const reli = calls.upserted.find(u => u.industry === '电力');
  assertEqual('multi — 电力 phase germinate', reli?.phase, 'germinate');
  assertEqual('multi — 电力 is_mainline false', reli?.is_mainline, false);
}

async function testWithYesterdayContext() {
  // 半导体 昨日 outbreak (8 lim_up) → 今日 1 lim_up → 应是 recession (触发2 减半)
  const { ds, calls } = makeFakeDS({
    todaySentiment: [
      snap({ industry: '半导体', lim_up_count: 1, consecutive_max: 1, composite_score: -0.5 }),
    ],
    prevPhases: [
      { industry: '半导体', phase: 'outbreak', lim_up_count: 8 },
    ],
  });
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assert('y-ctx — ok', r.ok === true);
  const semi = calls.upserted.find(u => u.industry === '半导体');
  assertEqual('y-ctx — recession', semi?.phase, 'recession');
  assertEqual('y-ctx — phase_changed_from outbreak', semi?.phase_changed_from, 'outbreak');
}

async function testUpsertSingleThrow() {
  const { ds, calls } = makeFakeDS({
    todaySentiment: [
      snap({ industry: '半导体', lim_up_count: 5, consecutive_max: 2 }),
      snap({ industry: '电力', lim_up_count: 2 }),
    ],
    upsertThrowIndustries: new Set(['半导体']),
  });
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assertEqual('throw — scanned 2', r.industries_scanned, 2);
  assertEqual('throw — written 1', r.industries_written, 1);
  assertEqual('throw — errors 1', r.errors.length, 1);
  assert('throw — ok=false', r.ok === false);
  assertEqual('throw — 电力 upserted', calls.upserted[0].industry, '电力');
}

async function testDryRun() {
  const { ds, calls } = makeFakeDS({
    todaySentiment: [snap({ industry: '半导体', lim_up_count: 3 })],
  });
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29', dry_run: true });
  assert('dry — ok', r.ok === true);
  assertEqual('dry — written 1', r.industries_written, 1);
  assertEqual('dry — no upsert call', calls.upserted.length, 0);
}

async function testYesterdayMissingDegrades() {
  // listPreviousPhases 抛错 → 不阻塞主流程, 只 log + 错误计数
  const { ds, calls } = makeFakeDS({
    todaySentiment: [snap({ industry: '半导体', lim_up_count: 5, consecutive_max: 2 })],
    listPrevPhasesThrow: 'db boom',
  });
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assertEqual('y-miss — errors 1', r.errors.length, 1);
  assert('y-miss — ok=false (errors > 0)', r.ok === false);
  assertEqual('y-miss — written 1 (主流程继续)', r.industries_written, 1);
  assertEqual('y-miss — semi phase_changed_from null', calls.upserted[0].phase_changed_from, null);
}

async function testListSentimentThrow() {
  const { ds } = makeFakeDS({ listSentimentThrow: 'db boom' });
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assert('top-throw — ok=false', r.ok === false);
  assertEqual('top-throw — errors 1', r.errors.length, 1);
  assertEqual('top-throw — written 0', r.industries_written, 0);
}

async function testMainlineSwitchE2E() {
  // 模拟主线切换场景
  const { ds, calls } = makeFakeDS({
    todaySentiment: [
      snap({ industry: '半导体', lim_up_count: 1, composite_score: -0.5 }),  // 老主线退潮
      snap({ industry: '储能', lim_up_count: 6, consecutive_max: 3, composite_score: 4, top_codes: ['300750'] }),
    ],
    prevPhases: [
      { industry: '半导体', phase: 'outbreak', lim_up_count: 8 },
      { industry: '储能', phase: 'germinate', lim_up_count: 0 },
    ],
  });
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  const r = await svc.runOnce({ trade_date: '2026-06-29' });
  assert('switch-e2e — ok', r.ok === true);
  assertEqual('switch-e2e — events 1', r.mainline_switch_events.length, 1);
  const ev = r.mainline_switch_events[0];
  assertEqual('switch-e2e — old 半导体', ev.old_industry, '半导体');
  assertEqual('switch-e2e — new 储能', ev.new_industry, '储能');
  // 写表 raw_payload 透传 switch events
  const semi = calls.upserted.find(u => u.industry === '半导体')!;
  const storage = calls.upserted.find(u => u.industry === '储能')!;
  assert('switch-e2e — 半导体 raw_payload 含 switch event', semi.raw_payload.mainline_switch_events.length === 1);
  assert('switch-e2e — 储能 raw_payload 含 switch event', storage.raw_payload.mainline_switch_events.length === 1);
}

async function testTradeDateAutoResolve() {
  const { ds } = makeFakeDS({ todaySentiment: [] });
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  // 不传 trade_date, 用 now 自动算
  const fixed = new Date('2026-06-29T08:00:00Z'); // UTC = 16:00 上海
  const r = await svc.runOnce({ now: fixed });
  // 自动 resolve Asia/Shanghai 时区
  assert('auto-date — resolved YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(r.trade_date));
}

// ---------------------------------------------------------------------------
// Test: PHASE_THRESHOLDS 守卫 (回归)
// ---------------------------------------------------------------------------
function testThresholdsGuard() {
  // 阈值数值不变 — 任何 PR 改阈值必须更新本测试 (强制 code review 视线)
  assertEqual('TH climax_lim_up_min', PHASE_THRESHOLDS.climax_lim_up_min, 10);
  assertEqual('TH climax_consecutive_min', PHASE_THRESHOLDS.climax_consecutive_min, 4);
  assertEqual('TH outbreak_lim_up_min', PHASE_THRESHOLDS.outbreak_lim_up_min, 5);
  assertEqual('TH outbreak_consecutive_min', PHASE_THRESHOLDS.outbreak_consecutive_min, 2);
  assertEqual('TH outbreak_composite_min', PHASE_THRESHOLDS.outbreak_composite_min, 2.5);
  assertEqual('TH launch_lim_up_min', PHASE_THRESHOLDS.launch_lim_up_min, 1);
  assertEqual('TH recession_lim_up_max', PHASE_THRESHOLDS.recession_lim_up_max, 5);
  assertEqual('TH recession_failure_rate_min', PHASE_THRESHOLDS.recession_failure_rate_min, 0.5);
  assertEqual('TH recession_yesterday_lim_up_min', PHASE_THRESHOLDS.recession_yesterday_lim_up_min, 5);
  assertEqual('TH recession_decay_ratio', PHASE_THRESHOLDS.recession_decay_ratio, 0.5);
  assertEqual('TH mainline_top_n', PHASE_THRESHOLDS.mainline_top_n, 3);

  // Object.freeze 守卫
  let frozen = false;
  try {
    (PHASE_THRESHOLDS as any).climax_lim_up_min = 999;
    if ((PHASE_THRESHOLDS as any).climax_lim_up_min !== 10) frozen = false;
    else frozen = true;
  } catch {
    frozen = true;
  }
  assert('TH frozen — mutation no-op', frozen);
}

// ---------------------------------------------------------------------------
// Test: 字典 / icon 完整性
// ---------------------------------------------------------------------------
function testLabelsAndIcons() {
  assertEqual('FERMENTATION_PHASES length 5', FERMENTATION_PHASES.length, 5);
  for (const p of FERMENTATION_PHASES) {
    assert(`label exists ${p}`, !!FERMENTATION_PHASE_LABELS[p] && FERMENTATION_PHASE_LABELS[p].length > 0);
    assert(`icon exists ${p}`, !!FERMENTATION_PHASE_ICONS[p] && FERMENTATION_PHASE_ICONS[p].length > 0);
  }
}

// ---------------------------------------------------------------------------
// Test: meta-guard — model / migration SQL / db registration
// ---------------------------------------------------------------------------
function testMetaGuards() {
  const root = path.resolve(__dirname, '../..');
  // model 列定义
  const modelSrc = fs.readFileSync(path.join(root, 'src/models/ThemeFermentationPhase.ts'), 'utf-8');
  assert('meta — model has phase column', /field:\s*['"]?phase['"]?/.test(modelSrc) || /comment:.*?5 阶段/.test(modelSrc));
  for (const col of ['lim_up_count', 'consecutive_max', 'phase_changed_from', 'is_mainline', 'top_codes']) {
    assert(`meta — model has ${col}`, modelSrc.includes(col));
  }
  assert('meta — primaryKey trade_date + industry', modelSrc.includes('primaryKey: true'));

  // migration sql
  const migSql = fs.readFileSync(
    path.join(root, 'scripts/migrations/2026-06-30-theme-fermentation-phases.sql'),
    'utf-8'
  );
  assert('meta — migration CREATE TABLE', /CREATE TABLE IF NOT EXISTS theme_fermentation_phases/.test(migSql));
  assert('meta — migration PRIMARY KEY', /PRIMARY KEY \(trade_date, industry\)/.test(migSql));
  assert('meta — migration 3 indexes', (migSql.match(/CREATE INDEX IF NOT EXISTS/g) || []).length === 3);
  assert('meta — migration BEGIN/COMMIT', /BEGIN;/.test(migSql) && /COMMIT;/.test(migSql));

  // rollback
  const rollbackSql = fs.readFileSync(
    path.join(root, 'scripts/migrations/2026-06-30-theme-fermentation-phases-rollback.sql'),
    'utf-8'
  );
  assert('meta — rollback DROP TABLE', /DROP TABLE IF EXISTS theme_fermentation_phases/.test(rollbackSql));

  // database.ts registration
  const dbSrc = fs.readFileSync(path.join(root, 'src/config/database.ts'), 'utf-8');
  assert('meta — db.ts imports ThemeFermentationPhase', dbSrc.includes('ThemeFermentationPhase'));
  assert('meta — db.ts registers in models[]', /models:\s*\[[\s\S]*ThemeFermentationPhase[\s\S]*\]/.test(dbSrc));

  // models/index.ts export
  const indexSrc = fs.readFileSync(path.join(root, 'src/models/index.ts'), 'utf-8');
  assert('meta — models/index re-exports', indexSrc.includes("./ThemeFermentationPhase"));

  // cronRegistry
  const cronSrc = fs.readFileSync(path.join(root, 'src/constants/cronRegistry.ts'), 'utf-8');
  assert('meta — cronRegistry has THEME_FERMENTATION_DETECT', cronSrc.includes('THEME_FERMENTATION_DETECT'));
  assert('meta — cronRegistry recommendedCron 30 16', /THEME_FERMENTATION_DETECT[\s\S]*?recommendedCron:\s*['"]30 16 \* \* 1-5['"]/.test(cronSrc));

  // SchedulerService dispatch + seed
  const schedSrc = fs.readFileSync(path.join(root, 'src/services/SchedulerService.ts'), 'utf-8');
  assert('meta — SchedulerService dispatches THEME_FERMENTATION_DETECT', schedSrc.includes("task.type === 'THEME_FERMENTATION_DETECT'"));
  assert('meta — SchedulerService seeds THEME_FERMENTATION_DETECT', /type:\s*'THEME_FERMENTATION_DETECT'/.test(schedSrc));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  testSafeNum();
  testClassifyPhase();
  testRankIndustriesByHeat();
  testDetectMainlineSwitch();
  await testEmptyToday();
  await testMultiIndustryHit();
  await testWithYesterdayContext();
  await testUpsertSingleThrow();
  await testDryRun();
  await testYesterdayMissingDegrades();
  await testListSentimentThrow();
  await testMainlineSwitchE2E();
  await testTradeDateAutoResolve();
  testThresholdsGuard();
  testLabelsAndIcons();
  testMetaGuards();

  console.log(`\n[theme-fermentation-detector] ${ok} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
})();
