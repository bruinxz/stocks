/**
 * BlackSwanQuarterlyReportService 单元测试 (US-134 [PR-019]).
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/black-swan-quarterly-report-service.test.ts
 *
 * 覆盖维度:
 *   [1] parseYmd — happy / 非法格式 / 边界 / 非数字
 *   [2] monthToQuarter / quarterMonths / lastDayOfQuarterMonth — 12 月全覆盖
 *   [3] computePrevQuarterRange — 4 季 + 跨年 + Asia/Shanghai 起止 UTC 时戳
 *   [4] aggregateByDimension — count desc + key asc tie / 空 events / 空 key
 *   [5] aggregateTopSymbols — 仅 scope=symbol / cap / worst_severity / last_detected_at
 *   [6] severityRank — 4 级 + 未知 → 0
 *   [7] buildSeverityHighlights — 仅 critical+high / detected_at desc / cap
 *   [8] countDaysWithEvents — UTC→Asia/Shanghai 跨日 + 去重
 *   [9] parseRecipientsList — 逗号/分号/空白 + trim + 去重 + 空
 *   [10] buildQuarterlyReportPayload — events_total / days_with_events / 5 维度齐
 *   [11] buildQuarterlyReportEmail — subject 含 year+Q / html 含数据 / text 兜底
 *        + htmlEscape 防注入
 *   [12] runBlackSwanQuarterlyReport e2e (fake runner):
 *        (a) 非法 reference_date → success=false + error
 *        (b) loadEvents ok=false → success=false + error: events_query_failed
 *        (c) dry_run=true → 不调 sendEmail + payload 完整
 *        (d) 空 events → success=true + payload.events_total=0
 *        (e) recipients_override 透传 + 真发送累计 sent_count
 *        (f) listRecipients 返空 → skipped success=true + error=no_recipients_configured
 *        (g) sendEmail 返 success → sent_count +1
 *        (h) sendEmail 返 skipped → skipped_count +1
 *        (i) sendEmail 返 success=false (无 skipped) → failed_count +1
 *        (j) sendEmail throw → failed_count +1 整体不抛
 *        (k) listRecipients throw → recipients=[] + skipped
 *   [13] PRODUCTION runner smoke — 工厂返对象 + singleton + listRecipients 读 env
 *   [14] META-GUARD: cron registry 含 BLACK_SWAN_QUARTERLY_SUMMARY + SchedulerService
 *        含 dispatch 分支 + service jsdoc 含 PR-019/US-134 + 邮件 + fail-OPEN
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BLACK_SWAN_QUARTERLY_RECOMMENDED_CRON,
  QUARTERLY_SEVERITY_HIGHLIGHT_CAP,
  QUARTERLY_TOP_SYMBOLS_CAP,
  QuarterRange,
  QuarterlyBlackSwanEventSnapshot,
  QuarterlyReportPayload,
  QuarterlyReportRunner,
  aggregateByDimension,
  aggregateTopSymbols,
  buildQuarterlyReportEmail,
  buildQuarterlyReportPayload,
  buildSeverityHighlights,
  computePrevQuarterRange,
  countDaysWithEvents,
  createProductionQuarterlyRunner,
  getProductionQuarterlyRunner,
  lastDayOfQuarterMonth,
  monthToQuarter,
  parseRecipientsList,
  parseYmd,
  quarterMonths,
  runBlackSwanQuarterlyReport,
  severityRank,
} from '../../src/services/BlackSwanQuarterlyReportService';
import type { EmailNotificationSendResult } from '../../src/services/EmailNotificationService';

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

function makeEvent(
  overrides: Partial<QuarterlyBlackSwanEventSnapshot> = {}
): QuarterlyBlackSwanEventSnapshot {
  return {
    id: 1,
    detected_at: new Date('2026-04-15T03:30:00Z'),
    event_type: 'ST',
    severity: 'high',
    scope: 'symbol',
    symbol: '600519.SH',
    title: 'ST 茅台',
    signature: 'ST::600519',
    ...overrides,
  };
}

interface FakeRunnerState {
  loadCalls: Array<{ start_at: Date; end_at: Date }>;
  sendCalls: Array<{ payload: QuarterlyReportPayload; address: string }>;
  listCalls: number;
  loadResult:
    | { ok: true; events: QuarterlyBlackSwanEventSnapshot[] }
    | { ok: false; error: string };
  listResult: string[] | Error;
  sendResults: Array<EmailNotificationSendResult | Error>;
}

function makeFakeRunner(
  overrides: Partial<FakeRunnerState> = {}
): {
  runner: QuarterlyReportRunner;
  state: FakeRunnerState;
} {
  const state: FakeRunnerState = {
    loadCalls: [],
    sendCalls: [],
    listCalls: 0,
    loadResult: { ok: true, events: [] },
    listResult: ['ops@example.com'],
    sendResults: [],
    ...overrides,
  };
  let sendIdx = 0;
  const runner: QuarterlyReportRunner = {
    async loadEvents(input) {
      state.loadCalls.push(input);
      return state.loadResult;
    },
    async listRecipients() {
      state.listCalls += 1;
      if (state.listResult instanceof Error) throw state.listResult;
      return state.listResult;
    },
    async sendEmail(payload, address) {
      state.sendCalls.push({ payload, address });
      const res = state.sendResults[sendIdx];
      sendIdx += 1;
      if (res instanceof Error) throw res;
      if (!res) return { success: true };
      return res;
    },
  };
  return { runner, state };
}

// ---------------------------------------------------------------------------
// [1] parseYmd
// ---------------------------------------------------------------------------
console.log('\n[1] parseYmd...');
assertEqual('happy', parseYmd('2026-04-01'), { year: 2026, month: 4, day: 1 });
assertEqual('边界 12 月末', parseYmd('2025-12-31'), { year: 2025, month: 12, day: 31 });
assertEqual('非法分隔', parseYmd('2026/04/01'), null);
assertEqual('短 year', parseYmd('26-04-01'), null);
assertEqual('非数字', parseYmd('abcd-04-01'), null);
assertEqual('月 0', parseYmd('2026-00-01'), null);
assertEqual('月 13', parseYmd('2026-13-01'), null);
assertEqual('空串', parseYmd(''), null);
assertEqual('non-string', parseYmd(null as any), null);

// ---------------------------------------------------------------------------
// [2] monthToQuarter / quarterMonths / lastDayOfQuarterMonth
// ---------------------------------------------------------------------------
console.log('\n[2] monthToQuarter / quarterMonths / lastDayOfQuarterMonth...');
for (let m = 1; m <= 12; m += 1) {
  const expected = Math.ceil(m / 3);
  assertEqual(`monthToQuarter(${m})`, monthToQuarter(m), expected);
}
assertEqual('monthToQuarter(0)', monthToQuarter(0), 0);
assertEqual('monthToQuarter(13)', monthToQuarter(13), 0);
assertEqual('quarterMonths Q1', quarterMonths(1), [1, 3]);
assertEqual('quarterMonths Q2', quarterMonths(2), [4, 6]);
assertEqual('quarterMonths Q3', quarterMonths(3), [7, 9]);
assertEqual('quarterMonths Q4', quarterMonths(4), [10, 12]);
assertEqual('lastDay Q1 2026 (Mar)', lastDayOfQuarterMonth(2026, 1), 31);
assertEqual('lastDay Q2 2026 (Jun)', lastDayOfQuarterMonth(2026, 2), 30);
assertEqual('lastDay Q3 2026 (Sep)', lastDayOfQuarterMonth(2026, 3), 30);
assertEqual('lastDay Q4 2026 (Dec)', lastDayOfQuarterMonth(2026, 4), 31);
// 闰年/平年 Q1 (2 月) — Q1 末是 3 月 31, 与闰年无关 (闰年只影响 2 月末日)
assertEqual('lastDay Q1 2024 (闰年 Mar)', lastDayOfQuarterMonth(2024, 1), 31);

// ---------------------------------------------------------------------------
// [3] computePrevQuarterRange
// ---------------------------------------------------------------------------
console.log('\n[3] computePrevQuarterRange...');
const q2026q2 = computePrevQuarterRange('2026-07-15');
assert('2026-07-15 → 上季 2026 Q2', !!q2026q2);
assertEqual('quarter.year', q2026q2!.year, 2026);
assertEqual('quarter.quarter', q2026q2!.quarter, 2);
assertEqual('quarter.start_date', q2026q2!.start_date, '2026-04-01');
assertEqual('quarter.end_date', q2026q2!.end_date, '2026-06-30');
assertEqual('quarter.days', q2026q2!.days_in_quarter, 91);
// start_at = 2026-04-01 00:00:00 Asia/Shanghai = 2026-03-31 16:00:00 UTC
assertEqual('start_at iso', q2026q2!.start_at.toISOString(), '2026-03-31T16:00:00.000Z');
// end_at = 2026-06-30 23:59:59.999 +08 = 2026-06-30 15:59:59.999 UTC
assertEqual('end_at iso', q2026q2!.end_at.toISOString(), '2026-06-30T15:59:59.999Z');

// 跨年: 2026-01-15 → 上季 2025 Q4
const q2025q4 = computePrevQuarterRange('2026-01-15');
assertEqual('跨年 year', q2025q4!.year, 2025);
assertEqual('跨年 quarter', q2025q4!.quarter, 4);
assertEqual('跨年 start_date', q2025q4!.start_date, '2025-10-01');
assertEqual('跨年 end_date', q2025q4!.end_date, '2025-12-31');
assertEqual('跨年 days', q2025q4!.days_in_quarter, 92);

// 季度首日跑 → 上季正好 (2026-04-01 跑 → 2026 Q1)
const q2026q1 = computePrevQuarterRange('2026-04-01');
assertEqual('季首跑 year', q2026q1!.year, 2026);
assertEqual('季首跑 quarter', q2026q1!.quarter, 1);
assertEqual('季首跑 start_date', q2026q1!.start_date, '2026-01-01');
assertEqual('季首跑 end_date', q2026q1!.end_date, '2026-03-31');
assertEqual('季首跑 days (Q1 平年)', q2026q1!.days_in_quarter, 90);

// 闰年 Q1 (2024-01-01 ~ 2024-03-31 = 91 天)
const q2024q1 = computePrevQuarterRange('2024-04-15');
assertEqual('Q1 闰年 days', q2024q1!.days_in_quarter, 91);

assertEqual('非法 refDate → null', computePrevQuarterRange('not-a-date'), null);

// ---------------------------------------------------------------------------
// [4] aggregateByDimension
// ---------------------------------------------------------------------------
console.log('\n[4] aggregateByDimension...');
const aggEvents = [
  makeEvent({ id: 1, event_type: 'ST', severity: 'high', scope: 'symbol' }),
  makeEvent({ id: 2, event_type: 'ST', severity: 'medium', scope: 'symbol' }),
  makeEvent({ id: 3, event_type: 'NEWS_KEYWORD', severity: 'medium', scope: 'symbol' }),
  makeEvent({ id: 4, event_type: 'SUSPENDED', severity: 'medium', scope: 'symbol' }),
  makeEvent({ id: 5, event_type: 'SUSPENDED', severity: 'low', scope: 'market', symbol: null }),
];
const byType = aggregateByDimension(aggEvents, 'event_type');
assertEqual('byType 长度', byType.length, 3);
// 排序: count desc + key asc tie. ST=2, SUSPENDED=2 (tie), NEWS_KEYWORD=1. ST<SUSPENDED alphabetic
assertEqual('byType[0]', byType[0], { key: 'ST', count: 2, pct: 40 });
assertEqual('byType[1]', byType[1], { key: 'SUSPENDED', count: 2, pct: 40 });
assertEqual('byType[2]', byType[2], { key: 'NEWS_KEYWORD', count: 1, pct: 20 });
const bySev = aggregateByDimension(aggEvents, 'severity');
assertEqual('bySev 长度', bySev.length, 3);
assertEqual('bySev[0]', bySev[0], { key: 'medium', count: 3, pct: 60 });

// 空 events
assertEqual('空 events 返空', aggregateByDimension([], 'event_type'), []);
// 空 key 过滤
const eventsWithEmpty = [makeEvent({ event_type: '' }), makeEvent({ event_type: 'ST' })];
assertEqual('空 key 过滤后长度', aggregateByDimension(eventsWithEmpty, 'event_type').length, 1);

// ---------------------------------------------------------------------------
// [5] aggregateTopSymbols
// ---------------------------------------------------------------------------
console.log('\n[5] aggregateTopSymbols...');
const topEvents = [
  makeEvent({
    id: 1,
    symbol: '600519.SH',
    scope: 'symbol',
    severity: 'high',
    detected_at: new Date('2026-04-10T00:00:00Z'),
  }),
  makeEvent({
    id: 2,
    symbol: '600519.SH',
    scope: 'symbol',
    severity: 'critical',
    detected_at: new Date('2026-05-20T00:00:00Z'),
  }),
  makeEvent({
    id: 3,
    symbol: '000001.SZ',
    scope: 'symbol',
    severity: 'medium',
    detected_at: new Date('2026-06-01T00:00:00Z'),
  }),
  makeEvent({ id: 4, symbol: null, scope: 'market', severity: 'high' }), // 跳过
  makeEvent({ id: 5, symbol: '300750.SZ', scope: 'sector', severity: 'medium' }), // 跳过 (scope=sector)
];
const top = aggregateTopSymbols(topEvents);
assertEqual('top 长度 (仅 scope=symbol)', top.length, 2);
assertEqual('top[0] symbol', top[0].symbol, '600519.SH');
assertEqual('top[0] count', top[0].count, 2);
assertEqual('top[0] worst_severity (critical 胜)', top[0].worst_severity, 'critical');
assertEqual(
  'top[0] last_detected_at (max)',
  top[0].last_detected_at,
  '2026-05-20T00:00:00.000Z'
);
assertEqual('top[1] symbol', top[1].symbol, '000001.SZ');
assertEqual('top cap=1', aggregateTopSymbols(topEvents, 1).length, 1);
assertEqual('top cap=0', aggregateTopSymbols(topEvents, 0).length, 0);

// ---------------------------------------------------------------------------
// [6] severityRank
// ---------------------------------------------------------------------------
console.log('\n[6] severityRank...');
assertEqual('critical', severityRank('critical'), 4);
assertEqual('high', severityRank('high'), 3);
assertEqual('medium', severityRank('medium'), 2);
assertEqual('low', severityRank('low'), 1);
assertEqual('unknown → 0', severityRank('unknown'), 0);
assertEqual('null → 0', severityRank(null), 0);
assertEqual('CRITICAL (大写) → 4', severityRank('CRITICAL'), 4);

// ---------------------------------------------------------------------------
// [7] buildSeverityHighlights
// ---------------------------------------------------------------------------
console.log('\n[7] buildSeverityHighlights...');
const hlEvents = [
  makeEvent({
    id: 10,
    severity: 'critical',
    detected_at: new Date('2026-04-10T00:00:00Z'),
  }),
  makeEvent({
    id: 11,
    severity: 'high',
    detected_at: new Date('2026-05-20T00:00:00Z'),
  }),
  makeEvent({
    id: 12,
    severity: 'medium',
    detected_at: new Date('2026-06-01T00:00:00Z'),
  }), // 过滤
  makeEvent({ id: 13, severity: 'low', detected_at: new Date('2026-06-02T00:00:00Z') }), // 过滤
];
const hl = buildSeverityHighlights(hlEvents);
assertEqual('hl 长度 (仅 critical+high)', hl.length, 2);
// detected_at desc: id=11 (2026-05-20) > id=10 (2026-04-10)
assertEqual('hl[0] id (最近)', hl[0].id, 11);
assertEqual('hl[1] id', hl[1].id, 10);
assertEqual('hl cap=1', buildSeverityHighlights(hlEvents, 1).length, 1);

// ---------------------------------------------------------------------------
// [8] countDaysWithEvents
// ---------------------------------------------------------------------------
console.log('\n[8] countDaysWithEvents...');
const daysEvents = [
  // UTC 03:00 = Asia/Shanghai 11:00 → 同日
  makeEvent({ detected_at: new Date('2026-04-10T03:00:00Z') }),
  makeEvent({ detected_at: new Date('2026-04-10T05:00:00Z') }),
  // UTC 23:00 = Asia/Shanghai 次日 07:00 — 跨日
  makeEvent({ detected_at: new Date('2026-04-10T23:00:00Z') }),
  // UTC 18:00 = Asia/Shanghai 次日 02:00 — 跨日
  makeEvent({ detected_at: new Date('2026-04-11T18:00:00Z') }),
];
// 期望: 2026-04-10 (前 2 行) + 2026-04-11 (第 3 行 UTC=04-10 23:00 → 上海 04-11 07:00) +
//       2026-04-12 (第 4 行 UTC=04-11 18:00 → 上海 04-12 02:00) = 3 天
assertEqual('days distinct (Asia/Shanghai)', countDaysWithEvents(daysEvents), 3);
assertEqual('空 → 0', countDaysWithEvents([]), 0);

// ---------------------------------------------------------------------------
// [9] parseRecipientsList
// ---------------------------------------------------------------------------
console.log('\n[9] parseRecipientsList...');
assertEqual('单地址', parseRecipientsList('a@b.com'), ['a@b.com']);
assertEqual('逗号分隔', parseRecipientsList('a@b.com,c@d.com'), ['a@b.com', 'c@d.com']);
assertEqual('分号分隔', parseRecipientsList('a@b.com;c@d.com'), ['a@b.com', 'c@d.com']);
assertEqual('空白分隔', parseRecipientsList('a@b.com   c@d.com'), ['a@b.com', 'c@d.com']);
assertEqual('混合 + trim + 去重', parseRecipientsList(' a@b.com , a@b.com; c@d.com  '), [
  'a@b.com',
  'c@d.com',
]);
assertEqual('空', parseRecipientsList(''), []);
assertEqual('undefined', parseRecipientsList(undefined), []);
assertEqual('null', parseRecipientsList(null), []);

// ---------------------------------------------------------------------------
// [10] buildQuarterlyReportPayload
// ---------------------------------------------------------------------------
console.log('\n[10] buildQuarterlyReportPayload...');
const quarter = computePrevQuarterRange('2026-07-15')!;
const payloadEvents = [
  makeEvent({ id: 1, event_type: 'ST', severity: 'high', symbol: '600519.SH' }),
  makeEvent({
    id: 2,
    event_type: 'NEWS_KEYWORD',
    severity: 'critical',
    scope: 'symbol',
    symbol: '000001.SZ',
    detected_at: new Date('2026-05-01T01:00:00Z'),
  }),
];
const genAt = new Date('2026-07-01T01:05:00Z');
const fullPayload = buildQuarterlyReportPayload(quarter, payloadEvents, genAt);
assertEqual('payload events_total', fullPayload.events_total, 2);
assertEqual('payload generated_at_iso', fullPayload.generated_at_iso, genAt.toISOString());
assert('payload quarter', fullPayload.quarter === quarter);
assert('payload by_event_type 非空', fullPayload.by_event_type.length === 2);
assert('payload by_severity 非空', fullPayload.by_severity.length === 2);
assert('payload by_scope 非空', fullPayload.by_scope.length >= 1);
assert('payload top_symbols 非空', fullPayload.top_symbols.length === 2);
assert(
  'payload severity_highlights 含 critical+high',
  fullPayload.severity_highlights.length === 2
);

// ---------------------------------------------------------------------------
// [11] buildQuarterlyReportEmail
// ---------------------------------------------------------------------------
console.log('\n[11] buildQuarterlyReportEmail...');
const emailContent = buildQuarterlyReportEmail(fullPayload);
assert(
  'subject 含 year+Q',
  emailContent.subject.includes('2026') && emailContent.subject.includes('Q2'),
  emailContent.subject
);
assert('subject 含 事件数', emailContent.subject.includes('2 起事件'));
assert('html 非空', emailContent.html.length > 200);
assert('html 含 600519.SH', emailContent.html.includes('600519.SH'));
assert('html 含 ST', emailContent.html.includes('ST'));
assert('html 含 critical', emailContent.html.includes('critical'));
assert('text 非空', !!emailContent.text && emailContent.text.length > 50);
assert('text 含 events 数', !!emailContent.text && emailContent.text!.includes('共 2 起事件'));

// htmlEscape 防注入
const injectionPayload = buildQuarterlyReportPayload(
  quarter,
  [
    makeEvent({
      id: 99,
      title: '<script>alert(1)</script>',
      symbol: '<img>',
      severity: 'critical',
    }),
  ],
  genAt
);
const injHtml = buildQuarterlyReportEmail(injectionPayload).html;
assert('html escape <script>', !injHtml.includes('<script>alert(1)</script>'));
assert('html 含 escaped &lt;script&gt;', injHtml.includes('&lt;script&gt;'));

// 空 events → "无数据" 兜底
const emptyPayload = buildQuarterlyReportPayload(quarter, [], genAt);
const emptyHtml = buildQuarterlyReportEmail(emptyPayload).html;
assert('空 events html 含 "无数据"', emptyHtml.includes('(无数据)'));
assert(
  '空 events html 含 "本季度无 critical/high 事件"',
  emptyHtml.includes('本季度无 critical/high 事件')
);

// ---------------------------------------------------------------------------
// [12] runBlackSwanQuarterlyReport e2e
// ---------------------------------------------------------------------------
console.log('\n[12] runBlackSwanQuarterlyReport e2e...');

(async () => {
  // (a) 非法 reference_date
  {
    const { runner } = makeFakeRunner();
    const r = await runBlackSwanQuarterlyReport(runner, { reference_date: 'bad' });
    assert('(a) success=false', r.success === false);
    assert('(a) error 含 invalid_reference_date', !!r.error && r.error.includes('invalid_reference_date'));
    assertEqual('(a) quarter=null', r.quarter, null);
  }

  // (b) loadEvents fail
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: false, error: 'db_down' },
    });
    const r = await runBlackSwanQuarterlyReport(runner, { reference_date: '2026-07-15' });
    assert('(b) success=false', r.success === false);
    assert('(b) error 含 events_query_failed', !!r.error && r.error.includes('events_query_failed'));
    assert('(b) error 含 db_down', !!r.error && r.error.includes('db_down'));
    assert('(b) quarter 非 null', r.quarter !== null);
  }

  // (c) dry_run
  {
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, events: [makeEvent(), makeEvent({ id: 2 })] },
    });
    const r = await runBlackSwanQuarterlyReport(runner, {
      reference_date: '2026-07-15',
      dry_run: true,
    });
    assert('(c) success=true', r.success === true);
    assert('(c) dry_run=true', r.dry_run === true);
    assertEqual('(c) events_total', r.events_total, 2);
    assert('(c) payload 非空', r.payload !== null);
    assertEqual('(c) sendCalls 0 (dry)', state.sendCalls.length, 0);
    assertEqual('(c) listCalls 0 (dry)', state.listCalls, 0);
    assertEqual('(c) per_recipient empty', r.per_recipient, []);
  }

  // (d) 空 events
  {
    const { runner } = makeFakeRunner({ loadResult: { ok: true, events: [] } });
    const r = await runBlackSwanQuarterlyReport(runner, {
      reference_date: '2026-07-15',
      recipients_override: ['ops@x.com'],
    });
    assert('(d) success=true', r.success === true);
    assertEqual('(d) events_total', r.events_total, 0);
    assertEqual('(d) recipients_total', r.recipients_total, 1);
    // 即使 events_total=0, 仍发空报告邮件 (操盘手可能想知道 "本季无 black swan")
    assertEqual('(d) sent_count', r.sent_count, 1);
  }

  // (e) recipients_override 透传
  {
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, events: [makeEvent()] },
    });
    const r = await runBlackSwanQuarterlyReport(runner, {
      reference_date: '2026-07-15',
      recipients_override: ['a@x.com', 'b@x.com'],
    });
    assert('(e) success=true', r.success === true);
    assertEqual('(e) recipients_total', r.recipients_total, 2);
    assertEqual('(e) sent_count', r.sent_count, 2);
    assertEqual('(e) listCalls 0 (override)', state.listCalls, 0);
    assertEqual('(e) sendCalls 顺序', state.sendCalls.map(c => c.address), ['a@x.com', 'b@x.com']);
  }

  // (f) listRecipients 返空
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, events: [makeEvent()] },
      listResult: [],
    });
    const r = await runBlackSwanQuarterlyReport(runner, { reference_date: '2026-07-15' });
    assert('(f) success=true', r.success === true);
    assertEqual('(f) sent_count', r.sent_count, 0);
    assertEqual('(f) error', r.error, 'no_recipients_configured');
  }

  // (g) sendEmail success
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, events: [makeEvent()] },
      sendResults: [{ success: true, data: { messageId: 'abc' } }],
    });
    const r = await runBlackSwanQuarterlyReport(runner, {
      reference_date: '2026-07-15',
      recipients_override: ['ok@x.com'],
    });
    assertEqual('(g) sent_count', r.sent_count, 1);
    assertEqual('(g) per_recipient[0].status', r.per_recipient[0].status, 'sent');
  }

  // (h) sendEmail skipped
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, events: [makeEvent()] },
      sendResults: [{ success: false, skipped: true, message: 'smtp_not_configured' }],
    });
    const r = await runBlackSwanQuarterlyReport(runner, {
      reference_date: '2026-07-15',
      recipients_override: ['x@x.com'],
    });
    assertEqual('(h) skipped_count', r.skipped_count, 1);
    assertEqual('(h) per_recipient[0].status', r.per_recipient[0].status, 'skipped');
    assertEqual(
      '(h) per_recipient[0].skip_reason',
      r.per_recipient[0].skip_reason,
      'smtp_not_configured'
    );
  }

  // (i) sendEmail failed (success=false, no skipped)
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, events: [makeEvent()] },
      sendResults: [{ success: false, message: 'smtp_550' }],
    });
    const r = await runBlackSwanQuarterlyReport(runner, {
      reference_date: '2026-07-15',
      recipients_override: ['x@x.com'],
    });
    assertEqual('(i) failed_count', r.failed_count, 1);
    assertEqual('(i) per_recipient[0].status', r.per_recipient[0].status, 'failed');
    assertEqual('(i) per_recipient[0].message', r.per_recipient[0].message, 'smtp_550');
  }

  // (j) sendEmail throw
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, events: [makeEvent()] },
      sendResults: [new Error('network_down'), { success: true }],
    });
    const r = await runBlackSwanQuarterlyReport(runner, {
      reference_date: '2026-07-15',
      recipients_override: ['x@x.com', 'y@x.com'],
    });
    assert('(j) success=true (整体不抛)', r.success === true);
    assertEqual('(j) failed_count', r.failed_count, 1);
    assertEqual('(j) sent_count (其它继续)', r.sent_count, 1);
    assert(
      '(j) per_recipient[0].message 含 network_down',
      !!r.per_recipient[0].message && r.per_recipient[0].message.includes('network_down')
    );
  }

  // (k) listRecipients throw → fallback 空
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, events: [makeEvent()] },
      listResult: new Error('env_read_fail'),
    });
    const r = await runBlackSwanQuarterlyReport(runner, { reference_date: '2026-07-15' });
    assert('(k) success=true', r.success === true);
    assertEqual('(k) error', r.error, 'no_recipients_configured');
    assertEqual('(k) recipients_total', r.recipients_total, 0);
  }

  // ---------------------------------------------------------------------------
  // [13] PRODUCTION runner smoke
  // ---------------------------------------------------------------------------
  console.log('\n[13] PRODUCTION runner smoke...');
  const prod = createProductionQuarterlyRunner();
  assert('prod 是对象', !!prod && typeof prod === 'object');
  assert('prod.loadEvents 是 fn', typeof prod.loadEvents === 'function');
  assert('prod.listRecipients 是 fn', typeof prod.listRecipients === 'function');
  assert('prod.sendEmail 是 fn', typeof prod.sendEmail === 'function');
  const prod2 = getProductionQuarterlyRunner();
  assert('singleton 同实例', prod2 === getProductionQuarterlyRunner());

  // listRecipients 读 env (DB-less 安全)
  const savedEnv = process.env.QUARTERLY_BLACK_SWAN_RECIPIENTS;
  process.env.QUARTERLY_BLACK_SWAN_RECIPIENTS = 'a@x.com,b@x.com';
  const recips = await prod.listRecipients();
  assertEqual('prod listRecipients env', recips, ['a@x.com', 'b@x.com']);
  process.env.QUARTERLY_BLACK_SWAN_RECIPIENTS = '';
  const recipsEmpty = await prod.listRecipients();
  assertEqual('prod listRecipients 空 env', recipsEmpty, []);
  if (savedEnv === undefined) {
    delete process.env.QUARTERLY_BLACK_SWAN_RECIPIENTS;
  } else {
    process.env.QUARTERLY_BLACK_SWAN_RECIPIENTS = savedEnv;
  }

  // ---------------------------------------------------------------------------
  // [14] META-GUARD: cron registry + SchedulerService dispatch + jsdoc 关键标记
  // ---------------------------------------------------------------------------
  console.log('\n[14] META-GUARD...');
  const registrySrc = readFileSync(
    join(__dirname, '../../src/constants/cronRegistry.ts'),
    'utf8'
  );
  assert(
    'cronRegistry 含 BLACK_SWAN_QUARTERLY_SUMMARY type',
    registrySrc.includes("type: 'BLACK_SWAN_QUARTERLY_SUMMARY'")
  );
  assert(
    'cronRegistry recommendedCron 与 service 常量一致',
    registrySrc.includes(BLACK_SWAN_QUARTERLY_RECOMMENDED_CRON)
  );

  const schedulerSrc = readFileSync(
    join(__dirname, '../../src/services/SchedulerService.ts'),
    'utf8'
  );
  assert(
    'SchedulerService 含 dispatch 分支',
    schedulerSrc.includes("task.type === 'BLACK_SWAN_QUARTERLY_SUMMARY'")
  );
  assert(
    'SchedulerService lazy-require BlackSwanQuarterlyReportService',
    schedulerSrc.includes("require('./BlackSwanQuarterlyReportService')")
  );
  assert(
    'SchedulerService 调 runBlackSwanQuarterlyReport',
    schedulerSrc.includes('runBlackSwanQuarterlyReport(')
  );
  assert(
    'SchedulerService 调 getProductionQuarterlyRunner',
    schedulerSrc.includes('getProductionQuarterlyRunner()')
  );

  const serviceSrc = readFileSync(
    join(__dirname, '../../src/services/BlackSwanQuarterlyReportService.ts'),
    'utf8'
  );
  assert('service jsdoc 含 PR-019', serviceSrc.includes('PR-019'));
  assert('service jsdoc 含 US-134', serviceSrc.includes('US-134'));
  assert('service jsdoc 含 "邮件"', serviceSrc.includes('邮件'));
  assert('service jsdoc 含 fail-OPEN', serviceSrc.includes('fail-OPEN'));
  assert(
    'service 引用 EmailNotificationService',
    serviceSrc.includes("from './EmailNotificationService'")
  );
  assert(
    'service 常量 TOP_SYMBOLS_CAP 与导出一致',
    QUARTERLY_TOP_SYMBOLS_CAP === 15 && QUARTERLY_SEVERITY_HIGHLIGHT_CAP === 20
  );

  // ===========================================================================
  console.log('\n--------------------------------------------------------------');
  console.log(`Total: ${passed} ok, ${failed} failed`);
  console.log('--------------------------------------------------------------');
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
})().catch(err => {
  console.error('UNCAUGHT TEST FAILURE:', err);
  process.exit(1);
});
