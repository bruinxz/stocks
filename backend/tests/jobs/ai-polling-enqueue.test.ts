/**
 * ai-polling-enqueue.test.ts — US-019 [EX-005] aiPollingQueue dedup 持久化
 *
 *   cd backend && npx ts-node --transpile-only tests/jobs/ai-polling-enqueue.test.ts
 *
 * 覆盖 AC: "重复 enqueue 被合并" — Bull Redis Lua `addJob-6.lua` 行 56-59 (EXISTS jobIdKey == 1
 * → return existing jobId) 是持久化的事实源, 同 jobId 二次入队短路, worker 只跑一次.
 * 测试用 fake DataSource 直接模拟该语义, 不需要真实 Redis.
 *
 * 测试矩阵 (DB-less, 不依赖 Redis/Bull queue 真实启动):
 *   [1] 常量冻结 / 默认值 (prefix='ai-poll-', attempts=10, backoff 3min, retention 1000/500)
 *   [2] buildAIPollingJobOptions 纯函数:
 *       - happy: taskId='T1' → jobId='ai-poll-T1' + 4 个默认值齐全
 *       - 边界: taskId 缺失 / 空串 / 非 string / 全空格 → 返 null
 *       - taskId 含 trim 安全 (前后空格被剥掉)
 *       - override.attempts / backoff / retention / jobId 各自单独覆盖, 未传保留默认
 *   [3] enqueueAIPollingJob 主入口:
 *       - happy: fake queue add 一次, 返 {ok:true, jobId:'...'}
 *       - 重复入队 (AC 主验收): 同 taskId 两次, fake queue 复刻 Bull dedup 语义
 *         → 第二次返同一 jobId, 整体 worker side-effect 不会因第二次触发 (fake 验 add 调 2 次但 returned id 相同)
 *       - taskId 非法 → 不调 queue.add + 返 {ok:false, reason:'invalid_task_id'}
 *       - queue.add throw → 不 re-throw + 返 {ok:false, reason:'queue_add_failed', error}
 *   [4] 生产 DataSource 工厂 smoke — 不 throw, 返结构含 add function
 *   [5] META-GUARD fs+regex 扫 4 caller 源文件:
 *       - 必须 import { buildAIPollingJobOptions } from '...aiPollingEnqueue'
 *       - 不再 inline 写 jobId: `ai-poll-${...}` (helper 是单事实源)
 *       - 不再 inline 写 attempts: 10 + backoff fixed 3*60*1000 + removeOnComplete count 1000
 *
 * 关键约束: 项目 backend 测试不依赖 jest, 一律 self-contained IIFE + process.exit (US-018 patterns).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  AI_POLLING_JOB_ID_PREFIX,
  DEFAULT_AI_POLLING_ATTEMPTS,
  DEFAULT_AI_POLLING_BACKOFF_DELAY_MS,
  DEFAULT_AI_POLLING_REMOVE_ON_COMPLETE_COUNT,
  DEFAULT_AI_POLLING_REMOVE_ON_FAIL_COUNT,
  buildAIPollingJobOptions,
  enqueueAIPollingJob,
  createProductionAIPollingEnqueueDataSource,
  type AIPollingEnqueueDataSource,
} from '../../src/jobs/aiPollingEnqueue';
import type { AIPollingJobData } from '../../src/jobs/aiPollingQueue';
import type { JobOptions } from 'bull';

let passed = 0;
let failed = 0;
function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ----------------------------------------------------------------------------
// [1] 常量冻结 / 默认值
// ----------------------------------------------------------------------------
function testConstants() {
  console.log('\n## [1] 常量 / 默认值');
  assert('AI_POLLING_JOB_ID_PREFIX 是 "ai-poll-"', AI_POLLING_JOB_ID_PREFIX === 'ai-poll-');
  assert('DEFAULT_AI_POLLING_ATTEMPTS = 10', DEFAULT_AI_POLLING_ATTEMPTS === 10);
  assert(
    'DEFAULT_AI_POLLING_BACKOFF_DELAY_MS = 3 * 60 * 1000',
    DEFAULT_AI_POLLING_BACKOFF_DELAY_MS === 3 * 60 * 1000
  );
  assert(
    'DEFAULT_AI_POLLING_REMOVE_ON_COMPLETE_COUNT = 1000',
    DEFAULT_AI_POLLING_REMOVE_ON_COMPLETE_COUNT === 1000
  );
  assert(
    'DEFAULT_AI_POLLING_REMOVE_ON_FAIL_COUNT = 500',
    DEFAULT_AI_POLLING_REMOVE_ON_FAIL_COUNT === 500
  );
}

// ----------------------------------------------------------------------------
// [2] buildAIPollingJobOptions
// ----------------------------------------------------------------------------
function testBuildHappy() {
  console.log('\n## [2a] buildAIPollingJobOptions happy path');
  const opts = buildAIPollingJobOptions({ taskId: 'T1' });
  assert('返非 null', opts !== null);
  assert('jobId=ai-poll-T1', opts?.jobId === 'ai-poll-T1');
  assert('attempts=10', opts?.attempts === 10);
  assert(
    'backoff=fixed 3min',
    (opts?.backoff as any)?.type === 'fixed' && (opts?.backoff as any)?.delay === 180000
  );
  assert(
    'removeOnComplete count=1000',
    (opts?.removeOnComplete as any)?.count === 1000
  );
  assert('removeOnFail count=500', (opts?.removeOnFail as any)?.count === 500);
}

function testBuildInvalidTaskId() {
  console.log('\n## [2b] buildAIPollingJobOptions 非法 taskId → null');
  assert('null', buildAIPollingJobOptions({ taskId: null as any }) === null);
  assert('undefined', buildAIPollingJobOptions({ taskId: undefined as any }) === null);
  assert('空串', buildAIPollingJobOptions({ taskId: '' }) === null);
  assert('全空格', buildAIPollingJobOptions({ taskId: '   ' }) === null);
  assert('number', buildAIPollingJobOptions({ taskId: 123 as any }) === null);
  assert('object', buildAIPollingJobOptions({ taskId: {} as any }) === null);
}

function testBuildTrim() {
  console.log('\n## [2c] taskId 前后空格 trim');
  const opts = buildAIPollingJobOptions({ taskId: '  T2  ' });
  assert('jobId=ai-poll-T2 (trimmed)', opts?.jobId === 'ai-poll-T2');
}

function testBuildOverride() {
  console.log('\n## [2d] override 各字段独立生效, 未传保留默认');
  const opts1 = buildAIPollingJobOptions({ taskId: 'T3', override: { attempts: 5 } });
  assert('override attempts=5', opts1?.attempts === 5);
  assert('未传 backoff 保留默认 delay=180000', (opts1?.backoff as any)?.delay === 180000);
  assert(
    '未传 removeOnComplete 保留默认 count=1000',
    (opts1?.removeOnComplete as any)?.count === 1000
  );

  const opts2 = buildAIPollingJobOptions({
    taskId: 'T4',
    override: {
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  });
  assert('attempts 不被 backoff override 影响', opts2?.attempts === 10);
  assert(
    'override backoff exponential',
    (opts2?.backoff as any)?.type === 'exponential' && (opts2?.backoff as any)?.delay === 5000
  );
  assert('override removeOnComplete=200', (opts2?.removeOnComplete as any)?.count === 200);
  assert('override removeOnFail=100', (opts2?.removeOnFail as any)?.count === 100);

  const opts3 = buildAIPollingJobOptions({
    taskId: 'T5',
    override: { jobId: 'custom-prefix-T5' },
  });
  assert('override jobId 替换 default', opts3?.jobId === 'custom-prefix-T5');
}

// ----------------------------------------------------------------------------
// [3] enqueueAIPollingJob + dedup 验收
// ----------------------------------------------------------------------------
type FakeQueueState = {
  /** Redis-like map: jobId → first stored data — 模拟 Bull EXISTS Lua 短路 */
  store: Map<string, AIPollingJobData>;
  addCalls: Array<{ data: AIPollingJobData; opts: JobOptions; returnedId: string }>;
  /** 给特定 case 注入 throw */
  addThrow: Error | null;
};

function makeFakeSource(): { source: AIPollingEnqueueDataSource; state: FakeQueueState } {
  const state: FakeQueueState = {
    store: new Map(),
    addCalls: [],
    addThrow: null,
  };
  const source: AIPollingEnqueueDataSource = {
    add: async (data, opts) => {
      if (state.addThrow) throw state.addThrow;
      const jobId = String(opts.jobId);
      // 复刻 Bull Lua dedup: EXISTS jobIdKey == 1 → return existing jobId, 不覆盖
      if (!state.store.has(jobId)) {
        state.store.set(jobId, data);
      }
      state.addCalls.push({ data, opts, returnedId: jobId });
      return { id: jobId };
    },
  };
  return { source, state };
}

const sampleData: AIPollingJobData = {
  taskId: 'T-happy',
  symbol: '600519.SH',
  name: '贵州茅台',
};

async function testEnqueueHappy() {
  console.log('\n## [3a] enqueueAIPollingJob happy path');
  const { source, state } = makeFakeSource();
  const r = await enqueueAIPollingJob(source, {
    data: sampleData,
    source: 'quant_recommendation_controller',
  });
  assert('ok=true', r.ok === true);
  assert('jobId=ai-poll-T-happy', r.jobId === 'ai-poll-T-happy');
  assert('queue.add 调 1 次', state.addCalls.length === 1);
  assert('数据透传', state.addCalls[0].data.symbol === '600519.SH');
  assert('attempts 默认 10 透传', state.addCalls[0].opts.attempts === 10);
}

async function testEnqueueDedupRepeated() {
  console.log('\n## [3b] AC 主验收: 同 taskId 两次入队 → Bull dedup 返同 jobId');
  const { source, state } = makeFakeSource();
  const data1: AIPollingJobData = { taskId: 'dedup-key-1', symbol: '000858.SZ', name: '五粮液' };
  const data2: AIPollingJobData = { taskId: 'dedup-key-1', symbol: '000858.SZ', name: '五粮液 (变更)' };
  const r1 = await enqueueAIPollingJob(source, {
    data: data1,
    source: 'automated_recommendation_loop',
  });
  const r2 = await enqueueAIPollingJob(source, {
    data: data2,
    source: 'automated_recommendation_loop',
  });
  assert('第一次 ok=true', r1.ok === true);
  assert('第二次 ok=true', r2.ok === true);
  assert('jobId 完全相同 (dedup 持久化)', r1.jobId === r2.jobId);
  assert('jobId=ai-poll-dedup-key-1', r1.jobId === 'ai-poll-dedup-key-1');
  assert('queue.add 调 2 次 (caller 各自一次)', state.addCalls.length === 2);
  // Redis 存储侧只有 1 条 (Bull Lua EXISTS 短路: 第二次 add 不覆盖原有 data)
  assert('Redis 实际存储仅 1 条 (短路)', state.store.size === 1);
  assert(
    '原 data1 保留, data2 被短路 (worker 只跑一次)',
    state.store.get('ai-poll-dedup-key-1')?.name === '五粮液'
  );
}

async function testEnqueueInvalidTaskId() {
  console.log('\n## [3c] 非法 taskId → 不调 queue + ok=false reason=invalid_task_id');
  const { source, state } = makeFakeSource();
  const r1 = await enqueueAIPollingJob(source, {
    data: { taskId: '' as any, symbol: 'X', name: 'X' } as AIPollingJobData,
    source: 'scheduler_service',
  });
  assert('ok=false', r1.ok === false);
  assert('reason=invalid_task_id', r1.reason === 'invalid_task_id');
  assert('queue.add 不调用 (短路)', state.addCalls.length === 0);

  const r2 = await enqueueAIPollingJob(source, {
    data: { symbol: 'X', name: 'X' } as any,
    source: 'scheduler_service',
  });
  assert('缺 taskId 字段也 ok=false', r2.ok === false && r2.reason === 'invalid_task_id');
}

async function testEnqueueAddThrow() {
  console.log('\n## [3d] queue.add throw → 不 re-throw, ok=false reason=queue_add_failed');
  const { source, state } = makeFakeSource();
  state.addThrow = new Error('Redis ECONNREFUSED');
  let threw = false;
  let result: any = null;
  try {
    result = await enqueueAIPollingJob(source, {
      data: sampleData,
      source: 'quant_fusion_service',
    });
  } catch (e) {
    threw = true;
  }
  assert('不 re-throw (helper 自身永不 throw)', threw === false);
  assert('ok=false', result?.ok === false);
  assert('reason=queue_add_failed', result?.reason === 'queue_add_failed');
  assert(
    'error 透传含 ECONNREFUSED',
    String((result?.error as any)?.message || '').includes('ECONNREFUSED')
  );
}

async function testEnqueueOverride() {
  console.log('\n## [3e] override 透传到 queue.add');
  const { source, state } = makeFakeSource();
  await enqueueAIPollingJob(source, {
    data: sampleData,
    source: 'scheduler_service',
    override: { attempts: 3 },
  });
  assert('attempts override 透传', state.addCalls[0].opts.attempts === 3);
  // 未 override 的字段保留默认
  assert(
    'backoff 仍默认',
    (state.addCalls[0].opts.backoff as any)?.delay === 180000
  );
}

// ----------------------------------------------------------------------------
// [4] 生产 DataSource 工厂 smoke
// ----------------------------------------------------------------------------
function testProductionDataSourceSmoke() {
  console.log('\n## [4] 生产 DataSource 工厂返结构正确');
  let source: AIPollingEnqueueDataSource | null = null;
  try {
    source = createProductionAIPollingEnqueueDataSource();
  } catch (err) {
    // 工厂本身只做闭包, 不应 throw — 真调 add 时才会 lazy require aiPollingQueue
    assert('工厂构造不 throw', false, String(err));
    return;
  }
  assert('source 非 null', source !== null);
  assert('source.add 是 function', typeof source!.add === 'function');
}

// ----------------------------------------------------------------------------
// [5] META-GUARD: 4 caller 源文件
// ----------------------------------------------------------------------------
function metaGuardSrc(relPath: string): string {
  const abs = path.resolve(__dirname, '../../', relPath);
  return fs.readFileSync(abs, 'utf-8');
}

// 批5: 原 [5] META-GUARD (4 caller 使用 helper) 已删除 —
// 其 3 个被检 caller (QuantRecommendationController / AutomatedRecommendationLoopService /
// QuantFusionService) 已在前序批次删除, SchedulerService 的 AI_DAILY_SCREENER 分支亦下线,
// 不再有 caller 入队 AI 轮询任务. helper 自身单元测试 ([1]-[4], [5b]) 仍保留.

function testMetaGuard_HelperSingleSourceOfTruth() {
  console.log('\n## [5b] helper 自身是单事实源: aiPollingEnqueue.ts 含全部默认值');
  const src = metaGuardSrc('src/jobs/aiPollingEnqueue.ts');
  assert(
    'AI_POLLING_JOB_ID_PREFIX = "ai-poll-"',
    /AI_POLLING_JOB_ID_PREFIX\s*=\s*['"]ai-poll-['"]/.test(src)
  );
  assert(
    'DEFAULT_AI_POLLING_ATTEMPTS = 10',
    /DEFAULT_AI_POLLING_ATTEMPTS\s*=\s*10/.test(src)
  );
  assert(
    'BACKOFF_DELAY_MS = 3 * 60 * 1000',
    /DEFAULT_AI_POLLING_BACKOFF_DELAY_MS\s*=\s*3\s*\*\s*60\s*\*\s*1000/.test(src)
  );
  assert(
    'export function buildAIPollingJobOptions',
    /export\s+function\s+buildAIPollingJobOptions/.test(src)
  );
  assert(
    'export async function enqueueAIPollingJob',
    /export\s+async\s+function\s+enqueueAIPollingJob/.test(src)
  );
  assert(
    'export createProductionAIPollingEnqueueDataSource',
    /export\s+function\s+createProductionAIPollingEnqueueDataSource/.test(src)
  );
}

// ----------------------------------------------------------------------------
// Main IIFE
// ----------------------------------------------------------------------------
(async () => {
  console.log('\n=== ai-polling-enqueue.test.ts (US-019 EX-005) ===\n');
  try {
    testConstants();
    testBuildHappy();
    testBuildInvalidTaskId();
    testBuildTrim();
    testBuildOverride();
    await testEnqueueHappy();
    await testEnqueueDedupRepeated();
    await testEnqueueInvalidTaskId();
    await testEnqueueAddThrow();
    await testEnqueueOverride();
    testProductionDataSourceSmoke();
    testMetaGuard_HelperSingleSourceOfTruth();
  } catch (err: any) {
    failed++;
    console.error('THROW in main:', err?.message || err);
    console.error(err?.stack);
  }
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
