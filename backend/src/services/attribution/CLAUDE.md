# `backend/src/services/attribution/` — L8-Postmortem 每日归因

本目录由 US-078 [PM-001] 起步, 后续 PM-002~009 共建一个 service. 设计文档:
`docs/trader-system/71_attribution_daily.md`.

## 当前架构

```
DailyAttributionService.ts   — PM-001 主入口 + 6 维框架 + DataSource DI seam
AttributionEngine.ts         — PM-002 Brinson-Fachler 拆解 (pure helper, no DB)
ExecutionCostAggregator.ts   — PM-004 commission + stamp + transfer + slippage + LiveTrade 对账
```

后续 story 在本目录新增:
- PM-003 (US-080): 持久化走 `backend/src/models/DailyAttributionReport.ts` + migration  ✔ 已落
- PM-004 (US-081): `ExecutionCostAggregator.ts` — 滑点 + 手续费 + 印花税 + 实盘对账  ✔ 已落
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

### PM-002 AttributionEngine 接入 (US-079, 已落地)

`AttributionEngine.ts` 是纯函数 Brinson-Fachler 拆解, **不接任何 model/DB**.
主入口 `computeBrinsonFachler(input)`, 输入 `{portfolio_value, rows[]}` (每行含
`portfolio_weight / benchmark_weight / portfolio_return / benchmark_return`),
输出 `{allocation_contrib, selection_contrib, interaction_contrib, total_active_return, by_industry[], meta}`.

`buildDailyAttributionReport` 可选接 `attribution_engine_input` — 传了就调
engine 把 4 维 placeholder 替换成 sizing/selection/timing 真值:

- `sizing_contrib`    ← `allocation_contrib`  (行业 β over/underweight)
- `selection_contrib` ← `selection_contrib`   (行业内 α)
- `timing_contrib`    ← `interaction_contrib` (交叉项)
- `factor_*` 仍 placeholder=0 (留 PM-005)

`residual` 公式重算 = `total - industry - alloc - sel - inter + execution_cost`,
让 AC §E.2 ±5% 不变量永远 trivially 成立.

**fail-safe**: rows 空/V<=0/NaN/Infinity 全自动 0; 同 industry 重复行自动合并
(`mergeAttributionRowsByIndustry`); 没给 `benchmark_weight` 走 universe 等权
(`fillBenchmarkWeightsEqual`, `meta.used_equal_weight_benchmark=true`).

**caller 何时传**: 当 caller (PM-006 cron / route) 准备好"每行业 portfolio
weight + portfolio return + benchmark weight + benchmark return" 4 路 input 后
才传; 否则 (e.g. benchmark 不可达, 行业数据缺失) 不传即可, 保持 PM-001
placeholder=0 行为.

### PM-004 ExecutionCostAggregator 接入 (US-081, 已落地)

`ExecutionCostAggregator.ts` 是纯函数 (与 PM-002 同形态, 不依赖 model/DB).
6 个 export: `aggregateExecutionCost` / `reconcileWithLiveFills` /
`computeStampDutyFromTrade` / `computeTransferFeeFromTrade` /
`computeSlippageFromTrade` / `sumLiveFixedCosts` + 常量 `MATCH_RATIO_THRESHOLD`
/ `STAMP_DUTY_RATE` / `TRANSFER_FEE_RATE`.

`buildDailyAttributionReport` 接 `execution_cost_input?: ExecutionCostInput | null`:

- `undefined` (默认): 用 tradesToday 自动构最小 input → breakdown 4 件套始终可见
  (slippage_total=0 当 ref_prices 缺失)
- 显式 ExecutionCostInput (含 ref_prices): aggregator 完整算 commission + stamp +
  transfer + slippage; breakdown 挂在 `execution_cost_breakdown`
- 显式 `null`: 关闭 aggregator → 退到 PM-001 老 `Σ commission` 路径, breakdown=null

**重要语义陷阱**: PaperTradingFacade 的 `trade.commission` 列 **已经** 是
broker_commission + stamp_tax + transfer_fee 三者之和 (见
`PaperTradingFacade.ts:1322`). 因此 `commission_total + stamp_duty_total + transfer_fee_total`
**不能直接相加** 当总成本 — 会重复计 stamp + transfer. aggregator 的 `total_cost`
= `commission_total + slippage_total` 才是真总执行成本; stamp/transfer 字段
仅作"分项展示", 用于前端拆细给操盘手看.

**LiveTrade 对账 (AC §E.1 ≥ 99%)**: `reconcileWithLiveFills({paper_trades, live_fills})`
返 `{paper_total, live_total, diff_abs, match_ratio, is_match, trade_count_*}`.
- `live_total` 用 `sumLiveFixedCosts(fills)` (复用 `services/execution/tca.ts`
  的 `aShareFixedCosts` 按标准费率反推, LiveTrade 没 commission 列只有
  trade_amount/side)
- `match_ratio = 1 - |paper - live| / max(paper, live)`, paper==live==0 → 1
- caller (PM-006 cron) 在 `is_match=false` 时写 mid/high RiskAlert, 提示
  paper 费率模型与实盘漂移

**何时传 execution_cost_input**: caller 准备好 `symbol → arrival_price` 或
`symbol → 当日 VWAP` 参考价 map 后才传含 ref_prices 的 input — 否则 slippage
覆盖率=0 也可, breakdown 仍含 commission/stamp/transfer 三件套对 UI 已可用.

### DataSource 接口扩展

`DailyAttributionDataSource` 当前 4 个 method (loadTrades / loadSnapshots /
loadPositions / loadSymbolIndustryMap). 后续 story 加 method 时:

- PM-003: 加 `saveReport(report) → number` 让 service 层 persist 可选
- PM-004: ExecutionCostAggregator 走 caller 传 `execution_cost_input`/`live_fills`,
  DataSource 不需新增 method (aggregator 是纯函数, caller 自己控 I/O); PM-006 cron
  可加 `loadExecutionFills(portfolio_id, date)` 给对账
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
