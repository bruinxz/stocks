/**
 * EventTimelineReplayerService 单元测试 (US-104 [PR-015]).
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/event-timeline-replayer-service.test.ts
 *
 * 覆盖维度:
 *   [1] normalizeAlertSeverity — 大小写/未知/null/undefined 兜底
 *   [2] alertToTimelineItem — rule_id='black_swan' → watchdog_trigger; 其它 → risk_alert
 *                           — message > 80 字截断 + description 透传
 *   [3] aggregateAlertCounts — 4 档聚合 + 仅统计 alert/watchdog 类型 (其它 type 不归桶)
 *   [4] sortTimeline — ts 升序 + source_id 兜底 + title localeCompare 兜底 + 不 mutate 输入
 *   [5] truncateTimeline — cap<=0 / cap>=len / 长于 cap 保首尾
 *   [6] buildEventTimeline engine — sources_used / items_total / items_truncated / cap
 *                                  / lookback_days override / extra_items 拼接
 *   [7] appendSectionFilled / decidePostmortemStatus — 与 PR-014 同款契约 (含 4 段全升 ok)
 *   [8] runEventTimelineReplayerService e2e (fake runner):
 *        (a) loadCandidates ok=false → success=false + error
 *        (b) loadCandidates throw → success=false + error
 *        (c) 无 candidates → success=true + 0
 *        (d) dry_run=true → 不调 loadRiskAlerts / updateReport
 *        (e) loadRiskAlerts throw → alerts=[] + 但 engine 仍跑 (本场景 timeline=0 → skipped)
 *        (f) timeline 为空 (无 alerts) → skipped
 *        (g) updateReport ok=false → failed +1
 *        (h) updateReport throw → failed +1
 *        (i) 全成功路径 — sections_filled 累加 + status partial / ok 升级 +
 *                       payload 仅含约定 5 列 + alert_count_by_level 正确
 *        (j) event_id + lookback_hours + lookback_days 透传
 *        (k) metadata 透传 + replayer_version 覆盖
 *   [9] PRODUCTION runner smoke — 工厂返对象 + singleton + 脱 DB 不抛
 *   [10] META-GUARD: cron registry + SchedulerService dispatch + service jsdoc 标记
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALL_POSTMORTEM_SECTIONS,
  BLACK_SWAN_TIMELINE_DEFAULT_ITEMS_CAP,
  BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_DAYS,
  BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_HOURS,
  BLACK_SWAN_TIMELINE_RECOMMENDED_CRON,
  BLACK_SWAN_TIMELINE_REPLAYER_VERSION,
  PartialPostmortemSnapshot,
  RiskAlertSnapshot,
  TimelineItem,
  TimelineReportUpdateRow,
  TimelineRunner,
  aggregateAlertCounts,
  alertToTimelineItem,
  appendSectionFilled,
  buildEventTimeline,
  createProductionTimelineRunner,
  decidePostmortemStatus,
  getProductionTimelineRunner,
  normalizeAlertSeverity,
  runEventTimelineReplayerService,
  sortTimeline,
  truncateTimeline,
} from '../../src/services/EventTimelineReplayerService';

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

function mkAlert(overrides: Partial<RiskAlertSnapshot> = {}): RiskAlertSnapshot {
  return {
    id: 1,
    created_at: new Date('2026-06-09T03:00:00Z'),
    symbol: '600519',
    name: '贵州茅台',
    level: 'HIGH',
    message: 'trailing stop triggered',
    rule_id: 'trailing_stop',
    metadata: { foo: 'bar' },
    ...overrides,
  };
}

function makePartial(overrides: Partial<PartialPostmortemSnapshot> = {}): PartialPostmortemSnapshot {
  return {
    id: 1,
    black_swan_event_id: 11,
    event_detected_at: new Date('2026-06-10T03:30:00Z'),
    event_scope: 'symbol',
    event_symbol: '600519',
    event_scope_detail: { symbol: '600519' },
    current_metadata: { sections_filled: ['event_summary'] },
    current_status: 'partial',
    ...overrides,
  };
}

interface FakeRunnerState {
  loadCalls: Array<{ asOf: Date; lookback_hours: number; event_id?: number }>;
  alertCalls: Array<{ symbol: string | null; event_detected_at: Date; lookback_days: number }>;
  updateCalls: TimelineReportUpdateRow[];
  loadResult:
    | { ok: true; candidates: PartialPostmortemSnapshot[] }
    | { ok: false; error: string };
  loadShouldThrow?: Error;
  alertsBySymbol: Map<string, RiskAlertSnapshot[] | Error>;
  alertsDefault?: RiskAlertSnapshot[] | Error;
  updateResults: Array<{ ok: true } | { ok: false; error: string } | Error>;
}

function makeFakeRunner(overrides: Partial<FakeRunnerState> = {}): {
  runner: TimelineRunner;
  state: FakeRunnerState;
} {
  const state: FakeRunnerState = {
    loadCalls: [],
    alertCalls: [],
    updateCalls: [],
    loadResult: { ok: true, candidates: [] },
    alertsBySymbol: new Map(),
    updateResults: [],
    ...overrides,
  };
  const runner: TimelineRunner = {
    async loadCandidates(input) {
      state.loadCalls.push(input);
      if (state.loadShouldThrow) throw state.loadShouldThrow;
      return state.loadResult;
    },
    async loadRiskAlerts(input) {
      state.alertCalls.push(input);
      const key = input.symbol || '__null__';
      const v = state.alertsBySymbol.get(key);
      if (v instanceof Error) throw v;
      if (v !== undefined) return v;
      if (state.alertsDefault instanceof Error) throw state.alertsDefault;
      return state.alertsDefault ?? [];
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
// [1] normalizeAlertSeverity
// ============================================================================
console.log('\n[1] normalizeAlertSeverity');
{
  assertEqual('1.1 critical', normalizeAlertSeverity('critical'), 'critical');
  assertEqual('1.2 HIGH', normalizeAlertSeverity('HIGH'), 'high');
  assertEqual('1.3 Medium', normalizeAlertSeverity('Medium'), 'medium');
  assertEqual('1.4 med 简写', normalizeAlertSeverity('med'), 'medium');
  assertEqual('1.5 low', normalizeAlertSeverity('low'), 'low');
  assertEqual('1.6 未知 → medium fail-safe', normalizeAlertSeverity('weird'), 'medium');
  assertEqual('1.7 null → medium', normalizeAlertSeverity(null), 'medium');
  assertEqual('1.8 undefined → medium', normalizeAlertSeverity(undefined), 'medium');
  assertEqual('1.9 空串 → medium', normalizeAlertSeverity(''), 'medium');
  assertEqual('1.10 非 string → medium', normalizeAlertSeverity(123), 'medium');
}

// ============================================================================
// [2] alertToTimelineItem
// ============================================================================
console.log('\n[2] alertToTimelineItem');
{
  // 2.1 rule_id='black_swan' → watchdog_trigger
  const watchdog = alertToTimelineItem(mkAlert({ rule_id: 'black_swan' }));
  assertEqual('2.1 watchdog type', watchdog.type, 'watchdog_trigger');
  assertEqual('2.2 source_id 透传', watchdog.source_id, 1);
  assertEqual('2.3 source_table=risk_alerts', watchdog.source_table, 'risk_alerts');

  // 2.4 rule_id 其它 → risk_alert
  const normal = alertToTimelineItem(mkAlert({ rule_id: 'trailing_stop' }));
  assertEqual('2.4 普通 alert type', normal.type, 'risk_alert');

  // 2.5 rule_id 大写 → 仍归 watchdog (case-insensitive)
  const upper = alertToTimelineItem(mkAlert({ rule_id: 'BLACK_SWAN' }));
  assertEqual('2.5 大小写不敏感', upper.type, 'watchdog_trigger');

  // 2.6 rule_id=null → risk_alert
  const nullRule = alertToTimelineItem(mkAlert({ rule_id: null }));
  assertEqual('2.6 rule_id=null → risk_alert', nullRule.type, 'risk_alert');

  // 2.7 severity 来自 level
  const critical = alertToTimelineItem(mkAlert({ level: 'CRITICAL' }));
  assertEqual('2.7 severity', critical.severity, 'critical');

  // 2.8 短 message 不截断 + description=undefined
  const short = alertToTimelineItem(mkAlert({ message: 'short msg' }));
  assertEqual('2.8a title 不截断', short.title, 'short msg');
  assertEqual('2.8b description undefined', short.description, undefined);

  // 2.9 长 message 截断 80 字 + description 透传完整
  const longMsg = 'a'.repeat(200);
  const long = alertToTimelineItem(mkAlert({ message: longMsg }));
  assertEqual('2.9a title 截断 80 字', long.title.length, 80);
  assert('2.9b title 含省略号', long.title.endsWith('...'));
  assertEqual('2.9c description 全量', long.description, longMsg);

  // 2.10 空 message
  const empty = alertToTimelineItem(mkAlert({ message: '' }));
  assertEqual('2.10 空 message → (空告警)', empty.title, '(空告警)');

  // 2.11 metadata 透传 (浅拷贝)
  const md = alertToTimelineItem(mkAlert({ metadata: { x: 1 } }));
  assertEqual('2.11 metadata 透传', md.metadata, { x: 1 });

  // 2.12 ts ISO 格式
  const it = alertToTimelineItem(mkAlert({ created_at: new Date('2026-06-09T03:00:00Z') }));
  assertEqual('2.12 ts ISO', it.ts, '2026-06-09T03:00:00.000Z');

  // 2.13 symbol=null
  const noSym = alertToTimelineItem(mkAlert({ symbol: null }));
  assertEqual('2.13 symbol=null 透传', noSym.symbol, null);
}

// ============================================================================
// [3] aggregateAlertCounts
// ============================================================================
console.log('\n[3] aggregateAlertCounts');
{
  // 3.1 空数组
  assertEqual('3.1 空 → 全 0', aggregateAlertCounts([]), {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  });

  // 3.2 4 档各 1 条 (混 watchdog/alert)
  const items: TimelineItem[] = [
    { ts: '1', type: 'risk_alert', title: 'a', severity: 'low' },
    { ts: '2', type: 'watchdog_trigger', title: 'b', severity: 'medium' },
    { ts: '3', type: 'risk_alert', title: 'c', severity: 'high' },
    { ts: '4', type: 'watchdog_trigger', title: 'd', severity: 'critical' },
  ];
  assertEqual('3.2 4 档各 1', aggregateAlertCounts(items), {
    low: 1,
    medium: 1,
    high: 1,
    critical: 1,
  });

  // 3.3 非 alert/watchdog 类型不归桶
  const mixed: TimelineItem[] = [
    { ts: '1', type: 'risk_alert', title: 'a', severity: 'high' },
    { ts: '2', type: 'news', title: 'b', severity: 'high' },
    { ts: '3', type: 'price_break', title: 'c', severity: 'critical' },
  ];
  assertEqual('3.3 仅归 alert/watchdog', aggregateAlertCounts(mixed), {
    low: 0,
    medium: 0,
    high: 1,
    critical: 0,
  });

  // 3.4 severity 缺省 → medium
  const noSev: TimelineItem[] = [{ ts: '1', type: 'risk_alert', title: 'a' }];
  assertEqual('3.4 无 severity → medium', aggregateAlertCounts(noSev), {
    low: 0,
    medium: 1,
    high: 0,
    critical: 0,
  });
}

// ============================================================================
// [4] sortTimeline
// ============================================================================
console.log('\n[4] sortTimeline');
{
  // 4.1 ts 升序
  const unsorted: TimelineItem[] = [
    { ts: '2026-06-10T05:00:00Z', type: 'risk_alert', title: 'c' },
    { ts: '2026-06-10T03:00:00Z', type: 'risk_alert', title: 'a' },
    { ts: '2026-06-10T04:00:00Z', type: 'risk_alert', title: 'b' },
  ];
  const sorted = sortTimeline(unsorted);
  assertEqual('4.1 ts 升序', sorted.map(i => i.title), ['a', 'b', 'c']);

  // 4.2 不 mutate 输入
  assertEqual('4.2 输入未变', unsorted[0].title, 'c');

  // 4.3 ts 相同 → source_id 升序
  const sameT: TimelineItem[] = [
    { ts: 'T', type: 'risk_alert', title: 'b', source_id: 5 },
    { ts: 'T', type: 'risk_alert', title: 'a', source_id: 2 },
  ];
  const s2 = sortTimeline(sameT);
  assertEqual('4.3 source_id 兜底', s2.map(i => i.source_id), [2, 5]);

  // 4.4 ts + source_id 全相同 → title localeCompare
  const sameTI: TimelineItem[] = [
    { ts: 'T', type: 'risk_alert', title: 'banana', source_id: 1 },
    { ts: 'T', type: 'risk_alert', title: 'apple', source_id: 1 },
  ];
  const s3 = sortTimeline(sameTI);
  assertEqual('4.4 title 兜底', s3.map(i => i.title), ['apple', 'banana']);

  // 4.5 空数组
  assertEqual('4.5 空 → []', sortTimeline([]), []);

  // 4.6 source_id 缺省 (用 +Infinity 排末尾)
  const noId: TimelineItem[] = [
    { ts: 'T', type: 'risk_alert', title: 'no-id' },
    { ts: 'T', type: 'risk_alert', title: 'has-id', source_id: 1 },
  ];
  const s4 = sortTimeline(noId);
  assertEqual('4.6 缺 source_id 排后', s4[0].title, 'has-id');
}

// ============================================================================
// [5] truncateTimeline
// ============================================================================
console.log('\n[5] truncateTimeline');
{
  const items: TimelineItem[] = Array.from({ length: 10 }, (_, i) => ({
    ts: `t${i}`,
    type: 'risk_alert' as const,
    title: `i${i}`,
  }));
  // 5.1 cap=0 → []
  assertEqual('5.1 cap=0', truncateTimeline(items, 0), []);
  // 5.2 cap=负 → []
  assertEqual('5.2 cap=-1', truncateTimeline(items, -1), []);
  // 5.3 cap >= len → 拷贝全返
  const eq = truncateTimeline(items, 10);
  assertEqual('5.3a cap=len → 全返', eq.length, 10);
  // 5.4 返新数组 (shallow copy — push 到 eq 不影响 items)
  eq.push({ ts: 'extra', type: 'risk_alert', title: 'extra' });
  assertEqual('5.4 items.length 未变 (新数组)', items.length, 10);
  // 5.5 cap < len → 保首尾 (前 cap-1 + 最后 1)
  const trunc = truncateTimeline(items, 3);
  assertEqual('5.5a len=3', trunc.length, 3);
  assertEqual('5.5b 首点保留', trunc[0].title, 'i0');
  assertEqual('5.5c 中点保留 (前 cap-1)', trunc[1].title, 'i1');
  assertEqual('5.5d 末点保留', trunc[2].title, 'i9');
  // 5.6 cap=1 → 仅末点
  const one = truncateTimeline(items, 1);
  assertEqual('5.6 cap=1 → 仅末点', one.length, 1);
  assertEqual('5.6b 末点', one[0].title, 'i9');
}

// ============================================================================
// [6] buildEventTimeline engine
// ============================================================================
console.log('\n[6] buildEventTimeline engine');
{
  const eventAt = new Date('2026-06-10T03:30:00Z');

  // 6.1 空 input → 空 timeline + sources_used=[]
  const empty = buildEventTimeline({ event_detected_at: eventAt });
  assertEqual('6.1a timeline=[]', empty.timeline, []);
  assertEqual('6.1b sources_used=[]', empty.meta.sources_used, []);
  assertEqual('6.1c items_total=0', empty.meta.items_total, 0);
  assertEqual('6.1d items_truncated=false', empty.meta.items_truncated, false);
  assertEqual('6.1e lookback_days 默认 7', empty.lookback_days, BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_DAYS);
  assertEqual('6.1f replayer_version', empty.replayer_version, BLACK_SWAN_TIMELINE_REPLAYER_VERSION);
  assertEqual('6.1g event_detected_at ISO', empty.meta.event_detected_at, eventAt.toISOString());
  assertEqual('6.1h alert_count_by_level 全 0', empty.alert_count_by_level, {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  });

  // 6.2 全 4 档 risk_alerts
  const fourLv = buildEventTimeline({
    event_detected_at: eventAt,
    risk_alerts: [
      mkAlert({ id: 1, level: 'low', created_at: new Date('2026-06-09T01:00:00Z') }),
      mkAlert({ id: 2, level: 'medium', created_at: new Date('2026-06-09T02:00:00Z') }),
      mkAlert({ id: 3, level: 'high', created_at: new Date('2026-06-09T03:00:00Z') }),
      mkAlert({ id: 4, level: 'critical', created_at: new Date('2026-06-09T04:00:00Z') }),
    ],
  });
  assertEqual('6.2a items_total=4', fourLv.meta.items_total, 4);
  assertEqual('6.2b 4 档分布', fourLv.alert_count_by_level, {
    low: 1,
    medium: 1,
    high: 1,
    critical: 1,
  });
  assertEqual('6.2c sources_used 含 risk_alerts', fourLv.meta.sources_used, ['risk_alerts']);
  // timeline 升序 by ts
  assertEqual('6.2d timeline 升序', fourLv.timeline.map(i => i.source_id), [1, 2, 3, 4]);

  // 6.3 extra_items 拼接
  const extra = buildEventTimeline({
    event_detected_at: eventAt,
    extra_items: [{ ts: 'T', type: 'news', title: '突发公告' }],
  });
  assertEqual('6.3a sources_used 含 extra_items', extra.meta.sources_used, ['extra_items']);
  assertEqual('6.3b timeline.length=1', extra.timeline.length, 1);

  // 6.4 risk_alerts + extra_items 都给
  const both = buildEventTimeline({
    event_detected_at: eventAt,
    risk_alerts: [mkAlert({ id: 1 })],
    extra_items: [{ ts: 'T', type: 'news', title: '公告' }],
  });
  assertEqual('6.4 sources_used 双', both.meta.sources_used, ['risk_alerts', 'extra_items']);

  // 6.5 lookback_days override
  const ov = buildEventTimeline({ event_detected_at: eventAt, lookback_days: 14 });
  assertEqual('6.5 lookback_days=14', ov.lookback_days, 14);
  assertEqual('6.5b meta.lookback_days=14', ov.meta.lookback_days, 14);

  // 6.6 lookback_days 非法 → 默认 7
  const bad = buildEventTimeline({ event_detected_at: eventAt, lookback_days: -1 });
  assertEqual('6.6 非法 lookback_days fallback', bad.lookback_days, BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_DAYS);

  // 6.7 items_cap default
  assertEqual('6.7 cap 默认', empty.meta.items_cap, BLACK_SWAN_TIMELINE_DEFAULT_ITEMS_CAP);

  // 6.8 items_cap override + items_truncated=true
  const many = Array.from({ length: 50 }, (_, i) =>
    mkAlert({ id: i, created_at: new Date(2026, 5, 9, 0, 0, 0, i) })
  );
  const capped = buildEventTimeline({
    event_detected_at: eventAt,
    risk_alerts: many,
    items_cap: 10,
  });
  assertEqual('6.8a items_cap=10', capped.meta.items_cap, 10);
  assertEqual('6.8b timeline.length=10', capped.timeline.length, 10);
  assertEqual('6.8c items_total=50 (排序前总数)', capped.meta.items_total, 50);
  assertEqual('6.8d items_truncated=true', capped.meta.items_truncated, true);
  // 截断后首=第一条 source_id=0, 末=最后一条 source_id=49
  assertEqual('6.8e 首点保留', capped.timeline[0].source_id, 0);
  assertEqual('6.8f 末点保留', capped.timeline[capped.timeline.length - 1].source_id, 49);

  // 6.9 items_cap 非法 → 默认 200
  const badCap = buildEventTimeline({ event_detected_at: eventAt, items_cap: 0 });
  assertEqual('6.9 非法 cap fallback', badCap.meta.items_cap, BLACK_SWAN_TIMELINE_DEFAULT_ITEMS_CAP);
}

// ============================================================================
// [7] appendSectionFilled / decidePostmortemStatus
// ============================================================================
console.log('\n[7] appendSectionFilled / decidePostmortemStatus');
{
  // 7.1 空 metadata
  const r1 = appendSectionFilled({}, 'event_timeline');
  assertEqual('7.1a sections_filled=[本段]', r1.sections_filled, ['event_timeline']);
  assertEqual(
    '7.1b merged_metadata.sections_filled',
    (r1.merged_metadata as any).sections_filled,
    ['event_timeline']
  );

  // 7.2 已含本段 → 不重复
  const r2 = appendSectionFilled(
    { sections_filled: ['event_summary', 'event_timeline'] },
    'event_timeline'
  );
  assertEqual('7.2 已含不重复', r2.sections_filled.sort(), ['event_summary', 'event_timeline']);

  // 7.3 累加
  const r3 = appendSectionFilled(
    { sections_filled: ['event_summary', 'counterfactual_baselines'] },
    'event_timeline'
  );
  assertEqual('7.3 累加', r3.sections_filled.sort(), [
    'counterfactual_baselines',
    'event_summary',
    'event_timeline',
  ]);

  // 7.4 sections_filled 非数组兜底
  const r4 = appendSectionFilled(
    { sections_filled: 'not-array' as unknown as string[] },
    'event_timeline'
  );
  assertEqual('7.4 非数组兜底', r4.sections_filled, ['event_timeline']);

  // 7.5 非 string 项过滤
  const r5 = appendSectionFilled(
    { sections_filled: ['event_summary', 123 as unknown as string, null] },
    'event_timeline'
  );
  assertEqual('7.5 非 string 过滤', r5.sections_filled.sort(), [
    'event_summary',
    'event_timeline',
  ]);

  // 7.6 保留其它 metadata key
  const r6 = appendSectionFilled({ foo: 'bar', sections_filled: [] }, 'event_timeline');
  assertEqual('7.6 保留其它 key', (r6.merged_metadata as any).foo, 'bar');

  // 7.7 decidePostmortemStatus — 4 段全 ok
  const ok = decidePostmortemStatus(Array.from(ALL_POSTMORTEM_SECTIONS));
  assertEqual('7.7a 4 段全 → status=ok', ok.status, 'ok');
  assertEqual('7.7b reason=null', ok.reason, null);

  // 7.8 缺段 → partial + reason 含 pending_sections
  const p = decidePostmortemStatus(['event_summary', 'event_timeline']);
  assertEqual('7.8a 缺段 → partial', p.status, 'partial');
  assert(
    '7.8b reason 含 pending_sections',
    Boolean(p.reason && p.reason.includes('pending_sections'))
  );
  assert(
    '7.8c reason 含 counterfactual_baselines',
    Boolean(p.reason && p.reason.includes('counterfactual_baselines'))
  );

  // 7.9 空 → partial
  assertEqual('7.9 空 → partial', decidePostmortemStatus([]).status, 'partial');

  // 7.10 ALL_POSTMORTEM_SECTIONS frozen
  assert('7.10 ALL_POSTMORTEM_SECTIONS 已 freeze', Object.isFrozen(ALL_POSTMORTEM_SECTIONS));
  assertEqual('7.10b ALL_POSTMORTEM_SECTIONS.length=4', ALL_POSTMORTEM_SECTIONS.length, 4);
}

// ============================================================================
// [8] runEventTimelineReplayerService e2e
// ============================================================================
async function run8(): Promise<void> {
  console.log('\n[8] runEventTimelineReplayerService e2e');

  // (a) loadCandidates ok=false
  {
    const { runner } = makeFakeRunner({ loadResult: { ok: false, error: 'db_down' } });
    const r = await runEventTimelineReplayerService(runner, {});
    assertEqual('8a.1 success=false', r.success, false);
    assert(
      '8a.2 error 含 candidates_query_failed',
      Boolean(r.error && r.error.includes('candidates_query_failed'))
    );
    assert('8a.3 error 含原 error', Boolean(r.error && r.error.includes('db_down')));
    assertEqual('8a.4 candidates_total=0', r.candidates_total, 0);
  }

  // (b) loadCandidates throw
  {
    const { runner } = makeFakeRunner({ loadShouldThrow: new Error('network_blown') });
    const r = await runEventTimelineReplayerService(runner, {});
    assertEqual('8b.1 success=false', r.success, false);
    assert(
      '8b.2 error 含 candidates_query_failed',
      Boolean(r.error && r.error.includes('candidates_query_failed'))
    );
    assert('8b.3 error 含原 throw', Boolean(r.error && r.error.includes('network_blown')));
  }

  // (c) 无 candidates
  {
    const { runner } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    const r = await runEventTimelineReplayerService(runner, {});
    assertEqual('8c.1 success=true', r.success, true);
    assertEqual('8c.2 candidates_total=0', r.candidates_total, 0);
    assertEqual('8c.3 reports_updated=0', r.reports_updated, 0);
  }

  // (d) dry_run=true → 不调 loadRiskAlerts / updateReport
  {
    const { runner, state } = makeFakeRunner({
      loadResult: {
        ok: true,
        candidates: [makePartial(), makePartial({ id: 2, black_swan_event_id: 12 })],
      },
    });
    const r = await runEventTimelineReplayerService(runner, { dry_run: true });
    assertEqual('8d.1 success=true', r.success, true);
    assertEqual('8d.2 dry_run=true', r.dry_run, true);
    assertEqual('8d.3 candidates_total=2', r.candidates_total, 2);
    assertEqual('8d.4 reports_updated=0', r.reports_updated, 0);
    assertEqual('8d.5 不调 loadRiskAlerts', state.alertCalls.length, 0);
    assertEqual('8d.6 不调 updateReport', state.updateCalls.length, 0);
  }

  // (e) loadRiskAlerts throw → alerts=[]; engine 仍跑 (无 alert → skipped)
  {
    const am = new Map<string, RiskAlertSnapshot[] | Error>();
    am.set('600519', new Error('alert_db_down'));
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      alertsBySymbol: am,
    });
    const r = await runEventTimelineReplayerService(runner, {});
    assertEqual('8e.1 success=true (不抛)', r.success, true);
    assertEqual('8e.2 reports_skipped=1 (无 items)', r.reports_skipped, 1);
    assertEqual('8e.3 reports_updated=0', r.reports_updated, 0);
    assertEqual('8e.4 reports_failed=0', r.reports_failed, 0);
  }

  // (f) 无 alerts → timeline 为空 → skipped
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      alertsDefault: [],
    });
    const r = await runEventTimelineReplayerService(runner, {});
    assertEqual('8f.1 reports_skipped=1', r.reports_skipped, 1);
    assertEqual('8f.2 reports_updated=0', r.reports_updated, 0);
  }

  // (g) updateReport ok=false → failed +1
  {
    const am = new Map<string, RiskAlertSnapshot[] | Error>();
    am.set('600519', [mkAlert()]);
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      alertsBySymbol: am,
      updateResults: [{ ok: false, error: 'pg_explode' }],
    });
    const r = await runEventTimelineReplayerService(runner, {});
    assertEqual('8g.1 success=true', r.success, true);
    assertEqual('8g.2 reports_failed=1', r.reports_failed, 1);
    assertEqual('8g.3 reports_updated=0', r.reports_updated, 0);
  }

  // (h) updateReport throw → failed +1
  {
    const am = new Map<string, RiskAlertSnapshot[] | Error>();
    am.set('600519', [mkAlert()]);
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      alertsBySymbol: am,
      updateResults: [new Error('sequelize_blow')],
    });
    const r = await runEventTimelineReplayerService(runner, {});
    assertEqual('8h.1 success=true', r.success, true);
    assertEqual('8h.2 reports_failed=1', r.reports_failed, 1);
  }

  // (i) 全成功 + 多条 + status partial/ok + payload 仅含 5 列
  {
    const am = new Map<string, RiskAlertSnapshot[] | Error>();
    am.set('600519', [
      mkAlert({ id: 11, level: 'HIGH', created_at: new Date('2026-06-09T01:00:00Z') }),
      mkAlert({
        id: 12,
        level: 'CRITICAL',
        rule_id: 'black_swan',
        created_at: new Date('2026-06-09T02:00:00Z'),
      }),
    ]);
    am.set('000001', [
      mkAlert({ id: 21, level: 'medium', created_at: new Date('2026-06-09T03:00:00Z') }),
    ]);
    const { runner, state } = makeFakeRunner({
      loadResult: {
        ok: true,
        candidates: [
          makePartial({ id: 100, event_symbol: '600519' }),
          makePartial({
            id: 200,
            event_symbol: '000001',
            // 3 段已填, 加本段后 4 段全 → status='ok'
            current_metadata: {
              sections_filled: ['event_summary', 'counterfactual_baselines', 'improvement_suggestions'],
            },
          }),
        ],
      },
      alertsBySymbol: am,
    });
    const r = await runEventTimelineReplayerService(runner, {});
    assertEqual('8i.1 success=true', r.success, true);
    assertEqual('8i.2 candidates_total=2', r.candidates_total, 2);
    assertEqual('8i.3 reports_updated=2', r.reports_updated, 2);
    assertEqual('8i.4 reports_failed=0', r.reports_failed, 0);
    assertEqual('8i.5 reports_skipped=0', r.reports_skipped, 0);
    assertEqual('8i.6 updateCalls.length=2', state.updateCalls.length, 2);

    // 行 1 (id=100): 1 段累加 → 2/4 段 → partial
    const row1 = state.updateCalls[0];
    assertEqual('8i.7a id 透传', row1.id, 100);
    assertEqual('8i.7b status=partial (2/4 段)', row1.status, 'partial');
    assert(
      '8i.7c reason 含 pending_sections',
      Boolean(row1.reason && row1.reason.includes('pending_sections'))
    );
    assertEqual(
      '8i.7d sections_filled 累加',
      (row1.metadata as any).sections_filled.sort(),
      ['event_summary', 'event_timeline']
    );
    assertEqual(
      '8i.7e replayer_version 覆盖到 metadata',
      (row1.metadata as any).replayer_version,
      BLACK_SWAN_TIMELINE_REPLAYER_VERSION
    );
    assert(
      '8i.7f event_timeline_filled_at_iso 已写',
      typeof (row1.metadata as any).event_timeline_filled_at_iso === 'string'
    );
    assertEqual('8i.7g timeline.length=2', row1.event_timeline.timeline.length, 2);
    // alert_count_by_level: high=1 (id=11), critical=1 (id=12 watchdog)
    assertEqual('8i.7h alert_count_by_level', row1.event_timeline.alert_count_by_level, {
      low: 0,
      medium: 0,
      high: 1,
      critical: 1,
    });

    // 行 2 (id=200): 4 段全 → status='ok' / reason=null
    const row2 = state.updateCalls[1];
    assertEqual('8i.8a id 透传', row2.id, 200);
    assertEqual('8i.8b status=ok (4/4 段)', row2.status, 'ok');
    assertEqual('8i.8c reason=null', row2.reason, null);
    assertEqual(
      '8i.8d sections_filled 4 段全',
      (row2.metadata as any).sections_filled.sort(),
      ['counterfactual_baselines', 'event_summary', 'event_timeline', 'improvement_suggestions']
    );

    // payload 仅含约定 5 列 — 不出现其它 JSONB 段 (核心契约 — 与 PR-013/014 同款不擦其它段)
    assert('8i.9a row 不含 event_summary key', !('event_summary' in row1));
    assert('8i.9b row 不含 counterfactual_baselines key', !('counterfactual_baselines' in row1));
    assert('8i.9c row 不含 improvement_suggestions key', !('improvement_suggestions' in row1));
    assert('8i.9d row1 含 event_timeline key', 'event_timeline' in row1);
    assert('8i.9e row1 含 metadata key', 'metadata' in row1);
    assert('8i.9f row1 含 status key', 'status' in row1);
    assert('8i.9g row1 含 reason key', 'reason' in row1);
    assert('8i.9h row1 含 generated_at key', 'generated_at' in row1);

    // loadRiskAlerts 调用参数: symbol 透传 + lookback_days default
    assertEqual('8i.10a alertCalls.length=2', state.alertCalls.length, 2);
    assertEqual('8i.10b symbol 透传 row1', state.alertCalls[0].symbol, '600519');
    assertEqual('8i.10c symbol 透传 row2', state.alertCalls[1].symbol, '000001');
    assertEqual(
      '8i.10d lookback_days default',
      state.alertCalls[0].lookback_days,
      BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_DAYS
    );
  }

  // (j) event_id + lookback_hours + lookback_days 透传
  {
    const { runner, state } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    await runEventTimelineReplayerService(runner, {
      event_id: 42,
      lookback_hours: 72,
      lookback_days: 14,
    });
    assertEqual('8j.1 loadCalls.length=1', state.loadCalls.length, 1);
    assertEqual('8j.2 event_id 透传', state.loadCalls[0].event_id, 42);
    assertEqual('8j.3 lookback_hours 透传', state.loadCalls[0].lookback_hours, 72);

    // 默认值
    const { runner: r2, state: s2 } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    await runEventTimelineReplayerService(r2, {});
    assertEqual(
      '8j.4 lookback_hours 默认',
      s2.loadCalls[0].lookback_hours,
      BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_HOURS
    );

    // 非法 lookback_hours fallback
    const { runner: r3, state: s3 } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    await runEventTimelineReplayerService(r3, { lookback_hours: -10 });
    assertEqual(
      '8j.5 非法 lookback_hours fallback',
      s3.loadCalls[0].lookback_hours,
      BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_HOURS
    );

    // lookback_days 透传到 loadRiskAlerts 调用
    const am = new Map<string, RiskAlertSnapshot[] | Error>();
    am.set('600519', [mkAlert()]);
    const { runner: r4, state: s4 } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      alertsBySymbol: am,
    });
    await runEventTimelineReplayerService(r4, { lookback_days: 14 });
    assertEqual('8j.6 loadRiskAlerts lookback_days 透传', s4.alertCalls[0].lookback_days, 14);
  }

  // (k) metadata 透传 + replayer_version 覆盖 + generated_at 覆盖
  {
    const am = new Map<string, RiskAlertSnapshot[] | Error>();
    am.set('600519', [mkAlert()]);
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, candidates: [makePartial()] },
      alertsBySymbol: am,
    });
    const customAt = new Date('2026-07-01T12:00:00Z');
    await runEventTimelineReplayerService(runner, {
      metadata: { cron_run_id: 999, service_version: 'PR-015/v1' },
      generated_at: customAt,
    });
    const md = state.updateCalls[0].metadata as any;
    assertEqual('8k.1 cron_run_id 透传', md.cron_run_id, 999);
    // replayer_version 由 service 强制写入, 覆盖 metadata 同名 key
    assertEqual(
      '8k.2 replayer_version service 强制',
      md.replayer_version,
      BLACK_SWAN_TIMELINE_REPLAYER_VERSION
    );
    // generated_at 覆盖
    assertEqual(
      '8k.3 generated_at 覆盖',
      state.updateCalls[0].generated_at.toISOString(),
      customAt.toISOString()
    );
    // generated_at_iso 在主返值里
    const r = await runEventTimelineReplayerService(runner, {
      loadResult: { ok: true, candidates: [] },
    } as any);
    assert('8k.4 generated_at_iso 是 string', typeof r.generated_at_iso === 'string');
  }
}

// ============================================================================
// [9] PRODUCTION runner smoke
// ============================================================================
async function run9(): Promise<void> {
  console.log('\n[9] PRODUCTION runner smoke');
  const r = createProductionTimelineRunner();
  assert('9.1 createProductionTimelineRunner 返对象', typeof r === 'object' && r !== null);
  assert('9.2 含 loadCandidates', typeof r.loadCandidates === 'function');
  assert('9.3 含 loadRiskAlerts', typeof r.loadRiskAlerts === 'function');
  assert('9.4 含 updateReport', typeof r.updateReport === 'function');
  // singleton
  const s1 = getProductionTimelineRunner();
  const s2 = getProductionTimelineRunner();
  assert('9.5 singleton 同一实例', s1 === s2);
  // loadCandidates 脱 DB → 走 try/catch 返 ok:false (永不抛)
  const lc = await s1.loadCandidates({ asOf: new Date(), lookback_hours: 24 });
  assert(
    '9.6 loadCandidates 脱 DB 永不抛',
    typeof lc === 'object' && 'ok' in lc
  );
  // loadRiskAlerts 脱 DB → 返 [] (永不抛)
  const la = await s1.loadRiskAlerts({
    symbol: '600519',
    event_detected_at: new Date(),
    lookback_days: 7,
  });
  assert('9.7 loadRiskAlerts 脱 DB → 数组', Array.isArray(la));
  // updateReport 脱 DB → 返 ok:false (永不抛)
  const ur = await s1.updateReport({
    id: 1,
    event_timeline: {
      lookback_days: 7,
      timeline: [],
      alert_count_by_level: { low: 0, medium: 0, high: 0, critical: 0 },
      replayer_version: BLACK_SWAN_TIMELINE_REPLAYER_VERSION,
      meta: {
        event_detected_at: new Date().toISOString(),
        lookback_days: 7,
        items_total: 0,
        items_truncated: false,
        items_cap: 200,
        sources_used: [],
      },
    },
    metadata: {},
    status: 'partial',
    reason: null,
    generated_at: new Date(),
  });
  assert('9.8 updateReport 脱 DB → 永不抛', typeof ur === 'object' && 'ok' in ur);
}

// ============================================================================
// [10] META-GUARD — 源文件正则扫
// ============================================================================
console.log('\n[10] META-GUARD');
{
  const ROOT = join(__dirname, '../..');
  const SCHEDULER_SRC = readFileSync(join(ROOT, 'src/services/SchedulerService.ts'), 'utf8');
  const SERVICE_SRC = readFileSync(
    join(ROOT, 'src/services/EventTimelineReplayerService.ts'),
    'utf8'
  );
  const REGISTRY_SRC = readFileSync(join(ROOT, 'src/constants/cronRegistry.ts'), 'utf8');

  // 10.1 cronRegistry 含 BLACK_SWAN_TIMELINE type
  assert(
    '10.1 cronRegistry 含 BLACK_SWAN_TIMELINE',
    REGISTRY_SRC.includes("type: 'BLACK_SWAN_TIMELINE'")
  );
  // 10.2 recommendedCron 与常量一致
  assert(
    '10.2 cronRegistry recommendedCron 一致',
    REGISTRY_SRC.includes(`recommendedCron: '${BLACK_SWAN_TIMELINE_RECOMMENDED_CRON}'`)
  );
  // 10.3 与 BLACK_SWAN_BASELINE 错峰 (23,53 vs 33,3)
  assert(
    '10.3 错峰 BLACK_SWAN_BASELINE (23,53 vs 33,3)',
    REGISTRY_SRC.includes("recommendedCron: '23,53 * * * *'") &&
      REGISTRY_SRC.includes("recommendedCron: '33,3 * * * *'")
  );
  // 10.4 SchedulerService 含 dispatch 分支
  assert(
    '10.4 SchedulerService dispatch 分支',
    SCHEDULER_SRC.includes("task.type === 'BLACK_SWAN_TIMELINE'")
  );
  // 10.5 SchedulerService lazy-require
  assert(
    '10.5 SchedulerService lazy-require',
    SCHEDULER_SRC.includes('runEventTimelineReplayerService') &&
      SCHEDULER_SRC.includes("require('./EventTimelineReplayerService')")
  );
  // 10.6 SchedulerService 透传 dry_run + event_id + lookback_hours + lookback_days
  assert(
    '10.6 SchedulerService 透传 4 参数',
    /dry_run:\s*dryRunTl/.test(SCHEDULER_SRC) &&
      /event_id:\s*eventIdTl/.test(SCHEDULER_SRC) &&
      /lookback_hours:/.test(SCHEDULER_SRC) &&
      /lookback_days:/.test(SCHEDULER_SRC)
  );
  // 10.7 Service jsdoc 含 US-104 / PR-015
  assert(
    '10.7 Service jsdoc 含 US-104/PR-015',
    SERVICE_SRC.includes('US-104') && SERVICE_SRC.includes('PR-015')
  );
  // 10.8 Service jsdoc 含 RiskAlert + Watchdog 双数据源
  assert(
    '10.8 Service jsdoc 含 RiskAlert + Watchdog',
    SERVICE_SRC.includes('RiskAlert') && SERVICE_SRC.includes('Watchdog')
  );
  // 10.9 Service 标 fail-OPEN
  assert('10.9 Service 标 fail-OPEN', SERVICE_SRC.includes('fail-OPEN'));
  // 10.10 Service 标 idempotent + sections_filled
  assert(
    '10.10 Service 标 idempotent + sections_filled',
    SERVICE_SRC.includes('idempotent') && SERVICE_SRC.includes('sections_filled')
  );
  // 10.11 Service 标与 PR-013/014/016 段间分工
  assert(
    '10.11 Service 标 PR-013/014/016 分工',
    SERVICE_SRC.includes('PR-013') &&
      SERVICE_SRC.includes('PR-014') &&
      SERVICE_SRC.includes('PR-016')
  );
  // 10.12 Service 标"不擦其它段"
  assert(
    '10.12 Service 标不擦其它 JSONB 段',
    /不动它们|不擦/.test(SERVICE_SRC)
  );
  // 10.13 Service 标与 BLACK_SWAN_BASELINE 错峰
  assert(
    '10.13 Service 标错峰 BLACK_SWAN_BASELINE',
    SERVICE_SRC.includes('BLACK_SWAN_BASELINE') && SERVICE_SRC.includes('错峰')
  );
  // 10.14 cap 常量合理
  assertEqual('10.14 BLACK_SWAN_TIMELINE_DEFAULT_ITEMS_CAP=200', BLACK_SWAN_TIMELINE_DEFAULT_ITEMS_CAP, 200);
  // 10.15 默认 lookback_days=7 与 PRD US-104 AC 一致
  assertEqual(
    '10.15 默认 lookback_days=7 (PRD AC)',
    BLACK_SWAN_TIMELINE_DEFAULT_LOOKBACK_DAYS,
    7
  );
  // 10.16 ALL_POSTMORTEM_SECTIONS 4 段
  assertEqual('10.16 ALL_POSTMORTEM_SECTIONS.length=4', ALL_POSTMORTEM_SECTIONS.length, 4);
}

// ============================================================================
// Async wrapper
// ============================================================================
(async () => {
  await run8();
  await run9();

  console.log(`\n[EventTimelineReplayerService] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error('test crashed:', err);
  process.exit(1);
});
