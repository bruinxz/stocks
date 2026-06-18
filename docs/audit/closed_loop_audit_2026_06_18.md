# 操盘手闭环 — 审计报告

**生成日期**：2026-06-18
**worktree**：`.claude/worktrees/happy-torvalds-180c51`
**前置文档**：[closed_loop_architecture_2026_06_18.md](closed_loop_architecture_2026_06_18.md)
**严重度分级**：
- **S = 严重 (Severe)**：影响真实资金安全 / 收益可信度的结构性问题，**必须**在接入更大真实资金前修复。
- **M = 中 (Medium)**：可绕过 / 实现弱化 / 时序错位的问题，目前不致命但会引导错误决策。
- **L = 低 (Low)**：工程瑕疵、命名一致性、文档同步。

**风险标记**：⚠️ = 高风险改动，需人工确认后才能执行（触实盘 / 改 secrets / 改部署 / 改 schema）。

---

## 0. 一句话客观评估

> **当前链路具备模拟盘稳定运行的前提，但不具备真实环境放量盈利的前提。** 三大根因：
> 1. **"已回测过"是错觉**——13 个核心组合级策略在回测引擎里 trade_count=0；上层 walk-forward / kill-switch / Bayesian / FactorIC 评估对它们全部为空指标（详见 S-1）。
> 2. **A 股最重要的硬约束（涨跌停按市场段区分）在回测和实盘 placeOrder 都缺失或不复用**——回测系统性低估创业板/科创板/北交所成交率，实盘可下单到涨停板（详见 S-2、S-3）。
> 3. **post-trade 风控不是 pre-trade gate；对账无主动告警**——`TradeComplianceChecker` 事后跑，对账只在用户 GET 页面计算，差异长时间漂移无人发现（详见 S-5、S-6）。

下面按 5 类列问题，每条都带 `文件:行号` 证据 + 修复方案 + 验证方式。最关键 TOP 3 在末尾"决策摘要"中再次汇总。

---

## 1. 链路完整性与正确性

### S-1 ⚠️ **回测↔实盘策略分叉**：组合级策略在回测里被永远 `evaluate()`→`'hold'`，trade_count=0

**证据**
- 回测入口：[backend/src/quant/backtest/internal/QuantBacktestEngine.ts:191](../../backend/src/quant/backtest/internal/QuantBacktestEngine.ts) — 只调 `strategy.evaluate(context, options)`。
- 13 个组合级策略 `evaluate()` 全部退化为"信息性 hold"：
  - [MultiFactorAlphaStrategy.ts:500-517](../../backend/src/quant/strategies/MultiFactorAlphaStrategy.ts)
  - [DragonHeadMomentumStrategy.ts:578-595](../../backend/src/quant/strategies/DragonHeadMomentumStrategy.ts)
  - [BreakoutStrategy.ts:429-446](../../backend/src/quant/strategies/BreakoutStrategy.ts)
  - [LeftSideReversalStrategy.ts](../../backend/src/quant/strategies/LeftSideReversalStrategy.ts) 同款；Ensemble / GameTraderRelay / Linkage / HighDividendValue / EarningsSurprise / NorthboundFollow / CTA100Momentum / SectorRotationLeader / GARP 同款。
- 实盘走的是不同入口：[QuantSignalService.runCompositeStrategies](../../backend/src/quant/engine/internal/QuantSignalService.ts:496-601) 调 `(strategy as any).generateSignals(trade_date, …)`。

**影响**
- 所有 ralph 评估、walk-forward / kill-switch / FactorIC / cost-sensitivity / Bayesian 优化对 MFA 等核心策略**指标全是空的或来自 evaluate() stub**。
- `kill_switch_metric: 'mean_test_sharpe_30d'` / `kill_switch_threshold: 0.3`（[MultiFactorAlphaStrategy.ts:481](../../backend/src/quant/strategies/MultiFactorAlphaStrategy.ts)）**无实际数据支撑**——回测从来没产生过 sharpe。
- 当前任何"我们已经回测过 MFA / DragonHead 了"的说法都是错误的。

**修复方案**（**S 级，必须做**）
两选一：
- **方案 A（推荐）**：把 `QuantBacktestEngine` 改造为支持两种调用——若 `strategy.generateSignals` 存在则按"组合级模式"撮合（每日 generate 一次 target_portfolio，引擎按差额生成买卖单），否则维持现 `evaluate()` 路径。
- **方案 B**：把 13 个组合级策略的 `evaluate()` 实现成"对单股运行一次组合级排序后看本股是否入选 → 转 `buy/hold/sell`"，复用现引擎。**缺点**：与 `generateSignals` 的真实行为口径仍可能漂移。

**验证方式**
- 跑一次 MFA 月度回测，要求 `trade_count > 0` 且 `equity_curve.length > 0`；与同周期实盘 `QuantSignal` 表里 MFA 的 buy/sell 数据做对账，buy 信号 ±2 个交易日匹配率 ≥ 80%。
- 验收脚本草案：`backend/scripts/quant-audit/verify_composite_backtest_parity.ts`（待创建）。

---

### S-2 ⚠️ **A 股涨跌停约束不按市场段区分**（回测系统性偏差）

**证据**
- 回测约束统一阈值，未按 symbol 区分：[backend/src/quant/backtest/AShareConstraintEngine.ts:79-95,264-281](../../backend/src/quant/backtest/AShareConstraintEngine.ts)；配置只暴露单个 `limit_up_pct`（[QuantTypes.ts:182-183](../../backend/src/quant/types/QuantTypes.ts)）。
- 正确实现已存在但**仅在 feasibility 评分**用：[ExecutionFeasibilityService.ts:163-184](../../backend/src/services/execution/ExecutionFeasibilityService.ts) `inferMarketSegment` + `getLimitPct`：主板 10% / 创业板 20% / 科创板 20% / 北交所 30% / ST 5%。

**影响**
- 创业板/科创板 / 北交所的回测 BUY 在 ≥9.8% 涨幅时被拒，实盘可继续买 → 回测系统性低估成交率与 alpha。
- BJ 30% 股回测**几乎天天**被涨停拦截，回测 universe 实际剔除了 BJ。
- ST 股回测按 9.8% 当成跌停，实盘 5% 即跌停 → 回测的 ST 反弹策略在实盘根本不可成交。

**修复方案**（**S 级**）
- 在 `AShareConstraintEngine` 抽出 `getLimitPctForSymbol(symbol, isST, prevClose, dailyBar)` 函数，**与 `ExecutionFeasibilityService` 共用一份**实现（提到 `quant/backtest/marketLimits.ts` 或 `services/marketSegments.ts`）。
- 回测 + paper trading + live trading 三处全部 import 同一函数。

**验证方式**
- 单元测试：300033 (sz.300033 创业板) 涨 12% → 不拦截；688001 (sh.688001 科创板) 涨 18% → 不拦截；920001 (bj.920) 涨 25% → 不拦截；603001 (sh.6) 涨 9.9% → 拦截；ST 名称含 "ST" 涨 4.5% → 不拦截。
- 现有 CI：`cd backend && npm test -- AShareConstraintEngine`。

---

### S-3 ⚠️ **实盘 `PaperTradingFacade.placeOrder` 完全不查涨跌停**（实盘隐性 bug）

**证据**
- 全文搜 `limit_up` / `getLimitPct` / `pricePctChange`：[backend/src/portfolio/PaperTradingFacade.ts:524-702](../../backend/src/portfolio/PaperTradingFacade.ts) 仅命中注释，BUY/SELL 主流程无任何涨跌停拦截。
- 现有 BUY 流程只检查：交易时段 / portfolio 路由 / 行情陈旧度（3 天，应该是 30min）/ `DrawdownCircuitBreaker`(fail-open) / `PositionLimitGuard` / T+1。
- `ExecutionFeasibilityService` 虽然是 Buy Gate，但当 `fillable_score = 70` 时**不阻塞**（即在涨停板上 fillable_score 仍可能过线）。

**影响**
- 模拟盘可以下单到涨停板上（回测里被拦的票，实盘照下）；当前是 paper trading 没造成真损失，**但一旦切实盘就是直接资金风险**。

**修复方案**（**S 级，与 S-2 同步**）
- `PaperTradingFacade.placeOrder` BUY 路径插入 limit_up 拦截，复用 S-2 的统一函数。SELL 路径插入 limit_down 拦截。
- 实盘 `LiveRiskGuardService.evaluate` 已有 `block_limit_up_buy` ([LiveRiskGuardService.ts:140](../../backend/src/live-trading/services/LiveRiskGuardService.ts))，但**只按主板 10% 配置**，要同样换成统一函数。

**验证方式**
- 单元测试：模拟一笔 300xxx 创业板涨 21% 时下单 → 拒绝；涨 19% → 允许。
- 集成：`PaperTradingFacade.test.ts` 加 5 个 case 覆盖 5 个市场段。

---

### S-4 ⚠️ **回测前视偏差**：`execution_timing='same_close'` + 次日 `change_percent` 双重未来信息

**证据**
- 同收回测路径：[QuantBacktestEngine.ts:182-228](../../backend/src/quant/backtest/internal/QuantBacktestEngine.ts) — `evaluate()` 输入 `barsUntilDate` 含 T 日收盘价 → `'same_close'` 用 T 日收盘价撮合。
- 次日撮合分支：[QuantBacktestEngine.ts:597](../../backend/src/quant/backtest/internal/QuantBacktestEngine.ts) 调 `AShareConstraintEngine.executePrice(bar, 'buy', 'next_open')`，但 `evaluateOrder` 在 [AShareConstraintEngine.ts:263-270](../../backend/src/quant/backtest/AShareConstraintEngine.ts) 用 `bar.change_percent`（次日收盘后才知）判定次日是否涨停。

**影响**
- `'same_close'` 模式整段回测都是前视偏差（CLAUDE.md 自己提到"龙头/短线策略常用"——说明确有人在用）。
- 次日开盘撮合分支：用次日收盘后的 change_percent 反向决定要不要在次日开盘买入，混用未来信息。

**修复方案**（**M 级**）
- `'same_close'` 模式：要么禁用（回测引擎 warn + 强制改 `next_open`），要么 `evaluate()` 时把 T 日 bar 从 `barsUntilDate` 排除。
- 次日撮合判涨停：改用 `(bar.open - prev_close) / prev_close` 判断开盘是否涨停（这是 9:25 集合竞价后即可得的信息）。

**验证方式**
- 黄金回测：选 1 只历史已涨停股，跑同收 vs 次日开盘，前者 sharpe 显著高于后者即视为"前视偏差消除前"，修复后两者差异应缩到 ≤10%。

---

### S-5 ⚠️ **`TradeComplianceChecker` 5 wizard 是事后审计，不是 pre-trade gate**

**证据**
- 入口：[backend/src/services/TradeComplianceChecker.ts:61](../../backend/src/services/TradeComplianceChecker.ts) `checkTradeCompliance` + `:104` `emitWizardAlert`。
- 触发：[backend/src/models/RecommendationTradeOutcome.ts:278-360](../../backend/src/models/RecommendationTradeOutcome.ts) afterUpdate hook，**只在 outcome closed 后**跑。
- 在 `createDraft / autoBuyFromSignals / approveDraft` 链路里**全文无引用**。

**影响**
- 违反 5 wizard 规则（如"次日追高"）的下单会照样执行，只是事后 RiskAlert MEDIUM。若产品本意是 pre-trade gate，则被绕过。

**修复方案**（**待你确认意图后决定**）
- 若本意 pre-trade：在 `PaperTradingAutomationService.createBuyTrade` 与 `LiveTradingService.approveDraft` 各插一次 `checkTradeCompliance(decisionDraft)` 调用，违反硬规则直接拒单。
- 若本意保留事后：补一条 `audit_event = 'TRADE_COMPLIANCE_FAILED'`，并在 dashboard 单独展示"事后违规率"指标。

**验证方式**
- 单元：构造一笔违规 trade，期望 `createBuyTrade` 抛 `TradeComplianceError` 而非成功后再 alert。

---

### M-6 — `aborted` 命令状态游离在状态机文档之外

**证据**
- 引入位置：[KillSwitchService.abortPendingCommands](../../backend/src/live-trading/services/KillSwitchService.ts:225-249)，写 `status='aborted'`。
- 但 `LiveBrokerCommand.status` 注释 ([models/LiveBrokerCommand.ts:67](../../backend/src/models/LiveBrokerCommand.ts)) 与 [docs/live_trading_state_machine.md](../live_trading_state_machine.md) mermaid 都**未包含 aborted**。
- `BridgeCommandExpiryService.scanCommandsExpired` ([backend/src/live-trading/services/BridgeCommandExpiryService.ts:94](../../backend/src/live-trading/services/BridgeCommandExpiryService.ts)) 的 `WHERE status IN ('pending','dispatching','dispatched')` 不覆盖 aborted。

**影响**
- aborted 命令永远不会被 TTL 巡检覆盖，无终态清理路径；新人读 model 注释会以为不可能出现 aborted。

**修复方案**（**L 级，文档 + 注释，不改逻辑**）
- 把 `aborted` 加进 model 注释、加进 state_machine mermaid；明确"aborted 是终态，不需 TTL 巡检"。

---

## 2. 量化策略本身（前视偏差 / A 股约束 / 同源性）

### S-7 ⚠️ **生存者偏差**：回测 universe 强制 `is_listed=true`

**证据**
- [backend/src/quant/_helpers.ts:77](../../backend/src/quant/_helpers.ts)、[backend/src/services/QuantDataService.ts:67-75](../../backend/src/services/QuantDataService.ts) 全部 `WHERE is_listed=true`。
- 退市股从 universe 完全消失。

**影响**
- 跨年回测系统性高估历史回报（尤其是 2015、2018、2022 几年退市潮密集时段）。

**修复方案**（**S 级，但与 S-2 同步即可**）
- universe 改为 `delisting_date IS NULL OR delisting_date > as_of_date`（需先确认 `Stock` 表是否有 `delisting_date` 字段；若无，需补字段并从 AKShare 同步退市清单）。⚠️ 改 schema 需你确认。

**验证方式**
- 跑 2015-2020 5 年 MFA 回测，对比修复前后 total_return_pct，差值 ≥ 5% 视为修复生效（A 股退市股长期跑输市场）。

---

### M-8 — 因子时序错位：`MoneyFlowFactor` 等用 `Stock.circulating_market_cap`（最新 snapshot）做分母

**证据**
- [backend/src/quant/factors/library/MoneyFlowFactor.ts:70-72](../../backend/src/quant/factors/library/MoneyFlowFactor.ts)、`InsiderTradeFactor.ts`、`MarginFlowFactor.ts` 同款。

**影响**
- 回测较早日期时用"今天的市值"除"当时的资金流"，因子值有系统性偏差。

**修复方案**
- 改用 `StockValuationFactor.total_market_cap`（有 `factor_date` 字段）或 DailyBar 上的市值列。

---

### M-9 — 因子按"自然日 lookback"对齐而非交易日

**证据**
- [backend/src/quant/factors/library/MoneyFlowFactor.ts:24](../../backend/src/quant/factors/library/MoneyFlowFactor.ts) `WINDOW_DAYS=14`（注释"10 交易日 ≈ 14 自然日"）
- [backend/src/quant/factors/library/IndustryMomentumFactor.ts:31](../../backend/src/quant/factors/library/IndustryMomentumFactor.ts) `WINDOW_DAYS=7` 同款
- [backend/src/quant/factors/library/NorthboundFactor.ts:36](../../backend/src/quant/factors/library/NorthboundFactor.ts) `WINDOW_DAYS+10` 自然日兜底节假日

**影响**
- 春节/国庆窗口实际交易日少计，因子值偏小。

**修复方案**
- 改用 `TradingCalendar.previousNTradingDays(as_of, N)` 取交易日窗口（[backend/src/services/TradingCalendarService.ts](../../backend/src/services/TradingCalendarService.ts) 是否存在待确认）。

---

### M-10 — 因子 `as_of_date` 时序与"T 日 generate → T+1 撮合"未在调度上落实

**证据**
- `FactorPipeline.runForDate(T)` 写入 `factor_scores.trade_date=T`，**需 T 日收盘后才能算**。
- [MultiFactorAlphaStrategy.ts:578](../../backend/src/quant/strategies/MultiFactorAlphaStrategy.ts) `generateSignals(T)` 读 `tradeDate` 当日 factor_scores → 实际可成交日是 T+1。
- SchedulerService 没强制 "T 日 generate → T+1 BUY" 的撮合 lag。

**修复方案**
- 策略输出的 target 默认按 T+1 开盘价撮合；`SchedulerService` 在 "T 日收盘后" 调度 generate；下单 facade 加 `signal_date < trade_date` 校验。

---

### M-11 — `LowVolFactor` / `GradualBreakoutFactor` 等的 lookback 与 stop_loss 计算是否考虑停牌期跳过

**待确认**：未深入展开，需要后续单独跑 `quant/factors` 一轮 lint。

---

## 3. 风控与资金管理（盈利前提）

### S-12 ⚠️ **对账无主动告警**：差异长时间漂移无人发现

**证据**
- 实时对账：[backend/src/live-trading/services/LiveTradingService.ts:361-565](../../backend/src/live-trading/services/LiveTradingService.ts) — 仅在 GET `/api/live-trading/reconciliation` 时计算。
- EOD：[scripts/ops/end_of_day_reconciliation.js](../../scripts/ops/end_of_day_reconciliation.js) — 仅 cli，**不在 cron 注册**。
- 搜遍 [SchedulerService.ts](../../backend/src/services/SchedulerService.ts) + `jobs/`，**无任何任务**调 `getReconciliation` + 阈值告警。

**影响**
- `live_underweight / paper_only` 长时间漂移不报警；EOD 脚本依赖运维记得跑。

**修复方案**（**S 级**）
- 注册 cron `LIVE_RECONCILIATION_GUARD`（建议每日 10:30 + 14:30 + 15:30 三次盘中 + 16:00 收盘后），调 `getReconciliation` → `alignment_score < 70` 或 `live_only/paper_only > 3` 时写 `RiskAlert HIGH` → 自动走 `RealtimeAlertDispatcher` 飞书推送。
- ⚠️ 改 cron 配置可能影响线上调度负载，需你确认。

**验证方式**
- 集成测：mock 一份持仓差异，期望 cron 跑一次后 `RiskAlert.count` +1 且飞书 webhook 收到。

---

### M-13 — `DrawdownCircuitBreaker` fail-open 在 DB 抖动时失效

**证据**
- [backend/src/portfolio/PaperTradingFacade.ts:537](../../backend/src/portfolio/PaperTradingFacade.ts) 注释明确 "Failure-open: a DB outage in the guard simply lets the order proceed"。
- memory `sprint-27-28-29-l8-activation-results` 已经记录"fail-open 教训"，但此处仍是 fail-open。

**影响**
- DB 短暂抖动时大撤回保护失效；与 memory 教训冲突。

**修复方案**
- 改成 fail-closed + 抛 `RiskGuardUnavailableError`，配合上层 retry；同时补 DB 抖动告警通道。
- ⚠️ 是 fail-open 还是 fail-closed 取决于产品意图（保守 vs 流畅），需你确认。

---

### M-14 — 策略级 dry_run 默认值切换历史风险

**证据**
- [SchedulerService.ts:2596-2605](../../backend/src/services/SchedulerService.ts) Batch N 把 `STRATEGY_KILL_SWITCH_CHECK` 的 `dry_run` 默认从 true 改成 false。
- 但旧的 `task_parameters` 行可能仍有 `dry_run: true` 覆盖。

**修复方案**
- 写一次性 migration / 运维脚本扫所有 enabled 任务的 `task_parameters`，若 `task_key='STRATEGY_KILL_SWITCH_CHECK'` 且显式 `dry_run=true` → 写告警让人决定是否清零。
- ⚠️ 改 task_parameters 是高风险，需你确认每条。

---

### M-15 — `aiPollingQueue` 无 `jobId` 去重，同 `task_id` 可能并发

**证据**
- [backend/src/services/AutomatedRecommendationLoopService.ts:2165](../../backend/src/services/AutomatedRecommendationLoopService.ts) `aiPollingQueue.add(...)` 未传 `{jobId}`。
- worker [backend/src/jobs/aiPollingWorker.ts](../../backend/src/jobs/aiPollingWorker.ts) 无去重。

**影响**
- 同一 TradingAgents `taskId` 的 polling 失败 retry 可能 enqueue 多条同时跑，重复落库 `AIInvestmentSignal`（UNIQUE 约束兜底，但浪费 AI 调用）。

**修复方案**
- `add(..., {jobId: \`ai-poll-\${taskId}\`, removeOnComplete: true})`。

---

### M-16 — `runShadowAutopilot` 幂等保护比 `approveDraft` 弱

**证据**
- [backend/src/live-trading/services/LiveTradingService.ts:746-770](../../backend/src/live-trading/services/LiveTradingService.ts) `createDraft` 后直接 `markDraftShadowExecuted`，无 `SELECT FOR UPDATE`。

**影响**
- 并发两个 cron 触发可能各产生一份影子记录。影子不下真单，量级低，但 `RecommendationTradeOutcome` 会被双计入。

**修复方案**
- 复用 `approveDraft` 的事务模板，包一层 `SELECT FOR UPDATE`。

---

## 4. 工程健壮性

### M-17 — `PaperTradingFacade.placeOrder` 行情陈旧度 guard 只看 daily_bar 3 天

**证据**
- [backend/src/portfolio/PaperTradingFacade.ts:495-509](../../backend/src/portfolio/PaperTradingFacade.ts)；jsdoc 自承认 "未来可接 RealtimeQuoteService 同款 30min 阈值"。

**影响**
- 盘中行情中断时仍以 3 天前的 daily_bar 收盘价下单。

**修复方案**
- 用 `RealtimeQuoteService.getQuote(symbol)` 的 `timestamp` 计算 minutes lag；> 30min → 拒单。

---

### M-18 — bid/ask 数据通路不稳：`PaperTradingAutomationService` 几乎全走 high_low_proxy

**证据**
- [backend/src/services/execution/ExecutionFeasibilityService.ts:99-107,708](../../backend/src/services/execution/ExecutionFeasibilityService.ts) 区分 `real_bid_ask` vs `high_low_proxy`。
- [backend/src/portfolio/internal/PaperTradingAutomationService.ts:2351,4386,4451](../../backend/src/portfolio/internal/PaperTradingAutomationService.ts) 注释承认"akshare/daily_bar fallback 时缺"。

**影响**
- "真盘口"在生产路径上多数时候是 proxy；与 memory `sprint-34` 的"真生效"叙述不一致。

**修复方案**
- 加 Prometheus metric `feasibility_bid_ask_source{type=real|proxy}`，上线后看真实比例；< 70% 时回头查 RealtimeQuote 抽取链路。

---

### L-19 — TradingAgents 基址硬编码 10 处

**证据**
- 见 [closed_loop_architecture_2026_06_18.md](closed_loop_architecture_2026_06_18.md) §3.3。

**影响**
- 改服务器要改 10 个文件；内部 IP 暴露在 git。

**修复方案**
- 抽 `backend/src/config/externalServices.ts`，导出 `TRADING_AGENTS_BASE_URL`；10 处全部 import 这个常量。
- ⚠️ 把 `47.93.224.109` 从代码里移到 `.env.example` 才不算"暴露内部 IP"，但 git 历史还在。需你确认是否要做 git filter-repo 或者接受历史现状。

---

### L-20 — 计量学不一致：annual 用自然日 365，sharpe 用交易日 252

**证据**
- [QuantBacktestEngine.ts:324](../../backend/src/quant/backtest/internal/QuantBacktestEngine.ts) `annual = (1+r)^(365/d) - 1`
- 同文件 `:329-334` `sharpe = mean/std × √252`

**修复方案**
- 统一改 252。

---

### L-21 — bridge nonce 清理已有，但与 5min 滑窗的关系建议落到状态机文档

**证据**
- [backend/src/live-trading/services/BridgeCommandExpiryService.ts:172-182](../../backend/src/live-trading/services/BridgeCommandExpiryService.ts) `cleanupNonces`。
- [backend/src/live-trading/middlewares/bridgeAuth.ts:24-43](../../backend/src/live-trading/middlewares/bridgeAuth.ts)。

**修复方案**
- 文档化即可，不动代码。

---

## 5. "能否赚钱"的客观评估（基于回测产出指标）

### S-22 ⚠️ 回测指标当前**不可信**，因为：

1. **核心策略 trade_count=0**（S-1）→ 没有真实 sharpe/最大回撤/胜率/盈亏比/换手率/成本占比可供评估；这些数字在 dashboard 上**全是 evaluate() stub 产物**。
2. **涨跌停口径错**（S-2）→ 修复后回测的成交集会扩大，sharpe / 换手率全部变化。
3. **生存者偏差**（S-7）→ 修复后年化收益会下降数个百分点。
4. **费率分叉**（M-23）→ 回测扣 0.025% commission + 0.2% slippage；实盘 `PaperTradingFacade.ts:519-521` 硬编码 0.03% commission + 0.1% slippage。两套口径，回测的 sharpe 不能直接信。
5. **缺失指标**：Calmar / Sortino / turnover ratio / cost-as-pct-of-alpha / capacity 全部缺失。

### M-23 — 回测↔实盘费率分叉

**证据**
- [backend/src/quant/backtest/AShareConstraintEngine.ts:115-120](../../backend/src/quant/backtest/AShareConstraintEngine.ts)：默认 commission=0.00025, slippage=0.002。
- [backend/src/portfolio/PaperTradingFacade.ts:519-521](../../backend/src/portfolio/PaperTradingFacade.ts)：硬编码 commission=0.0003, slippage=0.001，注释承认"避免改动历史 realized_pnl"。

**修复方案**
- 把费率常量集中到 `backend/src/constants/aShareFees.ts`，回测/实盘都 import；历史 `realized_pnl` 若不能动，至少在产生新 trade 时口径统一。

---

### S-24 ⚠️ **最关键 3 个风险点 + 修复路径建议**

| # | 风险 | 一句话总结 | 当下处置 |
|---|---|---|---|
| 1 | **核心策略未真正回测过** (S-1) | MFA / DragonHead / Breakout / LeftSideReversal 等组合级策略 trade_count=0 | **修复回测引擎支持 generateSignals**；在拿到这些策略的真实 sharpe/MDD 之前**不要放大模拟盘资金**，更不要切真实账户 |
| 2 | **涨跌停约束在回测/实盘三套不复用** (S-2 + S-3) | 创业板/科创板/北交所/ST 全错；实盘 placeOrder 完全不拦涨停 | **抽 `getLimitPctForSymbol` 共用**；模拟盘 BUY 路径马上加拦截（低风险改动），实盘路径配置统一 |
| 3 | **对账无主动告警 + 5 wizard 是事后** (S-12 + S-5) | 漂移无人发现；违规下单照样执行 | **补 cron + RiskAlert HIGH**；若 5 wizard 本意 pre-trade，挂到 `createBuyTrade / approveDraft` |

**结论判断**：
- **模拟盘**：除上述修复外，链路本身完整、状态机严密、bridge 受七重闸门保护，**继续在模拟盘运行是安全的**。
- **接入真实账户的 prerequisite**：S-1、S-2、S-3、S-12、S-7 全部修复 + 至少一只样本股的 6 个月真实模拟盘 vs 实盘 alignment_score ≥ 85；否则**不具备**真实环境盈利前提。

---

## 修复优先级建议（执行顺序）

| 阶段 | 项目 | 风险 | 是否需我确认 |
|---|---|---|---|
| 1.1（立刻可做） | S-2 抽 `getLimitPctForSymbol`、L-20 统一 252、L-19 抽 `TRADING_AGENTS_BASE_URL`、M-9 因子用交易日窗口 | 低 | 直接做 |
| 1.2 | S-3 PaperTradingFacade BUY 加涨停拦截、M-15 aiPollingQueue jobId 去重、M-17 行情陈旧度改 RealtimeQuote 30min | 中（改 portfolio 路径） | ⚠️ 确认 |
| 1.3 | S-12 注册对账 cron + RiskAlert HIGH、M-23 费率常量统一 | 中（cron 改 + RiskAlert 噪音） | ⚠️ 确认 |
| 2.1（结构性） | **S-1 回测引擎支持 generateSignals** | 高（动 QuantBacktestEngine 核心） | ⚠️ 确认 |
| 2.2 | S-4 禁用 same_close 或排除 T 日 bar、S-7 加 delisting_date 过滤 | 中（可能要补 Stock 表字段） | ⚠️ 确认 schema |
| 2.3 | S-5 决定 TradeComplianceChecker 是 pre 还是 post | 高（产品意图） | ⚠️ 确认 |
| 3 | M-6 文档同步 aborted、M-14 task_parameters 巡检、M-18 bid/ask metric、M-8 因子分母 | 低-中 | 滚动做 |

---

## 阶段一交付物清单（修复后）

1. **代码改动**：上述 1.1 全做、1.2/1.3/2.x 按你确认结果做。
2. **测试**：每条 S/M 级带至少 1 个单元/集成测试。
3. **回测验证脚本**：`backend/scripts/quant-audit/verify_composite_backtest_parity.ts`（S-1 验证）。
4. **文档**：本报告 + 状态机文档补 `aborted` 终态 + 部署文档补对账 cron。
5. **新指标**：Prometheus `feasibility_bid_ask_source{type}` + `reconciliation_alignment_score` + `backtest_trade_count{strategy_key}`。
