# Grafana Dashboards — A-Share 量化平台 (US-129 / OPS-010)

5 个生产就绪的 dashboard 模板, 与 `backend/src/metrics/PrometheusRegistry.ts` 当前埋点
一一对应. **完全 import-and-use** — 不依赖第三方插件, 仅需要 Prometheus datasource.

## 文件

| 文件                                | 标题            | 覆盖范围                                                                 |
| ----------------------------------- | --------------- | ------------------------------------------------------------------------ |
| `dashboards/signal-flow.json`       | 信号流          | order/AI/backtest 三类事件 — QPS / 成功率 / P95 耗时                     |
| `dashboards/risk-control.json`      | 风控            | 拒单 code 分布 + 对账告警严重度 + HTTP 5xx 错误率                        |
| `dashboards/reconciliation.json`    | 对账            | alignment_score / drift_positions / snapshot_age_minutes + alert counter |
| `dashboards/data-sla.json`          | 数据 SLA        | scheduler_task_runs_total 按 task_type 看 success/skipped/failed         |
| `dashboards/strategy-performance.json` | 策略表现     | backtest_total + backtest_trade_count_total (audit S-1 trade=0 检测)     |

## 导入步骤

1. Grafana → **Dashboards** → **New** → **Import**
2. 拷贝对应 JSON 内容 → **Load**
3. 选择 datasource (Prometheus) → **Import**

每个 dashboard 顶部都有 `DS_PROMETHEUS` template variable, 不需要改 JSON.

## 抓取配置

后端在 `:PORT/metrics` 暴露 prometheus 兼容指标, 详见 `docs/monitoring.md`. Prometheus
抓取间隔建议 15s. 任何"分钟级"告警 (e.g. `increase[5m]==0`) 都需要这个频率.

## 修改约定

- **数据源**: dashboards 里所有 `expr` 引用的 metric 名必须出现在
  `backend/src/metrics/PrometheusRegistry.ts` 里的 `new (Counter|Gauge|Histogram)` 调用中.
  `backend/tests/ops/grafana-dashboards.test.ts` 用 fs.readFileSync + 正则做 drift guard,
  改 metric 名或加新 metric 时记得同步 dashboard + test.
- **schemaVersion=39** 对应 Grafana 10.x. 升级 Grafana 时 import 仍向后兼容, 但建议跑一次 `Inspect → JSON` 重新导出.
- **不要** 给 panel 加高基数 label (e.g. user_id 作为 legend) — 与 `PrometheusRegistry.ts` 已经
  在 metric 层守住的 cardinality 红线对偶.
- **不要** 在 dashboard JSON 里写死告警阈值 (alert rule 走独立的 alertmanager / Grafana Alerts —
  本 dashboard 仅做"看", 不做"报").

## 相关

- 指标契约 (label / 命名约定): `docs/monitoring.md`
- Prometheus client 实现: `backend/src/metrics/PrometheusRegistry.ts`
- Drift guard 测试: `backend/tests/ops/grafana-dashboards.test.ts`
