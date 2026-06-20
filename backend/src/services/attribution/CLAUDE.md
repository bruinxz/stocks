# `backend/src/services/attribution/` — L8-Postmortem 每日归因

本目录由 US-078 [PM-001] 起步, 后续 PM-002~009 共建一个 service. 设计文档:
`docs/trader-system/71_attribution_daily.md`.

## 当前架构

```
DailyAttributionService.ts   — PM-001 主入口 + 6 维框架 + DataSource DI seam
AttributionEngine.ts         — PM-002 Brinson-Fachler 拆解 (pure helper, no DB)
ExecutionCostAggregator.ts   — PM-004 commission + stamp + transfer + slippage + LiveTrade 对账
AIAttributionSummary.ts      — PM-005 LLM 摘要 (≤200 字 + ≥3 数字 + heuristic fallback)
DailyAttributionCronRunner.ts — PM-006 工作日 17:00 批量 cron 入口 + persistReport DataSource
```

后续 story 在本目录新增:
- PM-003 (US-080): 持久化走 `backend/src/models/DailyAttributionReport.ts` + migration  ✔ 已落
- PM-004 (US-081): `ExecutionCostAggregator.ts` — 滑点 + 手续费 + 印花税 + 实盘对账  ✔ 已落
- PM-005 (US-082): `AIAttributionSummary.ts` — LLM 替换 heuristicSummary  ✔ 已落
- PM-006 (US-083): `DailyAttributionCronRunner.ts` + SchedulerService.DAILY_ATTRIBUTION_GENERATE cron  ✔ 已落
- PM-007 (US-084): `api/controllers/DailyAttributionController.ts` + route
- PM-008 (US-085): BehaviorBiasDetector.detectIncremental 接入 bias_findings  ✔ 已落 (method 就绪, caller 后续接)
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

### PM-005 AIAttributionSummary 接入 (US-082, 已落地)

`AIAttributionSummary.ts` 纯函数 + DataSource DI, 与 PM-002/PM-004 同形态.
3 个 export 主入口: `buildAttributionSummaryPrompt` (拼 LLM 指令) /
`enforceAttributionSummaryConstraints` (校验 ≤200 字 + ≥3 数字) /
`generateAIAttributionSummary(report, source?)` (async, 调 LLM → 校验 → fallback);
常量 `AI_ATTRIBUTION_SUMMARY_MAX_CHARS=200` (复用 PM-001 `DAILY_ATTRIBUTION_AI_SUMMARY_MAX_CHARS`)
+ `AI_ATTRIBUTION_SUMMARY_MIN_NUMBERS=3` (AC §E.3).

`generateDailyReport` 新增 option `ai_summary_source?: AIAttributionSummaryDataSource | null | 'off'`:
- `undefined` / `null` / `'off'`: ai_summary 走 PM-001 heuristic (老行为, 全兼容)
- DataSource: 调 LLM, 失败自动 fallback 到 heuristic, **永不 throw**

**三层校验** (与 [[AI_VIEW_MAX_CHARS 5 件套]] 同款):
1. prompt 上游告诉 LLM "≤200 字 + ≥3 数字"
2. 中游 `enforceAttributionSummaryConstraints` 收到 LLM 返值后 hard-cap 截断 + 数字计数
3. 下游 fallback 走 `heuristicSummary` (PM-001, 输出含 date/total_pnl/trade_count 至少 3 数字)

**数字计数**: 用 `/-?\d+(?:\.\d+)?/g`, 全局匹配, 不去重. 日期 `2026-06-19` 命中
`2026`/`-06`/`-19` = 3 个 (有 `-` 算负数). 极端边界 fallback 内补
`默认占位 0.00 元 0 笔` 保证永远 ≥ 3.

**PRODUCTION DataSource**: lazy require axios + TRADING_AGENTS_BASE_URL, 调
`/api/attribution-summary`, 30s timeout, 与 `AnnouncementNLPService.callRemoteSummarize`
完全同形态. 接口失败 (ECONNREFUSED / timeout / 5xx) 转 null 不 throw, 主流程降级.

**caller 何时传 source**: PM-006 cron 启动时根据 env / config (`AI_ATTRIBUTION_MODE`)
决定传 `PRODUCTION_AI_ATTRIBUTION_SUMMARY_DATA_SOURCE` 还是 `null` / `'off'`. 灰度
推进 (off → shadow → hard) 在 caller 侧, 本 module 不感知.

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

## DailyAttributionCronRunner — PM-006 cron 批量入口 (US-083)

工作日 17:00 (盘后 + DAILY_UPDATE 18:00 前) 批量驱动 — 给所有 active paper trading
portfolio 跑 `DailyAttributionService.generateDailyReport` 并 upsert 到
`daily_attribution_reports`. 与 service 解耦的 cron-side DataSource:

```ts
runDailyAttributionGenerate({
  date?: 'YYYY-MM-DD',          // 默认今日 Asia/Shanghai
  portfolio_ids?: number[],      // 空 = 取所有 is_active=true
  dry_run?: boolean,             // true 时不调 persistReport
  ai_summary_source?: ...,       // 默认 'off' (cron 跑零 AI 链路)
  cron_data_source?: ...,        // 单测注入
  service_data_source?: ...,     // 单测注入透传给 generateDailyReport
})
```

返聚合 summary (`total_portfolios / ok_count / skipped_count / failed_count /
persisted_count / per_portfolio[]`), SchedulerService 落 `execution_log.result_summary`.

**fail-OPEN 双层**:
1. service 内部 fail-OPEN — `loadTrades` 抛被 service 顶层 catch 转 `status='failed'`
2. persistReport 失败 → `per_portfolio[].status='persist_failed'` 但 continue 下一个

**dry_run 契约**: `dry_run=true` 时跳过 persistReport, 仅返聚合 (cron preview / 灰度).

**skipped / failed 也持久化留痕**: PRD US-080 AC "表里有当日记录" 要求所有 portfolio
都有一行 (status 字段区分), 不留无记录的 "todo" 行 — `buildPersistRow` 在 report=null
时用占位 0 / '' 仍写一行.

**新加 PM-007 (route) 时不要再调 runDailyAttributionGenerate**: route 是单 portfolio
按需读 (GET /api/portfolio/:id/attribution/daily?date=...), 直接读 `DailyAttributionReport`
表; 缓存 miss 时调 `dailyAttributionService.generateDailyReport` 单 portfolio 跑 + 不
落库 (route 是只读语义). cron + route 共享同一份 service, 不共享 cron runner.
