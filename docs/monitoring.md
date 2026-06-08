# 监控指标 (Prometheus / Grafana) — US-072

## 概述

A-Share 量化平台后端通过 [`prom-client`](https://github.com/siimon/prom-client) 暴露 Prometheus 兼容的运行时指标，
默认抓取地址：

```
http://<backend-host>:<PORT>/metrics
```

该 endpoint 不做鉴权（Prometheus scraper 通常运行在内网，应通过反向代理 / 防火墙做访问控制），
返回 Prometheus 文本格式（Content-Type: `text/plain; version=0.0.4; charset=utf-8`）。

## 抓取配置示例

`prometheus.yml`：

```yaml
scrape_configs:
  - job_name: 'a-share-backend'
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ['backend-host:3000']
        labels:
          env: production
          service: a-share-backend
```

## 核心指标 (AC 要求)

### 1. `http_requests_total` (Counter)

每个 HTTP 请求的累计计数。

| Label    | 说明                                             |
| -------- | ------------------------------------------------ |
| `method` | HTTP 方法（GET / POST / PUT / DELETE…），大写   |
| `route`  | Express 路由模板（**不含**实际参数，避免高基数）；如 `/api/portfolio/:id`；未匹配到具体 endpoint 时退回 `req.baseUrl`；都没有时为 `unmatched` |
| `status` | HTTP 状态码字符串（如 `"200"` / `"404"` / `"500"`） |

**常见查询**：

```promql
# QPS（按 route）
sum by (route) (rate(http_requests_total[5m]))

# 5xx 错误率
sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))

# 404 路由 top 10（暴露前端误调用）
topk(10, sum by (route) (rate(http_requests_total{status="404"}[1h])))
```

**Cardinality 提示**：`route` 字段使用 Express 的 `req.route.path` + `req.baseUrl` 模板，
避免泄漏 `user_id` / `stock_code` 等高基数参数。**绝不要**在新 endpoint 中跳过 Express
的标准路由匹配（直接 `app.use(handler)`）让 `req.route` 为空 — 会让该流量全部归到
`unmatched` label 影响排障。

### 2. `backtest_total` (Counter)

回测任务完成事件计数。一个 task 可能跑多策略，按策略 + 结果分组各计 1 次。

| Label      | 说明                                                                   |
| ---------- | ---------------------------------------------------------------------- |
| `strategy` | 策略 key（如 `multi_factor_alpha` / `dragon_head`）；未知时 `unknown` |
| `result`   | `success` / `failed`                                                   |

**埋点位置**：

- 成功：`QuantBacktestService.processBacktestTask` 内 task COMPLETED update 之后，按 `resultsWithValidation` 每条 +1。
- 失败：`QuantBacktestService.markTaskFailed` 内按 `task.parameters.strategy_keys` 回溯每策略 +1；
  无法回溯时记 `strategy='unknown'`。

**常见查询**：

```promql
# 每日各策略成功 / 失败次数
sum by (strategy, result) (increase(backtest_total[1d]))

# 策略失败率（按策略）
sum by (strategy) (rate(backtest_total{result="failed"}[1h])) /
sum by (strategy) (rate(backtest_total[1h]))
```

### 3. `ai_request_duration_seconds` (Histogram)

AI 远程调用耗时分布。当前主要 AI provider 是 TradingAgents。

| Label      | 说明                                                              |
| ---------- | ----------------------------------------------------------------- |
| `provider` | AI 供应商；当前固定为 `trading_agents`，未来扩 `openai` 等       |
| `endpoint` | 调用 endpoint（如 `analyze` / `task_status`）                    |
| `status`   | `success` / `failed`                                              |

**Buckets**：`[0.05, 0.1, 0.5, 1, 2, 5, 10, 20, 30]` 秒 — 覆盖
50 ms ~ 30 s。AI 远程分析典型 5~20 秒，5 秒是常见 SLA 边界。

**埋点位置**：`AIAdvisorService` 内的 `timedAIRequest()` wrapper 包裹所有 axios 调用。
失败也记 duration（`status='failed'`），让 Grafana 能看到 timeout 类故障的耗时分布。

**常见查询**：

```promql
# P50 / P95 / P99 耗时
histogram_quantile(0.5, sum(rate(ai_request_duration_seconds_bucket[5m])) by (le, endpoint))
histogram_quantile(0.95, sum(rate(ai_request_duration_seconds_bucket[5m])) by (le, endpoint))
histogram_quantile(0.99, sum(rate(ai_request_duration_seconds_bucket[5m])) by (le, endpoint))

# AI 失败率
sum(rate(ai_request_duration_seconds_count{status="failed"}[5m])) /
sum(rate(ai_request_duration_seconds_count[5m]))

# 每分钟 AI 调用量
sum by (endpoint) (rate(ai_request_duration_seconds_count[1m])) * 60
```

### 4. `order_total` (Counter)

模拟交易下单事件计数。

| Label       | 说明                                                                                |
| ----------- | ----------------------------------------------------------------------------------- |
| `direction` | `BUY` / `SELL`                                                                      |
| `status`    | `success` / `failed`                                                                |
| `code`      | 成功时 `ok`；失败时为稳定错误码 — 见下方表                                          |

**失败 code 取值**（避免 message 字符串漂移让时间序列爆炸）：

| Code                          | 触发场景                                                  |
| ----------------------------- | --------------------------------------------------------- |
| `POSITION_LIMIT_VIOLATION`    | US-047 持仓上限守卫拒单                                  |
| `DRAWDOWN_BREAKER_PAUSED`     | US-049 回撤熔断器暂停建仓                                |
| `PER_STOCK_STOP_LOSS_PAUSED`  | US-051 单股止损 cooldown                                  |
| `INSUFFICIENT_FUNDS`          | 可用资金不足                                              |
| `INSUFFICIENT_HOLDING`        | 持仓不足无法卖出                                          |
| `PORTFOLIO_NOT_FOUND`         | 用户尚未初始化模拟盘                                      |
| `NO_POSITION`                 | 平仓时无持仓                                              |
| `PRICE_UNAVAILABLE`           | 7 日内无 K 线无法定价                                     |
| `INVALID_PARAMS`              | quantity ≤ 0 / symbol 空 / direction 空                  |
| `INVALID_DIRECTION`           | direction 不是 BUY / SELL                                |
| `NOT_FOUND`                   | 兜底 404（未匹配到上面任何 code）                        |
| `unknown`                     | 兜底（未来新增 throw 应优先加 `err.code` 而不是落 unknown）|

**埋点位置**：`PaperTradingFacade.placeOrder` 外层 try/catch wrapper。

**常见查询**：

```promql
# 下单成功率（按 direction）
sum by (direction) (rate(order_total{status="success"}[5m])) /
sum by (direction) (rate(order_total[5m]))

# 拒单原因 top（识别风控 / 数据可用性问题）
topk(5, sum by (code) (rate(order_total{status="failed"}[1h])))

# 持仓上限触发频率
sum(rate(order_total{code="POSITION_LIMIT_VIOLATION"}[5m]))
```

## 内置默认指标

启用 `collectDefaultMetrics`，自动暴露 Node.js 进程级指标：

- `process_cpu_user_seconds_total` / `process_cpu_system_seconds_total`
- `process_resident_memory_bytes`
- `nodejs_heap_size_total_bytes` / `nodejs_heap_size_used_bytes`
- `nodejs_eventloop_lag_seconds`
- `nodejs_active_handles_total` / `nodejs_active_requests_total`
- `nodejs_gc_duration_seconds`（Histogram）

**典型 alerting rule**：

```yaml
groups:
  - name: a-share-backend
    rules:
      - alert: BackendHighEventLoopLag
        expr: nodejs_eventloop_lag_seconds > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'Node event loop lag > 100 ms 持续 5 分钟'

      - alert: BackendHigh5xxRate
        expr: |
          sum(rate(http_requests_total{status=~"5.."}[5m])) /
          sum(rate(http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: 'HTTP 5xx 错误率 > 5% 持续 5 分钟'

      - alert: AIRequestP95High
        expr: |
          histogram_quantile(0.95,
            sum(rate(ai_request_duration_seconds_bucket[5m])) by (le, endpoint)
          ) > 25
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: 'AI 调用 P95 > 25s 持续 10 分钟（接近 30s timeout 上限）'

      - alert: OrderRejectionSpike
        expr: |
          sum(rate(order_total{status="failed"}[5m])) > 1
        for: 10m
        labels:
          severity: info
        annotations:
          summary: '模拟交易拒单率 > 1/秒 — 检查风控守卫配置或数据源健康'
```

## Grafana Dashboard 建议

推荐 4 个核心面板：

1. **流量 & 错误率** — `http_requests_total` 按 route 分组的 stacked area，叠加 5xx 红线
2. **API 延迟** — `ai_request_duration_seconds` P50 / P95 / P99 多曲线
3. **回测吞吐** — `backtest_total` 按 strategy 分组的 daily bar，叠加 failed 红条
4. **风控触发** — `order_total{status="failed"}` 按 code 分组的 stacked area

可从 [grafana.com/dashboards](https://grafana.com/grafana/dashboards/) 搜索 `prom-client` 现成模板。

## 扩展新指标

新增业务指标的步骤：

1. **在 `backend/src/metrics/PrometheusRegistry.ts` 定义 metric**：
   - 在 `createPrometheusRegistry()` 里注册一个新的 `Counter` / `Gauge` / `Histogram`
   - 给 `PrometheusMetricsBundle` 接口加字段
   - 添加 label 类型别名（如 `export type MyMetricLabel = 'a' | 'b';`）
2. **加 helper 函数**（如 `incrementMyMetric(...)`）封装 `bundle.myMetric.inc(...)`，业务代码只 import helper 不直接接触 prom-client。
3. **在业务代码调用 helper**，保持 try/catch 不阻塞主流程（prom-client 内部极少抛错，但 belt-and-suspenders）。
4. **加单测** 到 `backend/tests/metrics/`，构造 fresh registry 验证 increment / label cardinality / text-format 输出。
5. **更新本文档** 加 metric 说明 + 常见查询 + alerting rule 建议。

## 故障排查

| 症状                                                    | 可能原因                                                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/metrics` 返回 500                                     | prom-client 内部异常；查 backend logs（极少见）                                                                  |
| `/metrics` 返回 404                                     | 反向代理把 `/metrics` 路径拦了；nginx 加 `location /metrics { proxy_pass http://backend; }`                       |
| 时间序列爆炸（Prometheus 内存暴涨）                     | label cardinality 失控；检查是否有人在新 endpoint 用了 `req.originalUrl` 或 user_id / stock_code 直接传 label   |
| `http_requests_total{route="unmatched"}` 占比高         | 大量 404；查 nginx access log 看是不是前端旧版本还在调下线的 endpoint                                            |
| `order_total{code="unknown"}` 占比高                    | 新加的 throw 未带 `err.code`；查 PaperTradingFacade 调用链补充 code，或在 `inferOrderFailureCode` 加 message 模板 |
| `backtest_total{strategy="unknown"}` 占比高             | `task.parameters.strategy_keys` 未填；查 task 创建路径补充                                                       |

## 相关代码

- `backend/src/metrics/PrometheusRegistry.ts` — 单例 registry + 4 metric + middleware + helpers
- `backend/src/index.ts` — `/metrics` endpoint 注册 + httpMetricsMiddleware 挂载
- `backend/src/portfolio/PaperTradingFacade.ts` — `order_total` 埋点 + `inferOrderFailureCode`
- `backend/src/services/AIAdvisorService.ts` — `ai_request_duration_seconds` `timedAIRequest()` wrapper
- `backend/src/quant/backtest/internal/QuantBacktestService.ts` — `backtest_total` success / failure 增量
- `backend/tests/metrics/prometheus-registry.test.ts` — 73 个单测（纯函数 / metric 注册 / middleware / 文本格式）
