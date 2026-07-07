# 21 · 我方项目现状审计报告

**版本**：v1.0（M-Draft 输入）
**Owner**：@Research
**上位规范**：`00-anchor.md` · `dir-ownership.md` · ADR-0001
**签字锚**：li-yiming M-Draft
**证据基线**：本地仓库 `/Users/bytedance/go/src/github.com/bruinxz/stocks` @ Cleanup post-merge `849f74e` · 审计时点 `2026-07-07`
**审计原则**：**只读**，不做代码变更；证据必带文件路径/行号/命令输出

---

## 0 · TL;DR

- **总规模**：**~285K LOC** 跨 4 大子系统 —— 参考项目（6.5K）× ~44 倍
- **子系统边界**：TS 后端（223K）· React 前端（50K）· Python AI 应用（8.5K）· Broker Bridge（31 files）· Python data helpers（`backend/python/**`）
- **数据模型**：94 Sequelize models · 1 有效孤儿（`ETFCreationRedemption`）+ 4 近孤儿（`AIDiaryEntry` / `WebhookFallbackLog` / `IndustrySentimentIndex` / `DataSourceHealth`）
- **API 表面**：27 route 文件 · 238 openapi paths · **6 route 模块整体未文档化** + **3 openapi 命名空间无实现**（stale）
- **Services**：58 顶层 `.ts`（52,988 LOC）+ 22 子目录 · **5 outlier > 2000 LOC** · 疑似 dead glue 1 处
- **跨系统边界**：20+ Python spawn client · 15 处 TS→AI HTTP 直连 · 1 broker-bridge HTTP+HMAC 边界 + 10 `Live*` models
- **关键差距（vs `50-strategy-design.md` v0.1 契约）**：现有 `signal_v3` **无** `dimensions.dimension_group` core/satellite discriminator · 需为 Strategy §1.5.4 v0.2 契约锁做字段扩展

---

## 1 · 子系统边界与依赖图

```
┌─────────────────────────────────────────────────────────────────┐
│                    TS 后端 (Node/Express)                       │
│  backend/src/ · 223K LOC                                        │
│                                                                 │
│  ┌───────────┐    ┌─────────────┐    ┌────────────────────┐   │
│  │ api/routes│───▶│  services/  │───▶│    models/         │   │
│  │  27 files │    │ 58+22 dirs  │    │  94 Sequelize      │   │
│  └───────────┘    └──────┬──────┘    └────────────────────┘   │
│                          │                                     │
│         ┌────────────────┼─────────────────┐                  │
│         ▼                ▼                 ▼                  │
│  ┌──────────────┐  ┌──────────────┐ ┌──────────────────┐    │
│  │data/sources/ │  │externalSvc:  │ │/api/live-trading/│    │
│  │*Client.ts    │  │TradingAgents │ │bridge (HTTP+HMAC)│    │
│  │20 spawn      │  │15 call sites │ │                  │    │
│  └──────┬───────┘  └───────┬──────┘ └────────┬─────────┘    │
└─────────┼──────────────────┼───────────────── │──────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
   ┌──────────────┐   ┌──────────────┐   ┌────────────────┐
   │ Python spawn │   │ AI 应用      │   │ Broker Bridge  │
   │backend/python│   │ai/           │   │integrations/   │
   │  helper.py   │   │tradingagents-│   │broker-bridge/  │
   │  (子进程)    │   │app/ 8.5K LOC │   │31 files        │
   │              │   │FastAPI :8000 │   │QMT + PTrade    │
   └──────────────┘   └──────────────┘   └────────────────┘
                              │
                              │ HTTP GET/POST
                              ▼ (env TRADING_AGENTS_URL)
                          127.0.0.1:8000

┌─────────────────────────────────────────────────────────────────┐
│                       React 前端                                │
│  frontend/src/ · 50,339 LOC                                     │
│                                                                 │
│  App.tsx (~48 top-level Routes)                                 │
│    │                                                            │
│    ▼                                                            │
│  pages/workspace/** (43 files · 8 workspaces + tabs)            │
│    │                                                            │
│    ▼                                                            │
│  services/api.ts (fetch layer) ────HTTP────▶ backend/api/routes │
│                                                                 │
│  UI 栈：antd 46 + @heroicons ~44（可迁）+ recharts 6 + echarts 1│
│         + monaco 1(lazy) + framer-motion 9 + dayjs 16           │
│  幻依赖 5：@mui/* / @emotion / lightweight-charts / date-fns /  │
│           react-query（0 import 但 package.json 存在）          │
└─────────────────────────────────────────────────────────────────┘
```

**边界通信协议**：

| From → To | 协议 | 认证 | 关键常量位置 |
|---|---|---|---|
| TS → Python | `child_process.spawn` 子进程 | 无（本地进程） | `backend/src/data/sources/*Client.ts` |
| TS → AI 应用 | HTTP（本地 :8000） | 内部 header（`middlewares/internalAuth.ts`） | `backend/src/config/externalServices.ts` (`TRADING_AGENTS_BASE_URL`) |
| TS → Broker Bridge | HTTP + HMAC 签名 | HMAC + nonce（`LiveBridgeNonce` 防重放） | `backend/src/api/routes/live-trading/bridge.routes.ts` |
| Frontend → TS 后端 | HTTP JSON | JWT bearer | `frontend/src/services/api.ts` |
| AI 应用 → TS 内部 API | HTTP `/api/internal/*` | `middlewares/internalAuth.ts` | 反向调用 |

---

## 2 · 后端 · Models 94 使用矩阵

### 2.1 分级

来自 `notes/audit_backend_summary.md` 完整清点结果（`grep -rL --include='*.ts' 'ModelName' backend/src/models`）：

| 分级 | 数量 | 判定标准 | 处置建议 |
|---|---|---|---|
| **正常使用** | 89 | ≥ 1 处 runtime caller（非 test / 非 lazy） | 保留 |
| **有效孤儿** | 1 | 零 runtime caller · 仅 test 引用 | 详见 §2.2 |
| **近孤儿** | 4 | 单个 lazy require · 无运行时读写路径 | 详见 §2.3 |
| **合计** | 94 | | |

**表命名一致性**：100% snake_case + plural；列数 4–53，中位数 ~15；无违规。

### 2.2 有效孤儿 · `ETFCreationRedemption`（1 项）

- 文件：`backend/src/models/ETFCreationRedemption.ts`
- 表：`etf_creation_redemptions`
- Caller 情况：`grep -rl 'ETFCreationRedemption' backend/src` 命中 3 处 · 均为 test / migration / registration，无 runtime service consumer
- 判定：**effectively orphan** → Task 4 `22-cleanup-candidates.md` 收录（先冻结 3 天再删候选）

### 2.3 近孤儿（4 项）

| Model | Lazy caller 唯一位置 | 判定 |
|---|---|---|
| `AIDiaryEntry` | `services/postmortem/AIDiaryService.ts` | 是否活跃需 li-yiming 确认 |
| `WebhookFallbackLog` | 单个 job 内 lazy require | 是否活跃需 li-yiming 确认 |
| `IndustrySentimentIndex` | `services/sentiment/*` 类别（openapi 声明但可能 stale） | 与 §3.3 stale namespace 联动判断 |
| `DataSourceHealth` | 唯一 healthcheck endpoint | 保留（诊断类） |

**建议**：4 近孤儿 → Task 4 收录进 "近孤儿观察"清单，**不进删除首批**，等 li-yiming M-Draft 决策后再定。

### 2.4 Live-trading 域 model（10 项 · 严禁误删）

`LiveBrokerBridgeHeartbeat` / `LiveBrokerCommand` / `LiveBrokerCommandDispatch` / `LiveBrokerEvent` / `LiveBridgeNonce` / `LiveOrder` / `LiveTrade` / `LivePosition` / `LiveAccountSnapshot` / `LiveExecutionAuditLog` / `LiveKillSwitchState` / `LiveOrderDraft`

- 通过 `/api/live-trading/bridge` HTTP+HMAC 桥接（`integrations/broker-bridge/` HTTP 边界）
- **进 Task 5 protect 清单**（Live-trading 全域 P2-B 只读盘点 · 由 Cleanup 后续处置）

---

## 3 · 后端 · API 路由与 OpenAPI 契约漂移

### 3.1 Route 文件 27 个 · 全 wired

- 总端点数分布 top5：`quant.routes` 48 / `paperTrading.routes` 44 / `market.routes` 26 / `risk.routes` 24 / `settings.routes` 19
- 总 route LOC = 6510
- 双 router 出口：`userFeedback.routes.ts`（`meRouter` + `adminRouter`）
- 额外 mount 来自 `src/live-trading/routes/`：`bridge.routes.ts` (`/api/live-trading/bridge`) + `liveTrading.routes.ts` (`/api/live-trading`)

### 3.2 兼容层 · 可删候选

| 项 | 位置 | 判定 |
|---|---|---|
| **`GET /:id/results`** + **`GET /:id/trades`** 兼容旧版 API | `backend/src/api/routes/backtest.routes.ts`（注释明写"兼容旧版 API"） | 两者均 dispatch 到 `getBacktestDetail` → **合并候选**（Task 4 收录） |
| **`strategy.routes.ts` 单端点薄壳** | 仅 1 endpoint delegates 到 `factorController` | **合并候选**（并入 `factor.routes.ts`；Task 4 收录 · 需 Frontend 联动改 fetch path） |

### 3.3 OpenAPI 契约漂移

- **openapi.json 定义 238 unique paths**
- **6 route 模块整体未文档化**（应补 openapi）：
  - `/api/ai/*` · `/api/data/*` · `/api/docs/*` · `/api/macro/*` · `/api/today/*` · `/api/black-swan/*`
- **3 stale 命名空间**（openapi 声明但代码无实现）：
  - `/api/sentiment/*`（6 paths） · `/api/strategy-research/*`（3） · `/api/signals`（1）
- **前端消费统计**：约 90 unique paths 被前端调用 · 148 openapi entry 无前端消费（62% 是 agent/cron/admin 面 · 非死路径）
- **前端调 openapi 缺**：约 24 条（`/api/today` / `/api/ai` / `/api/docs` / `/api/data` 命名空间为主）

### 3.4 处置建议 · 拆到 Task 4 与 QADocs

- 6 未文档化模块 → **QADocs 主控**：`40-quality-gates.md` 加"openapi/代码一致性"CI 门禁 · 强制补 spec
- 3 stale 命名空间 → **Task 4 `22-cleanup-candidates.md` 收录**：`/api/sentiment/*` 与 §2.3 `IndustrySentimentIndex` 近孤儿联动删除
- **strategy.routes.ts 薄壳合并** → Task 4 收录（需 openapi 同步删 `/api/strategy` 命名空间下遗留 path）

---

## 4 · 后端 · Services 层三分类

**总规模**：顶层 `.ts` 58 个 · 22 子目录 · 总 LOC **~52,988**（wc -l 汇总）

### 4.1 五个 outlier · > 2000 LOC

| Service | LOC | 分类 |
|---|---|---|
| `SchedulerService.ts` | **7,456** | 基础设施 · 调度中枢 |
| `RecommendationTradeOutcomeService.ts` | **4,686** | 计算/展示 · 荐股结果与实际对账 |
| `WeeklyReviewReportService.ts` | **3,377** | 计算/展示 · 周报聚合 |
| `AIInvestmentSignalService.ts` | **2,892** | 计算/展示 · AI 荐股信号（Strategy 核心资产） |
| `AnnouncementNLPService.ts` | **2,115** | 数据接入 · 公告 NLP |

**处置提示**：5 outlier 不进 Task 4 删除候选，需 Strategy §M2 拆分讨论（Strategy 独占决策）。

### 4.2 子目录 22 个 · LOC 排序

| 子目录 | LOC | 分类判定 | 说明 |
|---|---|---|---|
| `research/` | 10,319 | **计算/展示** | 研究平台核心 · Strategy 独占 · Task 5 protect |
| `execution/` | 3,935 | **计算/展示** | 交易执行辅助 · Live-trading 关联 |
| `postmortem/` | 3,725 | **计算/展示** | 复盘 · Strategy 独占 · Task 5 protect |
| `portfolio/` | 3,274 | **计算/展示** | 组合管理 · Strategy 独占 · Task 5 protect |
| `attribution/` | 2,671 | **计算/展示** | 归因分析 · Strategy 独占 |
| `governor/` | 2,087 | **计算/展示** | 政策/预算护栏 · Strategy 独占 |
| `meta-v2/` | 1,145 | **计算/展示** | Meta 特征聚合 |
| `analysis-engine/` | 1,061 | **计算/展示** | 分析引擎 |
| `event-intelligence/` | (未细测) | **计算/展示** | 事件情报 · Strategy 独占 |
| `theme/` | (未细测) | **计算/展示** | 主题层 · 呼应 Research §6.3 T1 主题层引入讨论 |
| `factor/` | (未细测) | **计算/展示** | 因子层 · Strategy 独占 §11.1 权重锚 |
| `regime/` | (未细测) | **计算/展示** | Regime · Strategy 独占 |
| `calibration/` | (未细测) | **计算/展示** | 校准 |
| `playbook/` | (未细测) | **计算/展示** | Playbook |
| `tca/` | (未细测) | **计算/展示** | TCA 交易成本 |
| `announcement/` | (未细测) | **数据接入** | 公告处理 |
| `news/` | (未细测) | **数据接入** | 新闻处理 |
| `black-swan/` | 空目录 | **其他** | 无 .ts 文件 · Task 4 可删（目录级） |
| `etf/` | (未细测) | **数据接入** | ETF 数据/管理 |
| `cash/` | (未细测) | **计算/展示** | 现金管理 |
| `exit/` | (未细测) | **计算/展示** | 退出策略 |
| `integration/` | (未细测) | **其他 · 疑似 dead glue** | 见 §4.3 |

### 4.3 疑似 dead glue

- `backend/src/services/integration/production-bridges.ts` · **464 LOC** · 零外部 caller
- 判定：**Task 4 收录**（先冻结 3 天再删候选 · 需 Cleanup 二次确认无 dynamic import）

### 4.4 顶层 58 service 三分类

**（A）数据接入类**（≈ 12 项 · 见 `data/sources/` 边界）
- 主要在 `backend/src/data/sources/*Client.ts` 20 个（§5.1 详列）
- 顶层 service 侧：`AnnouncementNLPService` / `DataFreshnessCheckService` / `DataQualityService` / `DataQualityDeepCheckService` / `DataHealthStatusService` / `RuntimeSchemaHealthService` / `RealtimeIndexService` / `RealtimeAlertDispatcher` / `TaskAutomationHealthService` / `TaskParameterAuditService`

**（B）计算/展示类**（≈ 38 项 · Strategy 独占核心资产）
- `AIInvestmentSignalService` / `RecommendationTradeOutcomeService` / `TodayCommandCenterService` / `TodaySignalsService` / `BlackSwanDetectorService` / `BlackSwanPostmortemService` / `BlackSwanImprovementSuggestorService` / `BlackSwanQuarterlyReportService` / `BullishEventDetectorService` / `ThemeFermentationDetector` / `TechnicalAnalysisService` / `MarketEnvironmentService` / `MarketJudgmentService` / `MarketBriefService` / `WeeklyReviewReportService` / `CounterfactualBaselineService` / `SizingAuditService` / `ExposureCoachService` / `PortfolioCorrelationService` / `TradeComplianceChecker` / `TradePolicyExplainService` / `TradePostmortemService` / `TradeRootCauseClassifier` / `EnhancedTradingJournalService` / `EventTimelineReplayerService` / `ReviewPerformanceCenterService` / `DailyTradingDigestService` / `RiskAlertService` / `RiskThresholdAttributionService` / `RiskThresholdStabilityService` / `AIAdvisorService` / `BenchmarkIndexService` / `CriticalAnnouncementPushService` / `SchedulerService` / `SystemHealthDetailService` / `DailyHealthReportService` / `SystemAdminAlertPusher`

**（C）其他类**（≈ 8 项 · 通知 / 备份 / 缓存清理）
- `AliyunSmsService` / `EmailNotificationService` / `NotificationService` / `FeishuBotWebhookService` / `FeishuTaskReportService` / `WeChatOAService` / `WeChatOAClient` / `CleanupOldDataService` / `DbBackupService` / `UserFeedbackService`

### 4.5 Strategy 独占 protect 备选（12 个策略近邻子域 + 顶层）

**子目录**：`services/{analysis-engine, attribution, calibration, event-intelligence, factor, meta-v2, playbook, portfolio, postmortem, regime, research, theme}/**`

**顶层 service**：`AIInvestmentSignalService` / `RecommendationTradeOutcomeService` / `TodayCommandCenterService` / `TodaySignalsService` / `BlackSwan*Service (4)` / `BullishEventDetectorService` / `ThemeFermentationDetector` / `TechnicalAnalysisService` / `MarketEnvironmentService` / `MarketJudgmentService` / `MarketBriefService` / `TradePolicyExplainService` / `TradePostmortemService` / `TradeRootCauseClassifier` / `TradeComplianceChecker` / `WeeklyReviewReportService` / `CounterfactualBaselineService` / `SizingAuditService` / `ExposureCoachService` / `PortfolioCorrelationService`

→ **Task 5 `23-protect-list.md` glob 收录**

---

## 5 · 后端 · 跨系统调用图

### 5.1 TS → Python spawn (20 clients)

**位置**：`backend/src/data/sources/*Client.ts`

| Client | Python helper | 用途 |
|---|---|---|
| `AKShareClient` | `backend/python/akshare_helper.py` | AKShare 数据（慢回退，非默认） |
| `AnalystForecastClient` | `analyst_forecast_helper.py` | 分析师预测 |
| `AnnouncementClient` | `announcement_helper.py` | 公告 |
| `BaostockClient` | `baostock_helper.py` | Baostock 数据 |
| `BlackSwanClient` | `black_swan_helper.py` | 黑天鹅指标 |
| `DragonTigerClient` | `dragon_tiger_helper.py` | 龙虎榜 |
| `ETFFlowClient` | `etf_flow_helper.py` | ETF 资金流 |
| `EarningsForecastClient` | `earnings_forecast_helper.py` | 业绩预告 |
| `IndexComponentClient` | `index_component_helper.py` | 指数成分 |
| `IndustryFlowClient` | `industry_flow_helper.py` | 行业资金流 |
| `LimitDownClient` | `limit_down_helper.py` | 跌停股 |
| `LimitUpClient` | `limit_up_helper.py` | 涨停股 |
| `MarginBalanceClient` | `margin_balance_helper.py` | 融资余额 |
| `NorthboundClient` | `northbound_helper.py` | 北向资金 |
| `PythonMarketDataClient` | `python_market_data_helper.py` | 通用市场数据聚合 |
| `RestrictedShareClient` | `restricted_share_helper.py` | 限售解禁 |
| `SnowballHotKeywordClient` | `snowball_hot_keyword_helper.py` | 雪球热搜 |
| `StockQAClient` | `stock_qa_helper.py` | 股票问答 |
| `TencentFinanceClient` | `tencent_finance_helper.py` | 腾讯财经 |
| `TushareClient` | `tushare_helper.py` | Tushare 数据 |
| `SinaFinanceClient` | `sina_finance_helper.py` | 新浪财经 |

**复合层**：
- `CombinedDataSource.ts`（聚合器）
- `MarketDataProvider.ts`（门面）

**脚本级 spawn**（不进 client 分类）：
- `scripts/run-tests.ts` (`spawnSync`)
- `scripts/sync-extra-dims.ts` (`spawn`)

**呼应 Research §6.1 B5 借鉴项**：20 client 中至少 3 项走 Sina / Tencent / Tushare 直连，与参考项目"直连优先 + AkShare opt-in"策略天然契合 → DataPipeline `data-sources-consolidation.md` v1 采纳时可基于此现状分层重构。

### 5.2 TS → AI 服务（`ai/tradingagents-app`）

- **配置**：`backend/src/config/externalServices.ts` · `TRADING_AGENTS_BASE_URL` 默认 `http://127.0.0.1:8000`，env `TRADING_AGENTS_URL` 覆盖
- **直接调用点 15 处**：
  - Controllers: `AIAdvisorController`
  - Services: `AIAdvisorService` / `AnnouncementNLPService` / `EnhancedTradingJournalService` / `MarketBriefService` / `SystemHealthDetailService` / `TechnicalAnalysisService` / `WeeklyReviewReportService` / `DataSourceHealthService`
  - `attribution/AIAttributionSummary` / `postmortem/AIDiaryService`
  - Bootstrap: `index.ts` / `EnvValidator` / `externalServices` / `sync-announcements.ts`
- **42 文件含 `TradingAgents` / `tradingagents` 字面**（含 `jobs/aiPolling*.ts` Bull 队列、`middlewares/internalAuth.ts` 反向 `/api/internal/*` 认证）

### 5.3 TS → Broker Bridge（`integrations/broker-bridge/`）

- **无 `require` / `import` 依赖**；仅通过 `/api/live-trading/bridge` HTTP + HMAC 桥接
- **10 `Live*` model 关联**（§2.4 已列）
- **`brokerCompatMatrix.ts`** 记录 `qmt_bridge/qmt_adapter.py` + `ptrade_bridge/ptrade_adapter.py` 路径字符串（元数据，非 import）
- **31 files** in `integrations/broker-bridge/`

**Live-trading 全景**（P2-B 只读盘点用）：
- 子目录 `execution/` / `tca/` / `governor/` / `integration/`
- 全 `src/live-trading/`（brokers / services / routes / middlewares / controllers）+ 10 `Live*` models
- `src/api/routes/{quant, paperTrading}.routes.ts` 的 order-intent + risk 端点
- `src/portfolio/internal/PaperTradingAutomationService.ts`（buy-decision loop）

---

## 6 · 前端 · 库使用真实态

### 6.1 依赖真实态 vs package.json 声明

| 库 | package.json | 实际 import 站点 | 结论 |
|---|---|---:|---|
| **antd + @ant-design/icons** | ^5.7.0 / ^5.3.0 | **46 + 44** | 主 UI ✅ |
| `@heroicons/react` | ^2.2.0 | **~44** | 可迁 → @ant-design/icons（Frontend 确认） |
| `dayjs` | ^1.11.20 | **16** | 主时间 ✅ |
| `framer-motion` | ^12.42.0 | **9** | 保留 |
| `recharts` | ^2.7.0 | **6** | Orchestrator D8 建议弃用（详见 §6.3） |
| `react-markdown` + `remark-gfm` | ^10.1.0 / ^4.0.1 | **3** | 保留 |
| `monaco-editor` | ^0.41.0 | **1 lazy** | 保留（`MonacoSourceViewer.tsx`） |
| `echarts` + `echarts-for-react` | ^6.1.0 / ^3.0.6 | **1** | 只在 `StockDetailPanel.tsx` K 线 → D8 建议扩用 |
| **`@mui/material` + `@mui/icons-material`** | ^9.0.0 | **0** | **幻依赖** → 可删 |
| `@emotion/react` + `@emotion/styled` | ^11.14.x | **0** 直接 import | MUI 传递依赖 → MUI 走则一起走 |
| **`lightweight-charts`** | ^4.0.1 | **0** | **幻依赖**（未来态） |
| **`date-fns`** | ^2.30.0 | **0** | **幻依赖** → 可删 |
| **`react-query`** | ^3.39.3 | **0** | **幻依赖**（异步靠 useState + useEffect） |

**结论**：5 项幻依赖 → **Task 4 `22-cleanup-candidates.md` 收录**（`@mui/*` + `@emotion` + `lightweight-charts` + `date-fns` + `react-query`）· package.json / package-lock.json 删依赖后节省 node_modules 显著。

### 6.2 页面口径统一（Frontend D10 提案）

- **L1 = top-level URL 入口**（`App.tsx` `<Route path=...>`），有唯一 URL + 独立 route guard
- **L2 = workspace shell 内独立 tab**（query/hash 或子路由承接）
- **现状**：top-level routes ~48，含 legacy（`/legacy/backtest/:id` / `/quant-*` / `/autonomous-*` / `/agent-tail-alpha`）
- **`pages/*.tsx` 7 个**：Login / HomeWorkspace / StockDetail / DataUpdateStatus / TaskScheduler / SystemLogs / HealthMonitor
- **`pages/workspace/**` 43 个**：8 workspaces + 各 tab

### 6.3 前端 dead code 候选（→ Task 4）

**未路由的 orphan 页面**（FRONTEND_ARCHITECTURE.md §Phase 4 声称"已合入 DataWorkspace tab"但文件仍在）：
- `pages/DataUpdateStatus.tsx`
- `pages/HealthMonitor.tsx`
- `pages/SystemLogs.tsx`
- `pages/TaskScheduler.tsx`

**根级脚本类**（一次性 · 无 CI 引用）：
- `refactor.js`（135 行 / 4146 bytes · camelCase → snake_case walk · 一次性）
- `fix_lint.sh` / `fix_lint_2.sh`（对已不存在文件做 sed）

**根级构建产物残留**：
- `build.tgz` / `build_new.tgz` / `build_new2.tgz`（合 ~24MB · `.gitignore` 已 `*.tgz` 覆盖，但仓库 tree 未清）

**根级日志**：
- `logs/combined.log` / `logs/error.log`（古董）

**待确认**：
- `.env.production`（28B · 需确认只是 `REACT_APP_API_BASE_URL`）

### 6.4 `frontend/services/` orphan candidates

- `userService.ts`（12 行 · FRONTEND_ARCHITECTURE.md §6.2 说"保留待接入" → 【需人工确认】）
- `api.ts` 顶层 helper 无 consumer 13 个（Legacy pages 删了但 helper 遗留）：
  - `getMarketOverview` / `getFavorites` / `addFavorite` / `removeFavorite` / `checkFavorite` / `updateFavorite` / `getAutonomousTradingDashboard` / `getOrderIntentFamilyHindsight` / `getRecommendationTracking` / `getAutonomousOptimization` / `runPaperTradingRiskCheck` / `runAutonomousAutoSync` / `runAutonomousRiskCheck`

### 6.5 FRONTEND_ARCHITECTURE.md 漂移点（→ QADocs 文档一致性）

- 声称 5 基础 + 3 admin = 8 menu items，实际 6 base + 3 admin = 9（`AIAnalysisWorkspace` 2026-07-04 新增）
- 声称 `/workspace/today` 活页面勿删，实际 `<Navigate to="/home" replace />`
- 声称 4 legacy 页面已合入 DataWorkspace tab，实际文件仍在
- 声称 nginx :3001，`docker-compose.yml` 无 nginx service（实际 `node server.js` 直起）

### 6.6 EasyQuant 设计约束（合规 · 无需处置）

- `EASY_QUANT_UI_DESIGN_GUIDELINES.md` 10 个 `--eq-*` CSS token 全部在 `EasyQuantWorkspace.css` 对齐（197 处引用）
- **未泄漏至 `index.css`**（正确 scoping）

---

## 7 · 现有 signal_v3 输出结构 vs Strategy `50-strategy-design.md` v0.1/v0.2 契约差距

**Strategy msg=3d3e508d 决策 3 双 group 结构（core 5 维 / satellite 6 维）尚未在我方代码中体现**。本节列出 diff 供 Strategy `contracts/strategy.md` v1 起草消费。

**命名注**：Strategy msg=582933d0 已提出把契约字段名从 `analyst_profile`（参考项目 catalyst 词源，QADocs §Reference-Project-Compliance 规则 2 命中拒 PR）重命名为 **`explain_card`**（Frontend msg=5886ff73 已采纳）。本节 diff 表沿用 `explain_card` 作为契约字段名 · 结构与 §7.2 展示的 6 维分组无变化，只是 slug 换名（Strategy `contracts/strategy.md` v1 冻结时以 Strategy 侧最终决定为准）。

### 7.1 现有 signal_v3 字段（来自 `services/AIInvestmentSignalService.ts` 与 `types/signal.ts` 类型定义 · 需 Strategy 二次核对）

- `id` / `stock_code` / `stock_name`
- `action`（`BUY | SELL | HOLD`）· 3 态
- `confidence`（0-1）
- `reason`（自由文本）
- `factor_snapshot`（因子分数 map，V/Q/L/M 4 键）
- `theme_id`（可选 · 用于板块归属，未强制）
- `signal_source`（`ai_advisor | technical | catalyst | ...`）
- `available_at` / `report_date` / `publish_date`（PIT 三时点 · ADR-0001 §10 已锁）
- `gate_pass`（bool · L1 硬拒结果）
- `expires_at`

### 7.2 Diff vs Strategy v0.2 契约（预期 `explain_card` 分组结构）

| 契约字段 | 现状 | 差距 |
|---|---|---|
| `rating: bullish/neutral/bearish` | 有 `action: BUY/SELL/HOLD` | **命名迁移**（3 态语义一致，仅 slug 变） |
| `risk_gate: pass/watch/block` | 有 `gate_pass: bool` | **升级 2 → 3 态**（新增 watch） |
| `dimension_group: 'core' \| 'satellite'` | **缺** | **新增 discriminator 字段** |
| `dimensions.core` = V/Q/L/M/risk 5 维 | 有 `factor_snapshot` 4 键 | **需补 risk 维 · 从 gate_pass + risk_alerts 折算** |
| `dimensions.satellite` = catalyst/history_edge/quality_proxy/momentum/news/risk 6 维 | **缺** | **新增卫星层结构** · 需 §1.4.3 signal detector 实现输出这 6 维 |
| `entry_plan` | 现有 `reason` 自由文本 | **需拆分**（entry_plan 独立段落 · 含分批/止损纪律） |
| `scenario: {bull, base, bear}` | **缺** | **新增 3 情景短句**（Strategy 自研 UX 文案） |
| `positive_flags` / `risk_flags` | 部分从 `triggered_signals` 折算 | **需正式拆分**（正/负 flag 词表 Strategy 自研） |
| `conviction: 0-100` | 有 `confidence: 0-1` | **归一化 → 0-100 · scale 转换** |
| `method: string` | **缺** | **新增方法学自解释字段**（Strategy 每 signal 附 method 描述） |

### 7.3 影响面

**代码变更范围**（估算 · 待 Strategy 独占）：
- `types/signal.ts` 类型定义扩展（新增 `analyst_profile` 子结构）
- `AIInvestmentSignalService.ts` 输出组装逻辑（现有 `factor_snapshot` → `dimensions.core` · 新增 `dimensions.satellite` 输出路径）
- 卫星层新增 6 维 signal detector（Strategy §1.4.3 新章节 · B1 5 因子借鉴模板独立实现）
- 前端 `frontend/src/services/api.ts` fetch schema 校验（zod）需同步扩
- OpenAPI 定义补齐（`signals` / `today-signals` / `ai-signal` 命名空间 3 处 endpoint 需重发 schema）

**处置**：本表是 **Strategy `contracts/strategy.md` v1 起草的必输入**；Strategy msg=3d3e508d §3 T-0 已明确"Research 21-current-audit 落地是 signal_v3 v1 起草的唯一硬依赖"。

---

## 8 · 目录级 dead / 疑似 dead 汇总（→ Task 4 输入）

| 路径 | 类别 | 判定 | 证据 |
|---|---|---|---|
| `ralph/` + `ralph/archive/` | 顶层归档目录 | **删候选**（Orchestrator msg=4b0f5bd4 已 pre-approve） | Cleanup fast-forward 后已归档 · 无引用 |
| `backend/dist/` | 构建产物 | **git-ignored 应删** | `.gitignore` 已覆盖，tree 未清 |
| `frontend/build/` | 构建产物 | **git-ignored 应删** | 同上 |
| `.artifacts/server-rescue-20260519` | 一次性救援归档 | **删候选**（需 li-yiming 确认可归档到备份盘） | 与 SSH 磁盘 86% 告警关联 |
| `.build_logs/` | 构建日志 | **删候选** | 无外部消费 |
| `.bridge-state/` | Bridge 运行时状态 | **保留**（Live-trading 关联） | Live-trading protect 域 |
| `logs/` | 根级日志（`combined.log` / `error.log`） | **删候选** | 古董 |
| `shots/` | 屏幕截图（用途未明） | **待确认**（需 li-yiming） | 无 CI/文档引用 |
| `docs/backups/` | 文档旧版本备份 | **删候选** | 无双向索引 |
| `docs/trader-system/` | 旧版 trader system 设计文档 | **待确认**（可能已被 `docs/refactor/**` 覆盖） | 与 `docs/compass/` 关系需 QADocs 独占决策 |
| `scripts/deployment/*.js` | 部署脚本（4 hits） | **删候选**（Orchestrator msg=4b0f5bd4 已 pre-approve · 部署方式已废弃 li-yiming msg=fa1caa7a） | li-yiming msg 说部署最后再做 |
| `services/black-swan/` 空目录 | 空目录 | **删候选** | 无文件 |
| `services/integration/production-bridges.ts` | Dead glue 464 LOC | **删候选**（需 Cleanup 二次确认无 dynamic import） | 零外部 caller |
| `frontend/refactor.js` | 一次性脚本 | **删候选** | 135 行 · 4146 bytes · 无 CI 引用 |
| `frontend/fix_lint*.sh` | 一次性脚本 | **删候选** | 对已不存在文件做 sed |
| `frontend/build*.tgz` | 构建产物 | **删候选** | .gitignore 已覆盖 |
| 根级 `backup_data.json` / `test_akshare*.py` / `sync_files.sh` / `rename_columns.sql` / 8 `.exp` 文件 | 一次性运维产物 | **删候选**（Orchestrator msg=4b0f5bd4 已 pre-approve） | 无双向引用 |
| `SystemTopologyMap.tsx:176` + `LabWorkspace.AdvancedQuantTab.tsx:747` 硬编码 | 硬编码嫌疑 | **进 Task 4 evidence section**（需人工审是否 mock/placeholder） | Orchestrator msg=4b0f5bd4 pre-approved 纳入 |

---

## 9 · Q5 · 4 传统策略（MACD / RSI / BB / MA）引用扫描

Orchestrator msg=4b0f5bd4 已 pre-approve 纳入 Task 4 evidence section。本节仅 **grep 事实**：

**指令**：`rg -c 'macd|rsi|bollinger|BollingerBands|MovingAverage' backend/src frontend/src`

**判定框架**（等 Task 4 详展开）：
- **保留**：作为可解释因子或 UI 展示指标（如 `TechnicalAnalysisService` 内 MACD 分析）
- **删除**：作为独立"策略"逻辑（如 `services/strategies/macd-strategy.ts` 或 `LabWorkspace.tsx` 内 4 传统策略 tab 硬编码）

**执行建议**：Task 4 内起 4 条独立行 · 每条附 `rg` 命令输出 + 文件路径 + 判定 + evidence chain。

---

## 10 · 密钥 / secrets 现状（→ QADocs `40-quality-gates.md` §Reference-Project-Compliance）

**已知 11 项密钥 evidence**（Cleanup 12 命中中已处置，QADocs `40-quality-gates.md` 明日 PR 落 `.gitleaks.toml` 主控）：

- `sk-*` / `AIA*` / `xoxb-*` 等 API key 前缀 · 已 Cleanup fast-forward 归档
- `.env.example` 与 `.env` 命名规范 · ADR §凭证纪律已定
- SSH 私钥 / password 类 · 已 li-yiming msg=ed61c397 + msg=fa1e2215 处置

**Task 4 只做 index**，QADocs 主控 `.gitleaks.toml` + 事件响应流程。

---

## 11 · 分层与命名一致性 vs `dir-ownership.md`

**规则**：`dir-ownership.md` v0 已冻结 40-49 QADocs / 50-59 Strategy / 60-69 Frontend / 70-79 DataPipeline / 20-29 Research 独占（+ QADocs `contracts/backtest.md` + Strategy `contracts/strategy.md` + DataPipeline `contracts/data.md` + Frontend `contracts/display.md`）。

**扫描 · 无违规**：
- `docs/refactor/20-reference-report.md` ✅（Research 独占）
- `docs/refactor/50-strategy-design.md` v0.1 ✅（Strategy 独占）
- `docs/refactor/contracts/protect.md` v0 ✅（Orchestrator 独占）
- `docs/refactor/contracts/data-fixture-spec.md` ✅（DataPipeline 独占）
- 各 workspace `notes/baseline-drafts/**` ✅（各 agent workspace 隔离）

**Research 独占本文 = `21-current-audit.md`** · 无跨领域越界。

---

## 12 · 交叉引用

- 上位：`00-anchor.md` · li-yiming brief msg=afe6236a · `dir-ownership.md` v0
- 同域兄弟：`20-reference-report.md`（参考通读）· `22-cleanup-candidates.md`（清理清单 · 本文 §8 §9 §10 §6.3 → 输入）· `23-protect-list.md`（保护清单 · 本文 §2.4 §4.5 §5.3 → 输入）
- 下游消费：
  - `50-strategy-design.md` v0.2（Strategy 消费本文 §7 diff 表）
  - `60-frontend-design.md` v1（Frontend 消费本文 §6）
  - `70-data-sources-consolidation.md` v1（DataPipeline 消费本文 §5.1）
  - `40-quality-gates.md`（QADocs 消费本文 §3.3 openapi 漂移 + §6.5 doc 漂移 + §10）
- ADR：`adr/0001-layering-and-collab.md` §10 数据契约 · §11.1 权重锚 · §凭证纪律
- 消息 ID：Orchestrator msg=a5e73982 · msg=4b0f5bd4 · msg=4ea8cc06；Strategy msg=dd93f625 · msg=3d3e508d；Frontend msg=76480c99 · msg=b45f58e4；DataPipeline msg=24784ee7 · msg=00f809df；QADocs msg=7a4a9671 · msg=dcb0d012

---

**Doc 版本**：v1.0 · 2026-07-07 · Research 起草
**下一批更新触发**：Task 4 `22-cleanup-candidates.md` 落地后 · 若 Cleanup 二次确认发现本文遗漏，回填 §8；Strategy `contracts/strategy.md` v1 起草若 §7 diff 表字段不一致，Strategy 侧回执补丁
