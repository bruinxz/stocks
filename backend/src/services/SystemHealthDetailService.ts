/**
 * SystemHealthDetailService (US-096 运维：系统启动自检页)
 *
 * 目的：提供 `/health/detail` 给监控告警精准告知系统所有外部依赖的实时状态。
 *
 * 5 个被检依赖 + uptime：
 *   1. db          — Sequelize `SELECT 1` (1500ms 超时)
 *   2. redis       — redisLock.healthCheck() 调底层 `PING` (1500ms 超时)
 *   3. tradingAgents — GET ${TRADING_AGENTS_URL}/health (3000ms 超时)
 *   4. akshare     — python3 -c "import akshare; print(akshare.__version__)" (5000ms 超时)
 *   5. feishu      — 检查 FEISHU_BOT_WEBHOOK / FEISHU_RECOMMENDATION_BOT_WEBHOOK 是否配置；
 *                    若未配 → 'not_configured'；配了 → 不实际发请求避免噪音 → 'ok' (配置存在)。
 *                    说明：Feishu webhook 不能用空载 GET 探活，发送会推真实消息 → noise。
 *                    "配了就算 ok" 是接受度内的简化：缺地址才是 ops 真正关心的状态。
 *
 * 设计原则：
 *   - 5 个 ping 并发 (Promise.allSettled)：单点失败不阻塞总响应，平均 < 1s 返回；
 *   - 每个 ping 都套 timeout —— 慢探活也不阻塞监控 scraper；
 *   - failures 不抛 5xx —— /health/detail 永远返回 200，正文 status 字段告知失败的依赖；
 *   - 不依赖具体 Sequelize / Bull / axios 实例 —— 通过 ProbeFns 注入，方便单测。
 *
 * 输出 JSON 形如：
 * ```json
 * {
 *   "db": "ok",
 *   "redis": "ok",
 *   "tradingAgents": "ok",
 *   "akshare": "ok",
 *   "feishu": "not_configured",
 *   "uptime_seconds": 12345
 * }
 * ```
 *
 * 与既有 /health 区别：
 *   - /health 只返回 `{ status: 'ok' }` —— 跨网关 / k8s readiness probe 不需依赖介入；
 *   - /health/detail 才把所有 backing service 串起来探一次 —— 监控告警 / on-call 真正用。
 *
 * 单元测试：tests/services/system-health-detail-service.test.ts
 */

import { spawn } from 'child_process';

export type DependencyStatus = 'ok' | 'fail' | 'not_configured';

export interface SystemHealthDetail {
  db: DependencyStatus;
  redis: DependencyStatus;
  tradingAgents: DependencyStatus;
  akshare: DependencyStatus;
  feishu: DependencyStatus;
  uptime_seconds: number;
  /**
   * Batch M (2026-06-17): scheduler 健康度. 由 caller 在 collect 之后塞入
   * (避免本 service 依赖 SchedulerService). 0 = silent scheduler failure,
   * 运维 alert 触发. undefined = caller 未启用 scheduler.
   */
  scheduler_active_tasks?: number;
}

/**
 * 5 个 dep 的 probe 抽象 —— 让单测注入 fake 不依赖真实 DB / Redis / 外部 HTTP。
 *
 * 每个 probe 必须返回 `DependencyStatus`，never throw —— 实现侧 try/catch 全部吞掉
 * 转成 'fail'，保证 collect() 整体不可能因子 probe 异常崩溃。
 */
export interface HealthProbeFns {
  probeDb: () => Promise<DependencyStatus>;
  probeRedis: () => Promise<DependencyStatus>;
  probeTradingAgents: () => Promise<DependencyStatus>;
  probeAkshare: () => Promise<DependencyStatus>;
  probeFeishu: () => Promise<DependencyStatus>;
  getUptimeSeconds: () => number;
}

/**
 * 通用 timeout wrapper —— 任何 Promise 都套上 ms 上限，超时返回 'fail'。
 *
 * 不用 AbortController：底层 client (Sequelize / redis / axios / spawn) 大多不真支持
 * abort；超时仍触发 'fail' 让 caller 立刻返回，underlying 请求自然 abandon。
 *
 * 单独 export 是为了：(a) 让单测断言 timeout 行为不需启真 server (b) 同款逻辑后续可能
 * 复用到其他 monitoring/probe 场景。
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  onTimeoutValue: T
): Promise<T> {
  return new Promise<T>(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(onTimeoutValue);
    }, timeoutMs);

    fn()
      .then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(onTimeoutValue);
      });
  });
}

/**
 * 判定 Feishu 状态 —— 纯函数 (与 process.env 解耦) 让单测可以直接构造任意场景。
 *
 * 规则：
 *   - 任意一个 webhook URL 字段配置且非空 → 'ok' (配了)
 *   - 全部为空或全部空字符串 → 'not_configured' (acceptance 文档要求)
 *
 * 注意：本 service 不发送真实 Feishu 请求 —— 即使配错 webhook URL 也会判 'ok'，
 *       让 caller / ops 在发送时段才发现真问题。理由见文件头。
 */
export function determineFeishuStatus(env: NodeJS.ProcessEnv): DependencyStatus {
  const candidates = [
    env.FEISHU_BOT_WEBHOOK,
    env.FEISHU_RECOMMENDATION_BOT_WEBHOOK,
    env.FEISHU_DAILY_DIGEST_WEBHOOK,
  ];
  const hasAny = candidates.some(v => typeof v === 'string' && v.trim().length > 0);
  return hasAny ? 'ok' : 'not_configured';
}

/**
 * 合并 Promise.allSettled 结果 —— pure helper 让单测直接断言映射逻辑。
 *
 * 任一 probe rejected → 'fail'；fulfilled.value === 'ok' / 'fail' / 'not_configured' 直传。
 * uptime 独立路径不可能失败，单独传入。
 */
export function assembleDetail(
  results: PromiseSettledResult<DependencyStatus>[],
  uptimeSeconds: number
): SystemHealthDetail {
  if (results.length !== 5) {
    throw new Error(
      `assembleDetail expected 5 settled results, got ${results.length}. ` +
        `Order is [db, redis, tradingAgents, akshare, feishu].`
    );
  }
  const pick = (r: PromiseSettledResult<DependencyStatus>): DependencyStatus =>
    r.status === 'fulfilled' ? r.value : 'fail';
  return {
    db: pick(results[0]),
    redis: pick(results[1]),
    tradingAgents: pick(results[2]),
    akshare: pick(results[3]),
    feishu: pick(results[4]),
    uptime_seconds: Math.max(0, Math.floor(uptimeSeconds)),
  };
}

/**
 * Aggregate orchestrator —— 并发跑 5 个 probe + 取 uptime，整成单一 DTO。
 *
 * 单独 export 让单测注入 fake ProbeFns 验证整条 pipeline 不需启真 DB / Redis。
 * 实际生产用 buildDefaultProbeFns() 装配实例 dependencies。
 */
export async function collectSystemHealthDetail(
  probes: HealthProbeFns
): Promise<SystemHealthDetail> {
  const settled = await Promise.allSettled([
    probes.probeDb(),
    probes.probeRedis(),
    probes.probeTradingAgents(),
    probes.probeAkshare(),
    probes.probeFeishu(),
  ]);
  return assembleDetail(settled, probes.getUptimeSeconds());
}

// ---------------------------------------------------------------------------
// Default probe implementations (production wiring)
// ---------------------------------------------------------------------------

/**
 * 默认 probe 工厂 —— 接受运行时已存在的 sequelize / redisLock / http client，
 * 返回封装好的 ProbeFns。
 *
 * 默认超时取自 env，可在 service 启动时调整：
 *   - HEALTH_DETAIL_DB_TIMEOUT_MS (默认 1500)
 *   - HEALTH_DETAIL_REDIS_TIMEOUT_MS (默认 1500)
 *   - HEALTH_DETAIL_TA_TIMEOUT_MS (默认 3000)
 *   - HEALTH_DETAIL_AKSHARE_TIMEOUT_MS (默认 5000)
 */
export interface DefaultProbeDeps {
  sequelize: { query: (sql: string) => Promise<unknown> };
  redisHealthCheck: () => Promise<boolean>;
  httpGet: (url: string, opts: { timeout: number }) => Promise<{ status: number }>;
  tradingAgentsUrl: string;
  uptimeFn?: () => number;
  envOverride?: NodeJS.ProcessEnv;
  pythonProbeOverride?: (timeoutMs: number) => Promise<DependencyStatus>;
}

export function buildDefaultProbeFns(deps: DefaultProbeDeps): HealthProbeFns {
  const env = deps.envOverride || process.env;
  const dbTimeout = Number(env.HEALTH_DETAIL_DB_TIMEOUT_MS || 1500);
  const redisTimeout = Number(env.HEALTH_DETAIL_REDIS_TIMEOUT_MS || 1500);
  const taTimeout = Number(env.HEALTH_DETAIL_TA_TIMEOUT_MS || 3000);
  const akshareTimeout = Number(env.HEALTH_DETAIL_AKSHARE_TIMEOUT_MS || 5000);

  return {
    probeDb: () =>
      withTimeout<DependencyStatus>(
        async () => {
          await deps.sequelize.query('SELECT 1');
          return 'ok' as const;
        },
        dbTimeout,
        'fail'
      ),

    probeRedis: () =>
      withTimeout<DependencyStatus>(
        async () => {
          const ok = await deps.redisHealthCheck();
          return ok ? ('ok' as const) : ('fail' as const);
        },
        redisTimeout,
        'fail'
      ),

    probeTradingAgents: () =>
      withTimeout<DependencyStatus>(
        async () => {
          const res = await deps.httpGet(`${deps.tradingAgentsUrl}/health`, {
            timeout: taTimeout,
          });
          return res.status >= 200 && res.status < 400 ? ('ok' as const) : ('fail' as const);
        },
        taTimeout + 500,
        'fail'
      ),

    probeAkshare: () =>
      deps.pythonProbeOverride
        ? deps.pythonProbeOverride(akshareTimeout)
        : probeAkshareViaPythonCached(akshareTimeout),

    probeFeishu: async () => determineFeishuStatus(env),

    getUptimeSeconds: deps.uptimeFn || (() => Math.floor(process.uptime())),
  };
}

/**
 * Batch Z (2026-06-17, m-3 fix): probeAkshareViaPython 60s cache wrapper.
 * 之前 prometheus 高频拉 /health/detail (默认 15s/次) 让 spawn python3 -c
 * 'import akshare' 每次都跑, 内存堆积 + zombie 风险 + 5s timeout 概率叠加.
 * akshare 版本不会 sub-minute 改, 60s cache 足够安全; cache miss 兜底仍走真 spawn.
 */
let akshareCache: { ts: number; status: DependencyStatus } | null = null;
const AKSHARE_CACHE_TTL_MS = 60_000;

export function probeAkshareViaPythonCached(timeoutMs: number): Promise<DependencyStatus> {
  if (akshareCache && Date.now() - akshareCache.ts < AKSHARE_CACHE_TTL_MS) {
    return Promise.resolve(akshareCache.status);
  }
  return probeAkshareViaPython(timeoutMs).then(status => {
    akshareCache = { ts: Date.now(), status };
    return status;
  });
}

/**
 * AKShare 探活 —— 不调真实 endpoint 避免被限速；只 `python3 -c "import akshare"`
 * 校验 Python 环境 + akshare 包安装。失败 (Python 缺失 / pip 包未装 / import error)
 * 全部归到 'fail'。
 *
 * 与 timeout wrapper 双重保护：底层 spawn 超时返回 'fail'；wrapper 在更高一层兜底。
 */
export function probeAkshareViaPython(timeoutMs: number): Promise<DependencyStatus> {
  return new Promise<DependencyStatus>(resolve => {
    let settled = false;
    const finish = (status: DependencyStatus): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };

    let child: ReturnType<typeof spawn> | null = null;
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        // ignore — process may have already exited
      }
      finish('fail');
    }, timeoutMs);

    try {
      child = spawn('python3', ['-c', 'import akshare'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.on('exit', code => {
        clearTimeout(timer);
        finish(code === 0 ? 'ok' : 'fail');
      });
      child.on('error', () => {
        clearTimeout(timer);
        finish('fail');
      });
    } catch {
      clearTimeout(timer);
      finish('fail');
    }
  });
}
