/**
 * autopilotIdempotency.ts — US-108 [EX-008] runShadowAutopilot 幂等
 *
 * 统一的 autopilot 任务幂等 helper. BETA-4 已经在 LiveTradingService.markDraftShadowExecuted
 * 用 transaction + SELECT FOR UPDATE 把"单条草稿不可被重复 shadow_executed" 这一层
 * 锁死了 (DB 层强幂等); 本 helper 则是把"同一窗口内重复触发 autopilot 入口" 这一层
 * 在 in-memory 层去重 + 短期缓存返回, 适用于所有 autopilot-style 周期任务
 * (runShadowAutopilot / future runSignalAutopilot / runRiskAutopilot 等).
 *
 * 设计要点 (与 CLAUDE.md 多通道 dispatcher 模板对齐):
 *   1. 纯函数 / 单例 store (DB-less 单测可直接构造新实例);
 *   2. 双层去重:
 *        - in-flight: 同 key 第二个 caller share 第一个的 Promise — 0 重复执行;
 *        - completed cache: TTL 内同 key 直接返 cached result + reused=true 标记;
 *   3. 任何 throw 同时清 in-flight 注册 (不污染下次重试);
 *   4. clock 注入: 单测可控时间 (默认 Date.now);
 *   5. listInflight / listCached / clear: 调试 / 测试用窗口;
 *   6. fail-open: 这里只做幂等装饰, 不引入任何 DB / Redis 强依赖 (production 进程内
 *      去重已经覆盖 cron tick overlap + manual API 重连两大主场景; 跨进程靠 BETA-4
 *      的 DB transaction 兜底).
 *
 * 用法 (LiveTradingService.runShadowAutopilot 已 wire-in):
 *   const guard = getDefaultAutopilotIdempotencyStore();
 *   return await guard.run(
 *     { task: 'shadow_autopilot', user_id, source, window: dailyWindow(today) },
 *     { ttl_ms: 30_000 },
 *     async () => doActualWork(),
 *   );
 *
 * 测试:
 *   cd backend && npx ts-node --transpile-only tests/live-trading/autopilot-idempotency.test.ts
 */

import { logger } from './logger';

export type AutopilotIdempotencyKey =
  | string
  | {
      /** 任务标识 (e.g. 'shadow_autopilot') */
      task: string;
      /** 用户 / 账户 / 任意业务 scope */
      user_id?: number | string;
      /** 触发源 (e.g. 'scheduled_open_shadow_autopilot' / 'manual_shadow_autopilot') */
      source?: string;
      /** 时间窗口 (e.g. '2026-06-20' / '2026-06-20T09:58') 用来区分"同日内不同 tick" */
      window?: string;
      /** 任意额外维度 */
      extra?: Record<string, string | number | boolean | null | undefined>;
    };

export interface AutopilotIdempotencyOptions {
  /** 已完成结果缓存时长 (ms); 0 = 不缓存 (仅 in-flight 去重) */
  ttl_ms?: number;
  /** 缓存命中时是否把 reused=true 注入结果 (默认 true) */
  mark_reused?: boolean;
  /** 注入 reused 标记的 key 名 (默认 'reused_from_idempotency') */
  reused_key?: string;
  /** 自定义 logger 前缀 */
  log_prefix?: string;
}

export interface AutopilotIdempotencyRunResult<T> {
  result: T;
  /** 'fresh' = 真跑了; 'inflight_join' = join 了正在跑的 promise; 'cached' = 命中缓存 */
  source: 'fresh' | 'inflight_join' | 'cached';
  key: string;
}

interface CacheEntry {
  result: any;
  expires_at: number;
  finished_at: number;
}

/**
 * 把 AutopilotIdempotencyKey 规范成稳定字符串 (单测 + log 友好).
 * 纯函数 — export 出去给单测直接 assert.
 */
export function buildIdempotencyKey(input: AutopilotIdempotencyKey): string {
  if (typeof input === 'string') {
    return input.trim() || 'unknown';
  }
  const parts: string[] = [];
  parts.push(`task=${input.task || 'unknown'}`);
  if (input.user_id !== undefined && input.user_id !== null) {
    parts.push(`user=${String(input.user_id)}`);
  }
  if (input.source) parts.push(`source=${input.source}`);
  if (input.window) parts.push(`window=${input.window}`);
  if (input.extra && typeof input.extra === 'object') {
    const extraKeys = Object.keys(input.extra)
      .filter(k => input.extra![k] !== undefined && input.extra![k] !== null)
      .sort();
    for (const k of extraKeys) {
      parts.push(`${k}=${String(input.extra![k])}`);
    }
  }
  return parts.join('|');
}

/**
 * 把"今天 (Asia/Shanghai 日历日)" 转成 window 字符串. 用于 autopilot 天级幂等.
 * 单测可注入固定时间 (clock).
 */
export function dailyWindow(now: Date | number = Date.now()): string {
  const ts = typeof now === 'number' ? now : now.getTime();
  // 简单 +8h 偏移到北京时间日历日, 不依赖 moment-timezone (utils 是 leaf).
  const beijing = new Date(ts + 8 * 60 * 60 * 1000);
  return beijing.toISOString().slice(0, 10);
}

/**
 * Autopilot 幂等 store 主体. 进程内单例; 跨进程不共享 — 跨进程幂等靠下游 DB
 * (LiveTradingService.markDraftShadowExecuted 的 SELECT FOR UPDATE) 兜底.
 */
export class AutopilotIdempotencyStore {
  private inflight: Map<string, Promise<any>> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now || (() => Date.now());
  }

  /**
   * 主入口. 包装 worker:
   *   - 缓存命中 → 直接返 cached;
   *   - in-flight 命中 → join 现有 promise;
   *   - 都未命中 → 注册 in-flight, 跑 worker, 写缓存.
   */
  async run<T>(
    key: AutopilotIdempotencyKey,
    options: AutopilotIdempotencyOptions = {},
    worker: () => Promise<T>
  ): Promise<AutopilotIdempotencyRunResult<T>> {
    const k = buildIdempotencyKey(key);
    const ttl = Math.max(0, Number(options.ttl_ms || 0));
    const markReused = options.mark_reused !== false;
    const reusedKey = options.reused_key || 'reused_from_idempotency';
    const logPrefix = options.log_prefix || '[autopilot-idem]';

    // 1) 缓存命中
    const cached = this.peekCache(k);
    if (cached) {
      logger.info(`${logPrefix} cache hit key=${k} age_ms=${this.now() - cached.finished_at}`);
      const result =
        markReused && cached.result && typeof cached.result === 'object'
          ? { ...cached.result, [reusedKey]: true }
          : cached.result;
      return { result, source: 'cached', key: k };
    }

    // 2) in-flight 命中: join 现有 promise (避免并发重跑)
    const existing = this.inflight.get(k);
    if (existing) {
      logger.info(`${logPrefix} inflight join key=${k}`);
      const result = await existing;
      const finalResult =
        markReused && result && typeof result === 'object'
          ? { ...result, [reusedKey]: true }
          : result;
      return { result: finalResult, source: 'inflight_join', key: k };
    }

    // 3) 真跑
    const promise = (async () => {
      try {
        const value = await worker();
        if (ttl > 0) {
          this.cache.set(k, {
            result: value,
            finished_at: this.now(),
            expires_at: this.now() + ttl,
          });
        }
        return value;
      } finally {
        // 不论成功失败, in-flight 都要清掉, 让下次重试能重新进真跑路径.
        this.inflight.delete(k);
      }
    })();
    this.inflight.set(k, promise);

    const result = await promise;
    return { result, source: 'fresh', key: k };
  }

  /** 取一个 cache entry; 过期则自动 evict 并返 null. */
  peekCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expires_at <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  /** 调试: 当前 in-flight key 列表 */
  listInflight(): string[] {
    return [...this.inflight.keys()];
  }

  /** 调试: 当前未过期 cache key 列表 (顺带 evict 已过期) */
  listCached(): string[] {
    const out: string[] = [];
    for (const k of [...this.cache.keys()]) {
      if (this.peekCache(k)) out.push(k);
    }
    return out;
  }

  /** 清空 (单测 isolation 用) */
  clear(): void {
    this.inflight.clear();
    this.cache.clear();
  }
}

let defaultStore: AutopilotIdempotencyStore | null = null;
export function getDefaultAutopilotIdempotencyStore(): AutopilotIdempotencyStore {
  if (!defaultStore) defaultStore = new AutopilotIdempotencyStore();
  return defaultStore;
}

/** 单测 only: 替换默认 store (注入 fake clock 等). */
export function __setDefaultAutopilotIdempotencyStoreForTests(
  store: AutopilotIdempotencyStore | null
): void {
  defaultStore = store;
}
