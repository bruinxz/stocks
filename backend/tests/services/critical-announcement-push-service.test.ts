/**
 * CriticalAnnouncementPushService 单元测试 (US-031 / ANN-007 + PR-E 2026-06-29)
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/critical-announcement-push-service.test.ts
 *
 * 完全脱离 HTTP + DB: 注入 fake FeishuWebhookPoster + fake CriticalAnnouncementPushDataSource.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CriticalAnnouncementPushService,
  CRITICAL_ANNOUNCEMENT_PRIORITY,
  CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH,
  CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN,
  CRITICAL_ANNOUNCEMENT_USER_ALERT_MAX_MSG_LEN,
  CRITICAL_ANNOUNCEMENT_RULE_ID,
  EMERGENCY_CONF_GATE,
  EMERGENCY_CONF_GATE_THRESHOLD,
  EMERGENCY_CONF_GATE_SKIP_REASON,
  isEmergencyConfGated,
  shouldPushRecord,
  buildCriticalAnnouncementText,
  buildUserAlertMessage,
  buildUserAlertDedupKey,
  resolveWebhookUrl,
  FeishuWebhookPoster,
  CriticalAnnouncementPushDataSource,
  criticalAnnouncementPushService,
} from '../../src/services/CriticalAnnouncementPushService';
import { AnnouncementNLPRecord } from '../../src/services/AnnouncementNLPService';

let failed = 0;
let passed = 0;

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

function makeRecord(partial: Partial<AnnouncementNLPRecord> = {}): AnnouncementNLPRecord {
  return {
    announce_date: '2026-06-19',
    stock_code: '600519',
    stock_name: '贵州茅台',
    original_title: '关于收到证监会立案调查通知书的公告',
    announcement_type: '重大事项',
    url: 'https://example.com/p.pdf',
    summary: '公司收到立案调查通知, 涉及信息披露违规事项',
    sentiment: '负面',
    key_amounts_json: [],
    key_topics_json: ['监管'],
    event_type: '处罚',
    priority: 'critical',
    entities: [],
    status: 'completed',
    nlp_engine: 'heuristic',
    error: null,
    raw_payload: {},
    persisted: true,
    ...partial,
  };
}

interface PosterCall {
  url: string;
  body: { msg_type: 'text'; content: { text: string } };
}

function makeFakePoster(behavior: {
  ok?: boolean;
  message?: string;
  throwErr?: string;
  perCall?: Array<{ ok: boolean; message?: string; throwErr?: string }>;
}): { poster: FeishuWebhookPoster; calls: PosterCall[] } {
  const calls: PosterCall[] = [];
  let i = 0;
  const poster: FeishuWebhookPoster = async (url, body) => {
    calls.push({ url, body });
    const overrides = behavior.perCall && behavior.perCall[i];
    i += 1;
    if (overrides) {
      if (overrides.throwErr) throw new Error(overrides.throwErr);
      return { success: overrides.ok, message: overrides.message };
    }
    if (behavior.throwErr) throw new Error(behavior.throwErr);
    return { success: behavior.ok !== false, message: behavior.message };
  };
  return { poster, calls };
}

interface CreatedAlert {
  user_id: number;
  symbol: string;
  name: string;
  level: 'HIGH';
  rule_id: string;
  message: string;
}

function makeFakeDataSource(opts: {
  holdings?: Record<string, number[]>;
  findThrows?: Record<string, string>;
  createThrowsForUserIds?: number[];
}): {
  dataSource: CriticalAnnouncementPushDataSource;
  created: CreatedAlert[];
  findCalls: string[];
} {
  const created: CreatedAlert[] = [];
  const findCalls: string[] = [];
  const dataSource: CriticalAnnouncementPushDataSource = {
    async findUsersHoldingStock(symbol: string): Promise<number[]> {
      findCalls.push(symbol);
      const throwsMsg = opts.findThrows?.[symbol];
      if (throwsMsg) throw new Error(throwsMsg);
      return opts.holdings?.[symbol] ? [...opts.holdings[symbol]] : [];
    },
    async createRiskAlert(input): Promise<void> {
      if (opts.createThrowsForUserIds?.includes(input.user_id)) {
        throw new Error(`db error for user ${input.user_id}`);
      }
      created.push({ ...input });
    },
  };
  return { dataSource, created, findCalls };
}

function noopDS(): CriticalAnnouncementPushDataSource {
  return makeFakeDataSource({}).dataSource;
}

// ---------------------------------------------------------------------------
// Constants tests
// ---------------------------------------------------------------------------

function testConstants(): void {
  assertEqual(
    'CRITICAL_ANNOUNCEMENT_PRIORITY = critical',
    CRITICAL_ANNOUNCEMENT_PRIORITY,
    'critical'
  );
  assert(
    'CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH is positive int',
    typeof CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH === 'number' &&
      CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH > 0 &&
      Number.isInteger(CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH)
  );
  assert('CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN > 200', CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN > 200);
  assertEqual(
    'CRITICAL_ANNOUNCEMENT_RULE_ID',
    CRITICAL_ANNOUNCEMENT_RULE_ID,
    'announcement_critical'
  );
  assert(
    'CRITICAL_ANNOUNCEMENT_USER_ALERT_MAX_MSG_LEN > 200',
    CRITICAL_ANNOUNCEMENT_USER_ALERT_MAX_MSG_LEN > 200
  );
}

function testShouldPushRecord(): void {
  assert('critical + persisted → true', shouldPushRecord(makeRecord()) === true);
  assert('high + persisted → false', shouldPushRecord(makeRecord({ priority: 'high' })) === false);
  assert(
    'medium + persisted → false',
    shouldPushRecord(makeRecord({ priority: 'medium' })) === false
  );
  assert('low + persisted → false', shouldPushRecord(makeRecord({ priority: 'low' })) === false);
  assert(
    'critical + persisted=false → false',
    shouldPushRecord(makeRecord({ persisted: false })) === false
  );
  assert('null record → false', shouldPushRecord(null as any) === false);
  assert('undefined record → false', shouldPushRecord(undefined as any) === false);
}

function testBuildTextCompleteFields(): void {
  const text = buildCriticalAnnouncementText(makeRecord());
  assert('text contains CRITICAL header', text.includes('🚨 [CRITICAL 公告]'));
  assert('text contains stock_code', text.includes('600519'));
  assert('text contains stock_name', text.includes('贵州茅台'));
  assert('text contains original_title', text.includes('收到证监会立案调查'));
  assert('text contains summary', text.includes('摘要:'));
  assert('text contains event_type', text.includes('事件类型: 处罚'));
  assert('text contains sentiment', text.includes('情绪: 负面'));
  assert('text contains announce_date', text.includes('2026-06-19'));
  assert('text contains rule_id tail', text.includes('触发规则: announcement_critical_priority'));
}

function testBuildTextMissingFields(): void {
  const text = buildCriticalAnnouncementText(
    makeRecord({
      stock_name: null,
      summary: null,
      event_type: null,
      sentiment: null,
      announce_date: '',
    })
  );
  assert('text still has header w/o stock_name', text.includes('🚨 [CRITICAL 公告] 600519'));
  assert('text has no 摘要 line', !text.includes('摘要:'));
  assert('text has no 事件类型', !text.includes('事件类型:'));
  assert('text has no 情绪', !text.includes('情绪:'));
  assert('text has no 公告日期', !text.includes('公告日期:'));
  assert('text still has rule tail', text.includes('触发规则: announcement_critical_priority'));
}

function testBuildTextStockCodeFallback(): void {
  const text = buildCriticalAnnouncementText(makeRecord({ stock_code: '' as any }));
  assert('empty stock_code falls back to —', text.includes('🚨 [CRITICAL 公告] —'));
}

function testBuildTextSummaryEqualsTitleSkipped(): void {
  const title = '关于收到证监会立案调查通知书的公告';
  const text = buildCriticalAnnouncementText(makeRecord({ summary: title }));
  const occurrences = text.split(title).length - 1;
  assertEqual('title appears exactly once when summary==title', occurrences, 1);
  assert('no 摘要: prefix when summary==title', !text.includes('摘要:'));
}

function testBuildTextTruncation(): void {
  const longTitle = '处罚公告 '.repeat(500);
  const text = buildCriticalAnnouncementText(makeRecord({ original_title: longTitle }));
  assert('text <= MAX_TEXT_LEN', text.length <= CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN);
  assert('truncated text contains ellipsis', text.includes('...'));
  assert(
    'truncated text still has rule tail',
    text.endsWith('触发规则: announcement_critical_priority')
  );
}

// PR-E new pure helpers
function testBuildUserAlertMessage(): void {
  const msg = buildUserAlertMessage(makeRecord());
  assert('user msg contains title', msg.includes('立案调查'));
  assert('user msg contains summary', msg.includes('立案调查通知'));
  assert('user msg contains event_type', msg.includes('事件类型: 处罚'));
  assert('user msg no rule tail', !msg.includes('触发规则:'));

  const msg2 = buildUserAlertMessage(makeRecord({ summary: null, event_type: null }));
  assert('user msg has title even w/o summary', msg2.includes('立案调查'));
  assert('user msg no 事件类型 line when event_type null', !msg2.includes('事件类型:'));

  const msg3 = buildUserAlertMessage(makeRecord({ summary: '关于收到证监会立案调查通知书的公告' }));
  const occurrences = msg3.split('关于收到证监会立案调查通知书的公告').length - 1;
  assertEqual('title appears once when summary==title in user msg', occurrences, 1);

  const msg4 = buildUserAlertMessage(makeRecord({ original_title: '' }));
  assert('empty title falls back to (无标题)', msg4.includes('(无标题)'));

  const longSummary = '业绩亏损 '.repeat(500);
  const msg5 = buildUserAlertMessage(makeRecord({ summary: longSummary }));
  assert('long msg <= cap', msg5.length <= CRITICAL_ANNOUNCEMENT_USER_ALERT_MAX_MSG_LEN);
  assert('long msg has ellipsis', msg5.endsWith('...'));
}

function testBuildUserAlertDedupKey(): void {
  const key = buildUserAlertDedupKey(makeRecord());
  assert('dedup key prefix + code + date', /^announcement_critical:600519:2026-06-19:/.test(key));
  assertEqual(
    'dedup key stable',
    buildUserAlertDedupKey(makeRecord()),
    buildUserAlertDedupKey(makeRecord())
  );
  assert(
    'different stock_code → different key',
    buildUserAlertDedupKey(makeRecord()) !==
      buildUserAlertDedupKey(makeRecord({ stock_code: '000001' }))
  );
}

function testResolveWebhookUrl(): void {
  assertEqual(
    'options.webhook_url 优先',
    resolveWebhookUrl(
      { webhook_url: 'https://opt.example/' },
      {
        OPS_ALERT_FEISHU_WEBHOOK: 'https://env.example/',
      }
    ),
    'https://opt.example/'
  );
  assertEqual(
    'env fallback',
    resolveWebhookUrl({}, { OPS_ALERT_FEISHU_WEBHOOK: 'https://env.example/' }),
    'https://env.example/'
  );
  assertEqual('env 空字符串 → null', resolveWebhookUrl({}, { OPS_ALERT_FEISHU_WEBHOOK: '' }), null);
  assertEqual('env undefined → null', resolveWebhookUrl({}, {}), null);
  assertEqual('options 空字符串 → null', resolveWebhookUrl({ webhook_url: '   ' }, {}), null);
  assertEqual(
    'options 空字符串 + env 有 → env',
    resolveWebhookUrl({ webhook_url: '   ' }, { OPS_ALERT_FEISHU_WEBHOOK: 'https://env/' }),
    'https://env/'
  );
}

// ---------------------------------------------------------------------------
// service.pushBatch tests
// ---------------------------------------------------------------------------

async function testPushBatchEmpty(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch(
    [],
    { data_source: noopDS() },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' }
  );
  assertEqual('empty: skipped_reason', res.skipped_reason, 'no_records');
  assertEqual('empty: scanned', res.scanned, 0);
  assertEqual('empty: matched', res.matched, 0);
  assertEqual('empty: attempted', res.attempted, 0);
  assertEqual('empty: user_alerts 0', res.user_alerts, 0);
  assertEqual('empty: poster 0 calls', calls.length, 0);
}

async function testPushBatchAllLow(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch(
    [makeRecord({ priority: 'low' }), makeRecord({ priority: 'medium' })],
    { data_source: noopDS() },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' }
  );
  assertEqual('low/medium: skipped_reason', res.skipped_reason, 'no_critical');
  assertEqual('low/medium: user_alerts 0', res.user_alerts, 0);
  assertEqual('low/medium: poster 0 calls', calls.length, 0);
}

async function testPushBatchNoWebhook(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch([makeRecord()], { data_source: noopDS() }, {});
  assertEqual('no webhook: skipped_reason', res.skipped_reason, 'no_webhook');
  assertEqual('no webhook: matched 1', res.matched, 1);
  assertEqual('no webhook: attempted 0', res.attempted, 0);
  assertEqual('no webhook: user_alerts 0 (no holdings)', res.user_alerts, 0);
  assertEqual('no webhook: poster 0 calls', calls.length, 0);
}

async function testPushBatchDryRun(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created } = makeFakeDataSource({
    holdings: { '600519': [1, 2], '000001': [3] },
  });
  const res = await svc.pushBatch(
    [makeRecord(), makeRecord({ stock_code: '000001' })],
    { dry_run: true, data_source: dataSource },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' }
  );
  assertEqual('dry_run: matched 2', res.matched, 2);
  assertEqual('dry_run: attempted 2', res.attempted, 2);
  assertEqual('dry_run: user_alerts 0 (NO DB WRITE)', res.user_alerts, 0);
  assertEqual('dry_run: createRiskAlert 0 calls', created.length, 0);
  assertEqual('dry_run: poster 0 calls (NO HTTP)', calls.length, 0);
  assertEqual('dry_run: items[0].skip_reason', res.items[0].skip_reason, 'dry_run');
}

async function testPushBatchSingleCriticalAC(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch(
    [makeRecord()],
    { data_source: noopDS() },
    {
      OPS_ALERT_FEISHU_WEBHOOK: 'https://hook.example/abc',
    }
  );
  assertEqual('AC: matched 1', res.matched, 1);
  assertEqual('AC: succeeded 1', res.succeeded, 1);
  assertEqual('AC: poster called exactly once', calls.length, 1);
  assertEqual('AC: poster url', calls[0].url, 'https://hook.example/abc');
  assertEqual('AC: poster msg_type', calls[0].body.msg_type, 'text');
  assert('AC: body contains stock_code', calls[0].body.content.text.includes('600519'));
  assert('AC: body contains title fragment', calls[0].body.content.text.includes('立案调查'));
}

async function testPushBatchMultipleCriticalMixed(): Promise<void> {
  const { poster, calls } = makeFakePoster({
    perCall: [
      { ok: true },
      { ok: false, message: 'feishu 4xx' },
      { ok: true, throwErr: 'network DOWN' },
    ],
  });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch(
    [
      makeRecord({ stock_code: 'A' }),
      makeRecord({ stock_code: 'B' }),
      makeRecord({ stock_code: 'C' }),
    ],
    { data_source: noopDS() },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('mixed: succeeded 1', res.succeeded, 1);
  assertEqual('mixed: failed 2', res.failed, 2);
  assertEqual('mixed: poster called 3 times', calls.length, 3);
  assertEqual('mixed: items[1].error', res.items[1].error, 'feishu 4xx');
  assert(
    'mixed: items[2].error includes throw',
    String(res.items[2].error || '').includes('network DOWN')
  );
}

async function testPushBatchTruncatedByCap(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const records: AnnouncementNLPRecord[] = [];
  for (let i = 0; i < 25; i++) {
    records.push(makeRecord({ stock_code: String(100000 + i) }));
  }
  const res = await svc.pushBatch(
    records,
    { data_source: noopDS() },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('truncated: attempted=cap', res.attempted, CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH);
  assertEqual(
    'truncated: poster cap calls',
    calls.length,
    CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH
  );
  const truncated = res.items.filter(i => i.skip_reason === 'truncated_batch');
  assertEqual(
    'truncated: tail count',
    truncated.length,
    25 - CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH
  );
}

async function testPushBatchTopLevelCatch(): Promise<void> {
  const { poster } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const badRecord: any = {};
  Object.defineProperty(badRecord, 'priority', {
    get() {
      throw new Error('boom getter');
    },
  });
  const res = await svc.pushBatch(
    [badRecord],
    { data_source: noopDS() },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' }
  );
  assertEqual('top-level: skipped_reason', res.skipped_reason, 'top_level_error');
  assert('top-level: error contains boom', String(res.error || '').includes('boom'));
  assertEqual('top-level: user_alerts 0', res.user_alerts, 0);
}

async function testMetaAlertOnFailures(): Promise<void> {
  const { poster } = makeFakePoster({
    perCall: [
      { ok: true },
      { ok: false, message: 'feishu 4xx' },
      { ok: false, message: 'feishu rate limit' },
    ],
  });
  const svc = new CriticalAnnouncementPushService(poster);
  const metaCalls: any[] = [];
  const res = await svc.pushBatch(
    [
      makeRecord({ stock_code: '001' }),
      makeRecord({ stock_code: '002' }),
      makeRecord({ stock_code: '003' }),
    ],
    { meta_alert_push: input => metaCalls.push(input), data_source: noopDS() },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('meta-alert: failed=2', res.failed, 2);
  assertEqual('meta-alert: succeeded=1', res.succeeded, 1);
  assertEqual('meta-alert: 推 1 次', metaCalls.length, 1);
  assertEqual('meta-alert: dedup_key', metaCalls[0]?.dedup_key, 'critical_announcement_push_fail');
  assertEqual('meta-alert: level=WARN', metaCalls[0]?.level, 'WARN');
  assert('meta-alert: title 含 2/3', String(metaCalls[0]?.title || '').includes('2/3'));
}

async function testMetaAlertNotCalledWhenAllSucceed(): Promise<void> {
  const { poster } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const metaCalls: any[] = [];
  const res = await svc.pushBatch(
    [makeRecord({ stock_code: '001' }), makeRecord({ stock_code: '002' })],
    { meta_alert_push: input => metaCalls.push(input), data_source: noopDS() },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('all-succeed: failed=0', res.failed, 0);
  assertEqual('all-succeed: 元告警 0 次', metaCalls.length, 0);
}

async function testProductionSingleton(): Promise<void> {
  assert(
    'criticalAnnouncementPushService 是 service 实例',
    criticalAnnouncementPushService instanceof CriticalAnnouncementPushService
  );
}

// ---------------------------------------------------------------------------
// PR-E (2026-06-29): user inbox RiskAlert tests
// ---------------------------------------------------------------------------

async function testUserAlertsHoldingRelated(): Promise<void> {
  const { poster } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created, findCalls } = makeFakeDataSource({
    holdings: { '600519': [101, 202] },
  });
  const res = await svc.pushBatch(
    [makeRecord()],
    { data_source: dataSource },
    {
      OPS_ALERT_FEISHU_WEBHOOK: 'https://hook',
    }
  );
  assertEqual('user_alerts: matched 1', res.matched, 1);
  assertEqual('user_alerts: 写 2 条 (2 持仓用户)', res.user_alerts, 2);
  assertEqual('user_alerts: findCalls.length', findCalls.length, 1);
  assertEqual('user_alerts: findCalls[0]', findCalls[0], '600519');
  assertEqual('user_alerts: created.length 2', created.length, 2);
  assertEqual('user_alerts: created[0].user_id', created[0].user_id, 101);
  assertEqual('user_alerts: created[0].symbol', created[0].symbol, '600519');
  assertEqual('user_alerts: created[0].name', created[0].name, '贵州茅台');
  assertEqual('user_alerts: created[0].level', created[0].level, 'HIGH');
  assertEqual('user_alerts: created[0].rule_id', created[0].rule_id, 'announcement_critical');
  assert('user_alerts: message 含 title', created[0].message.includes('立案调查'));
  assertEqual('user_alerts: created[1].user_id', created[1].user_id, 202);
}

async function testUserAlertsNoHolders(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created, findCalls } = makeFakeDataSource({ holdings: {} });
  const res = await svc.pushBatch(
    [makeRecord()],
    { data_source: dataSource },
    {
      OPS_ALERT_FEISHU_WEBHOOK: 'https://hook',
    }
  );
  assertEqual('no-holders: user_alerts 0', res.user_alerts, 0);
  assertEqual('no-holders: created.length 0', created.length, 0);
  assertEqual('no-holders: findCalls 1', findCalls.length, 1);
  assertEqual('no-holders: OPS push succeeded', res.succeeded, 1);
  assertEqual('no-holders: poster 1 call', calls.length, 1);
}

async function testUserAlertsNonCritical(): Promise<void> {
  const { poster } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created, findCalls } = makeFakeDataSource({
    holdings: { '600519': [101] },
  });
  const res = await svc.pushBatch(
    [
      makeRecord({ priority: 'low' }),
      makeRecord({ priority: 'medium' }),
      makeRecord({ priority: 'high' }),
    ],
    { data_source: dataSource },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('non-critical: user_alerts 0', res.user_alerts, 0);
  assertEqual('non-critical: findCalls 0', findCalls.length, 0);
  assertEqual('non-critical: created 0', created.length, 0);
}

async function testUserAlertsMultiCritical(): Promise<void> {
  const { poster } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created } = makeFakeDataSource({
    holdings: { '600519': [101], '000001': [202, 303, 404] },
  });
  const res = await svc.pushBatch(
    [makeRecord({ stock_code: '600519' }), makeRecord({ stock_code: '000001' })],
    { data_source: dataSource },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('multi: user_alerts 1+3=4', res.user_alerts, 4);
  assertEqual('multi: created 4', created.length, 4);
  assertEqual('multi: 600519 alerts', created.filter(a => a.symbol === '600519').length, 1);
  assertEqual('multi: 000001 alerts', created.filter(a => a.symbol === '000001').length, 3);
}

async function testUserAlertsCreateThrowFailOpen(): Promise<void> {
  const { poster } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created } = makeFakeDataSource({
    holdings: { '600519': [101, 202, 303] },
    createThrowsForUserIds: [202],
  });
  const res = await svc.pushBatch(
    [makeRecord()],
    { data_source: dataSource },
    {
      OPS_ALERT_FEISHU_WEBHOOK: 'https://hook',
    }
  );
  assertEqual('create-throw: user_alerts 2 (1 fail-OPEN)', res.user_alerts, 2);
  assertEqual('create-throw: created 2', created.length, 2);
  assertEqual('create-throw: OPS succeeded 1', res.succeeded, 1);
}

async function testUserAlertsFindThrowFailOpen(): Promise<void> {
  const { poster } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created } = makeFakeDataSource({
    holdings: { '000001': [202] },
    findThrows: { '600519': 'db disconnected' },
  });
  const res = await svc.pushBatch(
    [makeRecord({ stock_code: '600519' }), makeRecord({ stock_code: '000001' })],
    { data_source: dataSource },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('find-throw: user_alerts 1 (1 fail-OPEN)', res.user_alerts, 1);
  assertEqual('find-throw: created[0].user_id', created[0]?.user_id, 202);
  assertEqual('find-throw: OPS attempted 2', res.attempted, 2);
}

async function testUserAlertsNoWebhookStillWrites(): Promise<void> {
  // PR-E 核心: OPS 群无 webhook 不阻塞 user inbox 通道
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created } = makeFakeDataSource({
    holdings: { '600519': [101, 202] },
  });
  const res = await svc.pushBatch([makeRecord()], { data_source: dataSource }, {});
  assertEqual('no-webhook: skipped_reason', res.skipped_reason, 'no_webhook');
  assertEqual('no-webhook: poster 0 calls', calls.length, 0);
  assertEqual('no-webhook: user_alerts 2 (still written)', res.user_alerts, 2);
  assertEqual('no-webhook: created 2', created.length, 2);
}

async function testUserAlertsDryRunNoWrite(): Promise<void> {
  const { poster } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created, findCalls } = makeFakeDataSource({
    holdings: { '600519': [101, 202, 303] },
  });
  const res = await svc.pushBatch(
    [makeRecord()],
    { dry_run: true, data_source: dataSource },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('dry-run: user_alerts 0', res.user_alerts, 0);
  assertEqual('dry-run: created 0', created.length, 0);
  assertEqual('dry-run: findCalls 0 (skip 整段)', findCalls.length, 0);
}

// ---------------------------------------------------------------------------
// PR-L (2026-06-29) — emergency conf gate tests.
// 见 CriticalAnnouncementPushService.ts 顶部 EMERGENCY_CONF_GATE 注释:
// PR-K 30 天回测证实 conf>=70 反向 (win 30% < low<50 win 40%).
// gate 在 push 循环里直接 skip OPS 群推送, **inbox (writeUserInboxAlerts) 仍写**.
// ---------------------------------------------------------------------------
async function testEmergencyConfGateConstants(): Promise<void> {
  // PR-W (2026-06-30): EMERGENCY_CONF_GATE 默认改 false 让飞书推送恢复. 用户实测
  // 明确反馈 "飞书没收到通知" → PR-L 反向防御 over-fix. 反向 conf 修复改走
  // PR-M3 SourceTypeWinRateAdjuster (批5 已下线; 反向 conf 修复能力停用, gate 常量本身不受影响).
  assertEqual('PR-W: EMERGENCY_CONF_GATE 默认 false (PR-L 解除)', EMERGENCY_CONF_GATE, false);
  assertEqual('PR-L: threshold=70 (保留供未来手动开启)', EMERGENCY_CONF_GATE_THRESHOLD, 70);
  assertEqual(
    'PR-L: skip_reason 字符串常量',
    EMERGENCY_CONF_GATE_SKIP_REASON,
    'emergency_stop_loss_conf_gate'
  );
}

async function testEmergencyConfGateHelper(): Promise<void> {
  // PR-W: gate=false 全部不拦截 (历史 PR-L 反向行为已通过 PR-M3 数据驱动取代).
  // 这些 case 保留作 helper 函数自身行为的回归测试 — 验证 gate=false 短路逻辑.
  const r1 = isEmergencyConfGated({ ...makeRecord(), confidence_score: 80 } as any);
  assertEqual('PR-W: gate=false top conf=80 不拦截', r1, false);

  const r2 = isEmergencyConfGated({ ...makeRecord(), confidence_score: 70 } as any);
  assertEqual('PR-W: gate=false top conf=70 不拦截', r2, false);

  const r3 = isEmergencyConfGated({ ...makeRecord(), confidence_score: 69 } as any);
  assertEqual('PR-W: gate=false top conf=69 不拦截', r3, false);

  const r4 = isEmergencyConfGated(makeRecord());
  assertEqual('PR-W: gate=false 全部缺失 conf 不拦截', r4, false);

  const r5 = isEmergencyConfGated({ ...makeRecord(), metadata: { fusion_score: 88 } } as any);
  assertEqual('PR-W: gate=false metadata.fusion_score=88 不拦截', r5, false);

  const r6 = isEmergencyConfGated({
    ...makeRecord(),
    metadata: { confidence_score: 75 },
  } as any);
  assertEqual('PR-W: gate=false metadata.confidence_score=75 不拦截', r6, false);

  const r7 = isEmergencyConfGated({ ...makeRecord(), confidence_score: NaN } as any);
  assertEqual('PR-W: gate=false NaN 不拦截', r7, false);
}

async function testEmergencyConfGateBlocksOpsPush(): Promise<void> {
  // PR-W: gate=false → conf=80 应正常推送 (历史 PR-L 行为已解除).
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource } = makeFakeDataSource({ holdings: {} });
  const recHigh = { ...makeRecord({ stock_code: '600519' }), confidence_score: 80 } as any;
  const res = await svc.pushBatch(
    [recHigh],
    { data_source: dataSource },
    {
      OPS_ALERT_FEISHU_WEBHOOK: 'https://hook',
    }
  );
  assertEqual('PR-W: matched 1', res.matched, 1);
  assertEqual('PR-W: attempted 1', res.attempted, 1);
  assertEqual('PR-W: gate=false succeeded=1 (推送通过)', res.succeeded, 1);
  assertEqual('PR-W: failed 0', res.failed, 0);
  assertEqual('PR-W: poster 调 1 次 (gate=false)', calls.length, 1);

  // 反例: conf=60 也正常推送 (本来就 <70, 任何 gate 都不拦截)
  const { poster: poster2, calls: calls2 } = makeFakePoster({ ok: true });
  const svc2 = new CriticalAnnouncementPushService(poster2);
  const recLow = { ...makeRecord({ stock_code: '600520' }), confidence_score: 60 } as any;
  const res2 = await svc2.pushBatch(
    [recLow],
    { data_source: dataSource },
    {
      OPS_ALERT_FEISHU_WEBHOOK: 'https://hook',
    }
  );
  assertEqual('PR-L: conf=60 不拦截 succeeded=1', res2.succeeded, 1);
  assertEqual('PR-L: conf=60 poster 调 1 次', calls2.length, 1);
}

async function testEmergencyConfGateInboxStillWritten(): Promise<void> {
  // PR-W: gate=false → OPS push 也通过, inbox RiskAlert 仍写. 两条通道独立验证.
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const { dataSource, created } = makeFakeDataSource({
    holdings: { '600519': [101, 202] },
  });
  const recHigh = { ...makeRecord({ stock_code: '600519' }), confidence_score: 90 } as any;
  const res = await svc.pushBatch(
    [recHigh],
    { data_source: dataSource },
    {
      OPS_ALERT_FEISHU_WEBHOOK: 'https://hook',
    }
  );
  assertEqual('PR-W inbox: poster 调 1 次 (gate=false 不拦截)', calls.length, 1);
  assertEqual('PR-L inbox: user_alerts=2 (101+202)', res.user_alerts, 2);
  assertEqual('PR-L inbox: RiskAlert created=2', created.length, 2);
  assertEqual('PR-L inbox: user_id list', created.map(c => c.user_id).sort(), [101, 202]);
  assertEqual('PR-L inbox: rule_id', created[0].rule_id, CRITICAL_ANNOUNCEMENT_RULE_ID);
}

// ---------------------------------------------------------------------------
// Meta-guard: AnnouncementNLPService.syncDate 真接入了本 service.
// ---------------------------------------------------------------------------

function testSyncDateWiringMetaGuard(): void {
  const path = join(__dirname, '..', '..', 'src', 'services', 'AnnouncementNLPService.ts');
  const src = readFileSync(path, 'utf-8');
  assert(
    'AnnouncementNLPService imports CriticalAnnouncementPushService (lazy require)',
    /require\(['"]\.\/CriticalAnnouncementPushService['"]\)/.test(src)
  );
  assert(
    'syncDate calls criticalAnnouncementPushService.pushBatch(records, ...)',
    /criticalAnnouncementPushService\.pushBatch\(\s*records/.test(src)
  );
  assert('SyncDateResult exposes critical_push? field', /critical_push\?:/.test(src));
  assert(
    'pushBatch 传 dry_run 透传 syncDate options',
    /dry_run:\s*options\.dry_run\s*===\s*true/.test(src)
  );
  assert(
    'push 调用包在 try/catch + logger.warn fail-OPEN',
    /try\s*\{[\s\S]{0,300}criticalAnnouncementPushService\.pushBatch[\s\S]{0,500}\}\s*catch[\s\S]{0,400}fail-OPEN/.test(
      src
    )
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testConstants();
  testShouldPushRecord();
  testBuildTextCompleteFields();
  testBuildTextMissingFields();
  testBuildTextStockCodeFallback();
  testBuildTextSummaryEqualsTitleSkipped();
  testBuildTextTruncation();
  testBuildUserAlertMessage();
  testBuildUserAlertDedupKey();
  testResolveWebhookUrl();

  await testPushBatchEmpty();
  await testPushBatchAllLow();
  await testPushBatchNoWebhook();
  await testPushBatchDryRun();
  await testPushBatchSingleCriticalAC();
  await testPushBatchMultipleCriticalMixed();
  await testPushBatchTruncatedByCap();
  await testPushBatchTopLevelCatch();
  await testProductionSingleton();

  // PR-E (2026-06-29)
  await testUserAlertsHoldingRelated();
  await testUserAlertsNoHolders();
  await testUserAlertsNonCritical();
  await testUserAlertsMultiCritical();
  await testUserAlertsCreateThrowFailOpen();
  await testUserAlertsFindThrowFailOpen();
  await testUserAlertsNoWebhookStillWrites();
  await testUserAlertsDryRunNoWrite();

  // PR-L (2026-06-29)
  await testEmergencyConfGateConstants();
  await testEmergencyConfGateHelper();
  await testEmergencyConfGateBlocksOpsPush();
  await testEmergencyConfGateInboxStillWritten();

  testSyncDateWiringMetaGuard();

  console.log(`\n${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
