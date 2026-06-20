/**
 * BlackSwanDetectorService 单元测试 (US-100 [PR-011]).
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/black-swan-detector-service.test.ts
 *
 * 覆盖维度:
 *   [1] normalizeSeverityForType — 5 类启发式 + unknown fallback
 *   [2] normalizeScopeForType — MARKET_REGIME → 'market', 其它 → 'symbol'
 *   [3] pickDistinctTriggers — (event_type, signature) 复合去重保序
 *   [4] buildTitleForTrigger — 5 类 + cap ≤ 200 字
 *   [5] buildDescriptionForTrigger — cap ≤ 500 字
 *   [6] mapTriggerToEventRow — 字段 1:1 + source='detector_cron' + status='open'
 *       + metadata 透传 + first_user_id/first_position_id 进 metadata
 *   [7] countByType / countBySeverity — Record 计数
 *   [8] runBlackSwanDetector e2e (fake runner):
 *        (a) watchdog ok=false → success=false + error: watchdog_evaluate_failed
 *        (b) 无 triggers → success=true + distinct_total=0 + inserted=0
 *        (c) dry_run=true → 不调 bulkInsertEvents + inserted=0 + distinct_total
 *        (d) 真插入成功 (inserted == distinct) → success=true + skipped=0
 *        (e) bulkInsertEvents 部分被 unique idx 拦 (inserted < distinct) →
 *            success=true + skipped_duplicates > 0
 *        (f) bulkInsertEvents throw → success=false + error: bulk_insert_failed
 *        (g) user_id 透传到 watchdog
 *        (h) detected_at 覆盖 + ISO 序列化正确
 *        (i) metadata 透传到每一行 row.metadata
 *   [9] PRODUCTION runner smoke — 工厂返对象, evaluateWatchdog 不真调 (catch path)
 *   [10] META-GUARD: cron registry 含 BLACK_SWAN_DETECT + SchedulerService 含 dispatch 分支
 *       + service jsdoc 含 5 类信号 + 与 BlackSwanWatchdog 边界注释
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import type {
  BlackSwanTrigger,
  BlackSwanEvaluationResult,
} from '../../src/portfolio/risk/BlackSwanWatchdog';
import {
  BLACK_SWAN_DETECT_RECOMMENDED_CRON,
  BlackSwanEventRow,
  DetectorRunner,
  buildDescriptionForTrigger,
  buildTitleForTrigger,
  countBySeverity,
  countByType,
  createProductionDetectorRunner,
  getProductionDetectorRunner,
  mapTriggerToEventRow,
  normalizeScopeForType,
  normalizeSeverityForType,
  pickDistinctTriggers,
  runBlackSwanDetector,
} from '../../src/services/BlackSwanDetectorService';

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
// Fake DetectorRunner
// ============================================================================
interface FakeRunnerState {
  evalCalls: Array<{ user_id?: number; asOfDate: Date }>;
  insertCalls: BlackSwanEventRow[][];
  evalResult:
    | { ok: true; result: BlackSwanEvaluationResult }
    | { ok: false; error: string };
  insertInserted: number; // override; defaults to rows.length (all inserted)
  insertShouldThrow: Error | null;
}

function makeFakeRunner(overrides: Partial<FakeRunnerState> = {}): {
  runner: DetectorRunner;
  state: FakeRunnerState;
} {
  const state: FakeRunnerState = {
    evalCalls: [],
    insertCalls: [],
    evalResult: {
      ok: true,
      result: {
        scanned_users: 0,
        triggered_users: 0,
        triggers: [],
        per_user: [],
        st_market_size: 0,
        suspended_market_size: 0,
        dry_run: true,
      },
    },
    insertInserted: -1, // sentinel: use rows.length
    insertShouldThrow: null,
    ...overrides,
  };
  const runner: DetectorRunner = {
    async evaluateWatchdog(input) {
      state.evalCalls.push(input);
      return state.evalResult;
    },
    async bulkInsertEvents(rows) {
      state.insertCalls.push(rows as BlackSwanEventRow[]);
      if (state.insertShouldThrow) throw state.insertShouldThrow;
      return { inserted: state.insertInserted >= 0 ? state.insertInserted : rows.length };
    },
  };
  return { runner, state };
}

function makeTrigger(overrides: Partial<BlackSwanTrigger> = {}): BlackSwanTrigger {
  return {
    user_id: 7,
    position_id: 42,
    symbol: '600519.SH',
    name: '贵州茅台',
    event_type: 'ST',
    detail: { latest_price: 1500.0, change_pct: -3.21, raw_name: '*ST 茅台' },
    signature: 'ST::600519',
    message: '600519（贵州茅台）已被纳入风险警示板。',
    ...overrides,
  };
}

// ============================================================================
// [1] normalizeSeverityForType
// ============================================================================
console.log('\n[1] normalizeSeverityForType');
assertEqual('1.1 ST → high', normalizeSeverityForType('ST'), 'high');
assertEqual('1.2 SUSPENDED → high', normalizeSeverityForType('SUSPENDED'), 'high');
assertEqual('1.3 MARKET_REGIME → high', normalizeSeverityForType('MARKET_REGIME'), 'high');
assertEqual('1.4 NEWS_KEYWORD → medium', normalizeSeverityForType('NEWS_KEYWORD'), 'medium');
assertEqual(
  '1.5 SHAREHOLDER_REDUCTION → medium',
  normalizeSeverityForType('SHAREHOLDER_REDUCTION'),
  'medium'
);
assertEqual('1.6 OTHER/unknown → medium', normalizeSeverityForType('OTHER'), 'medium');
assertEqual('1.7 empty → medium', normalizeSeverityForType(''), 'medium');

// ============================================================================
// [2] normalizeScopeForType
// ============================================================================
console.log('\n[2] normalizeScopeForType');
assertEqual('2.1 ST → symbol', normalizeScopeForType('ST'), 'symbol');
assertEqual('2.2 SUSPENDED → symbol', normalizeScopeForType('SUSPENDED'), 'symbol');
assertEqual('2.3 NEWS_KEYWORD → symbol', normalizeScopeForType('NEWS_KEYWORD'), 'symbol');
assertEqual(
  '2.4 SHAREHOLDER_REDUCTION → symbol',
  normalizeScopeForType('SHAREHOLDER_REDUCTION'),
  'symbol'
);
assertEqual('2.5 MARKET_REGIME → market', normalizeScopeForType('MARKET_REGIME'), 'market');
assertEqual('2.6 unknown → symbol', normalizeScopeForType('OTHER'), 'symbol');

// ============================================================================
// [3] pickDistinctTriggers
// ============================================================================
console.log('\n[3] pickDistinctTriggers');
const ts = [
  makeTrigger({ user_id: 1, position_id: 10, signature: 'ST::600519' }),
  makeTrigger({ user_id: 2, position_id: 20, signature: 'ST::600519' }), // dup
  makeTrigger({ user_id: 3, position_id: 30, signature: 'ST::000001' }),
  makeTrigger({
    user_id: 1,
    position_id: 11,
    event_type: 'NEWS_KEYWORD',
    signature: 'ST::600519',
  }), // 同 sig 不同 type, 不算重复
  makeTrigger({
    user_id: 5,
    position_id: 50,
    event_type: 'NEWS_KEYWORD',
    signature: 'ST::600519',
  }), // dup
];
const distinct = pickDistinctTriggers(ts);
assertEqual('3.1 distinct length', distinct.length, 3);
assertEqual('3.2 first dedup keeps first occurrence (user_id=1)', distinct[0].user_id, 1);
assertEqual('3.3 second is ST::000001', distinct[1].signature, 'ST::000001');
assertEqual(
  '3.4 third is NEWS_KEYWORD with same sig (type-disambiguated)',
  distinct[2].event_type,
  'NEWS_KEYWORD'
);
assertEqual('3.5 empty input', pickDistinctTriggers([]).length, 0);

// ============================================================================
// [4] buildTitleForTrigger
// ============================================================================
console.log('\n[4] buildTitleForTrigger');
assertEqual(
  '4.1 ST',
  buildTitleForTrigger(makeTrigger({ event_type: 'ST', symbol: '600519.SH', name: '贵州茅台' })),
  'ST 风险警示 - 600519.SH（贵州茅台）'
);
assertEqual(
  '4.2 SUSPENDED',
  buildTitleForTrigger(makeTrigger({ event_type: 'SUSPENDED', symbol: '000001', name: '平安' })),
  '停牌 - 000001（平安）'
);
assertEqual(
  '4.3 NEWS_KEYWORD',
  buildTitleForTrigger(makeTrigger({ event_type: 'NEWS_KEYWORD' })),
  '重大利空关键词 - 600519.SH（贵州茅台）'
);
assertEqual(
  '4.4 SHAREHOLDER_REDUCTION',
  buildTitleForTrigger(makeTrigger({ event_type: 'SHAREHOLDER_REDUCTION' })),
  '减持暴增 - 600519.SH（贵州茅台）'
);
const longName = 'A'.repeat(300);
assert(
  '4.5 cap ≤ 200',
  buildTitleForTrigger(makeTrigger({ name: longName })).length <= 200,
  `len=${buildTitleForTrigger(makeTrigger({ name: longName })).length}`
);

// ============================================================================
// [5] buildDescriptionForTrigger
// ============================================================================
console.log('\n[5] buildDescriptionForTrigger');
assertEqual(
  '5.1 normal pass-through',
  buildDescriptionForTrigger(makeTrigger({ message: 'hello' })),
  'hello'
);
const longMsg = 'B'.repeat(800);
const truncated = buildDescriptionForTrigger(makeTrigger({ message: longMsg }));
assert('5.2 cap ≤ 500', truncated.length <= 500, `len=${truncated.length}`);
assert('5.3 cap ends with ...', truncated.endsWith('...'), `tail=${truncated.slice(-5)}`);
assertEqual(
  '5.4 empty message → empty string',
  buildDescriptionForTrigger(makeTrigger({ message: '' })),
  ''
);

// ============================================================================
// [6] mapTriggerToEventRow
// ============================================================================
console.log('\n[6] mapTriggerToEventRow');
const detected = new Date('2026-06-20T07:33:00Z');
const row = mapTriggerToEventRow(makeTrigger(), detected, { cron_run_id: 12345 });
assertEqual('6.1 detected_at pass-through', row.detected_at.toISOString(), detected.toISOString());
assertEqual('6.2 event_type', row.event_type, 'ST');
assertEqual('6.3 severity ST→high', row.severity, 'high');
assertEqual('6.4 scope ST→symbol', row.scope, 'symbol');
assertEqual('6.5 symbol', row.symbol, '600519.SH');
assertEqual('6.6 signature', row.signature, 'ST::600519');
assertEqual('6.7 source default', row.source, 'detector_cron');
assertEqual('6.8 status default', row.status, 'open');
assertEqual('6.9 scope_detail default', row.scope_detail, {});
assert(
  '6.10 detail pass-through',
  JSON.stringify(row.detail).includes('raw_name'),
  `detail=${JSON.stringify(row.detail)}`
);
assertEqual('6.11 metadata.cron_run_id', row.metadata.cron_run_id, 12345);
assertEqual('6.12 metadata.first_user_id', row.metadata.first_user_id, 7);
assertEqual('6.13 metadata.first_position_id', row.metadata.first_position_id, 42);
assert(
  '6.14 title built',
  typeof row.title === 'string' && row.title.length > 0,
  `title=${row.title}`
);

// MARKET_REGIME row
const marketRow = mapTriggerToEventRow(
  makeTrigger({ event_type: 'MARKET_REGIME' as any, symbol: '000001', name: '上证指数' }),
  detected
);
assertEqual('6.15 MARKET_REGIME severity → high', marketRow.severity, 'high');
assertEqual('6.16 MARKET_REGIME scope → market', marketRow.scope, 'market');

// symbol=null fallback
const noSymRow = mapTriggerToEventRow(
  makeTrigger({ event_type: 'NEWS_KEYWORD', symbol: '' as any }),
  detected
);
assertEqual('6.17 empty symbol → null', noSymRow.symbol, null);

// ============================================================================
// [7] countByType / countBySeverity
// ============================================================================
console.log('\n[7] countByType / countBySeverity');
const rowsForCount: BlackSwanEventRow[] = [
  mapTriggerToEventRow(makeTrigger({ event_type: 'ST' }), detected),
  mapTriggerToEventRow(
    makeTrigger({ event_type: 'ST', signature: 'ST::000001', symbol: '000001' }),
    detected
  ),
  mapTriggerToEventRow(
    makeTrigger({ event_type: 'NEWS_KEYWORD', signature: 'NEWS::600519::立案::abc' }),
    detected
  ),
];
assertEqual('7.1 by_type', countByType(rowsForCount), { ST: 2, NEWS_KEYWORD: 1 });
assertEqual('7.2 by_severity', countBySeverity(rowsForCount), { high: 2, medium: 1 });
assertEqual('7.3 empty by_type', countByType([]), {});
assertEqual('7.4 empty by_severity', countBySeverity([]), {});

// ============================================================================
// [8] runBlackSwanDetector e2e
// ============================================================================
console.log('\n[8] runBlackSwanDetector e2e');

async function run8(): Promise<void> {
  // (a) watchdog ok=false → fail-OPEN
  {
    const { runner, state } = makeFakeRunner({
      evalResult: { ok: false, error: 'akshare_dead' },
    });
    const r = await runBlackSwanDetector(runner);
    assertEqual('8a.1 success=false', r.success, false);
    assert(
      '8a.2 error contains watchdog_evaluate_failed',
      (r.error || '').includes('watchdog_evaluate_failed') && (r.error || '').includes('akshare_dead'),
      r.error
    );
    assertEqual('8a.3 inserted=0', r.inserted, 0);
    assertEqual('8a.4 distinct_total=0', r.distinct_total, 0);
    assertEqual('8a.5 insertCalls 0', state.insertCalls.length, 0);
  }

  // (b) 无 triggers → success=true + inserted=0
  {
    const { runner, state } = makeFakeRunner({
      evalResult: {
        ok: true,
        result: {
          scanned_users: 5,
          triggered_users: 0,
          triggers: [],
          per_user: [],
          st_market_size: 100,
          suspended_market_size: 50,
          dry_run: true,
        },
      },
    });
    const r = await runBlackSwanDetector(runner);
    assertEqual('8b.1 success=true', r.success, true);
    assertEqual('8b.2 scanned_users=5', r.scanned_users, 5);
    assertEqual('8b.3 candidates_total=0', r.candidates_total, 0);
    assertEqual('8b.4 distinct_total=0', r.distinct_total, 0);
    assertEqual('8b.5 inserted=0', r.inserted, 0);
    assertEqual('8b.6 insertCalls 0 (no rows)', state.insertCalls.length, 0);
  }

  // (c) dry_run=true → 不调 bulkInsert
  {
    const { runner, state } = makeFakeRunner({
      evalResult: {
        ok: true,
        result: {
          scanned_users: 3,
          triggered_users: 2,
          triggers: [
            makeTrigger(),
            makeTrigger({ user_id: 2, signature: 'ST::000001', symbol: '000001' }),
          ],
          per_user: [],
          st_market_size: 0,
          suspended_market_size: 0,
          dry_run: true,
        },
      },
    });
    const r = await runBlackSwanDetector(runner, { dry_run: true });
    assertEqual('8c.1 dry_run=true', r.dry_run, true);
    assertEqual('8c.2 success=true', r.success, true);
    assertEqual('8c.3 distinct_total=2', r.distinct_total, 2);
    assertEqual('8c.4 inserted=0', r.inserted, 0);
    assertEqual('8c.5 insertCalls 0', state.insertCalls.length, 0);
    assertEqual('8c.6 by_type ST=2', r.by_type.ST, 2);
    assertEqual('8c.7 by_severity high=2', r.by_severity.high, 2);
  }

  // (d) 真插入成功 (all inserted)
  {
    const triggers = [
      makeTrigger(),
      makeTrigger({ user_id: 2, signature: 'ST::000001', symbol: '000001' }),
      makeTrigger({
        user_id: 3,
        event_type: 'NEWS_KEYWORD',
        signature: 'NEWS::000002::立案::abc',
        symbol: '000002',
      }),
    ];
    const { runner, state } = makeFakeRunner({
      evalResult: {
        ok: true,
        result: {
          scanned_users: 7,
          triggered_users: 3,
          triggers,
          per_user: [],
          st_market_size: 0,
          suspended_market_size: 0,
          dry_run: true,
        },
      },
    });
    const r = await runBlackSwanDetector(runner);
    assertEqual('8d.1 success=true', r.success, true);
    assertEqual('8d.2 candidates=3', r.candidates_total, 3);
    assertEqual('8d.3 distinct=3', r.distinct_total, 3);
    assertEqual('8d.4 inserted=3', r.inserted, 3);
    assertEqual('8d.5 skipped_duplicates=0', r.skipped_duplicates, 0);
    assertEqual('8d.6 insertCalls 1', state.insertCalls.length, 1);
    assertEqual('8d.7 insertCalls[0] length=3', state.insertCalls[0].length, 3);
  }

  // (e) bulkInsertEvents 部分被 unique idx 拦
  {
    const triggers = [
      makeTrigger(),
      makeTrigger({ user_id: 2, signature: 'ST::000001', symbol: '000001' }),
    ];
    const { runner, state } = makeFakeRunner({
      evalResult: {
        ok: true,
        result: {
          scanned_users: 7,
          triggered_users: 2,
          triggers,
          per_user: [],
          st_market_size: 0,
          suspended_market_size: 0,
          dry_run: true,
        },
      },
      insertInserted: 1, // unique idx 拦了一行
    });
    const r = await runBlackSwanDetector(runner);
    assertEqual('8e.1 success=true', r.success, true);
    assertEqual('8e.2 distinct=2', r.distinct_total, 2);
    assertEqual('8e.3 inserted=1', r.inserted, 1);
    assertEqual('8e.4 skipped_duplicates=1', r.skipped_duplicates, 1);
    assertEqual('8e.5 insertCalls 1', state.insertCalls.length, 1);
  }

  // (f) bulkInsertEvents throw → success=false
  {
    const { runner } = makeFakeRunner({
      evalResult: {
        ok: true,
        result: {
          scanned_users: 1,
          triggered_users: 1,
          triggers: [makeTrigger()],
          per_user: [],
          st_market_size: 0,
          suspended_market_size: 0,
          dry_run: true,
        },
      },
      insertShouldThrow: new Error('DB down'),
    });
    const r = await runBlackSwanDetector(runner);
    assertEqual('8f.1 success=false', r.success, false);
    assert(
      '8f.2 error contains bulk_insert_failed + DB down',
      (r.error || '').includes('bulk_insert_failed') && (r.error || '').includes('DB down'),
      r.error
    );
    assertEqual('8f.3 inserted=0', r.inserted, 0);
    assertEqual('8f.4 skipped_duplicates=1', r.skipped_duplicates, 1);
  }

  // (g) user_id 透传到 watchdog
  {
    const { runner, state } = makeFakeRunner({});
    await runBlackSwanDetector(runner, { user_id: 99 });
    assertEqual('8g.1 evalCalls 1', state.evalCalls.length, 1);
    assertEqual('8g.2 user_id passed', state.evalCalls[0].user_id, 99);
  }

  // (h) detected_at 覆盖
  {
    const fixed = new Date('2026-01-15T03:33:00Z');
    const { runner } = makeFakeRunner({});
    const r = await runBlackSwanDetector(runner, { detected_at: fixed, dry_run: true });
    assertEqual('8h.1 detected_at_iso', r.detected_at_iso, fixed.toISOString());
  }

  // (i) metadata 透传
  {
    const { runner, state } = makeFakeRunner({
      evalResult: {
        ok: true,
        result: {
          scanned_users: 1,
          triggered_users: 1,
          triggers: [makeTrigger()],
          per_user: [],
          st_market_size: 0,
          suspended_market_size: 0,
          dry_run: true,
        },
      },
    });
    await runBlackSwanDetector(runner, {
      metadata: { cron_run_id: 'log-123', detector_version: 'PR-011/v1' },
    });
    assertEqual('8i.1 insertCalls 1', state.insertCalls.length, 1);
    const inserted = state.insertCalls[0][0];
    assertEqual('8i.2 row.metadata.cron_run_id', inserted.metadata.cron_run_id, 'log-123');
    assertEqual('8i.3 row.metadata.detector_version', inserted.metadata.detector_version, 'PR-011/v1');
    assertEqual('8i.4 row.metadata.first_user_id', inserted.metadata.first_user_id, 7);
  }
}

// ============================================================================
// [9] PRODUCTION runner smoke
// ============================================================================
console.log('\n[9] PRODUCTION runner smoke');
async function run9(): Promise<void> {
  const r1 = createProductionDetectorRunner();
  assert('9.1 createProductionDetectorRunner returns object', typeof r1 === 'object' && r1 !== null);
  assert('9.2 evaluateWatchdog is function', typeof r1.evaluateWatchdog === 'function');
  assert('9.3 bulkInsertEvents is function', typeof r1.bulkInsertEvents === 'function');

  // singleton
  const r2 = getProductionDetectorRunner();
  const r3 = getProductionDetectorRunner();
  assert('9.4 getProductionDetectorRunner singleton', r2 === r3);

  // bulkInsertEvents([]) → inserted=0 (不走真 BlackSwanEvent.bulkCreate, 不连 DB)
  const r = await r1.bulkInsertEvents([]);
  assertEqual('9.5 empty insert → inserted=0', r.inserted, 0);
}

// ============================================================================
// [10] META-GUARD — registry / scheduler / service jsdoc / cron expr
// ============================================================================
console.log('\n[10] META-GUARD');
const ROOT = join(__dirname, '../..');
const SERVICE_SRC = readFileSync(join(ROOT, 'src/services/BlackSwanDetectorService.ts'), 'utf8');
const SCHEDULER_SRC = readFileSync(join(ROOT, 'src/services/SchedulerService.ts'), 'utf8');
const REGISTRY_SRC = readFileSync(join(ROOT, 'src/constants/cronRegistry.ts'), 'utf8');

assert(
  '10.1 cronRegistry contains BLACK_SWAN_DETECT type',
  REGISTRY_SRC.includes("type: 'BLACK_SWAN_DETECT'"),
  ''
);
assert(
  '10.2 cronRegistry recommendedCron matches constant',
  REGISTRY_SRC.includes(`recommendedCron: '${BLACK_SWAN_DETECT_RECOMMENDED_CRON}'`),
  ''
);
assert(
  '10.3 SchedulerService has dispatch branch',
  SCHEDULER_SRC.includes("task.type === 'BLACK_SWAN_DETECT'"),
  ''
);
assert(
  '10.4 SchedulerService imports runBlackSwanDetector via lazy-require',
  SCHEDULER_SRC.includes('runBlackSwanDetector') &&
    SCHEDULER_SRC.includes("require('./BlackSwanDetectorService')"),
  ''
);
assert(
  '10.5 SchedulerService passes dry_run + user_id',
  /dry_run:\s*dryRunBs/.test(SCHEDULER_SRC) && /user_id:\s*targetUserIdBs/.test(SCHEDULER_SRC),
  ''
);
assert(
  '10.6 Service jsdoc cites US-100 / PR-011',
  SERVICE_SRC.includes('US-100') && SERVICE_SRC.includes('PR-011'),
  ''
);
assert(
  '10.7 Service jsdoc declares boundary vs BlackSwanWatchdog',
  SERVICE_SRC.includes('BlackSwanWatchdog') && SERVICE_SRC.includes('边界'),
  ''
);
assert(
  '10.8 Service jsdoc lists 5 event types',
  SERVICE_SRC.includes('ST') &&
    SERVICE_SRC.includes('SUSPENDED') &&
    SERVICE_SRC.includes('NEWS_KEYWORD') &&
    SERVICE_SRC.includes('SHAREHOLDER_REDUCTION') &&
    SERVICE_SRC.includes('MARKET_REGIME'),
  ''
);
assert(
  '10.9 Service mentions ignoreDuplicates for idempotent',
  SERVICE_SRC.includes('ignoreDuplicates'),
  ''
);
assert(
  '10.10 Service mentions fail-OPEN',
  SERVICE_SRC.includes('fail-OPEN'),
  ''
);
assert(
  '10.11 Service forces watchdog dry_run=true to avoid double-write',
  SERVICE_SRC.includes('dry_run: true') &&
    SERVICE_SRC.includes('不让 watchdog 写 RiskAlert'),
  ''
);

// ============================================================================
// Async wrapper
// ============================================================================
(async () => {
  await run8();
  await run9();

  console.log(`\n[BlackSwanDetectorService] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error('test crashed:', err);
  process.exit(1);
});
