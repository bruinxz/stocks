/**
 * aiPollingEnqueue.ts — US-019 / EX-005 aiPollingQueue dedup 持久化统一入口
 *
 * BETA-3 (2026-06-18, audit M-15) 在 4 处 caller (QuantRecommendationController /
 * AutomatedRecommendationLoopService / SchedulerService / QuantFusionService) 各自
 * 内联了相同的 add 选项块:
 *
 *   { jobId: `ai-poll-${task_id}`, attempts: 10,
 *     backoff: { type: 'fixed', delay: 3*60*1000 },
 *     removeOnComplete: { count: 1000 }, removeOnFail: { count: 500 } }
 *
 * 4 处复制粘贴 → 任何一个 ops 调整 (attempts / retention) 都要同步 4 处, 漏改即偏移.
 * 本 helper 抽出 buildAIPollingJobOptions(taskId) 把 4 处归一, 并提供
 * enqueueAIPollingJob(data, source?) 主入口让 caller 一行替换内联 add.
 *
 * 持久化:
 *   Bull `customJobId` 是 Redis-EXISTS 原语 (见 bull/lib/commands/addJob-6.lua line 56-59):
 *   同 jobId 入队 → Lua `EXISTS jobIdKey == 1` → return existing jobId, 不再新建任务.
 *   Redis 本身是 dedup 状态的事实源, 跨进程/跨 service / 跨 worker 自然全局唯一.
 *   不需要也不应该再加进程内 Map (会与 Redis 真相漂移). 这就是 "dedup 持久化" 验收
 *   的实质 — caller 显式传 jobId, queue 默认 + Bull 内置 Redis Lua 完成持久化.
 *
 * 验收 (PRD AC: 重复 enqueue 被合并):
 *   await enqueueAIPollingJob({ taskId: 'T1', ... })
 *   await enqueueAIPollingJob({ taskId: 'T1', ... })  // 第二次返同一 jobId, worker 只跑一次
 *
 * 注: 接 DataSource DI seam (createAIPollingEnqueueDataSource) 跟 US-018 bridgeFailSafe
 * 同模式, 测试可注入 fake queue 验证 jobId/options/dedup 行为, 不需要真实 Redis.
 *
 * 与既有 patterns 关系:
 *   - 与 US-018 bridgeFailSafe.ts (DataSource DI + 反向 META-GUARD) 同款抽取模式;
 *   - 与 US-015 feasibilityGate.ts (4 处 caller 全接 + 反向 inline 守护) 同形态;
 *   - Bull retry / backoff / retention 这三个数值是 ops 调参主战场, 单事实源放这里.
 */
import type { JobOptions, Queue } from 'bull';
import type { AIPollingJobData } from './aiPollingQueue';

/**
 * AI polling job 标准 prefix — Redis key 前缀 `ai-poll-${taskId}`.
 * 选定值约束: 必须以 'ai-poll-' 开头, taskId 直接拼后面 (TradingAgents 已保证全局唯一).
 */
export const AI_POLLING_JOB_ID_PREFIX = 'ai-poll-';

/**
 * 默认 attempts/backoff/retention. 4 处 caller 之前各写一遍.
 * removeOnComplete 1000 / removeOnFail 500 与 BETA-3 实测值一致 — 不要在 helper 里
 * 加 env override (那会让 caller-side ops 调整失去显式语义). caller 想 override
 * 用 buildAIPollingJobOptions(taskId, { attempts: 5 }) 局部覆盖即可.
 */
export const DEFAULT_AI_POLLING_ATTEMPTS = 10;
export const DEFAULT_AI_POLLING_BACKOFF_DELAY_MS = 3 * 60 * 1000;
export const DEFAULT_AI_POLLING_REMOVE_ON_COMPLETE_COUNT = 1000;
export const DEFAULT_AI_POLLING_REMOVE_ON_FAIL_COUNT = 500;

export type AIPollingEnqueueSource =
  | 'quant_recommendation_controller'
  | 'automated_recommendation_loop'
  | 'scheduler_service'
  | 'quant_fusion_service'
  | 'unknown';

export interface BuildAIPollingJobOptionsInput {
  taskId: string;
  /** 测试 / 极少数 ops 场景需要覆盖默认值, 普通调用方不要传 */
  override?: Partial<
    Pick<JobOptions, 'attempts' | 'backoff' | 'removeOnComplete' | 'removeOnFail' | 'jobId'>
  >;
}

/**
 * 纯函数 — 构造 Bull add 选项. taskId 缺失 / 非 string / 空串都返 null
 * 让 caller 立刻知道 "没法 dedup" (不要静默 fallback 到自动生成 jobId,
 * 那会让 dedup 失效但 caller 完全无感).
 */
export function buildAIPollingJobOptions(input: BuildAIPollingJobOptionsInput): JobOptions | null {
  const rawTaskId = input?.taskId;
  if (typeof rawTaskId !== 'string') return null;
  const trimmed = rawTaskId.trim();
  if (trimmed.length === 0) return null;

  const opts: JobOptions = {
    jobId: `${AI_POLLING_JOB_ID_PREFIX}${trimmed}`,
    attempts: DEFAULT_AI_POLLING_ATTEMPTS,
    backoff: { type: 'fixed', delay: DEFAULT_AI_POLLING_BACKOFF_DELAY_MS },
    removeOnComplete: { count: DEFAULT_AI_POLLING_REMOVE_ON_COMPLETE_COUNT },
    removeOnFail: { count: DEFAULT_AI_POLLING_REMOVE_ON_FAIL_COUNT },
  };

  if (input.override) {
    if (input.override.jobId !== undefined) opts.jobId = input.override.jobId;
    if (input.override.attempts !== undefined) opts.attempts = input.override.attempts;
    if (input.override.backoff !== undefined) opts.backoff = input.override.backoff;
    if (input.override.removeOnComplete !== undefined) {
      opts.removeOnComplete = input.override.removeOnComplete;
    }
    if (input.override.removeOnFail !== undefined) {
      opts.removeOnFail = input.override.removeOnFail;
    }
  }

  return opts;
}

/**
 * DI seam — 让 unit test 不依赖真 Redis / 真 Bull queue.
 */
export interface AIPollingEnqueueDataSource {
  add: (
    data: AIPollingJobData,
    opts: JobOptions
  ) => Promise<{ id: string | number; isNew?: boolean }>;
}

/**
 * 生产 DataSource — lazy require 真 aiPollingQueue 单例, 与 US-018 同模式.
 */
export function createProductionAIPollingEnqueueDataSource(): AIPollingEnqueueDataSource {
  return {
    add: async (data, opts) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { aiPollingQueue } = require('./aiPollingQueue') as {
        aiPollingQueue: Queue<AIPollingJobData>;
      };
      const job = await aiPollingQueue.add(data, opts);
      return { id: job.id };
    },
  };
}

export interface EnqueueAIPollingJobInput {
  data: AIPollingJobData;
  source: AIPollingEnqueueSource;
  /** 覆盖默认 attempts / retention; 普通 caller 留空 */
  override?: BuildAIPollingJobOptionsInput['override'];
}

export interface EnqueueAIPollingJobResult {
  ok: boolean;
  /** Bull 返的 jobId (重复入队时与首次相同) */
  jobId?: string;
  /** taskId 非法时 ok=false */
  reason?: 'invalid_task_id' | 'queue_add_failed';
  error?: unknown;
}

/**
 * 主入口 — 统一调用方
 *
 * 行为契约:
 *  - taskId 非法 → 不调 queue, 返 {ok:false, reason:'invalid_task_id'} (caller 自己 log + fallback)
 *  - queue.add 抛错 → 兜底 {ok:false, reason:'queue_add_failed', error}; caller 决定是否继续
 *  - 重复入队 (Bull dedup) → 返 {ok:true, jobId: existing jobId} 与首次完全一致 (caller 视角无副作用)
 *
 * 不在 helper 里 swallow error — caller 视下游策略决定 throw / log / skip;
 * 但 helper 自身永不 throw, 不让队列层抖动直接打挂 cron / API.
 */
export async function enqueueAIPollingJob(
  source: AIPollingEnqueueDataSource,
  input: EnqueueAIPollingJobInput
): Promise<EnqueueAIPollingJobResult> {
  const opts = buildAIPollingJobOptions({
    taskId: input.data?.taskId,
    override: input.override,
  });
  if (!opts) {
    return { ok: false, reason: 'invalid_task_id' };
  }
  try {
    const job = await source.add(input.data, opts);
    return { ok: true, jobId: String(job.id) };
  } catch (err) {
    return { ok: false, reason: 'queue_add_failed', error: err };
  }
}
