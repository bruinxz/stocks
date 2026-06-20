# `backend/src/services/attribution/` — L8-Postmortem 每日归因

本目录由 US-078 [PM-001] 起步, 后续 PM-002~009 共建一个 service. 设计文档:
`docs/trader-system/71_attribution_daily.md`.

## 当前架构

```
DailyAttributionService.ts   — PM-001 主入口 + 6 维框架 + DataSource DI seam
```

后续 story 在本目录新增:
- PM-002 (US-079): `AttributionEngine.ts` — Brinson-Fachler 真拆解
- PM-003 (US-080): 持久化走 `backend/src/models/DailyAttributionReport.ts` + migration
- PM-004 (US-081): `ExecutionCostAggregator.ts` — 滑点 + 手续费 + 印花税
- PM-005 (US-082): `AIAttributionSummary.ts` — LLM 替换 heuristicSummary
- PM-006 (US-083): SchedulerService 注册 `DAILY_ATTRIBUTION_GENERATE` cron
- PM-007 (US-084): `api/controllers/DailyAttributionController.ts` + route
- PM-008 (US-085): BehaviorBiasDetector.detectIncremental 接入 bias_findings
- PM-009 (US-086): 飞书推送 attribution 卡片

## 接入约定 (PM-002~009 共同遵守)

### 主入口契约不变

`buildDailyAttributionReport(input)` 是纯函数主入口, 后续 story 替换 placeholder
字段而不破坏 `DailyAttributionReport` 类型. 不变量:

```
sum(industry_contrib.pnl) + selection_contrib + timing_contrib + sizing_contrib
  + factor_contrib_total + execution_cost + residual ≈ total_pnl  (±5%)
```

PM-001 当前 4 个 placeholder 字段 = 0, residual = `total - industry + execution_cost`
让等式 trivially 成立. PM-002 接入真因子模型时, 改 residual 公式即可, 主入口签名
和返回 shape 全保留.

### DataSource 接口扩展

`DailyAttributionDataSource` 当前 4 个 method (loadTrades / loadSnapshots /
loadPositions / loadSymbolIndustryMap). 后续 story 加 method 时:

- PM-003: 加 `saveReport(report) → number` 让 service 层 persist 可选
- PM-004: 加 `loadExecutionFills(portfolio_id, date)` 给 ExecutionCostAggregator
- PM-005: 加 `callLLMSummary(report) → string` 给 AIAttributionSummary
- PM-008: 加 `loadIncrementalBias(user_id, date)` 给 BehaviorBiasDetector
- PM-009: 加 `sendFeishuCard(payload)` 给推送

每加一个 method:
- (a) interface 内显式定义
- (b) `createProductionDailyAttributionDataSource()` 内实现 + 内层 try/catch + `logger.warn` + fail-OPEN 返空集合
- (c) 单测 fake source 全 method 加默认实现 (返空) 避免老 test 因为 interface 扩张全挂

### fail-OPEN 强制契约

- service 顶层 `try/catch` 任何异常 → `{status: 'failed', reason: 'db_error', error}`
- PRODUCTION DataSource 每个 method 内层 try/catch → 返 `[]` 或 `{}` (不 throw)
- 主流程绝不被归因链路阻塞 (cron 调度 / route 响应 / 飞书推送均不挂)

异常: 真"挡用户" 类的硬触发 (PM-008 BehaviorBiasDetector 检出 critical bias 触发
HIGH alert) 走 RiskAlertService dispatcher 自己的 fail-CLOSED 链路, 不在本 service
内部 throw.

### 与既有 service 边界

- `PaperTradingAttributionService` — 历史每笔聚合 (open/closed); 本目录是"今日整
  portfolio 6 维拆解", 同一份 trade 数据不同视角.
- `TradePostmortemService` — 单笔 outcome 关闭后 5-bullet; 本目录是当日全 portfolio
  汇总.
- `DailyTradingDigestService` — 飞书"账户+候选" 简报; PM-009 把本目录输出挂飞书
  推送 attribution 专卡.

## null vs Number(null)=0 隐患

任何"可空数字字段" (`realized_pnl`, `commission` 等) 过滤前必须显式:

```ts
if (t.realized_pnl == null) continue;
const pnl = Number(t.realized_pnl);
if (!Number.isFinite(pnl)) continue;
```

不能依赖 `Number.isFinite(Number(null))` (那是 `Number.isFinite(0) === true`, null
会被当 0 通过). 同时 unit test 必须同时断 sum 和 count 才能发现这类巧合通过.
