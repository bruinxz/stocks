/**
 * CriticalAnnouncementPushService 单元测试 (US-031 / ANN-007)
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/critical-announcement-push-service.test.ts
 *
 * 完全脱离 HTTP: 注入 fake FeishuWebhookPoster, 不真发飞书.
 *
 * 覆盖维度:
 *   - 常量冻结 (CRITICAL_ANNOUNCEMENT_PRIORITY / MAX_PUSH_PER_BATCH / MAX_TEXT_LEN);
 *   - 纯函数:
 *     - shouldPushRecord (priority gate / persisted gate / null defense);
 *     - buildCriticalAnnouncementText (完整字段 / 缺字段跳过 / 长文本截断 + 尾部规则保留);
 *     - resolveWebhookUrl (options 优先 / env fallback / 空字符串 → null / undefined → null);
 *   - service.pushBatch e2e:
 *     - records=[] → skipped_reason='no_records';
 *     - 全 low → skipped_reason='no_critical', poster 0 calls;
 *     - dry_run=true + 有 critical → 不真发, items per record skipped='dry_run', poster 0 calls;
 *     - no webhook (env + options 都空) + 非 dry_run + 有 critical → skipped_reason='no_webhook', poster 0 calls;
 *     - 有 webhook + 1 critical → poster 调一次 with msg_type=text + content.text 完整;
 *     - 多 critical → 顺序 fan-out (poster N 次), 单条失败不阻塞其余;
 *     - dry_run=false + 1 critical + poster 返 success=false → failed=1 + item.error 透传;
 *     - dry_run=false + 1 critical + poster throw → failed=1 + item.error 透传 (兜底);
 *     - critical 数 > cap → 前 cap 入队 + 尾部 items skip_reason='truncated_batch';
 *     - persisted=false (e.g. dry_run 路径) → 不推 (shouldPushRecord);
 *   - AC: 推送验证 — 1 条 critical 必然触发 1 次 poster 调用 + text 含 stock_code + title.
 *   - meta-guard: AnnouncementNLPService.syncDate 真接入了 criticalAnnouncementPushService.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CriticalAnnouncementPushService,
  CRITICAL_ANNOUNCEMENT_PRIORITY,
  CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH,
  CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN,
  shouldPushRecord,
  buildCriticalAnnouncementText,
  resolveWebhookUrl,
  FeishuWebhookPoster,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  /** 按 call index 自定义返回 (优先于 ok/message) */
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

// ---------------------------------------------------------------------------
// Constants tests
// ---------------------------------------------------------------------------

function testConstants(): void {
  assertEqual('CRITICAL_ANNOUNCEMENT_PRIORITY = critical', CRITICAL_ANNOUNCEMENT_PRIORITY, 'critical');
  assert(
    'CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH is positive int',
    typeof CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH === 'number' &&
      CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH > 0 &&
      Number.isInteger(CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH)
  );
  assert(
    'CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN > 200',
    CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN > 200
  );
}

// ---------------------------------------------------------------------------
// shouldPushRecord tests
// ---------------------------------------------------------------------------

function testShouldPushRecord(): void {
  assert('critical + persisted → true', shouldPushRecord(makeRecord()) === true);
  assert('high + persisted → false', shouldPushRecord(makeRecord({ priority: 'high' })) === false);
  assert('medium + persisted → false', shouldPushRecord(makeRecord({ priority: 'medium' })) === false);
  assert('low + persisted → false', shouldPushRecord(makeRecord({ priority: 'low' })) === false);
  assert(
    'critical + persisted=false → false',
    shouldPushRecord(makeRecord({ persisted: false })) === false
  );
  assert('null record → false', shouldPushRecord(null as any) === false);
  assert('undefined record → false', shouldPushRecord(undefined as any) === false);
}

// ---------------------------------------------------------------------------
// buildCriticalAnnouncementText tests
// ---------------------------------------------------------------------------

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
  assert(
    'text contains rule_id tail',
    text.includes('触发规则: announcement_critical_priority')
  );
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
  assert('header has no trailing space', !text.startsWith('🚨 [CRITICAL 公告] 600519 \n'));
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
  // title 行存在但摘要行不应重复 (避免 ops 看两遍同样字符串)
  const occurrences = text.split(title).length - 1;
  assertEqual('title appears exactly once when summary==title', occurrences, 1);
  assert('no 摘要: prefix when summary==title', !text.includes('摘要:'));
}

function testBuildTextTruncation(): void {
  const longTitle = '处罚公告 '.repeat(500); // > MAX_TEXT_LEN
  const text = buildCriticalAnnouncementText(makeRecord({ original_title: longTitle }));
  assert('text <= MAX_TEXT_LEN', text.length <= CRITICAL_ANNOUNCEMENT_MAX_TEXT_LEN);
  assert('truncated text contains ellipsis', text.includes('...'));
  assert(
    'truncated text still has rule tail (保留触发规则信息)',
    text.endsWith('触发规则: announcement_critical_priority')
  );
}

// ---------------------------------------------------------------------------
// resolveWebhookUrl tests
// ---------------------------------------------------------------------------

function testResolveWebhookUrl(): void {
  assertEqual(
    'options.webhook_url 优先',
    resolveWebhookUrl({ webhook_url: 'https://opt.example/' }, {
      OPS_ALERT_FEISHU_WEBHOOK: 'https://env.example/',
    }),
    'https://opt.example/'
  );
  assertEqual(
    'env fallback',
    resolveWebhookUrl({}, { OPS_ALERT_FEISHU_WEBHOOK: 'https://env.example/' }),
    'https://env.example/'
  );
  assertEqual('env 空字符串 → null', resolveWebhookUrl({}, { OPS_ALERT_FEISHU_WEBHOOK: '' }), null);
  assertEqual('env undefined → null', resolveWebhookUrl({}, {}), null);
  assertEqual(
    'options 空字符串 + env null → null',
    resolveWebhookUrl({ webhook_url: '   ' }, {}),
    null
  );
  assertEqual(
    'options 空字符串 + env 有 → fallback 取 env',
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
  const res = await svc.pushBatch([], {}, { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' });
  assertEqual('empty: skipped_reason', res.skipped_reason, 'no_records');
  assertEqual('empty: scanned 0', res.scanned, 0);
  assertEqual('empty: matched 0', res.matched, 0);
  assertEqual('empty: attempted 0', res.attempted, 0);
  assertEqual('empty: poster 0 calls', calls.length, 0);
}

async function testPushBatchAllLow(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch(
    [makeRecord({ priority: 'low' }), makeRecord({ priority: 'medium' })],
    {},
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' }
  );
  assertEqual('low/medium: skipped_reason', res.skipped_reason, 'no_critical');
  assertEqual('low/medium: scanned 2', res.scanned, 2);
  assertEqual('low/medium: matched 0', res.matched, 0);
  assertEqual('low/medium: poster 0 calls', calls.length, 0);
}

async function testPushBatchNoWebhook(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch([makeRecord()], {}, {});
  assertEqual('no webhook: skipped_reason', res.skipped_reason, 'no_webhook');
  assertEqual('no webhook: matched 1', res.matched, 1);
  assertEqual('no webhook: attempted 0', res.attempted, 0);
  assertEqual('no webhook: poster 0 calls', calls.length, 0);
}

async function testPushBatchDryRun(): Promise<void> {
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch(
    [makeRecord(), makeRecord({ stock_code: '000001' })],
    { dry_run: true },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' }
  );
  assertEqual('dry_run: matched 2', res.matched, 2);
  assertEqual('dry_run: attempted 2', res.attempted, 2);
  assertEqual('dry_run: succeeded 0', res.succeeded, 0);
  assertEqual('dry_run: failed 0', res.failed, 0);
  assertEqual('dry_run: poster 0 calls (NO HTTP)', calls.length, 0);
  assertEqual('dry_run: items[0].skip_reason', res.items[0].skip_reason, 'dry_run');
  assertEqual('dry_run: items[1].skip_reason', res.items[1].skip_reason, 'dry_run');
}

async function testPushBatchSingleCriticalAC(): Promise<void> {
  // === AC 主验收: 推送验证 ===
  // 1 条 critical → 1 次 poster 调 + body 含 stock_code + title.
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch([makeRecord()], {}, {
    OPS_ALERT_FEISHU_WEBHOOK: 'https://hook.example/abc',
  });
  assertEqual('AC: matched 1', res.matched, 1);
  assertEqual('AC: attempted 1', res.attempted, 1);
  assertEqual('AC: succeeded 1', res.succeeded, 1);
  assertEqual('AC: failed 0', res.failed, 0);
  assertEqual('AC: poster called exactly once', calls.length, 1);
  assertEqual('AC: poster url', calls[0].url, 'https://hook.example/abc');
  assertEqual('AC: poster msg_type', calls[0].body.msg_type, 'text');
  assert('AC: poster body.content.text contains stock_code', calls[0].body.content.text.includes('600519'));
  assert(
    'AC: poster body.content.text contains title fragment',
    calls[0].body.content.text.includes('立案调查')
  );
  assertEqual('AC: items[0] attempted=true', res.items[0].attempted, true);
  assertEqual('AC: items[0] success=true', res.items[0].success, true);
}

async function testPushBatchMultipleCriticalMixed(): Promise<void> {
  // 3 critical: 第 2 条 poster 返失败, 第 3 条 throw — 单条失败不阻塞其余.
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
    {},
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('mixed: matched 3', res.matched, 3);
  assertEqual('mixed: attempted 3', res.attempted, 3);
  assertEqual('mixed: succeeded 1', res.succeeded, 1);
  assertEqual('mixed: failed 2', res.failed, 2);
  assertEqual('mixed: poster called 3 times', calls.length, 3);
  assertEqual('mixed: items[0] success', res.items[0].success, true);
  assertEqual('mixed: items[1] success=false', res.items[1].success, false);
  assertEqual('mixed: items[1] error includes 4xx', res.items[1].error, 'feishu 4xx');
  assertEqual('mixed: items[2] success=false (throw)', res.items[2].success, false);
  assert(
    'mixed: items[2] error includes throw msg',
    String(res.items[2].error || '').includes('network DOWN')
  );
}

async function testPushBatchMixedPriorities(): Promise<void> {
  // 5 records: 2 critical + 3 其他 — 仅 2 critical 入队.
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch(
    [
      makeRecord({ stock_code: '001', priority: 'low' }),
      makeRecord({ stock_code: '002', priority: 'critical' }),
      makeRecord({ stock_code: '003', priority: 'medium' }),
      makeRecord({ stock_code: '004', priority: 'critical' }),
      makeRecord({ stock_code: '005', priority: 'high' }),
    ],
    {},
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('mixed pri: scanned 5', res.scanned, 5);
  assertEqual('mixed pri: matched 2', res.matched, 2);
  assertEqual('mixed pri: attempted 2', res.attempted, 2);
  assertEqual('mixed pri: poster 2 calls', calls.length, 2);
  // 仅 critical 行 (002, 004) 出现在 poster body
  assert('mixed pri: 002 pushed', calls.some(c => c.body.content.text.includes('002')));
  assert('mixed pri: 004 pushed', calls.some(c => c.body.content.text.includes('004')));
  assert('mixed pri: 001 NOT pushed', !calls.some(c => c.body.content.text.includes('🚨 [CRITICAL 公告] 001')));
}

async function testPushBatchNotPersistedSkip(): Promise<void> {
  // critical 但 persisted=false (e.g. dry_run 路径上的 record) → 不推
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch(
    [makeRecord({ persisted: false }), makeRecord({ persisted: false })],
    {},
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('not persisted: matched 0', res.matched, 0);
  assertEqual('not persisted: skipped_reason', res.skipped_reason, 'no_critical');
  assertEqual('not persisted: poster 0 calls', calls.length, 0);
}

async function testPushBatchTruncatedByCap(): Promise<void> {
  // 25 critical, cap=20 — 前 20 入队, 后 5 skip_reason=truncated_batch
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const records: AnnouncementNLPRecord[] = [];
  for (let i = 0; i < 25; i++) {
    records.push(makeRecord({ stock_code: String(100000 + i) }));
  }
  const res = await svc.pushBatch(records, {}, { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' });
  assertEqual('truncated: scanned 25', res.scanned, 25);
  assertEqual('truncated: matched 25', res.matched, 25);
  assertEqual('truncated: attempted equals cap', res.attempted, CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH);
  assertEqual('truncated: succeeded equals cap', res.succeeded, CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH);
  assertEqual('truncated: poster cap calls', calls.length, CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH);
  // 最后 5 条 items 应是 truncated_batch
  const truncatedItems = res.items.filter(i => i.skip_reason === 'truncated_batch');
  assertEqual('truncated: tail items count', truncatedItems.length, 25 - CRITICAL_ANNOUNCEMENT_MAX_PUSH_PER_BATCH);
}

async function testPushBatchCustomCapOption(): Promise<void> {
  // 自定义 max_per_batch=2
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const res = await svc.pushBatch(
    [makeRecord({ stock_code: 'A' }), makeRecord({ stock_code: 'B' }), makeRecord({ stock_code: 'C' })],
    { max_per_batch: 2 },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://hook' }
  );
  assertEqual('cap=2: attempted 2', res.attempted, 2);
  assertEqual('cap=2: poster 2 calls', calls.length, 2);
  assert('cap=2: 第 3 条 truncated', res.items.some(i => i.stock_code === 'C' && i.skip_reason === 'truncated_batch'));
}

async function testPushBatchOptionsWebhookOverride(): Promise<void> {
  // options.webhook_url 优先于 env, 用于多租户 / 单测
  const { poster, calls } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  await svc.pushBatch(
    [makeRecord()],
    { webhook_url: 'https://override.example/x' },
    { OPS_ALERT_FEISHU_WEBHOOK: 'https://env.example/y' }
  );
  assertEqual('option webhook 优先', calls[0].url, 'https://override.example/x');
}

async function testPushBatchTopLevelCatch(): Promise<void> {
  // 内部 records.filter throw (极端 — null 字段进了 shouldPushRecord), 顶层 catch 应该兜住.
  // 这里用一个会让 .filter 抛错的对象 (虽然 shouldPushRecord 本身防御了 null).
  // 改用注入一个 throw 的 poster + 触发 top-level: 实测 try-loop 内已 catch,
  // 所以这里 mock filter 抛错才能进 top catch — 用 Object.defineProperty 加 getter.
  const { poster } = makeFakePoster({ ok: true });
  const svc = new CriticalAnnouncementPushService(poster);
  const badRecord: any = {};
  Object.defineProperty(badRecord, 'priority', {
    get() {
      throw new Error('boom getter');
    },
  });
  const res = await svc.pushBatch([badRecord], {}, { OPS_ALERT_FEISHU_WEBHOOK: 'https://x' });
  assertEqual('top-level: skipped_reason', res.skipped_reason, 'top_level_error');
  assert('top-level: error contains boom', String(res.error || '').includes('boom'));
  assertEqual('top-level: succeeded 0', res.succeeded, 0);
}

// ---------------------------------------------------------------------------
// Production singleton smoke test
// ---------------------------------------------------------------------------

async function testProductionSingleton(): Promise<void> {
  assert(
    'criticalAnnouncementPushService 是 service 实例',
    criticalAnnouncementPushService instanceof CriticalAnnouncementPushService
  );
  // singleton 在 no_webhook 路径上必定 fail-OPEN 不抛
  const res = await criticalAnnouncementPushService.pushBatch(
    [makeRecord()],
    {},
    {} // empty env → no webhook
  );
  assertEqual('singleton no-webhook skipped_reason', res.skipped_reason, 'no_webhook');
}

// ---------------------------------------------------------------------------
// Meta-guard: AnnouncementNLPService.syncDate 真接入了本 service.
// 与 cron-registry [5] / portfolio-construction-adapter 同款源码扫描 guard.
// ---------------------------------------------------------------------------

function testSyncDateWiringMetaGuard(): void {
  const path = join(__dirname, '..', '..', 'src', 'services', 'AnnouncementNLPService.ts');
  const src = readFileSync(path, 'utf-8');
  assert(
    "AnnouncementNLPService imports CriticalAnnouncementPushService (lazy require)",
    /require\(['"]\.\/CriticalAnnouncementPushService['"]\)/.test(src)
  );
  assert(
    'syncDate calls criticalAnnouncementPushService.pushBatch(records, ...)',
    /criticalAnnouncementPushService\.pushBatch\(\s*records/.test(src)
  );
  // critical_push 字段加在 SyncDateResult 类型上
  assert(
    'SyncDateResult exposes critical_push? field',
    /critical_push\?:/.test(src)
  );
  // dry_run 透传 — push 路径必须知道是否真落库
  assert(
    'pushBatch 传 dry_run 透传 syncDate options',
    /dry_run:\s*options\.dry_run\s*===\s*true/.test(src)
  );
  // 顶层 try/catch 兜底 — push 通道失败不影响主流程
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
  testResolveWebhookUrl();

  await testPushBatchEmpty();
  await testPushBatchAllLow();
  await testPushBatchNoWebhook();
  await testPushBatchDryRun();
  await testPushBatchSingleCriticalAC();
  await testPushBatchMultipleCriticalMixed();
  await testPushBatchMixedPriorities();
  await testPushBatchNotPersistedSkip();
  await testPushBatchTruncatedByCap();
  await testPushBatchCustomCapOption();
  await testPushBatchOptionsWebhookOverride();
  await testPushBatchTopLevelCatch();
  await testProductionSingleton();

  testSyncDateWiringMetaGuard();

  console.log(`\n${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
