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

import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';
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

export interface PrometheusMetricsBundle {
  registry: Registry;
  httpRequestsTotal: Counter<HttpRequestLabel>;
  backtestTotal: Counter<BacktestLabel>;
  aiRequestDurationSeconds: Histogram<AIRequestLabel>;
  orderTotal: Counter<OrderLabel>;
  /** audit S-1 修复: 单次回测累计 trade 笔数（按策略 key 分） */
  backtestTradeCountTotal: Counter<BacktestTradeCountLabel>;
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

  return {
    registry,
    httpRequestsTotal,
    backtestTotal,
    aiRequestDurationSeconds,
    orderTotal,
    backtestTradeCountTotal,
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

// ---------------------------------------------------------------------------
//  /metrics endpoint contract
// ---------------------------------------------------------------------------

/**
 * 取整个 registry 的 Prometheus text 格式 dump，供 /metrics endpoint 使用。
 */
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
