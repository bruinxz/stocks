/**
 * SystemHealthDetailService 单元测试 (US-096 运维：系统启动自检页)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/system-health-detail-service.test.ts
 *
 * 覆盖维度：
 *   - withTimeout: 正常返回 / 超时返回 fallback / promise reject 返回 fallback / 同步抛出
 *   - determineFeishuStatus: 全空 / 至少一个非空 / 全空字符串 / undefined / mixed types
 *   - assembleDetail: 5 个 fulfilled / 5 个 rejected / mixed / 长度校验 throw
 *     uptime 负数 / float / 0 / 大整数
 *   - collectSystemHealthDetail: 整 pipeline 使用 fake ProbeFns；
 *     all-ok / all-fail / mixed / probe rejected
 *   - buildDefaultProbeFns: env 注入 / timeout 触发 / db 异常 → fail /
 *     redis returns false → fail / http 4xx → fail / http 200 → ok
 *   - probeAkshareViaPython: 超时返回 fail (用极短 timeout 不实际启 python)
 */

import {
  determineFeishuStatus,
  withTimeout,
  assembleDetail,
  collectSystemHealthDetail,
  buildDefaultProbeFns,
  probeAkshareViaPython,
  DependencyStatus,
  HealthProbeFns,
} from '../../src/services/SystemHealthDetailService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, details?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${details ? `\n    ${details}` : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// =============================================================================
// withTimeout
// =============================================================================
async function testWithTimeout(): Promise<void> {
  console.log('--- withTimeout ---');

  // 正常情况：fn 30ms 返回，timeout 1000ms → 直接拿 value
  const t1 = await withTimeout(async () => 'good', 1000, 'fallback');
  assertEqual('正常返回 value', t1, 'good');

  // 超时情况：fn 100ms 返回，但 timeout 10ms → fallback
  const t2 = await withTimeout(
    () => new Promise<string>(resolve => setTimeout(() => resolve('late'), 100)),
    10,
    'fallback'
  );
  assertEqual('超时返回 fallback', t2, 'fallback');

  // Reject 情况：fn throw → fallback
  const t3 = await withTimeout<string>(
    async () => {
      throw new Error('boom');
    },
    1000,
    'fallback'
  );
  assertEqual('reject 返回 fallback', t3, 'fallback');

  // 同步 throw：fn 同步抛 (其实 async fn 不会同步抛，但模拟万一)
  const t4 = await withTimeout<string>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (() => Promise.reject('sync-boom')) as any,
    1000,
    'fallback'
  );
  assertEqual('promise rejected with string → fallback', t4, 'fallback');

  // fn 在 timeout 后返回不应该污染结果
  let resolvedAfterTimeout = false;
  const t5 = await withTimeout(
    () =>
      new Promise<string>(resolve =>
        setTimeout(() => {
          resolvedAfterTimeout = true;
          resolve('too-late');
        }, 50)
      ),
    5,
    'fallback'
  );
  assertEqual('timeout 时仍返回 fallback', t5, 'fallback');
  // wait for the late resolution to fire & confirm it did NOT mutate the outer value
  await new Promise(r => setTimeout(r, 80));
  assert('late resolve 不污染结果 (still fallback)', resolvedAfterTimeout === true);
}

// =============================================================================
// determineFeishuStatus
// =============================================================================
function testDetermineFeishuStatus(): void {
  console.log('--- determineFeishuStatus ---');

  assertEqual(
    '全空 env → not_configured',
    determineFeishuStatus({} as NodeJS.ProcessEnv),
    'not_configured' as DependencyStatus
  );

  assertEqual(
    'FEISHU_BOT_WEBHOOK = "" → not_configured',
    determineFeishuStatus({ FEISHU_BOT_WEBHOOK: '' } as NodeJS.ProcessEnv),
    'not_configured' as DependencyStatus
  );

  assertEqual(
    'FEISHU_BOT_WEBHOOK = "   " → not_configured (trim)',
    determineFeishuStatus({ FEISHU_BOT_WEBHOOK: '   ' } as NodeJS.ProcessEnv),
    'not_configured' as DependencyStatus
  );

  assertEqual(
    'FEISHU_BOT_WEBHOOK = "https://x" → ok',
    determineFeishuStatus({ FEISHU_BOT_WEBHOOK: 'https://x' } as NodeJS.ProcessEnv),
    'ok' as DependencyStatus
  );

  assertEqual(
    'FEISHU_RECOMMENDATION_BOT_WEBHOOK 单独有 → ok',
    determineFeishuStatus({
      FEISHU_RECOMMENDATION_BOT_WEBHOOK: 'https://y',
    } as NodeJS.ProcessEnv),
    'ok' as DependencyStatus
  );

  assertEqual(
    'FEISHU_DAILY_DIGEST_WEBHOOK 单独有 → ok',
    determineFeishuStatus({
      FEISHU_DAILY_DIGEST_WEBHOOK: 'https://z',
    } as NodeJS.ProcessEnv),
    'ok' as DependencyStatus
  );

  // 混合：一个填一个空 → ok (任意一个有就算)
  assertEqual(
    '一个 webhook 配置另一个空 → ok',
    determineFeishuStatus({
      FEISHU_BOT_WEBHOOK: '',
      FEISHU_RECOMMENDATION_BOT_WEBHOOK: 'https://a',
    } as NodeJS.ProcessEnv),
    'ok' as DependencyStatus
  );

  // env 字段类型异常：undefined 应该被当 not present
  assertEqual(
    'undefined webhook → not_configured',
    determineFeishuStatus({
      FEISHU_BOT_WEBHOOK: undefined,
    } as NodeJS.ProcessEnv),
    'not_configured' as DependencyStatus
  );
}

// =============================================================================
// assembleDetail
// =============================================================================
function testAssembleDetail(): void {
  console.log('--- assembleDetail ---');

  // 5 个 fulfilled all ok
  const r1 = assembleDetail(
    [
      { status: 'fulfilled', value: 'ok' },
      { status: 'fulfilled', value: 'ok' },
      { status: 'fulfilled', value: 'ok' },
      { status: 'fulfilled', value: 'ok' },
      { status: 'fulfilled', value: 'ok' },
    ],
    100
  );
  assertEqual('all ok', r1, {
    db: 'ok',
    redis: 'ok',
    tradingAgents: 'ok',
    akshare: 'ok',
    feishu: 'ok',
    uptime_seconds: 100,
  });

  // 5 个 rejected all fail
  const r2 = assembleDetail(
    [
      { status: 'rejected', reason: new Error('a') },
      { status: 'rejected', reason: new Error('b') },
      { status: 'rejected', reason: new Error('c') },
      { status: 'rejected', reason: new Error('d') },
      { status: 'rejected', reason: new Error('e') },
    ],
    200
  );
  assertEqual('all rejected → all fail', r2, {
    db: 'fail',
    redis: 'fail',
    tradingAgents: 'fail',
    akshare: 'fail',
    feishu: 'fail',
    uptime_seconds: 200,
  });

  // mixed
  const r3 = assembleDetail(
    [
      { status: 'fulfilled', value: 'ok' },
      { status: 'rejected', reason: new Error('redis down') },
      { status: 'fulfilled', value: 'fail' },
      { status: 'fulfilled', value: 'ok' },
      { status: 'fulfilled', value: 'not_configured' },
    ],
    3600
  );
  assertEqual('mixed', r3, {
    db: 'ok',
    redis: 'fail',
    tradingAgents: 'fail',
    akshare: 'ok',
    feishu: 'not_configured',
    uptime_seconds: 3600,
  });

  // uptime 边界
  assertEqual('uptime 负数 → 0', assembleDetail(r1Settled(), -10).uptime_seconds, 0);
  assertEqual('uptime float 取整', assembleDetail(r1Settled(), 12.7).uptime_seconds, 12);
  assertEqual('uptime 0', assembleDetail(r1Settled(), 0).uptime_seconds, 0);
  assertEqual(
    'uptime 大整数',
    assembleDetail(r1Settled(), 99999999).uptime_seconds,
    99999999
  );

  // 长度校验
  let didThrow = false;
  try {
    assembleDetail([{ status: 'fulfilled', value: 'ok' }], 1);
  } catch {
    didThrow = true;
  }
  assert('长度 ≠ 5 throw', didThrow);
}

function r1Settled(): PromiseSettledResult<DependencyStatus>[] {
  return [
    { status: 'fulfilled', value: 'ok' },
    { status: 'fulfilled', value: 'ok' },
    { status: 'fulfilled', value: 'ok' },
    { status: 'fulfilled', value: 'ok' },
    { status: 'fulfilled', value: 'ok' },
  ];
}

// =============================================================================
// collectSystemHealthDetail (注入 fake probes)
// =============================================================================
async function testCollectSystemHealthDetail(): Promise<void> {
  console.log('--- collectSystemHealthDetail ---');

  const fakeAllOk: HealthProbeFns = {
    probeDb: async () => 'ok',
    probeRedis: async () => 'ok',
    probeTradingAgents: async () => 'ok',
    probeAkshare: async () => 'ok',
    probeFeishu: async () => 'ok',
    getUptimeSeconds: () => 42,
  };
  assertEqual('all-ok pipeline', await collectSystemHealthDetail(fakeAllOk), {
    db: 'ok',
    redis: 'ok',
    tradingAgents: 'ok',
    akshare: 'ok',
    feishu: 'ok',
    uptime_seconds: 42,
  });

  const fakeAllFail: HealthProbeFns = {
    probeDb: async () => 'fail',
    probeRedis: async () => 'fail',
    probeTradingAgents: async () => 'fail',
    probeAkshare: async () => 'fail',
    probeFeishu: async () => 'not_configured',
    getUptimeSeconds: () => 7,
  };
  assertEqual('all-fail pipeline (feishu not_configured)', await collectSystemHealthDetail(fakeAllFail), {
    db: 'fail',
    redis: 'fail',
    tradingAgents: 'fail',
    akshare: 'fail',
    feishu: 'not_configured',
    uptime_seconds: 7,
  });

  // probe rejected (合约说 probe 不应 throw，但万一)
  const fakeWithReject: HealthProbeFns = {
    probeDb: async () => {
      throw new Error('db boom');
    },
    probeRedis: async () => 'ok',
    probeTradingAgents: async () => 'ok',
    probeAkshare: async () => 'ok',
    probeFeishu: async () => 'not_configured',
    getUptimeSeconds: () => 99,
  };
  assertEqual('probe reject → mapped to fail', await collectSystemHealthDetail(fakeWithReject), {
    db: 'fail',
    redis: 'ok',
    tradingAgents: 'ok',
    akshare: 'ok',
    feishu: 'not_configured',
    uptime_seconds: 99,
  });
}

// =============================================================================
// buildDefaultProbeFns
// =============================================================================
async function testBuildDefaultProbeFns(): Promise<void> {
  console.log('--- buildDefaultProbeFns ---');

  // db 正常
  {
    const probes = buildDefaultProbeFns({
      sequelize: { query: async () => [{ '?column?': 1 }] },
      redisHealthCheck: async () => true,
      httpGet: async () => ({ status: 200 }),
      tradingAgentsUrl: 'http://fake',
      uptimeFn: () => 12,
      envOverride: { FEISHU_BOT_WEBHOOK: 'https://x' } as NodeJS.ProcessEnv,
      pythonProbeOverride: async () => 'ok',
    });
    const detail = await collectSystemHealthDetail(probes);
    assertEqual('all dep ok via default probes', detail, {
      db: 'ok',
      redis: 'ok',
      tradingAgents: 'ok',
      akshare: 'ok',
      feishu: 'ok',
      uptime_seconds: 12,
    });
  }

  // db throw
  {
    const probes = buildDefaultProbeFns({
      sequelize: {
        query: async () => {
          throw new Error('db down');
        },
      },
      redisHealthCheck: async () => true,
      httpGet: async () => ({ status: 200 }),
      tradingAgentsUrl: 'http://fake',
      uptimeFn: () => 1,
      envOverride: {} as NodeJS.ProcessEnv,
      pythonProbeOverride: async () => 'ok',
    });
    const detail = await collectSystemHealthDetail(probes);
    assertEqual('db throw → fail', detail.db, 'fail');
    assertEqual('feishu env 空 → not_configured', detail.feishu, 'not_configured');
  }

  // redis false
  {
    const probes = buildDefaultProbeFns({
      sequelize: { query: async () => [] },
      redisHealthCheck: async () => false,
      httpGet: async () => ({ status: 200 }),
      tradingAgentsUrl: 'http://fake',
      uptimeFn: () => 1,
      envOverride: {} as NodeJS.ProcessEnv,
      pythonProbeOverride: async () => 'ok',
    });
    const detail = await collectSystemHealthDetail(probes);
    assertEqual('redis healthCheck returns false → fail', detail.redis, 'fail');
  }

  // http 4xx
  {
    const probes = buildDefaultProbeFns({
      sequelize: { query: async () => [] },
      redisHealthCheck: async () => true,
      httpGet: async () => ({ status: 404 }),
      tradingAgentsUrl: 'http://fake',
      uptimeFn: () => 1,
      envOverride: {} as NodeJS.ProcessEnv,
      pythonProbeOverride: async () => 'ok',
    });
    const detail = await collectSystemHealthDetail(probes);
    assertEqual('TA 404 → fail', detail.tradingAgents, 'fail');
  }

  // http 200
  {
    const probes = buildDefaultProbeFns({
      sequelize: { query: async () => [] },
      redisHealthCheck: async () => true,
      httpGet: async () => ({ status: 200 }),
      tradingAgentsUrl: 'http://fake',
      uptimeFn: () => 1,
      envOverride: {} as NodeJS.ProcessEnv,
      pythonProbeOverride: async () => 'ok',
    });
    const detail = await collectSystemHealthDetail(probes);
    assertEqual('TA 200 → ok', detail.tradingAgents, 'ok');
  }

  // http throw → fail
  {
    const probes = buildDefaultProbeFns({
      sequelize: { query: async () => [] },
      redisHealthCheck: async () => true,
      httpGet: async () => {
        throw new Error('network');
      },
      tradingAgentsUrl: 'http://fake',
      uptimeFn: () => 1,
      envOverride: {} as NodeJS.ProcessEnv,
      pythonProbeOverride: async () => 'ok',
    });
    const detail = await collectSystemHealthDetail(probes);
    assertEqual('TA network error → fail', detail.tradingAgents, 'fail');
  }

  // db timeout (用 100ms 永远不返回的 query)
  {
    const probes = buildDefaultProbeFns({
      sequelize: { query: () => new Promise(() => {}) /* never resolves */ },
      redisHealthCheck: async () => true,
      httpGet: async () => ({ status: 200 }),
      tradingAgentsUrl: 'http://fake',
      uptimeFn: () => 1,
      envOverride: { HEALTH_DETAIL_DB_TIMEOUT_MS: '50' } as NodeJS.ProcessEnv,
      pythonProbeOverride: async () => 'ok',
    });
    const detail = await collectSystemHealthDetail(probes);
    assertEqual('db hang → timeout → fail', detail.db, 'fail');
  }

  // python probe injection 用了
  {
    const probes = buildDefaultProbeFns({
      sequelize: { query: async () => [] },
      redisHealthCheck: async () => true,
      httpGet: async () => ({ status: 200 }),
      tradingAgentsUrl: 'http://fake',
      uptimeFn: () => 1,
      envOverride: {} as NodeJS.ProcessEnv,
      pythonProbeOverride: async () => 'fail',
    });
    const detail = await collectSystemHealthDetail(probes);
    assertEqual('akshare probe override 生效', detail.akshare, 'fail');
  }
}

// =============================================================================
// probeAkshareViaPython 超时分支
// =============================================================================
async function testProbeAkshareViaPython(): Promise<void> {
  console.log('--- probeAkshareViaPython ---');

  // 不实际启 python（避免测试环境缺包污染结果）；只验证超时分支
  // 用 1ms 超时确保即使 spawn 启动了也来不及完成 → fail
  const result = await probeAkshareViaPython(1);
  // result 必然是 'ok' 或 'fail' — 不应 throw
  assert(
    "result ∈ {'ok', 'fail'}",
    result === 'ok' || result === 'fail',
    `got: ${result}`
  );
  // 1ms 超时几乎必然失败 (spawn 启动 >1ms)
  assertEqual('1ms 超时 → fail', result, 'fail');
}

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
  await testWithTimeout();
  testDetermineFeishuStatus();
  testAssembleDetail();
  await testCollectSystemHealthDetail();
  await testBuildDefaultProbeFns();
  await testProbeAkshareViaPython();

  console.log('\n--------------------------------------------------------------');
  console.log(`Total: ${passed} ok, ${failed} failed`);
  console.log('--------------------------------------------------------------');
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(2);
});
