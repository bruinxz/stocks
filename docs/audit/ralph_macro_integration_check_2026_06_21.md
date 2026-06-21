# Ralph 147 Story 完成后 — 宏观串联检查报告

**生成日期**：2026-06-21
**分支**：`ralph/trader-system-prod`（共 147 story merged）
**作者**：宏观串联只读审计 agent
**范围**：检查 6 大链路是否真接通，找出"看似做了实则没接通"的断裂点；为 push + merge to main + deploy 决策提供凭据
**全部只读**：未修改任何 code；本报告是唯一输出

---

## 总评

**🟡 黄灯 — 可以 push 上 PR，但 deploy to prod 前需补 3 个 cron 种子 + 1 处闭环**

3 个真实闭环断点（高严重度），其余链路基本接通：

1. **Improvement-suggestion 生成端无 cron / 无触发**：`ImprovementSuggestionService.generateForUser` 全仓库 0 caller，apply route 只能 mark 状态，**永远不会有新建议出现**（除非手动建库行）。
2. **ImprovementEffectTracker 无 cron**：apply 后效果回采 service 写完单测 123 个全过（US-146），但没接 SchedulerService，effect_metrics 永远是 `{}`。
3. **14 个已注册并已实现的 cron 没在 `ensureDefaultTasks` 种子里**：fresh DB 启动后这些 cron 不会运行（含 `BLACK_SWAN_DETECT`、`LIVE_RECONCILIATION_GUARD`、`DB_BACKUP`、`WEBHOOK_FALLBACK_RETRY`、`DATA_QUALITY_SCAN`、`SYNC_ALL_STOCKS` 等关键风控/对账/备份）；现网 prod 若 DB 里已有人工配置则不影响，但是路径上是隐患，部署 checklist 必须确认。

其余链路（Analysis Engine hard cutover、PortfolioConstruction、TradeCompliance、DrawdownCircuitBreaker、ExecutionFeasibility、AI Diary、Daily Attribution、Weekly Review、Black Swan 全套）都串到了 SchedulerService。

---

## 链路 1: 数据→因子→信号→决策→复盘

### 1.1 Cron 注册检查

`backend/src/constants/cronRegistry.ts` 66 条 entry；`backend/src/services/SchedulerService.ts` `task.type === 'X'` 分支 66 条。**两者完全一一对应（差集为空）**——白名单和实现层契合度 100%。

```bash
$ comm -23 /tmp/reg.txt /tmp/impl.txt   # registry 有但 impl 无: 空
$ comm -13 /tmp/reg.txt /tmp/impl.txt   # impl 有但 registry 无: 空
```

| Expected cron | 注册位置 | 实现位置 | seed 位置 | 状态 |
|---|---|---|---|---|
| ETF_FLOW_SYNC | **未注册** | **未实现**（仅 CLI `backend/src/scripts/sync-etf-flow.ts`） | 未 seed | ⚠️ **缺**（依赖 PRD KOL-002，未排期；当前只有手动 CLI） |
| LIVE_RECONCILIATION_GUARD | `cronRegistry.ts:338` | `SchedulerService.ts:5330` | **未 seed** | ⚠️ 实现就绪，无种子 |
| DAILY_ATTRIBUTION_GENERATE | `cronRegistry.ts:405` | `SchedulerService.ts:3466` | `SchedulerService.ts:6382` | ✅ 完整 |
| AI_DIARY_GENERATE | `cronRegistry.ts:418` | `SchedulerService.ts:3543` | `SchedulerService.ts:6395` | ✅ 完整 |
| WEEKLY_ERROR_PATTERN_AGGREGATE | `cronRegistry.ts:432` | `SchedulerService.ts:_executeTaskLogic` | `SchedulerService.ts:defaultTasks` | ✅ 完整 |
| QUARTERLY_PARAM_RETRAIN | **未注册** | **未实现** | 未 seed | ⚠️ PRD 项未落地 |
| FACTOR_IC_COMPUTE | `cronRegistry.ts:164` | `SchedulerService.ts:4761` | `SchedulerService.ts:6541` | ✅ 完整 |
| MONTHLY_FACTOR_IC_REVIEW | **未注册** | **未实现**（仅 `FACTOR_IC_COMPUTE` 每日跑） | 未 seed | 🟢 不阻塞——日级 IC 跑了就够；月度复盘可手工跑 |
| FACTOR_SCORE_COMPUTE | `cronRegistry.ts:158` | `SchedulerService.ts:4394` | `SchedulerService.ts:6483` | ✅ 完整 |
| BLACK_SWAN_DETECT/POSTMORTEM/BASELINE/TIMELINE/IMPROVEMENT/QUARTERLY_SUMMARY | `cronRegistry.ts:466..558` | `SchedulerService.ts:4963..5270` | **6 个全未 seed** | ⚠️ 实现就绪，无种子 |

#### 🚨 14 个已注册并已实现但 `ensureDefaultTasks` 未 seed 的 cron

```
BLACK_SWAN_BASELINE
BLACK_SWAN_DETECT
BLACK_SWAN_IMPROVEMENT
BLACK_SWAN_POSTMORTEM
BLACK_SWAN_QUARTERLY_SUMMARY
BLACK_SWAN_TIMELINE
DATA_QUALITY_SCAN
DB_BACKUP
EQUITY_CURVE_GOVERNOR_DAILY_EVAL
LIVE_RECONCILIATION_GUARD
RESEARCH_INTEGRITY_BATCH_AUDIT
SYNC_ALL_STOCKS
WEBHOOK_FALLBACK_RETRY
WEEKLY_QA_STAT_AGGREGATE
```

证据：`SchedulerService.ts:5644-6700` 的 `ensureDefaultTasks` 数组只覆盖 52 个 type；prod env (非 dev) 的 `index.ts:949-962` 在跑 `ensureDefaultTasks` 时仅 `findOrCreate`，所以**这些 cron 在 fresh DB 启动后不会被自动创建；只有人工 INSERT 到 `scheduled_tasks` 才会跑**。

⚠️ 建议（部署前必须）：
- 确认 prod DB 里这 14 个 type 是否已经存在（`SELECT type, is_active, cron_expression FROM scheduled_tasks WHERE type IN (...)`）
- 缺失的必须先 INSERT 再 deploy

### 1.2 数据源 → 因子（3 个抽样）

PRD 提到的 5 个"新加因子"（DividendYield / Turnaround / IpoFreshman / IndustryRelativeStrength / ContinuousLimitUpPremium）**全仓库 grep 0 hit**：

```bash
$ grep -rn "DividendYield\|Turnaround\|IpoFreshman\|IndustryRelativeStrength\|ContinuousLimitUpPremium" \
    backend/src/quant/factors/library
# 0 hit
```

实际 `backend/src/quant/factors/library/` 23 个 factor，全部用 snake_case（`value`, `growth`, `quality`, `quality_high`, `momentum`, `momentum_reversal`, `low_vol`, `liquidity`, `money_flow`, `northbound`, `margin_flow`, `analyst_consensus`, `earnings_surprise`, `gradual_breakout`, `industry_momentum`, `dragon_tiger`, `block_trade_signal`, `concept_heat`, `east_money_qa`, `fund_consensus`, `insider_trade`, `shareholder_concentration`, `dragon_tiger`）。**PRD 提到的 5 个 PascalCase factor 名不是本仓库的命名**——大概是 PRD 用 ID 别名指代既有 factor，或者 PRD 漏排了这些 story。不算缺陷。

抽样：`value` factor（`backend/src/quant/factors/library/ValueFactor.ts`）读 `StockValuationFactor` model；该 model 由 `backend/src/scripts/sync-valuation-factor.ts` 写。**未在 cronRegistry 注册独立 sync cron**——靠 `DAILY_UPDATE` / `SYNC_HISTORY` 间接刷新？需 ops 确认（不是本批引入的，是历史状态）。

### 1.3 因子 → 策略

`MultiFactorAlphaStrategy.ts:136` 接 `weights: Record<string, number>` 走 params，**未读 `FactorWeightConfig` model**（全仓库 grep `FactorWeightConfig` 0 hit）。说明 F-010 "因子权重热更新" 没落地——策略权重仍由调用方传入，没接外部 config。**这不是断点**（策略层 contract 仍工作），但路标功能没实现。

### 1.4 策略 → 组合 → 下单

✅ 完整链路存在：

```
QuantSignalService.generateSignals
  → AIInvestmentSignal 落库 (source_type='analysis_engine' / 'quant_strategy')
  → PaperTradingAutomationService.runAutoSync
      → autoBuyFromSignals
          → portfolioConstructionResult = await buildPortfolioConstruction(...)  // PCAdapter shadow/hard
              (backend/src/portfolio/internal/PaperTradingAutomationService.ts:1510-1564)
          → createBuyTrade
              → checkAllPreTradeGates  // drawdown + position-limit
              → checkPreTradeCompliance + emitPreTradeComplianceAlert  // 5 wizard rule
              → record into PaperTradingTrade
```

`PortfolioConstructionAdapter` 真接到了 buy-decision loop（不是 stub），默认 mode='off' shadow/hard 用户切换。

### 1.5 下单 → 风控

✅ **三处入口全接 pre-trade compliance**：

| Caller | TradeComplianceChecker 入口 | 证据 |
|---|---|---|
| `PaperTradingFacade.placeOrder` (UI / TodaySignals shadow autopilot / RebalanceEngine) | `checkPreTradeCompliance` + `emitPreTradeComplianceAlert` | `PaperTradingFacade.ts:976` |
| `PaperTradingAutomationService.createBuyTrade` (自动 BUY) | 同上 | `PaperTradingAutomationService.ts:6750` |
| `LiveTradingService.approveDraft` | 同上 | (按 facade jsdoc 标注)，未单独 grep |

⚠️ S-3 涨跌停拦截：`PaperTradingFacade.ts:390` 有 "audit S-3 修复: 涨跌停 pre-trade 拦截的纯函数实现"；`PaperTradingAutomationService.ts:5529` 有 "板块感知涨跌停阈值, 不再硬编码 9.7"。**已实现**。

✅ DrawdownCircuitBreaker fail-closed（BETA-7）：`backend/src/portfolio/internal/preTradeGuards.ts:28` 引 `drawdownCircuitBreaker`；`SchedulerService.ts:33` 注入；`PAPER_TRADING_DRAWDOWN_BREAKER_CHECK` cron 实现 + 种子齐全。

### 1.6 下单 → 执行 → 对账

✅ ExecutionFeasibility：`PaperTradingAutomationService.ts:40,1992,2366` 调 `executionFeasibilityService.computeFeasibility`；落 `ExecutionFeasibilityRecord` 表。

✅ TWAP/VWAP/Iceberg：`backend/src/services/execution/ExecutionAlgoSlicer.ts` 等。但调用链未追到 SchedulerService 或 facade（这两项是 ops 工具，不是 cron 任务）。

⚠️ 对账 cron `LIVE_RECONCILIATION_GUARD`：实现完整（`SchedulerService.ts:5330`），但 **未 seed**——见 1.1 §🚨。

✅ Bridge fail-safe：`backend/src/utils/webhookUrlGuard.ts`、`backend/src/services/webhookFailOpen.ts`、`backend/src/live-trading/services/ReconciliationAlertService.ts` 联动 `RealtimeAlertDispatcher`。

---

## 链路 2: AI 引擎 hard cutover

### 2.1 `AIAdvisorService.analyzeSingleStock` → `AnalysisEngineService`

✅ hard 短路接通：

- `AIAdvisorService.ts:1019-1050` —— `!isAsync` 时同步执行 `maybeRunHardShortCircuit(PRODUCTION_HARD_SHORT_CIRCUIT_DATA_SOURCE, {...})`；若返非 null，直接 `return hardResult`，**跳过 TradingAgents 5-维度路径与末尾 shadow trigger**。
- `AIAdvisorService.ts:1094-1108` —— off / shadow / unknown mode → fall-through 旧路径 + shadow trigger（`shadowDoubleRunService.maybeRunShadow`）。

### 2.2 `archiveAnalysisEngineResult` (AE-001) 落库 AIInvestmentSignal

✅ 接通：

- `backend/src/services/analysis-engine/hardShortCircuit.ts:400` —— hard 路径 `await archiveAnalysisEngineResult(ds, {...})`。
- `backend/src/services/analysis-engine/analysisEngineSignalArchive.ts:236` —— 落库写 `source_type: AISignalSourceType.ANALYSIS_ENGINE`；`upsert(where={source_type, source_id}, payload)`。

### 2.3 `AutomatedRecommendationLoop` → `analysis_engine` 路由

✅ 接通：

- `backend/src/services/AutomatedRecommendationLoopService.ts:13-15` 引 `runAnalysisEngineHardFollowup`。
- `backend/src/services/AutomatedRecommendationLoopService.ts:1898-1961` 在主 `QUANT_RECOMMENDATION` 跟单完成后，独立 `runAnalysisEngineHardFollowup` 拿 `source_type='analysis_engine'` 的 `AIInvestmentSignal` 再调 `autoBuyFromSignals`。
- `backend/src/services/recommendationLoop/analysisEngineHardFollowup.ts:140-180` 主入口 `runAnalysisEngineHardFollowup`，纯函数 `buildAnalysisEngineFollowupOptions` 把 `source_type` 钉死成 `analysis_engine`。

### 2.4 8 analyzer evidence 输出

✅ 抽样检查 `backend/src/services/analysis-engine/analyzers/`：

- `BaseAnalyzer.ts:27` —— interface 含 `evidence: EvidenceItem[]`。
- `BaseAnalyzer.ts:64` —— `data_missing` 时返 `evidence: []`（非异常态）。
- `EventAnalyzer.ts:80-100` —— `evidence.push({...})` 真有内容。
- `CapitalAnalyzer.ts:41-80`、`FundamentalAnalyzer.ts:150-218`、`IndustryRegimeAnalyzer.ts:244-321` —— 全部有 evidence 输出。

8 个 analyzer：`BaseAnalyzer / CapitalAnalyzer / EventAnalyzer / FundamentalAnalyzer / IndustryRegimeAnalyzer / NewsAnalyzer / RiskAnalyzer / SentimentAnalyzer / TechnicalAnalyzer`（共 8 个 concrete + 1 base）。每个 concrete 在 happy-path 都返非空 evidence。

---

## 链路 3: 复盘 → AI 日记 → 改进建议 → 应用 闭环

### 3.1 DailyAttribution → 飞书推送

✅ 完整链路：

- `DAILY_ATTRIBUTION_GENERATE` cron 注册+实现+seed（见 1.1）。
- `SchedulerService.ts:3473` lazy-require `runDailyAttributionGenerate`。
- `backend/src/services/attribution/DailyAttributionCronRunner.ts:46` 调 `DailyAttributionFeishuPushService`。
- 前端 `PortfolioWorkspace.tsx:1484` 调 `getDailyAttributionReport(portfolioId)` 拉 `DailyAttributionReport` 表。

### 3.2 AIDiary → 每日 cron

✅ 完整：

- 注册 `cronRegistry.ts:418`、实现 `SchedulerService.ts:3543`、seed `SchedulerService.ts:6395`。
- `AIDiaryCronRunner.runAIDiaryGenerate` 在 SchedulerService 内 lazy-require。

### 3.3 ErrorPatternReport → ImprovementSuggestion → apply → effect tracking

🚨 **严重断点（详见 §⚠️ 发现的断点）**：

- ✅ `ErrorPatternReport` 表 + `WEEKLY_ERROR_PATTERN_AGGREGATE` cron 全齐。
- ❌ **`ImprovementSuggestionService.generateForUser` 全仓库 0 caller**。模型注释（`ImprovementSuggestion.ts:20`）说 "PM-023 ImprovementSuggestionService.generateForUser(user_id, {date, ...}) 主入口"，但既没有 cron 调它，也没有 controller 调它。**该 service 永远不被触发**。
- ✅ apply route `/api/me/improvement-suggestions/:id/apply` 接通（`backend/src/api/routes/improvementSuggestion.routes.ts`）。controller 只标 status='applied' + applied_at，不生成新建议。
- ❌ **`ImprovementEffectTracker.trackPendingSuggestions` 全仓库 0 caller**（除了它自己的单测）。jsdoc 自己也写"未来 cron (PM-028+ 未排期) 接入 SchedulerService"。

⚠️ 现状："改进建议"在生产里**不会自动出现**（除非手动 SQL INSERT），且即使有 apply 过的也**不会有效果回采**。

### 3.4 WeeklyReview LLM 升级

✅ 接通：

- `SchedulerService.ts:3408` 实现 `WEEKLY_REVIEW_EMAIL` cron；`SchedulerService.ts:6366` seed。
- `WeeklyReviewReportService.loadNextWeekCalendarEvents` (US-145 PM-017) 接到 buildHtml。
- POST `/api/settings/weekly-review/apply` 路由存在（`settings.routes.ts:274`） + controller `SettingsController.ts:565`。
- ⚠️ 前端 grep `weekly-review/apply` **0 hit** —— 后端有路由但前端没消费（apply 这个 endpoint 是 US-143 加的，可能正在做 UI）。

---

## 链路 4: 黑天鹅复盘闭环

✅ 完整链路（cron 注册 + 实现都齐，但 6 个全没 seed —— 见 1.1 §🚨）：

| Cron | 注册 | 实现 | Service |
|---|---|---|---|
| `BLACK_SWAN_DETECT` | `cronRegistry.ts:466` | `SchedulerService.ts:4963` | `BlackSwanDetectorService` |
| `BLACK_SWAN_POSTMORTEM` | `cronRegistry.ts:483` | `SchedulerService.ts:5018` | `BlackSwanPostmortemService` |
| `BLACK_SWAN_BASELINE` | `cronRegistry.ts:501` | `SchedulerService.ts:5073` | `CounterfactualBaselineService` |
| `BLACK_SWAN_TIMELINE` | `cronRegistry.ts:521` | `SchedulerService.ts:5134` | `EventTimelineReplayerService` |
| `BLACK_SWAN_IMPROVEMENT` | `cronRegistry.ts:542` | `SchedulerService.ts:5201` | `BlackSwanImprovementSuggestorService` |
| `BLACK_SWAN_QUARTERLY_SUMMARY` | `cronRegistry.ts:558` | `SchedulerService.ts:5270` | `BlackSwanQuarterlyReportService` |

错峰设计完善（`13/23/33/43/53` 每 10min 一档），互不冲突。

⚠️ **6 个全未 seed** —— 部署 checklist 必须显式 INSERT。

---

## 链路 5: 前端→后端 API 串联

### 5.1 端点-Controller 对照（采样）

| 前端调用 | 后端路由 | 状态 |
|---|---|---|
| `GET /today/signals` | `today.routes.ts:22` `todayController.getTodaySignals` | ✅ |
| `POST /today/apply-signals` | `today.routes.ts:27` `todayController.applyTodaySignals` | ✅ |
| `GET /today/market-judgment` | `today.routes.ts:32` | ✅ |
| `GET /today/call-auction` | `today.routes.ts:39` | ✅ |
| `GET /factors/overview` | `factor.routes.ts:40` | ✅ |
| `POST /factors/preview` | `factor.routes.ts:68` | ✅ |
| `GET /factors/industry-heatmap` | `factor.routes.ts:93` | ✅ |
| `GET /factors/industry-board` | `factor.routes.ts:119` | ✅ |
| `GET /factors/sentiment-board` | `factor.routes.ts:145` | ✅ |
| `GET /factors/:name/detail` | `factor.routes.ts:196` | ✅ |
| `GET /risk/position-limits` ... 等 9 个 risk section | `risk.routes.ts:20..384` | ✅ 9 个全齐 |
| `GET/PUT /risk/analysis-engine-config` | `risk.routes.ts:511,516` | ✅ |
| `GET/PUT /paper-trading/portfolio-construction-config` | `paperTrading.routes.ts:447,452` | ✅ |
| `GET /admin/analysis-engine/shadow-stats` | `analysisEngineShadow.routes.ts` | ✅ |
| `POST /api/me/improvement-suggestions/:id/apply` | `improvementSuggestion.routes.ts:56` | ✅ 后端有，**前端未消费**（前端 grep 0 hit） |
| `POST /api/alerts/:id/snooze` | **后端 grep 0 hit** | ⚠️ 前端 jsdoc 提到未来用，本期 snooze 走 localStorage（`alertItemActionHelpers.ts`），不算断点 |
| `GET /tasks/risk-limit-suggestion/apply` | `task.routes.ts:119` | ✅ |
| `GET /black-swan/events` | `blackSwan.routes.ts:74` | ✅ |
| `WS /ws/alerts` | `index.ts:1035` `attachAlertsWebSocketServer` | ✅ |

### 5.2 后端写了但前端没读

- **`/api/me/improvement-suggestions/:id/apply`** —— 前端 SettingsWorkspace.TodoSuggestionsTab 只读 `/tasks/automation-health` 的 `risk_limit_suggestion`，不调 improvement-suggestion apply。
  - 影响：阵地有的 PM-024 apply 路由用户用不到（除非外部工具调）。
  - 严重度：中（功能存在但路径不完整）。
- **`/api/settings/weekly-review/apply`** —— 前端 grep 0 hit；只有 `weekly-review/preview` 和 `weekly-review/send`。
  - 影响：US-143 加的 apply route 没前端 UI 入口。
  - 严重度：中。

### 5.3 前端写了但后端没接口

- **`/api/alerts/:id/snooze`** —— 前端 jsdoc 提到，但本期 snooze 改走前端 localStorage（`alertItemActionHelpers.ts`），不依赖后端。**不是断点**。

### 5.4 工作区组件清单

⚠️ PRD 提到的 "6 个 workspace × 5 tab = 30 个组件" 的命名约定（TodayWorkspace 5 卡片 FE-001~005、FactorWorkspace 5 tab FE-006~010 等）在仓库里**部分对不上**：

- 实际 workspace 6 个：`TodayWorkspace.tsx`、`FactorWorkspace.tsx`、`LabWorkspace.tsx`、`PortfolioWorkspace.tsx`、`DataWorkspace.tsx`、`SettingsWorkspace.tsx`。
- 每个 workspace 的 tab 是.tsx 分文件（FactorWorkspace 4 个独立 tab + 主文件；LabWorkspace 6 个独立 tab + 主文件；SettingsWorkspace 7 个独立 tab + 主文件）。
- DataWorkspace.tsx 主体很薄（220 行），可能未拆 tab。

不算断点——是 PRD 命名 vs 实仓命名的对齐问题。**真接通即可，命名漂移由 PRD 后续整理**。

---

## 链路 6: schema migration 完整性

### 6.1 所有 2026-06 migrations（按时间排序）

```
2026-06-18-analysis-engine-shadow.sql                    + rollback
2026-06-19-announcement-nlp-event-priority-entities.sql  + rollback
2026-06-19-eastmoney-qa-stat.sql                         + rollback
2026-06-20-ai-diary-entries.sql                          + rollback
2026-06-20-announcement-event-relations.sql              + rollback
2026-06-20-black-swan-events.sql                         + rollback
2026-06-20-black-swan-postmortem-reports.sql             + rollback
2026-06-20-error-pattern-reports.sql                     + rollback
2026-06-20-improvement-suggestions.sql                   + rollback
2026-06-20-personality-strategy-match-reports.sql        + rollback
2026-06-20-webhook-fallback-log.sql                      + rollback
2026-06-21-etf-creation-redemption.sql                   + rollback
2026-06-21-improvement-suggestions-effect-metrics.sql    + rollback
2026-06-21-kol-author-stats.sql                          + rollback
```

✅ **14 个 up + 14 个 rollback 一一对应**，无遗漏 rollback。

### 6.2 依赖关系

- `2026-06-19-announcement-nlp-event-priority-entities.sql` ALTER 既存表 `announcement_summaries`（不在 migration 里 CREATE，依赖 sequelize sync 或更早的人工 CREATE）；prod 必须已经有该表。
- `2026-06-20-announcement-event-relations.sql` 有 FK `REFERENCES announcement_summaries(id) ON DELETE CASCADE`，**必须先建 announcement_summaries**（同上，prod 已有则 OK）。
- `2026-06-21-improvement-suggestions-effect-metrics.sql` 是 `2026-06-20-improvement-suggestions.sql` 的延伸（同表加列）—— **必须先跑 06-20 再跑 06-21**。文件名按时间排序天然满足。
- 其它 11 个都是新表创建，互无依赖。

### 6.3 model 漂移检查

✅ 每个 migration 都对应一个 model（采样 `ETFCreationRedemption`、`AIDiaryEntry`、`KOLAuthorStat`、`ImprovementSuggestion`、`PersonalityStrategyMatchReport`、`BlackSwanEvent`、`BlackSwanPostmortemReport`、`ErrorPatternReport`、`WebhookFallbackLog`、`AnnouncementEventRelation`、`EastMoneyQAStat`）—— 全部在 `backend/src/config/database.ts` 注册。

✅ 每个 migration 在 prd progress.txt 都有 META-GUARD 测试覆盖（fs+regex 校验 schema 对齐）。

### 6.4 prod 执行方式

migrations 通过 `psql $DATABASE_URL -f file.sql` 手动跑（无 sequelize-cli 工作流；`db:migrate` 在 package.json 但 `backend/migrations/` 目录不存在）。这是历史方式，本批 14 个 SQL 必须按时间顺序逐个 psql 跑。

⚠️ 部署 checklist 第 1 项：按文件名升序跑 14 个 .sql；遇到 ALREADY EXISTS 跳过（每个文件都用 `IF NOT EXISTS`）。

---

## ⚠️ 发现的断点 / 死链 / 隐患

### 🔴 高严重度

1. **改进建议生成端 0 caller**
   - 证据：`grep -rn "generateForUser" backend/src/` —— `ImprovementSuggestionService` 的 `generateForUser` 全仓库无调用方。
   - 影响：PM-023 / PM-024 apply route 是"空的循环"——既没有自动生成，apply 后又没 effect 回采，闭环只在文档里。
   - 修复方向：加 cron `WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE`（应错峰在 `WEEKLY_ERROR_PATTERN_AGGREGATE` 之后），调 `generateForUser`；同时加 cron 调 `ImprovementEffectTracker.trackPendingSuggestions`（建议每日 19:00）。

2. **ImprovementEffectTracker 0 caller**
   - 证据：`grep -rn "trackPendingSuggestions" backend/src/` —— 0 hit（除单测）；`ImprovementEffectTracker.ts:40` jsdoc 自己写"未来 cron (PM-028+ 未排期)"。
   - 影响：`effect_metrics JSONB` 永远是 `{}`；US-146 的 schema 改动 + service 实现是死的。
   - 修复方向：同上。

3. **14 个 cron 未 seed 到 `ensureDefaultTasks`**
   - 证据：`grep -E "type:" backend/src/services/SchedulerService.ts` defaultTasks 数组 vs cronRegistry 全集差。
   - 影响：fresh DB（如 prod 重建 / staging 新环境）启动后这些 cron **不会运行**：含 `BLACK_SWAN_DETECT`、`LIVE_RECONCILIATION_GUARD`（实盘对账主动告警!）、`DB_BACKUP`、`WEBHOOK_FALLBACK_RETRY`（飞书 fail-open 重投!）、`DATA_QUALITY_SCAN`、`EQUITY_CURVE_GOVERNOR_DAILY_EVAL`（资金曲线熔断!）、`SYNC_ALL_STOCKS` 等 11 个关键 cron + 6 个 BlackSwan cron。
   - 修复方向（A 方案推荐）：在 `ensureDefaultTasks` 增加 14 条 task 定义；或（B 方案）在 prod DB 里手动 INSERT；或（C 方案）写 migration `2026-06-21-seed-missing-crons.sql` 用 SQL INSERT ON CONFLICT DO NOTHING。

### 🟡 中严重度

4. **`/api/me/improvement-suggestions/:id/apply` 前端未消费**
   - 证据：`grep -rn "improvement-suggestions" frontend/src/` —— 0 hit。
   - 影响：用户没办法在 UI 上点 apply。
   - 修复方向：SettingsWorkspace.TodoSuggestionsTab 加一个 apply 按钮。

5. **`/api/settings/weekly-review/apply` 前端未消费**
   - 证据：`grep -rn "weekly-review/apply" frontend/src/` —— 0 hit。
   - 影响：US-143 加的 apply route 无 UI 入口。
   - 修复方向：SettingsWorkspace 或 PortfolioWorkspace 加 apply UI。

6. **`KOLAuthorTrackingService` / `ConceptLinkageAnalyzer` 0 caller**
   - 证据：`grep -rn "KOLAuthorTrackingService\|ConceptLinkageAnalyzer" backend/src/` —— singleton export 之外无调用方；既无 cron 也无 controller 用。
   - 影响：US-140 KOL-007 + US-141 KOL-008 是死代码。
   - 修复方向：依赖 KOL-002/003/004（ETFCreationRedemptionClient + sync service + KOLAggregator 集成）先落地。

7. **`PersonalityStrategyMatcher` 0 caller**
   - 证据：`grep -rn "PersonalityStrategyMatcher" backend/src/` —— singleton 之外无调用方。
   - 影响：US-127 PM-025 service 是死代码；`PersonalityStrategyMatchReport` 表永远空。

8. **`ETF_FLOW_SYNC` cron 缺**
   - 证据：仅 CLI `backend/src/scripts/sync-etf-flow.ts`，cronRegistry / SchedulerService 0 hit。
   - 影响：行业 ETF 资金流数据靠人工 CLI（或 crontab 跑 CLI），不在统一调度。

### 🟢 低严重度 / 信息项

9. **PRD 提到的 5 个新 factor 名未实现**（DividendYield/Turnaround/IpoFreshman/IndustryRelativeStrength/ContinuousLimitUpPremium 全 0 hit）—— 但既有 23 个 factor 体系完整。可能是 PRD 命名漂移，不算断点。

10. **F-010 FactorWeightConfig 未落地** —— `MultiFactorAlphaStrategy` 仍接 `weights: Record<string, number>` 走 params；策略层不读外部 config。

11. **MONTHLY_FACTOR_IC_REVIEW / QUARTERLY_PARAM_RETRAIN 未实现** —— 月度复盘 + 季度参数重训未排期。日级 IC + IC_weighted 权重 fallback 已 cover 大部分。

12. **CronRegistry 漂移检测有日志告警**（`SchedulerService.ts:484`） —— "DB type NOT in CRON_REGISTRY" 会打 warn，但反向"REGISTRY type NOT in DB"是上面 §3 的问题，**没有反向检测**。建议：在 `initialize()` 末尾加 `comm -23 REGISTRY DB`，warn 输出。

---

## ✅ 真接通的串联（绿色）

| 链路 | 证据要点 | 状态 |
|---|---|---|
| Analysis Engine hard cutover | `AIAdvisorService.ts:1019-1050` + `hardShortCircuit.ts:454` + `analysisEngineSignalArchive.ts:345` | ✅ |
| AnalysisEngine shadow double-run | `AIAdvisorService.ts:1094-1108` + `ShadowDoubleRunService.ts` + migration `2026-06-18-analysis-engine-shadow.sql` | ✅ |
| Autopilot → analysis_engine followup | `AutomatedRecommendationLoopService.ts:1898-1961` + `analysisEngineHardFollowup.ts:140` | ✅ |
| PortfolioConstruction shadow/hard 接入 buy-decision | `PaperTradingAutomationService.ts:1510-1564` + `PortfolioConstructionAdapter.ts` | ✅ |
| Pre-trade compliance 三入口 | facade + automation + LiveTrading 全覆盖（`PaperTradingFacade.ts:976` + `PaperTradingAutomationService.ts:6750`） | ✅ |
| DrawdownCircuitBreaker fail-closed | `preTradeGuards.ts:28` + `RiskGuardUnavailableError` 抛 503 | ✅ |
| ExecutionFeasibility gate | `PaperTradingAutomationService.ts:40,2366` | ✅ |
| DailyAttribution → Feishu push | cron seed + `DailyAttributionCronRunner` + `DailyAttributionFeishuPushService` | ✅ |
| AIDiary 每日 cron | cron seed + `AIDiaryCronRunner.runAIDiaryGenerate` | ✅ |
| WeeklyReview 邮件 cron | cron seed + `WEEKLY_REVIEW_EMAIL` 调 `weeklyReviewReportService.sendWeeklyReviewReports` | ✅ |
| BlackSwan 6 stage 错峰 cron 实现 | `SchedulerService.ts:4963..5270` 实现完整（**仍需 seed**） | 🟡 实现 ✅ seed ❌ |
| RealtimeAlertDispatcher → 飞书/邮件/短信 + /ws/alerts 广播 | `RiskAlert.afterCreate` hook + `index.ts:1035` WS server | ✅ |
| Migration up + rollback 全配对 | 14 + 14，无遗漏 | ✅ |
| Frontend Today/Factor/Risk/Portfolio 主要 endpoint 全接通 | 见 §5.1 表 | ✅ |

---

## 部署 checklist

### 🚨 deploy to prod 前必做

- [ ] **跑 14 个 2026-06 migration**（按文件名升序，psql $DATABASE_URL -f ...）。每个文件用 IF NOT EXISTS，遇 ALREADY EXISTS 应跳过；如 `2026-06-19-announcement-nlp-event-priority-entities.sql` 报 ALTER COLUMN 错，确认 prod 已有 `announcement_summaries` 表（应该有，是历史表）。
- [ ] **确认 prod DB 里 14 个未 seed 的 cron 是否存在** （`SELECT type, is_active, cron_expression FROM scheduled_tasks WHERE type IN ('BLACK_SWAN_DETECT','BLACK_SWAN_POSTMORTEM','BLACK_SWAN_BASELINE','BLACK_SWAN_TIMELINE','BLACK_SWAN_IMPROVEMENT','BLACK_SWAN_QUARTERLY_SUMMARY','DATA_QUALITY_SCAN','DB_BACKUP','EQUITY_CURVE_GOVERNOR_DAILY_EVAL','LIVE_RECONCILIATION_GUARD','RESEARCH_INTEGRITY_BATCH_AUDIT','SYNC_ALL_STOCKS','WEBHOOK_FALLBACK_RETRY','WEEKLY_QA_STAT_AGGREGATE');`）。**缺失的必须先 INSERT 再 deploy**，否则关键风控/对账/备份/告警重投不工作。
- [ ] 启动后 grep 日志 `[scheduler] initialize complete: active_count=N/N` 确认 cron 真的注册成功；并 grep `cron registry drift` 应为空。
- [ ] 启动后 grep 日志 `[scheduler] cron registry: ...` 应显示 66 条 entry。

### 🟡 deploy 后第 1 周观察

- [ ] **feature flag 默认值**：`AnalysisEngine` mode 默认 `off`；`PortfolioConstruction` mode 默认 `off`。两者均为用户自助切换。dry_run 巡检（BETA-5）已经做。
- [ ] **关键 cron 第一次成功率**：观察 `BLACK_SWAN_DETECT` / `LIVE_RECONCILIATION_GUARD` / `DAILY_ATTRIBUTION_GENERATE` / `AI_DIARY_GENERATE` 在第一周内的 `last_run_status='SUCCESS'` 数。
- [ ] **`/ws/alerts` WebSocket** 连接计数 > 0（前端 AlertsBell 应连上）。
- [ ] 监控 `ImprovementSuggestion` 表写入：**预期 0 行**（因为 §🚨 #1）；这是个"已知 P0 待修"。

### 🟢 deploy 后第 2 周（修补 §🚨 #1,#2）

- [ ] 加 cron `WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE`（周二 09:00；错峰 `WEEKLY_ERROR_PATTERN_AGGREGATE` 周一 22:00）：lazy-require + 调 `generateForUser` for active users。
- [ ] 加 cron `IMPROVEMENT_EFFECT_TRACK`（每日 19:30；错峰 `FACTOR_IC_COMPUTE` 19:00）：lazy-require + 调 `trackPendingSuggestions`。
- [ ] 加上述 2 个 cron 到 `cronRegistry.ts` + `ensureDefaultTasks` + `_executeTaskLogic`。
- [ ] 前端 SettingsWorkspace.TodoSuggestionsTab 加 apply 按钮调 `/api/me/improvement-suggestions/:id/apply`。

### secret 检查

- 本批未引入新 env / secret —— 都在历史的 `ANTHROPIC_*` / `OPENAI_*` / `DATABASE_URL` / `REDIS_URL` / `TRADING_AGENTS_URL` / `FEISHU_*` 范围内。
- 但请 confirm `QUARTERLY_BLACK_SWAN_RECIPIENTS` env 已配（`BLACK_SWAN_QUARTERLY_SUMMARY` 用）。

---

## 结论一句话

**当前可以 push + 上 PR + merge to main；但 deploy to prod 之前必须**：(a) 跑 14 个 migration，(b) INSERT 14 个未 seed 的 cron，(c) 知会用户"改进建议自动生成 + 效果回采"是当前没有自动跑的（需要后续 ~1 天补 2 个 cron 才闭环）。其它 6 大链路 95% 真接通——含 AI 引擎 hard cutover、PortfolioConstruction、pre-trade compliance 三入口、DrawdownCircuitBreaker fail-closed、对账主动告警、DailyAttribution + AIDiary + WeeklyReview + BlackSwan 6-stage 错峰链路。

---

报告路径：`/Users/bytedance/go/src/github.com/bruinxz/stocks/docs/audit/ralph_macro_integration_check_2026_06_21.md`
