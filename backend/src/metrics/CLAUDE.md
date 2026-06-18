# `backend/src/metrics/` — Prometheus 指标埋点 (US-072)

## 设计原则

**单例 Registry 在 `PrometheusRegistry.ts`** —— 整个进程一份 `prom-client.Registry`，避免不同模块各自注册同名 metric 导致 `Error: A metric with the name X has already been registered`。

**当前注册的业务 metric (US-072 + audit S-1 + US-004)**：
- `http_requests_total{method,route,status}` Counter
- `backtest_total{strategy,result}` Counter
- `ai_request_duration_seconds{provider,endpoint,status}` Histogram (buckets 50 ms - 30 s)
- `order_total{direction,status,code}` Counter
- `backtest_trade_count_total{strategy_key}` Counter (audit S-1: 检测组合策略 trade_count=0 退化)
- `scheduler_task_runs_total{task_type,status}` Counter (US-004: 调度任务执行计数, status=success/failed/skipped)
- `scheduler_task_duration_seconds{task_type,status}` Histogram (US-004: 调度任务耗时, buckets 100 ms - 600 s)

**命名约定**: `<domain>_<verb>_<unit>` (e.g. `scheduler_task_runs_total` = domain=scheduler, verb=runs, unit=total → counter; `*_seconds` 后缀 → histogram). 新增 metric 必须遵循.

**新加 metric 的 checklist**：
1. 在 `createPrometheusRegistry()` 内注册（不要在外面 new Counter）
2. 加 label type union（`export type XxxLabel = 'a' | 'b';`）
3. 加业务 helper（如 `incrementXxx()`）封装 `bundle.xxx.inc(...)`，**业务代码只 import helper 不接触 prom-client**
4. helper 内套 try/catch（prom-client 极少抛错，但 belt-and-suspenders）
5. label 名加测试（cardinality + text format 输出）
6. 更新 `docs/monitoring.md`

## label cardinality 红线

**route label 必须用 Express 模板**（`/api/portfolio/:id`），不要用 `req.originalUrl`。`resolveRouteLabel()` 已实现优先级：
- `req.route.path + req.baseUrl` —— 已匹配路由模板
- `req.baseUrl` —— 仅挂载路径（fallback）
- `'unmatched'` —— 兜底，通常 404

**`code` label 用稳定 enum** 不用 message 字符串。`inferOrderFailureCode()` 把 legacy throw 的中文 message 归一化成稳定码（`INSUFFICIENT_FUNDS` / `INVALID_PARAMS` / 等）；新增 throw 优先 `err.code = 'XXX'` 直接绕过 message 归一化。

## 业务代码埋点位置

- `src/portfolio/PaperTradingFacade.placeOrder` — `incrementOrderTotal()` 外层 try/catch wrapper
- `src/services/AIAdvisorService.timedAIRequest()` — `observeAIRequestDuration()` axios 调用 wrapper
- `src/quant/backtest/internal/QuantBacktestService.processBacktestTask` — `incrementBacktestTotal()` 成功路径
- `src/quant/backtest/internal/QuantBacktestService.markTaskFailed` — `incrementBacktestTotal()` 失败路径
- `src/services/SchedulerService._executeTaskLogic` — `recordSchedulerTaskRun()` 三出口 (success/failed/skipped). label 只取 `task.type` 不取 `task.name`/`task.id` (cardinality 控制在 54 cron type × 3 status = 162 series, 远低于 Prometheus per-job 10k 红线).
- `src/index.ts` — `httpMetricsMiddleware()` 全局挂载 + `/metrics` endpoint

**`/metrics` endpoint 不加鉴权**（Prometheus scraper 通常在内网通过反向代理访问；任何 auth middleware 都会让抓取失败）。

## 测试约定

`backend/tests/metrics/<name>.test.ts` 走与全局一致的 node-direct 约定：
- `npx ts-node --transpile-only tests/metrics/<name>.test.ts`
- 不依赖 jest；assert / assertEqual / async main / `process.exit`
- 测试用 `createPrometheusRegistry()` factory 单独构造 fresh registry，**不动 singleton**（避免互相污染）
- 覆盖：纯函数 / metric 注册 / business helper / middleware / text format 输出
