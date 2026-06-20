/**
 * autopilot-idempotency.test.ts — US-108 [EX-008] runShadowAutopilot 幂等
 *
 *   cd backend && npx ts-node --transpile-only tests/live-trading/autopilot-idempotency.test.ts
 *
 * 覆盖 AC: "幂等单测" — 包含
 *   [1] buildIdempotencyKey 纯函数稳定性 (顺序无关 / 缺省字段忽略 / string 透传 / sorted extra)
 *   [2] dailyWindow 北京时间日历日 (UTC 17:00 → 北京日期是次日)
 *   [3] AutopilotIdempotencyStore.run:
 *       (a) fresh 路径 — worker 跑 1 次, source='fresh'
 *       (b) cached 路径 — TTL 内重跑 = 命中 cache, worker 调用次数仍是 1, reused_from_idempotency=true
 *       (c) ttl_ms=0 → 不缓存, 第二次仍是 fresh
 *       (d) 缓存过期 (fake clock 推进) → 第二次回到 fresh
 *       (e) inflight_join — 同 key 并发两个 caller, worker 只跑 1 次, 第二个 source='inflight_join'
 *       (f) worker throw → in-flight 被清, 不污染后续重试, 也不写缓存
 *       (g) mark_reused=false → 不注入标记
 *   [4] LiveTradingService.runShadowAutopilot wiring meta-guard (fs+regex):
 *       (a) imports getDefaultAutopilotIdempotencyStore
 *       (b) runShadowAutopilot body 调 guard.run
 *       (c) 抽了 _runShadowAutopilotUncached 私有方法 (单一事实源)
 *   [5] 默认 store singleton 行为 (set/get/null reset)
 *
 * 关键约束: 项目 backend 测试不依赖 jest, 一律 self-contained IIFE + process.exit.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  buildIdempotencyKey,
  dailyWindow,
  AutopilotIdempotencyStore,
  getDefaultAutopilotIdempotencyStore,
  __setDefaultAutopilotIdempotencyStoreForTests,
} from '../../src/utils/autopilotIdempotency';

let failed = 0;
let passed = 0;
function assert(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ok   - ${label}`);
  } else {
    failed++;
    console.error(`  FAIL - ${label}`);
  }
}

// ----------------------------------------------------------------------------
// [1] buildIdempotencyKey
// ----------------------------------------------------------------------------
function test_buildIdempotencyKey() {
  console.log('\n## [1] buildIdempotencyKey 纯函数稳定性');
  // string 透传
  assert('string 透传', buildIdempotencyKey('abc') === 'abc');
  assert('string 空白 → unknown', buildIdempotencyKey('   ') === 'unknown');
  // 缺省字段忽略
  const k1 = buildIdempotencyKey({ task: 'shadow_autopilot' });
  assert('缺省字段只剩 task', k1 === 'task=shadow_autopilot');
  // 完整字段
  const k2 = buildIdempotencyKey({
    task: 'shadow_autopilot',
    user_id: 7,
    source: 'cron',
    window: '2026-06-20',
    extra: { dry_run: false, limit: 2 },
  });
  assert(
    '完整 key',
    k2 === 'task=shadow_autopilot|user=7|source=cron|window=2026-06-20|dry_run=false|limit=2'
  );
  // extra 顺序不影响
  const k3a = buildIdempotencyKey({ task: 't', extra: { b: 1, a: 2 } });
  const k3b = buildIdempotencyKey({ task: 't', extra: { a: 2, b: 1 } });
  assert('extra sorted 顺序无关', k3a === k3b && k3a === 'task=t|a=2|b=1');
  // undefined/null extra value 跳过
  const k4 = buildIdempotencyKey({ task: 't', extra: { a: 1, b: undefined, c: null } });
  assert('extra 跳过 undefined/null', k4 === 'task=t|a=1');
  // user_id=0 也要保留 (不是 null)
  const k5 = buildIdempotencyKey({ task: 't', user_id: 0 });
  assert('user_id=0 保留', k5 === 'task=t|user=0');
}

// ----------------------------------------------------------------------------
// [2] dailyWindow
// ----------------------------------------------------------------------------
function test_dailyWindow() {
  console.log('\n## [2] dailyWindow 北京时间日历日');
  // UTC 2026-06-20T00:00:00 → 北京 08:00 → 2026-06-20
  const utcMorning = Date.UTC(2026, 5, 20, 0, 0, 0);
  assert('UTC 00:00 → 北京 08:00 → 2026-06-20', dailyWindow(utcMorning) === '2026-06-20');
  // UTC 2026-06-19T17:00:00 → 北京 2026-06-20T01:00 → 2026-06-20
  const lateNight = Date.UTC(2026, 5, 19, 17, 0, 0);
  assert('UTC 17:00 → 北京次日 01:00 → 2026-06-20', dailyWindow(lateNight) === '2026-06-20');
  // UTC 2026-06-19T15:59:59 → 北京 2026-06-19T23:59:59 → 2026-06-19
  const justBeforeMidnight = Date.UTC(2026, 5, 19, 15, 59, 59);
  assert(
    'UTC 15:59 → 北京 23:59 → 2026-06-19',
    dailyWindow(justBeforeMidnight) === '2026-06-19'
  );
  // Date 入参也支持
  assert('Date 入参', dailyWindow(new Date(utcMorning)) === '2026-06-20');
}

// ----------------------------------------------------------------------------
// [3] AutopilotIdempotencyStore.run
// ----------------------------------------------------------------------------
async function test_storeRun_fresh() {
  console.log('\n## [3a] store.run fresh 路径');
  const store = new AutopilotIdempotencyStore();
  let calls = 0;
  const out = await store.run({ task: 't', user_id: 1 }, { ttl_ms: 1000 }, async () => {
    calls++;
    return { ok: true, n: calls };
  });
  assert('worker 跑了 1 次', calls === 1);
  assert('source=fresh', out.source === 'fresh');
  assert('result 透传', (out.result as any).ok === true);
  assert('key 已暴露', typeof out.key === 'string' && out.key.length > 0);
}

async function test_storeRun_cached() {
  console.log('\n## [3b] store.run TTL 内重跑命中 cache');
  const store = new AutopilotIdempotencyStore();
  let calls = 0;
  const key = { task: 't', user_id: 1 };
  const first = await store.run(key, { ttl_ms: 5_000 }, async () => {
    calls++;
    return { ok: true, n: calls };
  });
  const second = await store.run(key, { ttl_ms: 5_000 }, async () => {
    calls++;
    return { ok: true, n: 999 };
  });
  assert('worker 仅跑 1 次', calls === 1);
  assert('first source=fresh', first.source === 'fresh');
  assert('second source=cached', second.source === 'cached');
  assert(
    'second 返第一次 result + reused_from_idempotency=true',
    (second.result as any).n === 1 && (second.result as any).reused_from_idempotency === true
  );
}

async function test_storeRun_ttlZeroNoCache() {
  console.log('\n## [3c] ttl_ms=0 不缓存');
  const store = new AutopilotIdempotencyStore();
  let calls = 0;
  const key = 'no-cache';
  await store.run(key, { ttl_ms: 0 }, async () => {
    calls++;
    return { ok: true };
  });
  const second = await store.run(key, { ttl_ms: 0 }, async () => {
    calls++;
    return { ok: true };
  });
  assert('worker 跑 2 次', calls === 2);
  assert('second source=fresh', second.source === 'fresh');
  assert('cache 列表为空', store.listCached().length === 0);
}

async function test_storeRun_expiredCache() {
  console.log('\n## [3d] fake clock 推进过期 cache → 回到 fresh');
  let nowMs = 1_000_000_000_000;
  const store = new AutopilotIdempotencyStore({ now: () => nowMs });
  let calls = 0;
  const key = { task: 't', user_id: 9 };
  await store.run(key, { ttl_ms: 1000 }, async () => {
    calls++;
    return { ok: true };
  });
  nowMs += 500;
  const within = await store.run(key, { ttl_ms: 1000 }, async () => {
    calls++;
    return { ok: true };
  });
  assert('500ms 内命中 cache', within.source === 'cached' && calls === 1);
  nowMs += 2_000;
  const after = await store.run(key, { ttl_ms: 1000 }, async () => {
    calls++;
    return { ok: true };
  });
  assert('2500ms 后回到 fresh', after.source === 'fresh' && calls === 2);
}

async function test_storeRun_inflightJoin() {
  console.log('\n## [3e] 并发同 key → inflight_join, worker 只跑 1 次');
  const store = new AutopilotIdempotencyStore();
  let calls = 0;
  let resolveWorker!: (v: any) => void;
  const workerPromise = new Promise<any>(r => (resolveWorker = r));
  const key = { task: 't', user_id: 5 };
  const p1 = store.run(key, { ttl_ms: 1000 }, async () => {
    calls++;
    return await workerPromise;
  });
  const p2 = store.run(key, { ttl_ms: 1000 }, async () => {
    calls++;
    return { unreachable: true };
  });
  // 此时 in-flight = 1 个
  assert('listInflight 有 1 个', store.listInflight().length === 1);
  // 解锁 worker
  resolveWorker({ ok: true, value: 42 });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert('worker 只跑 1 次', calls === 1);
  assert('p1 source=fresh', r1.source === 'fresh');
  assert('p2 source=inflight_join', r2.source === 'inflight_join');
  assert(
    'p2 共享 p1 结果 + reused=true',
    (r2.result as any).value === 42 && (r2.result as any).reused_from_idempotency === true
  );
  assert('listInflight 清空', store.listInflight().length === 0);
}

async function test_storeRun_workerThrowsClearsInflight() {
  console.log('\n## [3f] worker throw → in-flight 清空, 不写缓存, 下次重试回到 fresh');
  const store = new AutopilotIdempotencyStore();
  let calls = 0;
  const key = 'throws';
  let threw = false;
  try {
    await store.run(key, { ttl_ms: 5000 }, async () => {
      calls++;
      throw new Error('boom');
    });
  } catch (e: any) {
    threw = true;
    assert('throw 透传 boom', /boom/.test(e?.message || ''));
  }
  assert('第一次确实 throw', threw === true);
  assert('in-flight 清空', store.listInflight().length === 0);
  assert('cache 没写', store.listCached().length === 0);
  // 第二次同 key 应回到 fresh (不命中缓存, 因为 throw 没写缓存)
  const ok = await store.run(key, { ttl_ms: 5000 }, async () => {
    calls++;
    return { ok: true };
  });
  assert('第二次重试是 fresh', ok.source === 'fresh' && calls === 2);
}

async function test_storeRun_markReusedFalse() {
  console.log('\n## [3g] mark_reused=false → 不注入标记');
  const store = new AutopilotIdempotencyStore();
  const key = 'no-mark';
  await store.run(key, { ttl_ms: 5000, mark_reused: false }, async () => ({ ok: true }));
  const second = await store.run(
    key,
    { ttl_ms: 5000, mark_reused: false },
    async () => ({ ok: true })
  );
  assert('source=cached', second.source === 'cached');
  assert(
    '没注入 reused_from_idempotency',
    (second.result as any).reused_from_idempotency === undefined
  );
}

// ----------------------------------------------------------------------------
// [4] LiveTradingService wiring (fs+regex meta-guard, 不依赖运行时 DB)
// ----------------------------------------------------------------------------
function test_metaGuard_liveTradingServiceWiring() {
  console.log('\n## [4] META-GUARD: LiveTradingService 已接入 autopilot idempotency');
  const lts = path.join(__dirname, '../../src/live-trading/services/LiveTradingService.ts');
  const src = fs.readFileSync(lts, 'utf8');

  // (a) 引入 helper
  assert(
    'imports getDefaultAutopilotIdempotencyStore',
    /import[\s\S]*?getDefaultAutopilotIdempotencyStore[\s\S]*?from\s+['"]\.\.\/\.\.\/utils\/autopilotIdempotency['"]/.test(
      src
    )
  );
  assert(
    'imports dailyWindow as autopilotDailyWindow',
    /dailyWindow\s+as\s+autopilotDailyWindow/.test(src)
  );

  // (b) runShadowAutopilot 调 guard.run
  assert(
    'runShadowAutopilot 调 guard.run',
    /async\s+runShadowAutopilot\([\s\S]*?guard\.run\(/m.test(src)
  );
  assert(
    'guard.run 第一参数 task=shadow_autopilot',
    /guard\.run\([\s\S]*?task:\s*['"]shadow_autopilot['"]/m.test(src)
  );
  assert(
    'guard.run window 用 autopilotDailyWindow()',
    /window:\s*autopilotDailyWindow\(\)/.test(src)
  );
  assert(
    'extra 含 dry_run / limit / account_role',
    /extra:\s*\{[\s\S]*?dry_run[\s\S]*?limit[\s\S]*?account_role[\s\S]*?\}/.test(src)
  );

  // (c) 抽了 _runShadowAutopilotUncached 私有方法
  assert(
    '抽了 _runShadowAutopilotUncached',
    /private\s+async\s+_runShadowAutopilotUncached\(/.test(src)
  );

  // (d) runShadowAutopilot 不再直接 new 草稿 (createDraft 调用应只在 _runShadowAutopilotUncached 里)
  const runIdx = src.indexOf('async runShadowAutopilot(');
  const uncachedIdx = src.indexOf('private async _runShadowAutopilotUncached(');
  assert('runShadowAutopilot 在 uncached 之前', runIdx > 0 && uncachedIdx > runIdx);
  const runBody = src.slice(runIdx, uncachedIdx);
  assert(
    'runShadowAutopilot 入口 body 不直接 createDraft',
    !/this\.createDraft\(/.test(runBody)
  );
}

// ----------------------------------------------------------------------------
// [5] 默认 singleton getter / 注入 hook
// ----------------------------------------------------------------------------
function test_defaultSingleton() {
  console.log('\n## [5] 默认 singleton getter / 注入 hook');
  // 先 reset
  __setDefaultAutopilotIdempotencyStoreForTests(null);
  const a = getDefaultAutopilotIdempotencyStore();
  const b = getDefaultAutopilotIdempotencyStore();
  assert('两次 get 返同一 instance', a === b);
  const custom = new AutopilotIdempotencyStore();
  __setDefaultAutopilotIdempotencyStoreForTests(custom);
  assert('注入 custom 后 get 返 custom', getDefaultAutopilotIdempotencyStore() === custom);
  __setDefaultAutopilotIdempotencyStoreForTests(null);
  const c = getDefaultAutopilotIdempotencyStore();
  assert('reset 后重新创建', c !== custom && c !== a);
}

// ----------------------------------------------------------------------------
// main
// ----------------------------------------------------------------------------
(async () => {
  console.log('autopilot-idempotency.test.ts — US-108 [EX-008]\n');
  test_buildIdempotencyKey();
  test_dailyWindow();
  await test_storeRun_fresh();
  await test_storeRun_cached();
  await test_storeRun_ttlZeroNoCache();
  await test_storeRun_expiredCache();
  await test_storeRun_inflightJoin();
  await test_storeRun_workerThrowsClearsInflight();
  await test_storeRun_markReusedFalse();
  test_metaGuard_liveTradingServiceWiring();
  test_defaultSingleton();

  console.log(`\n--- ${passed} ok / ${failed} failed ---`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.error('FATAL', e);
  process.exit(2);
});
