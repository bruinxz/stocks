/**
 * PrometheusRegistry.ts — US-072 运维：Prometheus 指标埋点
 *
 * 设计要点：
 *  1. **单例 Registry** —— 整个进程一份 `prom-client.Registry`，避免不同模块各自
 *     注册同名 metric 导致 `Error: A metric with the name X has already been registered`。
 *     默认 metrics（process_cpu / heap / event_loop_lag）也注入到同一个 registry 中
 *     方便 Grafana 同时看应用 + 进程级指标。
 *
 *  2. **4 个 AC 指定的核心 metric** (其余可后续按需扩展)：
 *     - `http_requests_total{method, route, status}` Counter —— 每个 HTTP 请求计数
 *     - `backtest_total{strategy?, result}` Counter —— 回测任务完成数 (result=success/failed)
 *     - `ai_request_duration_seconds{provider, endpoint, status}` Histogram —— AI 调用耗时
 *     - `order_total{direction, status, code?}` Counter —— 模拟交易下单数
 *
 *  3. **Express middleware `httpMetricsMiddleware`** —— 在所有路由之前安装，
 *     `res.on('finish')` 时记录 method / route / status。
 *     **route label** 使用 `req.route?.path || req.baseUrl || req.path`：
 *     - 已匹配到 router 时 `req.route.path` 是模板（`/portfolio/:id`），cardinality 受控
 *     - 没匹配上时（404）退化到 baseUrl 或 path，仍然 cardinality 受控（404 流量通常很少）
 *     - **绝不要直接用 `req.originalUrl`** —— 含 user_id / symbol 等高基数参数，
 *       Prometheus 标签会爆炸（每个唯一 URL 一个时间序列）
 *
 *  4. **`getMetricsContent()`** 返回 promise<string>，配合 `getMetricsContentType()`
 *     在 `/metrics` endpoint 暴露给 Prometheus 抓取。**绝不应做 auth**（Prometheus 抓取
 *     端通常是内网未鉴权的）—— 真正的访问控制由 reverse proxy / 网络层做。
 *
 *  5. **辅助函数 `incrementBacktestTotal` / `observeAIRequestDuration` / `incrementOrderTotal`**
 *     给业务代码使用，目的是把"如何打 metric"封装在 metrics 模块内 —— 业务代码
 *     只需要 import 一个语义化函数，不应直接接触 prom-client 的 `Counter.inc()` API。
 *     新增业务事件时优先在本文件加 helper，再被业务方调用。
 *
 *  6. **测试友好** —— 暴露 `resetMetrics()` 让单测之间互相隔离；测试不 import singleton
 *     而是通过 `createPrometheusRegistry()` factory 单独构造 fresh registry 验证语义。
 */

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { NextFunction, Request, Response } from 'express';

// ---------------------------------------------------------------------------
//  Metric label name unions — TypeScript 强类型，防 typo
// ---------------------------------------------------------------------------

export type HttpRequestLabel = 'method' | 'route' | 'status';
export type BacktestLabel = 'strategy' | 'result';
export type AIRequestLabel = 'provider' | 'endpoint' | 'status';
export type OrderLabel = 'direction' | 'status' | 'code';
/** audit S-1 修复: 回测产生的 trade 数 — 区分组合级策略 trade_count=0 退化与正常运行 */
export type BacktestTradeCountLabel = 'strategy_key';
/**
 * US-004 [OPS-004] 调度任务可观测: task_type=CRON_REGISTRY 的 type 字段, status=success/failed/skipped.
 * 不含 task name / task id —— cardinality 受控 (54 个 cron type × 3 status = 162 series, 远低于
 * Prometheus per-job 10k 红线).
 */
export type SchedulerTaskLabel = 'task_type' | 'status';

/**
 * US-017 [EX-003] Reconciliation 看板维度。
 *
 * - `user_id`: 多账户独立曲线（典型 ≤ 50 用户，远低于 cardinality 红线）。
 *   绝不要加 `account_id` / `symbol` —— 会让 Grafana per-user 曲线无法叠加。
 * - `side`: 'live_only' | 'paper_only' | 'live_overweight' | 'live_underweight'.
 * - `severity`: 'HIGH' | 'MEDIUM' | 'NONE' （NONE 也记 0 让 Grafana 看健康曲线）。
 * - `window`: 'intraday' | 'eod'.
 */
export type ReconciliationGaugeLabel = 'user_id';
export type ReconciliationDriftLabel = 'user_id' | 'side';
export type ReconciliationAlertLabel = 'severity' | 'window';

export interface PrometheusMetricsBundle {
  registry: Registry;
  httpRequestsTotal: Counter<HttpRequestLabel>;
  backtestTotal: Counter<BacktestLabel>;
  aiRequestDurationSeconds: Histogram<AIRequestLabel>;
  orderTotal: Counter<OrderLabel>;
  /** audit S-1 修复: 单次回测累计 trade 笔数（按策略 key 分） */
  backtestTradeCountTotal: Counter<BacktestTradeCountLabel>;
  /** US-004: 调度任务执行计数（按 task_type + status 分） */
  schedulerTaskRunsTotal: Counter<SchedulerTaskLabel>;
  /** US-004: 调度任务执行耗时（秒） */
  schedulerTaskDurationSeconds: Histogram<SchedulerTaskLabel>;
  /** US-017 [EX-003]: 实盘/模拟对账 alignment_score（0-100；null/未绑定不记） */
  reconciliationAlignmentScore: Gauge<ReconciliationGaugeLabel>;
  /** US-017 [EX-003]: 对账漂移持仓数（按 side 分；每次评估覆盖写入） */
  reconciliationDriftPositions: Gauge<ReconciliationDriftLabel>;
  /** US-017 [EX-003]: 对账快照过期分钟数（snapshot_age_minutes；null 不记） */
  reconciliationSnapshotAgeMinutes: Gauge<ReconciliationGaugeLabel>;
  /** US-017 [EX-003]: 实际写出的 ReconciliationAlert 累计数（按 severity + window 分） */
  reconciliationAlertsTotal: Counter<ReconciliationAlertLabel>;
}

// ---------------------------------------------------------------------------
//  Factory — used by tests for fresh registry; production uses singleton below
// ---------------------------------------------------------------------------

/**
 * 构造一组新的 Prometheus metrics，**不会**自动注册 default metrics（CPU / heap 等）。
 * 测试场景下让单测之间互相隔离；生产 singleton 通过 `getPrometheusBundle()` 拿到。
 *
 * `enableDefaultMetrics=true` 时启用 process_cpu / heap / event_loop_lag 等内置指标。
 */
export function createPrometheusRegistry(
  opts: { enableDefaultMetrics?: boolean } = {}
): PrometheusMetricsBundle {
  const registry = new Registry();

  if (opts.enableDefaultMetrics) {
    collectDefaultMetrics({ register: registry });
  }

  const httpRequestsTotal = new Counter<HttpRequestLabel>({
    name: 'http_requests_total',
    help: 'HTTP 请求总数（按 method / route / status 分组）',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const backtestTotal = new Counter<BacktestLabel>({
    name: 'backtest_total',
    help: '完成的回测任务总数（按策略名 + 结果 success/failed 分组）',
    labelNames: ['strategy', 'result'],
    registers: [registry],
  });

  const aiRequestDurationSeconds = new Histogram<AIRequestLabel>({
    name: 'ai_request_duration_seconds',
    help: 'AI 服务调用耗时分布（秒）',
    labelNames: ['provider', 'endpoint', 'status'],
    // buckets 覆盖 50ms ~ 30s：AI 远程分析典型 5~20s，5s 是常见 SLA 边界
    buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 20, 30],
    registers: [registry],
  });

  const orderTotal = new Counter<OrderLabel>({
    name: 'order_total',
    help: '模拟交易下单事件总数（按方向 + 状态 + 错误码分组）',
    labelNames: ['direction', 'status', 'code'],
    registers: [registry],
  });

  const backtestTradeCountTotal = new Counter<BacktestTradeCountLabel>({
    name: 'backtest_trade_count_total',
    help: '回测累计成交笔数（按策略 key 分组；audit S-1 修复 — 用于发现组合级策略 trade_count=0 退化）',
    labelNames: ['strategy_key'],
    registers: [registry],
  });

  // US-004 [OPS-004]: scheduler 域 — 54 个 cron type 的执行计数 / 耗时.
  // 命名遵循 `<domain>_<verb>_<unit>` 约定:
  //   scheduler_task_runs_total       (domain=scheduler, verb=runs, unit=total → counter)
  //   scheduler_task_duration_seconds (domain=scheduler, verb=duration, unit=seconds → histogram)
  const schedulerTaskRunsTotal = new Counter<SchedulerTaskLabel>({
    name: 'scheduler_task_runs_total',
    help: '调度任务执行次数（按 task_type + status=success/failed/skipped 分组）',
    labelNames: ['task_type', 'status'],
    registers: [registry],
  });

  const schedulerTaskDurationSeconds = new Histogram<SchedulerTaskLabel>({
    name: 'scheduler_task_duration_seconds',
    help: '调度任务执行耗时分布（秒；按 task_type + status 分组）',
    labelNames: ['task_type', 'status'],
    // buckets 覆盖 100ms ~ 600s：DAILY_UPDATE / SYNC_HISTORY 等批量任务典型 30s~5min
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600],
    registers: [registry],
  });

  // US-017 [EX-003]: reconciliation 域 — 对账主动监控的看板数据源.
  // 命名约定 `<domain>_<verb>_<unit>` (reconciliation / alignment_score / 无量纲 → gauge,
  // reconciliation / drift_positions / 无量纲 → gauge,
  // reconciliation / snapshot_age_minutes → gauge,
  // reconciliation / alerts / total → counter).
  // 与既有 ReconciliationAlertService 阈值对偶: <70 HIGH, [70,85) MEDIUM.
  const reconciliationAlignmentScore = new Gauge<ReconciliationGaugeLabel>({
    name: 'reconciliation_alignment_score',
    help: '实盘/模拟对账 alignment_score（0-100；按 user_id；ReconciliationAlertService 每跑一次覆盖写）',
    labelNames: ['user_id'],
    registers: [registry],
  });

  const reconciliationDriftPositions = new Gauge<ReconciliationDriftLabel>({
    name: 'reconciliation_drift_positions',
    help: '对账漂移持仓数（按 user_id + side ∈ {live_only,paper_only,live_overweight,live_underweight}）',
    labelNames: ['user_id', 'side'],
    registers: [registry],
  });

  const reconciliationSnapshotAgeMinutes = new Gauge<ReconciliationGaugeLabel>({
    name: 'reconciliation_snapshot_age_minutes',
    help: '对账快照过期分钟数（snapshot_age_minutes；按 user_id；>stale_threshold 触发 HIGH 告警）',
    labelNames: ['user_id'],
    registers: [registry],
  });

  const reconciliationAlertsTotal = new Counter<ReconciliationAlertLabel>({
    name: 'reconciliation_alerts_total',
    help: '实际写出的 ReconciliationAlert 累计数（按 severity=HIGH/MEDIUM/NONE + window=intraday/eod 分组；NONE 用于校验"健康跑过")',
    labelNames: ['severity', 'window'],
    registers: [registry],
  });

  return {
    registry,
    httpRequestsTotal,
    backtestTotal,
    aiRequestDurationSeconds,
    orderTotal,
    backtestTradeCountTotal,
    schedulerTaskRunsTotal,
    schedulerTaskDurationSeconds,
    reconciliationAlignmentScore,
    reconciliationDriftPositions,
    reconciliationSnapshotAgeMinutes,
    reconciliationAlertsTotal,
  };
}

// ---------------------------------------------------------------------------
//  Singleton — initialized lazily on first access
// ---------------------------------------------------------------------------

let _bundle: PrometheusMetricsBundle | null = null;

export function getPrometheusBundle(): PrometheusMetricsBundle {
  if (!_bundle) {
    _bundle = createPrometheusRegistry({ enableDefaultMetrics: true });
  }
  return _bundle;
}

/**
 * 重置整个 singleton（测试用；生产代码不应调用）。
 */
export function __resetPrometheusBundleForTests(): void {
  _bundle = null;
}

// ---------------------------------------------------------------------------
//  Pure helpers — exported for test coverage
// ---------------------------------------------------------------------------

/**
 * 把 HTTP status code 归一化为 label-friendly 字符串。
 * - 数字 → 字符串
 * - 非数字 / 0 / NaN → 'unknown'
 *
 * 不做 `2xx` 分桶 —— 保留精确 status 让 Grafana 自行 PromQL `floor(status/100)` 分组。
 */
export function normalizeStatusLabel(statusCode: unknown): string {
  if (typeof statusCode !== 'number' || !Number.isFinite(statusCode) || statusCode <= 0) {
    return 'unknown';
  }
  return String(statusCode);
}

/**
 * 取请求的 route label。优先级：
 *   1. req.route?.path（匹配到路由后是模板，如 `/portfolio/:id`）+ baseUrl 前缀
 *   2. req.baseUrl（仅匹配到挂载路径，没匹配到具体 endpoint）
 *   3. 'unmatched'（兜底；通常 404）
 *
 * **绝不**使用 req.originalUrl / req.url —— 含 query string + 具体参数，会让 label
 * cardinality 爆炸（每个 user_id / stock_code 一个时间序列）。
 *
 * baseUrl + route.path 拼接示例：
 *   app.use('/api/portfolio', portfolioRoutes); router.get('/:id', ...);
 *   匹配到 GET /api/portfolio/42 时 → baseUrl='/api/portfolio', route.path='/:id'
 *   → 'GET /api/portfolio/:id' （正确的低 cardinality 模板）
 */
export function resolveRouteLabel(req: Pick<Request, 'route' | 'baseUrl' | 'path'>): string {
  // express 的 IRoute 没显式 path 字段；运行时确实存在但 types 是 any
  const routePath = (req.route as { path?: string } | undefined)?.path;
  if (routePath) {
    const base = req.baseUrl || '';
    return `${base}${routePath}`;
  }
  if (req.baseUrl) {
    return req.baseUrl;
  }
  return 'unmatched';
}

/**
 * 把 HTTP method 归一化为大写字符串（label 一致性）。
 */
export function normalizeMethodLabel(method: unknown): string {
  if (typeof method !== 'string' || !method) {
    return 'UNKNOWN';
  }
  return method.toUpperCase();
}

// ---------------------------------------------------------------------------
//  Express middleware
// ---------------------------------------------------------------------------

/**
 * Express middleware：记录 http_requests_total。
 * **必须在所有路由之后挂载** —— 因为 req.route 只在路由匹配后才存在。
 * 但 `res.on('finish')` 是异步触发的，挂在最前面也能拿到 route，所以位置无强约束。
 *
 * 用法：app.use(httpMetricsMiddleware());
 */
export function httpMetricsMiddleware(bundle: PrometheusMetricsBundle = getPrometheusBundle()) {
  return function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    res.on('finish', () => {
      try {
        bundle.httpRequestsTotal.inc({
          method: normalizeMethodLabel(req.method),
          route: resolveRouteLabel(req),
          status: normalizeStatusLabel(res.statusCode),
        });
      } catch {
        // metrics 失败不应该影响主流程；prom-client 极少抛错，但 belt-and-suspenders。
      }
    });
    next();
  };
}

// ---------------------------------------------------------------------------
//  Business event helpers — preferred entry points for application code
// ---------------------------------------------------------------------------

/**
 * 记录一次回测任务完成事件。
 * @param strategy 策略名（如 'multi_factor_alpha'）；未知时传 'unknown'
 * @param result 'success' | 'failed'
 */
export function incrementBacktestTotal(
  strategy: string,
  result: 'success' | 'failed',
  bundle: PrometheusMetricsBundle = getPrometheusBundle()
): void {
  try {
    bundle.backtestTotal.inc({
      strategy: strategy || 'unknown',
      result,
    });
  } catch {
    // ignore
  }
}

/**
 * 记录一次 AI 调用耗时事件。
 * @param provider 供应商（如 'trading_agents' / 'openai'）
 * @param endpoint endpoint label（如 'analyze' / 'health'）
 * @param status 'success' | 'failed'
 * @param durationSeconds 耗时（秒）
 */
export function observeAIRequestDuration(
  provider: string,
  endpoint: string,
  status: 'success' | 'failed',
  durationSeconds: number,
  bundle: PrometheusMetricsBundle = getPrometheusBundle()
): void {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return;
  }
  try {
    bundle.aiRequestDurationSeconds.observe(
      {
        provider: provider || 'unknown',
        endpoint: endpoint || 'unknown',
        status,
      },
      durationSeconds
    );
  } catch {
    // ignore
  }
}

/**
 * 记录一次模拟交易下单事件。
 * @param direction 'BUY' | 'SELL'
 * @param status 'success' | 'failed'
 * @param code 拒单原因码（如 'POSITION_LIMIT_VIOLATION' / 'INSUFFICIENT_FUNDS'）；
 *             成功时传 'ok'，方便 Grafana 统一查询 `sum by (code)`。
 */
export function incrementOrderTotal(
  direction: 'BUY' | 'SELL' | string,
  status: 'success' | 'failed',
  code: string,
  bundle: PrometheusMetricsBundle = getPrometheusBundle()
): void {
  try {
    bundle.orderTotal.inc({
      direction: direction || 'unknown',
      status,
      code: code || (status === 'success' ? 'ok' : 'unknown'),
    });
  } catch {
    // ignore
  }
}

/**
 * 累加一次回测产出 trade 数 (audit S-1 修复)。
 *
 * 调用时机: QuantBacktestEngine.run() 收尾 — 把当前策略的 trades.length 加到
 * `backtest_trade_count_total{strategy_key=<key>}` 上。线上看板报警 "MFA 策略
 * 24h 内 trade_count_total 增量 = 0" 即可发现组合级策略退化为 evaluate() hold 的
 * 隐形 bug。
 */
export function incrementBacktestTradeCount(
  strategy_key: string,
  count: number,
  bundle: PrometheusMetricsBundle = getPrometheusBundle()
): void {
  if (!Number.isFinite(count) || count <= 0) return;
  try {
    bundle.backtestTradeCountTotal.inc({ strategy_key: strategy_key || 'unknown' }, count);
  } catch {
    // ignore
  }
}

/**
 * US-004 [OPS-004]: 记录一次 SchedulerService 任务执行的计数 + 耗时.
 *
 * 调用时机: SchedulerService._executeTaskLogic 的 success / failed / skipped 分支收尾.
 * @param task_type CRON_REGISTRY 中的 type 字段（e.g. 'DAILY_UPDATE' / 'SYNC_HISTORY'）；未知传 'unknown'
 * @param status 'success' | 'failed' | 'skipped'（skipped = 节假日跳过）
 * @param durationSeconds 任务耗时（秒）；负数 / NaN 时仍 inc counter 但不 observe histogram
 */
export function recordSchedulerTaskRun(
  task_type: string,
  status: 'success' | 'failed' | 'skipped',
  durationSeconds: number,
  bundle: PrometheusMetricsBundle = getPrometheusBundle()
): void {
  const labels = { task_type: task_type || 'unknown', status };
  try {
    bundle.schedulerTaskRunsTotal.inc(labels);
  } catch {
    // ignore
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    return;
  }
  try {
    bundle.schedulerTaskDurationSeconds.observe(labels, durationSeconds);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
//  US-017 [EX-003] Reconciliation helpers — preferred by ReconciliationAlertService
// ---------------------------------------------------------------------------

/**
 * 把任意 user_id 归一化为稳定 label 字符串（防 cardinality 漂移）。
 *  - number > 0       → String(number)
 *  - 其它（null/0/NaN/非数字字符串） → 'unknown'
 *
 * 不允许传 user.email / user.username —— PII 不进 metric label.
 */
export function normalizeUserIdLabel(user_id: unknown): string {
  if (typeof user_id === 'number' && Number.isFinite(user_id) && user_id > 0) {
    return String(user_id);
  }
  if (typeof user_id === 'string') {
    const n = Number(user_id);
    if (Number.isFinite(n) && n > 0) return String(n);
  }
  return 'unknown';
}

/**
 * 把对账 side 归一化为稳定 label string。
 * 仅接受四个值: live_only / paper_only / live_overweight / live_underweight.
 */
export function normalizeDriftSideLabel(side: unknown): string {
  if (typeof side !== 'string') return 'unknown';
  if (
    side === 'live_only' ||
    side === 'paper_only' ||
    side === 'live_overweight' ||
    side === 'live_underweight'
  ) {
    return side;
  }
  return 'unknown';
}

/**
 * 一次性记录单个用户的对账快照（让 Grafana 看 alignment / drift / age 三联）。
 *
 * @param user_id        用户 ID
 * @param alignmentScore 0-100；null 表示 paper-only 用户/未绑定 (跳过 set, 否则上次值会被冻结)
 * @param driftBySide    各 side 的漂移持仓数 (典型 {live_only: 2, paper_only: 1, ...})
 *                       未列出的 side 不写; 已列出的 side 一定要 set (覆盖式语义)
 * @param snapshotAgeMinutes  null 表示快照不存在 (跳过 set)
 */
export function recordReconciliationSnapshot(
  user_id: number | string,
  alignmentScore: number | null,
  driftBySide: Partial<Record<string, number>>,
  snapshotAgeMinutes: number | null,
  bundle: PrometheusMetricsBundle = getPrometheusBundle()
): void {
  const uid = normalizeUserIdLabel(user_id);
  try {
    if (alignmentScore !== null && Number.isFinite(alignmentScore)) {
      bundle.reconciliationAlignmentScore.set({ user_id: uid }, Number(alignmentScore));
    }
  } catch {
    // ignore
  }
  for (const [side, count] of Object.entries(driftBySide || {})) {
    const sideLabel = normalizeDriftSideLabel(side);
    if (sideLabel === 'unknown') continue;
    const n = Number(count);
    if (!Number.isFinite(n) || n < 0) continue;
    try {
      bundle.reconciliationDriftPositions.set({ user_id: uid, side: sideLabel }, n);
    } catch {
      // ignore
    }
  }
  try {
    if (snapshotAgeMinutes !== null && Number.isFinite(snapshotAgeMinutes)) {
      bundle.reconciliationSnapshotAgeMinutes.set({ user_id: uid }, Number(snapshotAgeMinutes));
    }
  } catch {
    // ignore
  }
}

/**
 * 累加一次 ReconciliationAlert 写出事件（counter；监测告警频率）。
 * - severity: 'HIGH' | 'MEDIUM' | 'NONE' （NONE 也记，用于"健康跑过"曲线）
 * - window: 'intraday' | 'eod'
 *
 * 与 recordReconciliationSnapshot 配套：snapshot 是覆盖式状态，alert 是事件累积；
 * Grafana 上一个看当前状态，一个看历史趋势 / 告警风暴检测。
 */
export function incrementReconciliationAlert(
  severity: 'HIGH' | 'MEDIUM' | 'NONE' | string,
  window: 'intraday' | 'eod' | string,
  bundle: PrometheusMetricsBundle = getPrometheusBundle()
): void {
  const sev =
    severity === 'HIGH' || severity === 'MEDIUM' || severity === 'NONE' ? severity : 'NONE';
  const win = window === 'intraday' || window === 'eod' ? window : 'intraday';
  try {
    bundle.reconciliationAlertsTotal.inc({ severity: sev, window: win });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
//  /metrics endpoint contract
// ---------------------------------------------------------------------------
export async function getMetricsContent(
  bundle: PrometheusMetricsBundle = getPrometheusBundle()
): Promise<string> {
  return await bundle.registry.metrics();
}

/**
 * /metrics endpoint 的 Content-Type，Prometheus 抓取要求这个具体字符串。
 */
export function getMetricsContentType(
  bundle: PrometheusMetricsBundle = getPrometheusBundle()
): string {
  return bundle.registry.contentType;
}
