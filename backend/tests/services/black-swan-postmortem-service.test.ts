/**
 * BlackSwanPostmortemService 单元测试 (US-102 [PR-013]).
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/black-swan-postmortem-service.test.ts
 *
 * 覆盖维度:
 *   [1] calcDurationMinutes — null/0/正数/异常 (resolved 早于 detected)
 *   [2] buildReportTitle — 含 " - 复盘报告" + cap ≤ 200 字 + 超长截断
 *   [3] buildReportSummary — 含 severity / detected_at / duration 启发式 + cap ≤ 500 字
 *   [4] buildEventSummary — 字段 1:1 + linked_risk_alert_ids Array.from 拷贝
 *   [5] buildPostmortemReportRow — status='partial' + reason +
 *       metadata.service_version + sections_filled=['event_summary']
 *   [6] runBlackSwanPostmortem e2e (fake runner):
 *        (a) loadEvents ok=false → success=false + error: events_query_failed
 *        (b) 无 events → success=true + reports_generated=0
 *        (c) dry_run=true → 不调 upsertReport + events_total 准确
 *        (d) 真 upsert 全成功 → reports_generated == events_total + reports_failed=0
 *        (e) upsertReport 部分返 ok:false → reports_failed > 0 但 success=true
 *        (f) upsertReport throw → reports_failed +1 但 success=true 不抛
 *        (g) loadLinkedRiskAlertIds throw → linked_risk_alert_ids=[] 不影响 upsert
 *        (h) event_id 透传到 loadEvents
 *        (i) lookback_hours 默认 24, override 透传
 *        (j) metadata 透传到 row.metadata
 *        (k) generated_at 覆盖 + ISO 序列化正确
 *   [7] PRODUCTION runner smoke — 工厂返对象 + singleton
 *   [8] META-GUARD: cron registry 含 BLACK_SWAN_POSTMORTEM + SchedulerService 含
 *       dispatch 分支 + service jsdoc 含 4 段 + PR-013/US-102 + fail-OPEN +
 *       BlackSwanPostmortemReport / BlackSwanEvent 边界 + UNIQUE(black_swan_event_id)
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BLACK_SWAN_POSTMORTEM_DEFAULT_LOOKBACK_HOURS,
  BLACK_SWAN_POSTMORTEM_RECOMMENDED_CRON,
  BlackSwanEventSnapshot,
  BlackSwanPostmortemReportRow,
  PostmortemRunner,
  buildEventSummary,
  buildPostmortemReportRow,
  buildReportSummary,
  buildReportTitle,
  calcDurationMinutes,
  createProductionPostmortemRunner,
  getProductionPostmortemRunner,
  runBlackSwanPostmortem,
} from '../../src/services/BlackSwanPostmortemService';

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

// ============================================================================
// Fakes
// ============================================================================

function makeEvent(overrides: Partial<BlackSwanEventSnapshot> = {}): BlackSwanEventSnapshot {
  return {
    id: 1,
    detected_at: new Date('2026-06-19T03:30:00Z'),
    event_type: 'ST',
    severity: 'high',
    scope: 'symbol',
    symbol: '600519.SH',
    title: '贵州茅台 600519 被 ST',
    description: '600519（贵州茅台）已被纳入风险警示板。',
    signature: 'ST::600519',
    resolved_at: null,
    resolved_reason: null,
    metadata: {},
    ...overrides,
  };
}

interface FakeRunnerState {
  loadCalls: Array<{ asOf: Date; lookback_hours: number; event_id?: number }>;
  linkedCalls: Array<{ event_type: string; symbol: string | null; detected_at: Date }>;
  upsertCalls: BlackSwanPostmortemReportRow[];
  loadResult:
    | { ok: true; events: BlackSwanEventSnapshot[] }
    | { ok: false; error: string };
  linkedResult: number[] | Error;
  upsertResults: Array<{ ok: true } | { ok: false; error: string } | Error>;
}

function makeFakeRunner(overrides: Partial<FakeRunnerState> = {}): {
  runner: PostmortemRunner;
  state: FakeRunnerState;
} {
  const state: FakeRunnerState = {
    loadCalls: [],
    linkedCalls: [],
    upsertCalls: [],
    loadResult: { ok: true, events: [] },
    linkedResult: [],
    upsertResults: [],
    ...overrides,
  };
  const runner: PostmortemRunner = {
    async loadEvents(input) {
      state.loadCalls.push(input);
      return state.loadResult;
    },
    async loadLinkedRiskAlertIds(input) {
      state.linkedCalls.push(input);
      if (state.linkedResult instanceof Error) throw state.linkedResult;
      return state.linkedResult;
    },
    async upsertReport(row) {
      state.upsertCalls.push(row);
      const idx = state.upsertCalls.length - 1;
      const result =
        idx < state.upsertResults.length ? state.upsertResults[idx] : { ok: true };
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { runner, state };
}

// ============================================================================
// [1] calcDurationMinutes
// ============================================================================
console.log('\n[1] calcDurationMinutes');
{
  const t0 = new Date('2026-06-19T03:30:00Z');
  assertEqual('1.1 resolved_at null → null', calcDurationMinutes(t0, null), null);
  assertEqual(
    '1.2 resolved_at == detected_at → 0',
    calcDurationMinutes(t0, new Date(t0.getTime())),
    0
  );
  assertEqual(
    '1.3 resolved 早于 detected → 0 (非负保护)',
    calcDurationMinutes(t0, new Date(t0.getTime() - 60_000)),
    0
  );
  assertEqual(
    '1.4 正常 60s → 1 分钟',
    calcDurationMinutes(t0, new Date(t0.getTime() + 60_000)),
    1
  );
  assertEqual(
    '1.5 90s → 2 分钟 (ceil)',
    calcDurationMinutes(t0, new Date(t0.getTime() + 90_000)),
    2
  );
  assertEqual(
    '1.6 1h → 60 分钟',
    calcDurationMinutes(t0, new Date(t0.getTime() + 3_600_000)),
    60
  );
}

// ============================================================================
// [2] buildReportTitle
// ============================================================================
console.log('\n[2] buildReportTitle');
{
  const ev = makeEvent({ title: '贵州茅台 600519 被 ST' });
  const t = buildReportTitle(ev);
  assert('2.1 含 - 复盘报告 后缀', t.endsWith(' - 复盘报告'));
  assert('2.2 ≤ 200 字', t.length <= 200);
  assert('2.3 含原 title', t.includes('贵州茅台'));

  const long = 'X'.repeat(500);
  const t2 = buildReportTitle(makeEvent({ title: long }));
  assert('2.4 超长 → 截断 + ...', t2.length <= 200 && t2.includes('...'));
  assert('2.5 超长后仍含后缀', t2.endsWith(' - 复盘报告'));

  const t3 = buildReportTitle(makeEvent({ title: '' }));
  assertEqual('2.6 空 title → 仅后缀', t3, ' - 复盘报告');
}

// ============================================================================
// [3] buildReportSummary
// ============================================================================
console.log('\n[3] buildReportSummary');
{
  const ev = makeEvent();
  const s = buildReportSummary(ev, 60);
  assert('3.1 含 event_type ST', s.includes('ST'));
  assert('3.2 含 severity=high', s.includes('severity=high'));
  assert('3.3 含 detected_at ISO', s.includes('2026-06-19T03:30:00.000Z'));
  assert('3.4 含 持续 60 分钟', s.includes('共持续 60 分钟'));
  assert('3.5 含 description 摘要', s.includes('贵州茅台'));
  assert('3.6 ≤ 500 字', s.length <= 500);

  const sNull = buildReportSummary(ev, null);
  assert('3.7 duration null → 仍在持续中', sNull.includes('仍在持续中'));

  const sZero = buildReportSummary(ev, 0);
  assert('3.8 duration 0 → 瞬时事件', sZero.includes('瞬时事件'));

  const sLong = buildReportSummary(makeEvent({ description: 'D'.repeat(2000) }), 5);
  assert('3.9 超长 description → ≤ 500 字', sLong.length <= 500);
  assert('3.10 超长 → 含 ... 截断标记', sLong.includes('...'));
}

// ============================================================================
// [4] buildEventSummary
// ============================================================================
console.log('\n[4] buildEventSummary');
{
  const ev = makeEvent({
    resolved_at: new Date('2026-06-19T04:30:00Z'),
    resolved_reason: 'st_removed',
  });
  const sum = buildEventSummary(ev, [11, 22, 33]);
  assertEqual('4.1 event_type', sum.event_type, 'ST');
  assertEqual('4.2 severity', sum.severity, 'high');
  assertEqual('4.3 scope', sum.scope, 'symbol');
  assertEqual('4.4 symbol', sum.symbol, '600519.SH');
  assertEqual('4.5 detected_at ISO', sum.detected_at, '2026-06-19T03:30:00.000Z');
  assertEqual('4.6 resolved_at ISO', sum.resolved_at, '2026-06-19T04:30:00.000Z');
  assertEqual('4.7 duration_minutes=60', sum.duration_minutes, 60);
  assertEqual('4.8 title', sum.title, '贵州茅台 600519 被 ST');
  assertEqual('4.9 linked_risk_alert_ids', sum.linked_risk_alert_ids, [11, 22, 33]);

  // open 事件 → resolved_at null + duration_minutes null
  const sumOpen = buildEventSummary(makeEvent(), [9]);
  assertEqual('4.10 open: resolved_at null', sumOpen.resolved_at, null);
  assertEqual('4.11 open: duration_minutes null', sumOpen.duration_minutes, null);

  // 空 linked → []
  const sumEmpty = buildEventSummary(makeEvent(), []);
  assertEqual('4.12 empty linked → []', sumEmpty.linked_risk_alert_ids, []);

  // Array.from 拷贝 (防外部 mutate)
  const src = [1, 2, 3];
  const sumCopy = buildEventSummary(makeEvent(), src);
  src.push(99);
  assertEqual('4.13 linked_risk_alert_ids 是拷贝不是引用', sumCopy.linked_risk_alert_ids, [1, 2, 3]);

  // symbol=null (scope=market) 透传
  const sumMkt = buildEventSummary(
    makeEvent({ event_type: 'MARKET_REGIME', scope: 'market', symbol: null }),
    []
  );
  assertEqual('4.14 symbol null 透传', sumMkt.symbol, null);
}

// ============================================================================
// [5] buildPostmortemReportRow
// ============================================================================
console.log('\n[5] buildPostmortemReportRow');
{
  const ev = makeEvent();
  const sum = buildEventSummary(ev, [42]);
  const genAt = new Date('2026-06-19T03:43:00Z');
  const row = buildPostmortemReportRow(ev, sum, genAt, { cron_run_id: 'log-7' });

  assertEqual('5.1 black_swan_event_id', row.black_swan_event_id, 1);
  assert('5.2 title 含 复盘报告', row.title.includes('复盘报告'));
  assert('5.3 summary 非空', row.summary.length > 0);
  assertEqual('5.4 source=service_auto', row.source, 'service_auto');
  assertEqual('5.5 status=partial', row.status, 'partial');
  assertEqual(
    '5.6 reason=only_event_summary_filled',
    row.reason,
    'only_event_summary_filled'
  );
  assertEqual('5.7 generated_at 透传', row.generated_at.toISOString(), genAt.toISOString());
  assertEqual(
    '5.8 metadata.service_version',
    (row.metadata as Record<string, unknown>).service_version,
    'PR-013/v1'
  );
  assertEqual(
    '5.9 metadata.sections_filled = [event_summary]',
    (row.metadata as Record<string, unknown>).sections_filled,
    ['event_summary']
  );
  assertEqual(
    '5.10 metadata.cron_run_id 透传',
    (row.metadata as Record<string, unknown>).cron_run_id,
    'log-7'
  );
  assertEqual(
    '5.11 metadata.first_generated_at_iso',
    (row.metadata as Record<string, unknown>).first_generated_at_iso,
    genAt.toISOString()
  );
  // payload 不含 PR-014/015/016 段 — UPSERT 时 sequelize 不动它们
  assert(
    '5.12 row 不含 counterfactual_baselines key',
    !Object.prototype.hasOwnProperty.call(row as any, 'counterfactual_baselines')
  );
  assert(
    '5.13 row 不含 event_timeline key',
    !Object.prototype.hasOwnProperty.call(row as any, 'event_timeline')
  );
  assert(
    '5.14 row 不含 improvement_suggestions key',
    !Object.prototype.hasOwnProperty.call(row as any, 'improvement_suggestions')
  );
  assertEqual('5.15 event_summary 透传', row.event_summary, sum);
}

// ============================================================================
// [6] runBlackSwanPostmortem e2e
// ============================================================================
async function run6(): Promise<void> {
  console.log('\n[6] runBlackSwanPostmortem e2e');

  // (a) loadEvents ok=false → success=false
  {
    const { runner } = makeFakeRunner({ loadResult: { ok: false, error: 'DB down' } });
    const r = await runBlackSwanPostmortem(runner);
    assertEqual('6a.1 success=false', r.success, false);
    assert(
      '6a.2 error 含 events_query_failed + DB down',
      (r.error || '').includes('events_query_failed') && (r.error || '').includes('DB down'),
      r.error
    );
    assertEqual('6a.3 events_total=0', r.events_total, 0);
    assertEqual('6a.4 reports_generated=0', r.reports_generated, 0);
  }

  // (b) 无 events → success=true + reports_generated=0
  {
    const { runner, state } = makeFakeRunner({ loadResult: { ok: true, events: [] } });
    const r = await runBlackSwanPostmortem(runner);
    assertEqual('6b.1 success=true', r.success, true);
    assertEqual('6b.2 events_total=0', r.events_total, 0);
    assertEqual('6b.3 reports_generated=0', r.reports_generated, 0);
    assertEqual('6b.4 upsertCalls=0', state.upsertCalls.length, 0);
    assertEqual('6b.5 linkedCalls=0', state.linkedCalls.length, 0);
  }

  // (c) dry_run=true → 不调 upsertReport + events_total 准确
  {
    const events = [makeEvent({ id: 1 }), makeEvent({ id: 2, symbol: '000001' })];
    const { runner, state } = makeFakeRunner({ loadResult: { ok: true, events } });
    const r = await runBlackSwanPostmortem(runner, { dry_run: true });
    assertEqual('6c.1 success=true', r.success, true);
    assertEqual('6c.2 dry_run=true', r.dry_run, true);
    assertEqual('6c.3 events_total=2', r.events_total, 2);
    assertEqual('6c.4 reports_generated=0 (dry)', r.reports_generated, 0);
    assertEqual('6c.5 upsertCalls=0 (dry)', state.upsertCalls.length, 0);
    assertEqual('6c.6 linkedCalls=0 (dry, 不调 linked)', state.linkedCalls.length, 0);
  }

  // (d) 真 upsert 全成功
  {
    const events = [makeEvent({ id: 1 }), makeEvent({ id: 2 }), makeEvent({ id: 3 })];
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, events },
      linkedResult: [101, 102],
    });
    const r = await runBlackSwanPostmortem(runner);
    assertEqual('6d.1 success=true', r.success, true);
    assertEqual('6d.2 events_total=3', r.events_total, 3);
    assertEqual('6d.3 reports_generated=3', r.reports_generated, 3);
    assertEqual('6d.4 reports_failed=0', r.reports_failed, 0);
    assertEqual('6d.5 upsertCalls=3', state.upsertCalls.length, 3);
    assertEqual('6d.6 linkedCalls=3', state.linkedCalls.length, 3);
    // 验证 row 字段
    assertEqual('6d.7 row[0].event_summary.linked', state.upsertCalls[0].event_summary.linked_risk_alert_ids, [101, 102]);
    assertEqual('6d.8 row[0].status=partial', state.upsertCalls[0].status, 'partial');
  }

  // (e) upsertReport 部分返 ok:false
  {
    const events = [makeEvent({ id: 1 }), makeEvent({ id: 2 }), makeEvent({ id: 3 })];
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, events },
      upsertResults: [{ ok: true }, { ok: false, error: 'duplicate fk' }, { ok: true }],
    });
    const r = await runBlackSwanPostmortem(runner);
    assertEqual('6e.1 success=true (单事件失败不算 fail)', r.success, true);
    assertEqual('6e.2 reports_generated=2', r.reports_generated, 2);
    assertEqual('6e.3 reports_failed=1', r.reports_failed, 1);
    assertEqual('6e.4 events_total=3', r.events_total, 3);
  }

  // (f) upsertReport throw → reports_failed +1 但 success=true 不抛
  {
    const events = [makeEvent({ id: 1 })];
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, events },
      upsertResults: [new Error('PG conn lost')],
    });
    const r = await runBlackSwanPostmortem(runner);
    assertEqual('6f.1 success=true (顶层不抛)', r.success, true);
    assertEqual('6f.2 reports_generated=0', r.reports_generated, 0);
    assertEqual('6f.3 reports_failed=1', r.reports_failed, 1);
  }

  // (g) loadLinkedRiskAlertIds throw → linked=[] 不影响 upsert
  {
    const events = [makeEvent({ id: 1 })];
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, events },
      linkedResult: new Error('RiskAlert table missing'),
    });
    const r = await runBlackSwanPostmortem(runner);
    assertEqual('6g.1 success=true (linked 失败不影响主流程)', r.success, true);
    assertEqual('6g.2 reports_generated=1', r.reports_generated, 1);
    assertEqual(
      '6g.3 linked_risk_alert_ids=[] (fallback)',
      state.upsertCalls[0].event_summary.linked_risk_alert_ids,
      []
    );
  }

  // (h) event_id 透传到 loadEvents
  {
    const { runner, state } = makeFakeRunner();
    await runBlackSwanPostmortem(runner, { event_id: 777, dry_run: true });
    assertEqual('6h.1 loadCalls=1', state.loadCalls.length, 1);
    assertEqual('6h.2 event_id=777 透传', state.loadCalls[0].event_id, 777);
  }

  // (i) lookback_hours 默认 24, override 透传
  {
    const { runner, state } = makeFakeRunner();
    await runBlackSwanPostmortem(runner, { dry_run: true });
    assertEqual(
      '6i.1 lookback_hours 默认 24',
      state.loadCalls[0].lookback_hours,
      BLACK_SWAN_POSTMORTEM_DEFAULT_LOOKBACK_HOURS
    );

    const { runner: r2, state: s2 } = makeFakeRunner();
    await runBlackSwanPostmortem(r2, { dry_run: true, lookback_hours: 6 });
    assertEqual('6i.2 lookback_hours=6 透传', s2.loadCalls[0].lookback_hours, 6);

    // 非法 lookback_hours → fallback 默认
    const { runner: r3, state: s3 } = makeFakeRunner();
    await runBlackSwanPostmortem(r3, { dry_run: true, lookback_hours: -1 });
    assertEqual(
      '6i.3 lookback_hours -1 → 默认 24',
      s3.loadCalls[0].lookback_hours,
      BLACK_SWAN_POSTMORTEM_DEFAULT_LOOKBACK_HOURS
    );
  }

  // (j) metadata 透传到 row.metadata
  {
    const events = [makeEvent({ id: 1 })];
    const { runner, state } = makeFakeRunner({ loadResult: { ok: true, events } });
    await runBlackSwanPostmortem(runner, {
      metadata: { cron_run_id: 'log-99', service_version: 'PR-013/v1' },
    });
    assertEqual('6j.1 upsertCalls=1', state.upsertCalls.length, 1);
    const row = state.upsertCalls[0];
    assertEqual(
      '6j.2 row.metadata.cron_run_id 透传',
      (row.metadata as Record<string, unknown>).cron_run_id,
      'log-99'
    );
    assertEqual(
      '6j.3 row.metadata.service_version',
      (row.metadata as Record<string, unknown>).service_version,
      'PR-013/v1'
    );
    assertEqual(
      '6j.4 row.metadata.sections_filled 仍为 [event_summary]',
      (row.metadata as Record<string, unknown>).sections_filled,
      ['event_summary']
    );
  }

  // (k) generated_at 覆盖 + ISO 序列化
  {
    const fixed = new Date('2026-06-19T03:43:00Z');
    const events = [makeEvent({ id: 1 })];
    const { runner, state } = makeFakeRunner({ loadResult: { ok: true, events } });
    const r = await runBlackSwanPostmortem(runner, { generated_at: fixed });
    assertEqual('6k.1 generated_at_iso', r.generated_at_iso, fixed.toISOString());
    assertEqual(
      '6k.2 row.generated_at 透传',
      state.upsertCalls[0].generated_at.toISOString(),
      fixed.toISOString()
    );
  }
}

// ============================================================================
// [7] PRODUCTION runner smoke
// ============================================================================
async function run7(): Promise<void> {
  console.log('\n[7] PRODUCTION runner smoke');
  const r1 = createProductionPostmortemRunner();
  assert(
    '7.1 createProductionPostmortemRunner returns object',
    typeof r1 === 'object' && r1 !== null
  );
  assert('7.2 loadEvents is function', typeof r1.loadEvents === 'function');
  assert(
    '7.3 loadLinkedRiskAlertIds is function',
    typeof r1.loadLinkedRiskAlertIds === 'function'
  );
  assert('7.4 upsertReport is function', typeof r1.upsertReport === 'function');

  // singleton
  const r2 = getProductionPostmortemRunner();
  const r3 = getProductionPostmortemRunner();
  assert('7.5 getProductionPostmortemRunner singleton', r2 === r3);

  // loadLinkedRiskAlertIds 任何 throw 都 fallback [] (生产 runner 内含 try/catch)
  // 我们这里不连 DB, 直接调即可 — 失败也只返 []
  const ids = await r1.loadLinkedRiskAlertIds({
    event_type: 'ST',
    symbol: '600519',
    detected_at: new Date(),
    lookback_days: 7,
  });
  assert('7.6 loadLinkedRiskAlertIds 失败返 []', Array.isArray(ids));
}

// ============================================================================
// [8] META-GUARD — registry / scheduler / service jsdoc / cron expr
// ============================================================================
console.log('\n[8] META-GUARD');
const ROOT = join(__dirname, '../..');
const SERVICE_SRC = readFileSync(
  join(ROOT, 'src/services/BlackSwanPostmortemService.ts'),
  'utf8'
);
const SCHEDULER_SRC = readFileSync(join(ROOT, 'src/services/SchedulerService.ts'), 'utf8');
const REGISTRY_SRC = readFileSync(join(ROOT, 'src/constants/cronRegistry.ts'), 'utf8');
const MODEL_SRC = readFileSync(
  join(ROOT, 'src/models/BlackSwanPostmortemReport.ts'),
  'utf8'
);

assert(
  '8.1 cronRegistry 含 BLACK_SWAN_POSTMORTEM type',
  REGISTRY_SRC.includes("type: 'BLACK_SWAN_POSTMORTEM'"),
  ''
);
assert(
  '8.2 cronRegistry recommendedCron 与常量一致',
  REGISTRY_SRC.includes(`recommendedCron: '${BLACK_SWAN_POSTMORTEM_RECOMMENDED_CRON}'`),
  ''
);
assert(
  '8.3 cronRegistry BLACK_SWAN_POSTMORTEM cron (13,43 · BlackSwanEvent 读端由外部写入源承担 · BLACK_SWAN_DETECT 已在 C-BS-03 批次删除)',
  REGISTRY_SRC.includes("recommendedCron: '13,43 * * * *'") &&
    !REGISTRY_SRC.includes("recommendedCron: '3,33 * * * *'"),
  ''
);
assert(
  '8.4 SchedulerService 含 dispatch 分支',
  SCHEDULER_SRC.includes("task.type === 'BLACK_SWAN_POSTMORTEM'"),
  ''
);
assert(
  '8.5 SchedulerService lazy-require runBlackSwanPostmortem',
  SCHEDULER_SRC.includes('runBlackSwanPostmortem') &&
    SCHEDULER_SRC.includes("require('./BlackSwanPostmortemService')"),
  ''
);
assert(
  '8.6 SchedulerService 透传 dry_run + event_id + lookback_hours',
  /dry_run:\s*dryRunBp/.test(SCHEDULER_SRC) &&
    /event_id:\s*eventIdBp/.test(SCHEDULER_SRC) &&
    /lookback_hours:/.test(SCHEDULER_SRC),
  ''
);
assert(
  '8.7 Service jsdoc 含 US-102 / PR-013',
  SERVICE_SRC.includes('US-102') && SERVICE_SRC.includes('PR-013'),
  ''
);
assert(
  '8.8 Service jsdoc 含 4 段语义 (event_summary/counterfactual_baselines/event_timeline/improvement_suggestions)',
  SERVICE_SRC.includes('event_summary') &&
    SERVICE_SRC.includes('counterfactual_baselines') &&
    SERVICE_SRC.includes('event_timeline') &&
    SERVICE_SRC.includes('improvement_suggestions'),
  ''
);
assert(
  '8.9 Service 标 fail-OPEN',
  SERVICE_SRC.includes('fail-OPEN'),
  ''
);
assert(
  '8.10 Service 标 UNIQUE(black_swan_event_id) idempotent',
  SERVICE_SRC.includes('UNIQUE(black_swan_event_id)') &&
    SERVICE_SRC.includes('idempotent'),
  ''
);
assert(
  '8.11 Service 标与 PR-014/015/016 分工',
  SERVICE_SRC.includes('PR-014') &&
    SERVICE_SRC.includes('PR-015') &&
    SERVICE_SRC.includes('PR-016'),
  ''
);
assert(
  '8.12 Model 与 Service 双向呼应 (Model 已声明 PR-013 主入口)',
  MODEL_SRC.includes('PR-013') && MODEL_SRC.includes('BlackSwanPostmortemService'),
  ''
);
assert(
  '8.13 Service 透传 status=partial 启发式',
  SERVICE_SRC.includes("status: 'partial'") || SERVICE_SRC.includes("'partial'"),
  ''
);
assert(
  '8.14 Service 透传 sections_filled=[event_summary]',
  SERVICE_SRC.includes('sections_filled') && SERVICE_SRC.includes('event_summary'),
  ''
);

// ============================================================================
// Async wrapper
// ============================================================================
(async () => {
  await run6();
  await run7();

  console.log(`\n[BlackSwanPostmortemService] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error('test crashed:', err);
  process.exit(1);
});
