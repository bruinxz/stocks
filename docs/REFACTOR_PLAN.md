# 系统改造方案 (Refactor Plan)

> **配套文件**: 决策依据见 `SIGNAL_FIRST_PLAN.md` (下称"计划档")。本文件是**执行档**: 把计划档的方向落到**当前线上每一个模块**上, 逐个标注 **保留 / 改造 / 删除**, 覆盖前后端 + docs + scripts。
>
> **只保留最新结论, 不留修订历史**。数字锚定见计划档 §11.1 / §11.2。

---

## 0. 主线 (一句话) + 改造原则

**主线**: 一个信号源 → 两个出口 (现在拍板 / 以后自动执行) → 回测背书可信度。
落到结构上 = **核心 70% ETF 因子轮动 + 卫星 20% 题材事件 + 现金 10%**。

**改造原则** (对应用户"大刀阔斧、不留系统债"):

1. **只留主线用得上的**。凡是为"全市场个股扫描 / 日内交易 / 20 策略同质化 / 伪共识融合"服务的模块, 一律删。
2. **改造 > 新建 > 保留原样**。已有的 EV gate、回测 7 关、组合风控、通知栈是资产, 改造复用; 不重复造轮子。
3. **删除必须可回滚 (<15 min)**。删除走 `git rm` + 单独 commit, 每类一个 commit, 出问题 `git revert` 即回。
4. **删表 (开发期直删)**: 现处开发阶段, DB 表 (models) 删前 grep 确认无 runtime 引用后**直接删**, 无需停写观察期; 删前建议一次性 `pg_dump` 备份兜底。代码删除同样立即执行。
5. **主线清晰**: 删完后, `backend/src/` 的目录结构应能一眼看出"ETF 轮动 / 卫星 / 风控 / 回测 / 通知"五条线。

**改造后的目标目录形态** (backend/src/):
```
data/        → 留 ETF/因子/指数/公告 RSS + 个股实盘查看数据(实时行情/龙虎榜/北向); 删社媒情绪/KOL/热搜等
quant/       → factors(ETF级) + backtest(7关) ; 删 engine/strategies
portfolio/   → RebalanceEngine + sizing + risk (保留主力)
services/    → 精简到 ~40 个 (ETF轮动/卫星/confidence/通知/复盘)
live-trading/→ 冻结保留 (未来实盘接口, 现在不动)
jobs/        → 月度再平衡 + 卫星轮询 + 数据更新 (删日内 burst)
models/      → ~92 个 (删日内/融合/个股因子相关表; 龙虎榜/北向表保留供查看)
```
删掉整目录: `layers/` (L1-L8 空壳), `backtest/` (src 根重复), `quant/engine/`, `quant/strategies/`。

---

## 1. 后端改造总表

| 目录 | 现状 | 保留 | 改造 | 删除 |
|---|---|---|---|---|
| `services/` | 116 文件 + 21 子目录 | ~40 | ~10 | ~66 |
| `quant/strategies/` | 30 策略 | 0 | 0 | 30 (整删) |
| `quant/engine/` | 融合引擎 | 0 | 0 | 整删 |
| `quant/factors/` | 4 因子(个股级) | 0 | 4 (改 ETF 级) | 0 |
| `quant/backtest/` | 11 文件 (7关套件) | 全留 | 0 | 0 |
| `backtest/` (src根) | engine/indicators/metrics/strategies | 0 | 0 | 整删 (与 quant/backtest 重复) |
| `jobs/` | 12 文件 | 6 | 4 | 2 |
| `data/sources/` | 36 client | ~10 | 0 | ~26 |
| `data/services/` | 25 sync | ~10 | 0 | ~15 |
| `portfolio/` | 38 文件 | ~32 | ~4 | ~2 |
| `live-trading/` | 28 文件 | 全留(冻结) | 0 | 0 |
| `layers/` | L1-L8 空壳 | 0 | 0 | 整删 |
| `models/` | 128 表 | ~92 | 2 | ~34 (开发期直删) |
| `api/routes` | 32 | ~18 | 2 | ~12 |
| `api/controllers` | 37 | ~20 | 2 | ~15 |

**总量**: 后端业务代码删除约 45-50% (在计划档 §7.4 的 40-50% 区间内, 本执行档按逐模块清点略偏上限)。

---

## 2. 后端逐模块

### 2.1 services/ — 顶层 116 文件

**删除 (日内交易类, 我们不做日内)**:
`AfternoonKickDetector` `OpeningRushDetector` `LastHourMomentumDetector` `IntradayMomentumDetector` `IntradayReversalDetector` `IntradayPriceVolumeAnomalyDetector` `IntradayOpportunityWatcher` `IntradayOpportunityPusher` `IntradayKlineSyncService` `IntradayUniverseService` `IndustryFlowIntradayService` `CallAuctionAnomalyService` `AuctionSnapshotSyncService` `LimitUpBoardDetector` `OvernightSignalSyncService`

**删除 (全市场个股扫描 / 融合 / 同质化, 计划档 §7.3 毒源)**:
`QuantRecommendationService` `AutomatedRecommendationLoopService` `MarketTopDetector` `BehaviorBiasDetector` `QALeadingSignalDetector` `SourceTypeWinRateAdjuster` `StrategyKellyStatsService` `StrategyCapacityEstimator` `StrategyKillSwitchMonitor` `StrategyCopilotService` `StrategyResearchCenterService`

**删除 (个股情绪 / 社媒 / KOL / 问答, 卫星改用 RSS+公告, 见计划档 §6.1)**:
`KOLAggregatorService` `EastMoneyQATopicService` `MarketSentimentIndexService` `MarketBreadthService` `IndustrySentimentAggregator` `EarningsForecastWatcher`
> 注: 龙虎榜/北向**数据本身保留**供个股查看 (见 §2.6 / D3), 只删"把它当推荐信号"的消费方。

**删除 (recommendationLoop 相关 snapshot / 审计)**:
`RecommendationLoopPolicySnapshotService` `BudgetPolicyVersionSnapshotService` `FieldGateAdjustmentAttributionService` `TaskParameterAuditService`

**改造**:
| 模块 | 改造 |
|---|---|
| `ThemeFermentationDetector` | 卫星核心, 先修 §6.2 数据链 (RSS+公告), source_type 独立 |
| `BullishEventDetectorService` | 卫星事件源, 改 source_type 不再借 quant_recommendation |
| `AIInvestmentSignalService` | 扩 schema 到 §2.2 Signal 结构 (统一信号原子) |
| `RecommendationTradeOutcomeService` | 加 rebalance_id / theme_id 字段 |
| `TodaySignalsService` / `TodayCommandCenterService` | 改为展示 ETF 排名 + 卫星题材, 去掉个股推荐 |
| `MarketJudgmentService` / `MarketEnvironmentService` | 保留 regime 判断, 喂给战略镜子硬阈值 (§8.3) |

**保留 (风控 / 通知 / 复盘 / 数据健康)**:
`BlackSwanDetectorService` (§0.2 例外) 及 black-swan 系列 (`BlackSwanPostmortemService` `BlackSwanImprovementSuggestorService` `BlackSwanQuarterlyReportService`)
通知栈: `NotificationService` `EmailNotificationService` `FeishuBotWebhookService` `FeishuTaskReportService` `AliyunSmsService` `WeChatOAService` `WeChatOAClient` `CriticalAnnouncementPushService` `RealtimeAlertDispatcher` `SystemAdminAlertPusher` `webhookFailOpen`
复盘: `WeeklyReviewReportService` `ReviewPerformanceCenterService` `EnhancedTradingJournalService` `TradePostmortemService` `TradeRootCauseClassifier` `CounterfactualBaselineService` `DailyTradingDigestService`
数据健康: `DataFreshnessCheckService` `DataHealthStatusService` `DataQualityService` `DataQualityDeepCheckService` `RuntimeSchemaHealthService` `SystemHealthDetailService` `DailyHealthReportService` `TaskAutomationHealthService` `DbBackupService` `CleanupOldDataService`
调度: `SchedulerService` (改造: 92 类 cron 裁剪到月度再平衡+卫星轮询+数据更新+健康检查, 删日内 cron)
风控辅助: `RiskAlertService` `RiskThresholdAttributionService` `RiskThresholdStabilityService` `SizingAuditService` `PortfolioCorrelationService` `TradeComplianceChecker` `TradePolicyExplainService`
研究辅助: `AnalysisEngineService`(月度调仓给用户看行业分析) `TechnicalAnalysisService` `AnnouncementNLPService` `MarketBriefService`

**历史遗留判定** (引用面核查后定案): **留 5** — `ExposureCoachService`(组合 exposure API 展示) `BenchmarkIndexService`(ETF 基准对比) `RealtimeIndexService`(大盘指数展示/regime) `MarketBriefService`(市场简报展示) `UserFeedbackService`(用户反馈); **删 3** — `QuantOpeningPreflightService`(**订正**: 消费方 `StrategyResearchController` 仍在, 已随批3 controller 删除一并处理, 批2 暂留) `OpeningReadinessService`(开盘就绪, 偏日内; 顺清 TodayController/Scheduler/TodayCommandCenter 调用点) `SparklinePngService`(消费方 IntradayOpportunityPusher 已删; 前端 sparkline 是客户端 Sparkline20d/MiniCharts, 与此后端 PNG 无关)

### 2.2 services/ 子目录 (21 个)

| 子目录 | 处置 |
|---|---|
| `meta-v2/` (EVDecisionService + IsotonicCalibrator) | **保留核心** — EV gate 种子 (§5.2) |
| `meta/` (旧 meta-label) | 删除 — 被 meta-v2 取代 |
| `factor/` | 改造 — 归并到 ETF 因子计算 |
| `portfolio/` | 保留 — 组合服务 |
| `execution/` | 保留 — 下单执行 (接 EV gate) |
| `governor/` | 保留 — equity curve governor (风控) |
| `regime/` | 保留 — 市场状态, 喂给战略镜子 |
| `black-swan/` | 保留 — §0.2 例外 |
| `postmortem/` `tca/` `attribution/` | 保留 — 复盘归因 |
| `announcement/` `event-intelligence/` | 改造 — 卫星事件源 (RSS+公告) |
| `analysis-engine/` | 保留 — 月度行业分析 |
| `recommendationLoop/` | 删除 — 全市场推荐循环 (旧主线) |
| `qa/` `kol/` | 删除 — 个股问答/KOL 情绪 |
| `research/` `playbook/` | 保留 — 战法库 reference (计划档 §7.1) |
| `integration/` | **冻结不接** ✅D4 — 现阶段不接外部系统, 代码保留不动 |

### 2.3 quant/

| 子目录 | 处置 |
|---|---|
| `strategies/` (30 个) | **删 29 留 1** (D10-A) — 删 29 个追涨同质化变种(计划档 §7.3 毒源); 保留/新建 1 个 ETF 因子策略类作为 `strategyRegistry` 唯一注册项, 供 7 关回测/纸面交易/绩效看板消费 |
| `engine/` (含 QuantFusionService 2330 行) | **瘦身保留** (D10-A) — 删 `QuantFusionService`(伪共识毒源)+ `QuantFusionAuditService`; **保留 `StrategyRegistry`/`StrategyEngine`** 骨架(仅注册 1 个 ETF 因子策略), 因 7 关回测/PaperTrading/绩效看板反向依赖它。⚠️ 删 fusion 前先断 §2.5 列出的 6 处 `QuantFusionAudit` 消费方 |
| `factors/library/` (Value/Quality/LowVol/Momentum) | **改造** — 从个股打分改 ETF 打分 (计划档 §4.1, 权重 V0: Value .40 Quality .30 LowVol .30 Momentum .0 影子) |
| `backtest/` (11 文件 7关套件) | **全留** — WalkForward/Overfit/CostSensitivity/RegimeSegmented/MonteCarlo/AShareConstraint (§9.2 七关验收)。⚠️ 全线依赖 `strategyRegistry`(QuantBacktestEngine/GridSearch/Bayesian/WalkForward), 故 engine 只能瘦身不能整删(D10-A) |
| `health/` `performance/` `workflow/` `types/` | 保留 — 回测支撑 |

### 2.4 backtest/ (src 根, 独立于 quant/backtest)

**整删** — `engine/indicators/metrics/strategies` 与 `quant/backtest/` 功能重复, 属早期遗留。
> **⚠️ 删前必做前置切换** (审计发现保留方仍连 src 根 backtest, 直接删会编译崩): (a) `api/controllers/BacktestController.ts` import 的是 `src/backtest/engine`, 需改指 `quant/backtest/` 或随其一并处置; (b) `jobs/backtestJob.ts` + `jobs/worker.ts` import `src/backtest/engine` + 简单策略, 需切到 7 关的 `quant/backtest`(见 §2.5 更正)。两处断开后再 `git rm -r src/backtest`。

### 2.5 jobs/ (12 文件)

| 文件 | 处置 |
|---|---|
| `aiPollingBurstDetector` | 保留 — 实为 **AI 轮询失败 burst 监控** (运维告警基建, 非日内交易信号); 被 `aiPollingWorker` 消费, 引用面核查后定案保留 |
| `aiPollingEnqueue` `aiPollingQueue` `aiPollingWorker` | 改造 — 从全市场个股轮询改卫星题材轮询 |
| `dataUpdateQueue` `dataUpdateWorker` | 改造 — 数据源精简后同步调整 |
| `quantBacktestQueue` `quantBacktestWorker` | 保留 — **真** 7 关回测队列 (连 `quant/backtest`) |
| `backtestJob` | **改造** — 审计发现它连的是要删的 `src/backtest/engine`+简单策略, 非 7 关; 需切到 `quant/backtest` 或与 src/backtest 一并删 |
| `queue` `worker` | 保留 — 基础队列设施 |

> **⚠️ 删 QuantFusionService 的连带清单** (审计新增, 原计划漏列): `QuantFusionService`(伪共识)与 `QuantFusionAudit`(审计 model)是两回事。删 fusion service + audit service 前, 必须先断这 6 处 audit 消费方: `config/database.ts:39`(注册)、`models/index.ts:38`(barrel export)、`index.ts:354`、`services/RecommendationTradeOutcomeService.ts:13`、`jobs/aiPollingWorker.ts:19`(用 QuantFusionAuditService)、`services/TodayCommandCenterService.ts:7`; 另有 `runDailyPipeline` 两处调用: `scripts/reset-paper-trading-and-run-quant.ts:7/70`(批7 脚本清理)、`services/AIInvestmentSignalService.ts`(改造为接 ETF 因子/EV gate, 见 §2.12)。若审计表本身要保留供追溯, 则只删 service 不删 model, 但仍需摘 aiPollingWorker 的写入调用。

### 2.6 data/

**sources/ 保留 (~10)**: `TushareClient` `BaostockClient` `AKShareClient` `PythonMarketDataClient` `MarketDataProvider` `ETFFlowClient` `IndexComponentClient` `AnnouncementClient` `CombinedDataSource` + **个股实盘查看数据** `DragonTigerClient`(龙虎榜) `NorthboundDataClient`(北向) — 后两者**仅作个股详情页只读展示, 不再喂推荐/策略** (D3)。

**sources/ 删除 (~26)**: 社媒情绪/KOL/热搜/融资融券/股东/限售等 —
`SnowballHotKeywordClient` `EastMoneyQAClient` `StockQAClient` `MarketHotSearchClient` `SocialSentimentClient` `MarginBalanceClient` `MarginTradingClient` `ShareholderCountClient` `ShareholderTradeClient` `RestrictedShareClient` `LimitUpClient` `LimitDownClient` `OvernightSignalClient` `BlackSwanClient`(改用探测器) `EarningsForecastClient` `AnalystForecastClient` `KOL/社媒类` `MarketNewsClient`(改 RSS) `IndustryFlowClient` `DividendHistoryClient` `TencentFinanceClient` `SinaFinanceClient` `FinancialReportClient`(个股财报, ETF 不需) 等 — 逐个 grep import 确认后删。

> **注**: `data/sources` 删除前必须 grep 全仓 import, 有的 client 被 sync service 间接引用。删除顺序: 先删 sync service → 再删 client。龙虎榜/北向 client 保留但要确认只被查看链路引用、不被已删策略引用。

**services/ (sync) 保留 (~10)**: `DataSyncService` `DataService` `LocalDataStore` `RealtimeQuoteService` `ETFFlowSyncService` `IndexComponentSyncService` `IndustrySyncService` `DataSourceHealthService` + `DragonTigerSyncService` `NorthboundSyncService`(供查看)。

**services/ (sync) 删除 (~15)**: `SnowballHotKeywordSyncService` `SocialSentimentSyncService` `StockSentimentSyncService` `ShareholderTradeSyncService` `ShareholderCountSyncService` `RestrictedShareSyncService` `MarginTradingSyncService` `LimitUpSyncService` `MarketHotSearchSyncService` `MarketNewsSyncService` `DividendHistorySyncService` `EarningsForecastSyncService` `AnalystForecastSyncService` `FinancialReportSyncService` `StockFactorService`(个股因子) 等。

### 2.7 portfolio/ (38 文件) — 高复用, 主力保留

**保留**: `RebalanceEngine` `PositionSizingPolicy` `PortfolioReturnSimulator` `PaperTradingFacade`
`risk/` 全套 (12 个 guard): `PerStockStopLossGuard`(即 PR-L 保命) `DrawdownCircuitBreaker` `PositionLimitGuard` `TrailingStopGuard` `IndustryConcentrationGuard` `BlackSwanWatchdog` `RestrictedShareWatchdog` `MarketRegimeAlertService` `MorningRiskCheckupService` `GuardSellExecutor` `RiskGuardFailClosed` `SizingPolicyService` `SizingLimitConsistency`
`sizing/SignalDrivenSizing` — 信号驱动仓位
`internal/` 大部分: `PaperTradingAutomationService`(改造接 EV gate) `PaperTradingPlanService` `CompositeRebalanceService` `PortfolioConstructionAdapter` `feasibilityGate` `preTradeGuards` `positionProtectionDefaults` `positionAtrHelpers` 等

**改造**: `PaperTradingAutomationService` (下单排序改 EV gate, 不用 confidence_score DESC — 计划档 §7.2); `PositionLimitGuard` (阈值上调单仓 15%/单板块 25%, 核心总仓位≤70% 硬顶 — PR-M4)

**删除**: `l8-activation.ts` (随 layers 删); `crossPortfolioDedup` (多组合去重, 单组合下无用 — ✅D5 删)

### 2.8 live-trading/ (28 文件) — 冻结保留

**全部保留但冻结**: 这是未来实盘接口子系统 (brokers/market-data/controllers/routes/services + KillSwitch + 审计)。现阶段跑纸面, **不动代码、不接线上**, 待卫星纸面毕业 (§5.1 n≥20) 才激活。删除风险高 (合规审计链), 保留成本低 (不参与主流程)。

### 2.9 layers/ L1-L8 — 整删

**整删** — 审计确认 L1-L8 是 Sprint 24 的 barrel re-export 空壳, **零 runtime import**。删 `backend/src/layers/` 整目录 + `portfolio/internal/l8-activation.ts` + `ARCHITECTURE.md`。底层实体已在各自物理路径 (portfolio/quant/services), 不受影响。

### 2.10 models/ (128 表) — 开发期直删 (删前确认无引用)

**删除 (~34, 开发期直删: grep 确认无 runtime 引用 → 直接删; 删前 pg_dump 备份)**:
- 融合/策略同质化: `QuantFusionAudit` `QuantSignal` `QuantStrategyModel` `QuantStrategyWeight` `QuantStrategyExperiment` `QuantStrategyParamValidation` `QuantStrategyParamVersion` `QuantStrategyPerformanceSnapshot` `QuantResearchArtifact` `QuantResearchExperiment` `StrategyPortfolioResult` `StrategyTcaMultiplier` `PersonalityStrategyMatchReport`
- 日内/竞价: `IntradayKline30Min` `IntradayOpportunityPush` `IndustryFlowIntraday` `AuctionSnapshot` `OvernightSignal`
- 社媒情绪/问答/股东/融资: `SnowballHotKeyword` `SocialSentimentSnapshot` `StockSentiment` `MarketHotSearch` `KOLAuthorStat` `KOLOpinion` `EastMoneyQAStat` `EastMoneyQATopic` `ShareholderCount` `ShareholderTradeRecord` `RestrictedShareRelease` `MarginTradingBalance` `BlockTrade`
- 个股因子: `StockFundamentalFactor` `StockMoneyFlowFactor` `StockValuationFactor` `DailyScreener`
- 推荐循环 snapshot: `RecommendationLoopPolicySnapshot` `BudgetPolicyVersionSnapshot`

> **保留供查看**: `DragonTigerBoard`(龙虎榜) `NorthboundHolding`(北向) 不删 — 转为个股详情页只读数据源 (D3)。

**改造 (2)**: `AIInvestmentSignal` (扩 §2.2 schema); `RecommendationTradeOutcome` (加 rebalance_id/theme_id)

**保留 (~92)**: 组合/纸面 (`PaperTrading*` `PortfolioConstructionResult` `PortfolioSimulation`), 回测 (`QuantBacktestResult/Task/Trade` `WalkForwardResult` `OptimizationRun/Result` `MonteCarloResult` `RegimeBacktestResult` `CostSensitivityResult` `OverfitMetrics相关`), 因子(ETF级) (`FactorScore` `FactorICResult` `FactorCorrelationResult`), 实盘 (`Live*` 全留冻结), 风控 (`RiskAlert` `MorningRiskCheckup` `EquityCurveGovernorState` `SizingDecisionAudit`), 数据基础 (`Stock` `DailyBar` `RealtimeQuote` `IndexComponent` `ETFFlow` `ETFCreationRedemption` `MacroIndicator` `IndustryFlow` `DragonTigerBoard` `NorthboundHolding`), 通知/复盘/黑天鹅/公告 相关表。

### 2.11 api/ routes + controllers

**删除 routes**: `advancedQuant` `strategy` `strategyResearch` `sentiment` (个股情绪) `signalTrace`(旧) `analysisEngineShadow`(✅D6 删) — 及对应 controller。
**删除 controllers**: `QuantRecommendationController` `AdvancedQuantController` `StrategyController` `StrategyResearchController` `SentimentController` `ScreenerController` `AISignalController`(旧) 等。
**改造**: `V3RecommendationController` (改 ETF 排名 + 卫星题材展示 — 计划档 §7.1); `PaperTradingController` (接 EV gate)。
**保留 (含删前必做的断引用)**: `PortfolioController` `BacktestController`(⚠️ 现 import `src/backtest`, 删前改指 `quant/backtest`) `FactorController`(⚠️ 现 import `quant/strategies/MultiFactorAlphaStrategy`, 删策略前需断开/改用 ETF 因子服务) `RiskController` `RiskAlertController` `ReviewController` `JournalController` `TodayController` `DataController` `MarketController` `MacroController` `BlackSwanEventController` `AuthController` `UserController` `SettingsController` `TaskController` `LogController` `DocsController` `AnnouncementController` `StockController`(个股实盘查看) 等。
**新增定性**: `QuantController`(审计发现未定性; 现 import `quant/engine/StrategyEngine`+`quant/strategies`+`quant/backtest`) → **改造** — 剥离 engine/strategies 依赖, 仅保留其对 `quant/backtest` 的调用(接一键回测), 或若无独立价值则随 engine/strategies 删。
**改造需断引用**: `TodaySignalsService`(§2.1 已列改造) 现 import `MultiFactorAlpha/DragonHeadMomentum/EarningsSurprise` 三个将删策略, 改造时必须断开这三处 import。

### 2.12 通知时机 (使用已有飞书 webhook, 时机由方案锚定)

通知栈整体保留 (§2.1), 复用现有 `FeishuBotWebhookService` + `NotificationService` + `webhookFailOpen`。删掉的只是"日内高频推送"的触发源, **通知能力本身全留**。改造后触发时机收敛为 5 类:

| 触发时机 | 内容 | 通道 | 频率 |
|---|---|---|---|
| **月度再平衡信号生成** | 核心 ETF 轮动换仓建议 (排名变化 + EV gate 结论) | 飞书 webhook | 月度 (再平衡日) |
| **卫星题材事件命中** | ThemeFermentation / BullishEvent 触发的题材 + 建议动作 | 飞书 webhook | 事件驱动 (轮询命中即推) |
| **风控告警** | 止损 / 回撤熔断 / 黑天鹅 / 单仓超限 | 飞书 webhook + (严重级) SMS | 实时 |
| **数据/任务健康异常** | 数据源过期、同步失败、cron 失败 | 飞书 webhook (管理员) | 异常即推 |
| **周度复盘报告** | 组合表现 + 归因 + 下周关注 | 飞书 webhook | 周度 |

原则: 高价值、低噪声 — 删掉的是"每几分钟一条日内异动"这类噪声推送, 保留"要你拍板/要你知道风险"的关键推送。

---

## 3. 前端逐模块

### 3.1 pages/ (顶层)

| 页面 | 处置 |
|---|---|
| `HomeWorkspace.tsx` | 改造 — 删装饰(见 3.3), 主视图改 ETF 排名+卫星+现金 三栏 |
| `RecommendationTrace.tsx` | 删除 — 个股推荐追溯 (旧主线) |
| `StockDetail.tsx` | **保留** — ETF 详情 + 个股实盘数据查看页 (实时行情 / 龙虎榜 / 北向 只读展示, D3 已拍板) |
| `TaskScheduler.tsx` `SystemLogs.tsx` `HealthMonitor.tsx` `DataUpdateStatus.tsx` `Login.tsx` | 保留 — 运维/登录基础页 |

### 3.2 pages/workspace/ tabs

**保留/改造**:
- `FactorWorkspace.tsx` + `ETFFlowTab` `MacroEnvTab` `PolicyNewsTab` → 改 ETF 因子视图 (保留)
- `PortfolioWorkspace` `LabWorkspace`(+WalkForward/Overfit/ShadowRun/Leaderboard 回测 tab) → 保留
- `SettingsWorkspace` (+RiskParameters/SizingPolicy/PortfolioConstruction tab) → 保留
- `TodayWorkspace.tsx` → 改造 (删 `IntradayCapitalFlowTab`)
- `EasyQuantWorkspace` + `easyQuant*` helpers → **保留** (一键回测入口, D2 已拍板; 仅接 7 关回测, 不接已删的 30 策略)
- `DataWorkspace` `DocsWorkspace` `SystemWorkspace` → 保留

**删除**:
- `FactorWorkspace.BlockTradesTab` (大宗交易信号 — 已删数据源; 龙虎榜/北向查看移到 StockDetail)
- `TodayWorkspace.IntradayCapitalFlowTab` (日内资金流)
- `SettingsWorkspace.StrategyKillSwitchTab` (30策略随后端删)
- `SettingsWorkspace.AnalysisEngineTab` (✅D6 删, 随 analysisEngineShadow)
- `LabWorkspace.AdvancedQuantTab` (删 — 接 30 策略, 随策略删)

### 3.3 components/ 装饰 (计划档 §7.2, 删花哈保内容)

**删除装饰组件**: `stripe/FlyLine.tsx` (飞线) `stripe/CountUp.tsx` (数字滚动) `index.css` 扫光动画 (lines ~18427-18479) `HomeWorkspace.tsx` 3D tilt (lines 1095/1895/2056/2097)。
**保留基础**: `stripe/StatusBadge` `LiveIndicator` `SectionDivider` `EmptyStripe` `MiniCharts` `charts/` `portfolio/` `backtest/` `trading/` `stock/`(ETF复用 + 个股查看) 等业务组件。

---

## 4. docs/ — 过时文档清理

**删除 (旧主线 / 日内 / 30 策略)**:
- `docs/research/intraday_anomaly_playbook_2026_06_29.md` (日内战法)
- `docs/trader-system/30_strategy_overview.md` (30 策略概述)
- `docs/trader-system/06_data_limit_up.md` `10_data_sentiment_news.md` (涨停/情绪数据源)

**改造 (更新到新主线)**:
- `SIGNAL_FIRST_PLAN.md` (决策档, 主) — 已是最新
- `trader-system/20_alpha_engine_overview.md` `21_alpha_factor_library.md` → 改 ETF 因子
- `trader-system/40_portfolio_construction.md` `41_position_sizing.md` `42_rebalancing.md` → 对齐核心70%/卫星20%
- `EASY_QUANT_UI_DESIGN_GUIDELINES.md` → **保留并更新** (EasyQuant 入口保留, D2)
- `USER_GUIDE.md` `FUNCTION_GUIDE_AND_OPERATION_MANUAL.md` → 重写为新主线操作手册
- `DEVELOPER_GUIDE.md` → 更新目录结构

**保留**: 风控文档 (`50_risk_*` `52/53/55`), 实盘文档 (`live_trading_*` `broker_bridge_*` `deployment_topology`), 运维 (`operations/` `monitoring.md` `DEPLOY_*` `LOCAL_DEVELOPMENT` `PORT-CONFIGURATION` `TESTING`), `openapi.json`, `templates/post_mortem_template.md`。

---

## 5. scripts/ — 调试脚本清理

- **backend 根目录 36 个 .ts/.js 调试脚本**: 逐个判定, 与已删模块相关的 (fusion/strategy/intraday/个股扫描调试) 全删; 保留 DB 迁移/回填/健康检查类。
- **`scripts/` 目录** (`data_analysis` `maintenance` `ops` `preflight` `tests` `deployment` `development` `setup_and_db` `ci`): 保留运维/部署/CI/DB; 删除针对已删模块的分析脚本 (`roadmap-to-prd.js` 需确认)。

---

## 6. 需人工确认的决策清单 (拍板前不动)

用户已授权大胆删除, 以下 items 删错代价高或语义不明。✅ = 本轮已拍板。

| # | Item | 结论 | 风险 / 备注 |
|---|---|---|---|
| D1 | `live-trading/` 28 文件 | **冻结保留** (不删) | 删=丢实盘链+合规审计, 未来重建成本高 |
| D2 | `EasyQuantWorkspace` + docs | **保留** ✅已拍板 | 用户确认要"一键回测"体验; 仅接回测(7关), 不接 30 策略 |
| D3 | `StockDetail.tsx` + 个股实盘数据 | **保留** ✅已拍板 | 用户确认要看个股实盘数据(实时行情/龙虎榜/北向 只读查看) |
| D4 | `services/integration/` | **冻结不接** ✅已拍板 | 现阶段不接外部系统, 代码保留待未来 |
| D5 | `crossPortfolioDedup` | **删** ✅已拍板 | 单组合下无用; 未来多组合再重建 |
| D6 | `analysisEngineShadow` routes/tab | **删** ✅已拍板 | shadow 实验, 连带 AnalysisEngineTab |
| D7 | models 物理删 34 表 | **开发期直删** ✅已拍板 | 删前 grep 确认无 runtime 引用; 删前一次性 pg_dump 备份 |
| D8 | backend 根 36 调试脚本 | **评估后删** ✅已拍板 | 与已删模块相关的直删; DB 迁移/回填/健康类保留 |
| D9 | KOL / 情绪 / 社媒 / 问答 数据 | **删** ✅已拍板 | 社媒衍生非实盘, 曾是融合毒源输入; 龙虎榜/北向按 D3 保留供查看 |
| D10 | 删 30 策略后 `quant/engine`(strategyRegistry/StrategyEngine) | **方案A: 瘦身保留** ✅已拍板 | 审计发现 7 关回测/PaperTrading/绩效看板反向依赖 strategyRegistry, 整删会编译崩; 改为注册表只留 1 个 ETF 因子策略, 删 fusion + 29 策略 |

---

## 7. 执行顺序 + 回滚

**执行分批** (每批一个 commit, 可独立 revert):

1. **批1 — 删空壳**: `layers/` L1-L8 (零风险, 零外部引用) + `quant/engine/` barrel; `backtest/`(src根) **删前先做 §2.4 前置切换**(BacktestController/backtestJob 改指 quant/backtest)否则编译崩。
2. **批2 — 删日内**: services 日内类 15 个 + jobs burst + models 日内表(直删) + 前端日内 tab。
3. **批3 — 删融合/策略/引擎瘦身** (D10-A): 删 29 策略(留 1 ETF 因子策略) + `QuantFusionService`/`QuantFusionAuditService` + `quant/engine` 瘦身(保留 StrategyRegistry/StrategyEngine 骨架, 注册表只留 1 策略) + models 策略表(直删)。**删前必做摘除**(否则编译/启动崩): (a) 断 §2.5 列的 6 处 QuantFusionAudit 消费方; (b) `SchedulerService.ts:20/26/1337` 摘 quantFusionService/intradayUniverseService 注册与 runDailyPipeline 调用; (c) 删 `QuantRecommendationController`/`AdvancedQuantController` 时连带删 `api/routes/ai.routes.ts`/`advancedQuant.routes.ts` + `index.ts:281/287` 的 `app.use`; (d) 前端删 tab 时改父组件摘 import+JSX (`FactorWorkspace.tsx:61/630` `SettingsWorkspace.tsx:50/53/1778/1819` `LabWorkspace.tsx:63/703` `App.tsx:48/636/644`); (e) `scripts/integration-smoke-test.ts:56` 随批7 删。
4. **批4 — 删社媒情绪数据源**: data/sources 社媒/KOL/情绪类 + data/services sync (先删 sync 再删 client) + models 情绪/问答表(直删)。**注: 龙虎榜/北向 client/sync/model 不在本批, 保留供查看。**
5. **批5 — 改造**: 4 因子 ETF 化 + PaperTradingAutomation 接 EV gate + V3Controller + AIInvestmentSignal schema + 通知时机收敛 (§2.12)。
6. **批6 — 新建** (计划档 §7.4, 15-19 天): ETFRotationService / FactorCalculatorService / ConfidenceCalibrationService / AutoExitService / 精简数据源 / PR-O5 修复 / 战略镜子 UI。
7. **批7 — 前端装饰清理** + docs 清理 + scripts 清理。
8. **批8 — models 物理删** (随批2-4 同期直删; 删前 grep 确认无引用 + pg_dump 备份, 无观察期)。

**前后端删除时序绑定** (前端删除项必须与对应后端同批, 避免删出死路由/空 tab):

| 前端删除项 | 绑定后端批次 | 原因 |
|---|---|---|
| `RecommendationTrace.tsx` | 批3 (删融合/策略) | 个股推荐追溯依赖旧推荐链 |
| `TodayWorkspace.IntradayCapitalFlowTab` | 批2 (删日内) | 接日内资金流后端 |
| `FactorWorkspace.BlockTradesTab` | 批4 (删社媒情绪源) | 接已删大宗/龙虎榜信号数据源 |
| `SettingsWorkspace.StrategyKillSwitchTab` | 批3 (删策略) | 控制 30 策略开关 |
| `LabWorkspace.AdvancedQuantTab` | 批3 (删策略) | 接 30 策略 |
| `SettingsWorkspace.AnalysisEngineTab` | 批3 (随 analysisEngineShadow) | D6 shadow 实验 |
| §3.3 装饰组件 (飞线/滚动/tilt/扫光) | 批7 (纯前端) | 无后端依赖, 独立删 |

> **改造类前端** (HomeWorkspace/FactorWorkspace/TodayWorkspace 换主线) 随批5 后端改造同批上, 不早于后端接口就绪。

**回滚**: 批1-7 代码删除均 `git revert <commit>` 即回 (<15 min)。批8 (物理删表) 不可 revert, 靠删前 pg_dump 备份兜底。

**依赖**: 批5 依赖批3/4 (删掉旧引用后才好改); 批6 依赖批5; 批8 在批2-4 对应代码删除后即可执行 (删前 grep + 备份)。

---

**估算复核** (较计划档 §7.4 细化): 删除后端业务代码 45-50% (§7.4 区间 40-50%) · 改写约 10 处 (较 §7.4 的 3 处细化: 因子×4 / 下单 / 展示 / schema / 调度 / 数据链 / 通知时机 / 断引用切换) · 新建 15-19 天。
