# 现状理解文档（monorepo 闭环 + AI 个股分析）

**生成日期**：2026-06-18
**worktree**：`.claude/worktrees/happy-torvalds-180c51`
**作者**：高级量化交易系统工程审计 agent
**前置规则**：本文档只用于"对齐架构理解"，不含修改方案；所有结论必须基于代码（含 `文件:行号`）。后续 [closed_loop_audit_2026_06_18.md](closed_loop_audit_2026_06_18.md) 与 [analysis_engine_design_2026_06_18.md](analysis_engine_design_2026_06_18.md) 以本文为基线。

---

## 0. 重要前置：纠正与"两个项目"叙述的偏差

我接到的 prompt 把项目讲成"两个仓库（操盘手闭环 + tradingagent）"，实际并不是。读完代码与已有审计文档后，事实是：

1. **本仓库是 monorepo**，根目录下 [backend/](../../backend/) + [frontend/](../../frontend/) + [integrations/broker-bridge/](../../integrations/broker-bridge/) + [backend/python/](../../backend/python/)（akshare 助手进程）。"操盘手闭环"和"AI 个股分析"都在这同一棵树里，不是两个仓库。
2. **TradingAgents 是独立的 FastAPI 多智能体服务**（基址常量见下文 §3.2），不在本仓库；本仓库通过 HTTP 与之交互。
3. **目前 `AIAdvisorService.analyzeSingleStock` 的"5 维度"并不是 5 个独立 analyzer**，而是**一次大 prompt 拿回一段研报后用本地 regex/字段映射拆成 5 块**——这是后续阶段二要替换的真正"固定流程"。证据：[AIAdvisorService.ts:77-83](../../backend/src/services/AIAdvisorService.ts) frozen 常量 `ANALYSIS_DIMENSIONS` + `:257-318` 的 `buildKeyPoints`。
4. **回测和实盘的"同源"假设错了一半**：因子/`evaluate()` 策略代码共享，但 13 个**组合级 `generateSignals()` 新式策略（MFA / DragonHead / Breakout / LeftSideReversal / Ensemble 等）的 `evaluate()` 全部退化为 `'hold'`**——回测引擎从未真正执行这些核心策略。详见 [closed_loop_audit](closed_loop_audit_2026_06_18.md) §S-1。

---

## 1. 物理拓扑（运行时进程）

```
┌─────────────────────────────────────────────────────────────────┐
│                    用户 / 浏览器                                  │
│  React + TS + Antd + Recharts (frontend/)                      │
└─────────────────────────────────────────────────────────────────┘
                ▲ HTTP/SSE
                │
┌─────────────────────────────────────────────────────────────────┐
│  Node.js + TypeScript (backend/)                                │
│  ├── Express API + WebSocket/SSE                                │
│  ├── Sequelize ORM → PostgreSQL + TimescaleDB                   │
│  ├── Bull(Redis) 队列：aiPolling / quantBacktest / dataUpdate    │
│  ├── SchedulerService（自研 cron）                              │
│  └── 子模块：                                                    │
│       quant/   strategies / factors / engine / backtest         │
│       portfolio/  risk / sizing / rebalance / paperTrading      │
│       live-trading/  brokers / bridge / safety / killSwitch     │
│       services/  recommendation / AI / event-intel / sentiment   │
└─────────────────────────────────────────────────────────────────┘
       ▲ stdio child_process       ▲ HTTP (HMAC+nonce)       ▲ HTTP
       │                            │                          │
┌──────┴────────────┐    ┌──────────┴───────────┐   ┌──────────┴────────────┐
│ Python helpers    │    │ broker-bridge        │   │ TradingAgents FastAPI │
│ akshare_helper.py │    │ qmt_bridge/ptrade    │   │ <internal-host>       │
│ market_data_…py   │    │ (Windows 跑)         │   │  :8000  (外部服务)    │
│ 数据源 + 代理池   │    │ adapter.place_order  │   │ /api/analyze 等       │
└───────────────────┘    └──────────────────────┘   └───────────────────────┘
```

进程边界要点：
- broker-bridge 必须 Windows 跑、HMAC + nonce + 时钟偏差 ≤ 60s（[docs/QMT_PTRADE_LIVE_TRADING_ROADMAP.md](../QMT_PTRADE_LIVE_TRADING_ROADMAP.md) §6.1）。
- bridge 接入 nginx，需独立 `proxy_*_timeout=40s` + `proxy_buffering off`；SSE 走 `X-Accel-Buffering: no`；容器健康检查**不**打 bridge 路由（[docs/live_trading_launch_checklist.md](../live_trading_launch_checklist.md) §69-75）。
- TradingAgents 外部基址 `<internal-host>:8000` **作为 env 默认值硬编码在 10 处**（[AIAdvisorService.ts:9](../../backend/src/services/AIAdvisorService.ts)、[TechnicalAnalysisService.ts:9](../../backend/src/services/TechnicalAnalysisService.ts)、[MarketBriefService.ts:65](../../backend/src/services/MarketBriefService.ts) 等），不是 secret 但**暴露内部 IP**。

---

## 2. "操盘手闭环"链路：信号 → 资金结算 全景

### 2.1 模拟盘闭环（当前真正在运行的全链路）

```
SchedulerService.AUTO_RECOMMENDATION_LOOP                         (services/SchedulerService.ts:3443)
  ↓
AutomatedRecommendationLoopService.run                            (services/AutomatedRecommendationLoopService.ts:1720)
  ├─ generateRecommendations → 选股 + 排序 + 加载市场环境
  │      └─ QuantRecommendationService.scoreStock                 (services/QuantRecommendationService.ts:828)
  │             └─ SignalEngine.generate / QuantSignalService     (quant/engine/internal/QuantSignalService.ts:136)
  │                    └─ strategy.evaluate(...)                  (quant/strategies/*.ts)
  ├─ archiveQuantRecommendations → AIInvestmentSignal             (services/AIInvestmentSignalService.ts)
  └─ if run_paper_trading:
        PaperTradingAutomationService.runAutoSync                 (portfolio/internal/PaperTradingAutomationService.ts:1801)
           ├─ autoBuyFromSignals
           │     ├─ tryReserveInflightBuy (内存 Set 锁)            (:3178)
           │     └─ createBuyTrade (Postgres tx + LOCK.UPDATE)     (:6679)
           │           ├─ preTradeGuards.checkPreBuyGuards         (portfolio/internal/preTradeGuards.ts:76)
           │           │     ├─ DrawdownCircuitBreaker (fail-open)
           │           │     └─ PositionLimitGuard
           │           └─ ExecutionFeasibilityService (Buy Gate)   (services/execution/ExecutionFeasibilityService.ts)
           ├─ refreshPortfolioOutcomes
           │     └─ RecommendationTradeOutcome afterUpdate hook    (models/RecommendationTradeOutcome.ts:278)
           │           └─ TradeComplianceChecker (5-wizard, 事后)  (services/TradeComplianceChecker.ts:61)
           └─ AI 复核排队（per top N）
                 aiPollingQueue.add → aiPollingWorker              (jobs/aiPollingWorker.ts)
                       └─ aiAdvisorService.getTaskStatus
                             └─ autoBuyFromSignals(agent-only ptf)
```

**关键证据**（无逐行展开，详见后续审计报告）：
- 状态机：`LiveOrderDraft.status` [models/LiveOrderDraft.ts:58](../../backend/src/models/LiveOrderDraft.ts)、`LiveBrokerCommand.status` [models/LiveBrokerCommand.ts:67](../../backend/src/models/LiveBrokerCommand.ts)、`LiveOrder.bridge_status` [models/LiveOrder.ts:62](../../backend/src/models/LiveOrder.ts)。
- 幂等键：`client_order_id = 'live-draft-{draft.id}'`，DB UNIQUE，[LiveTradingService.ts:1740](../../backend/src/live-trading/services/LiveTradingService.ts)。

### 2.2 实盘旁路（受七重闸门保护，目前默认走 MockBrokerGateway）

```
POST /api/live-trading/order-drafts                       (live-trading/routes/liveTrading.routes.ts:282)
   └─ createDraft (LiveTradingService.ts:1448)
        └─ LiveRiskGuardService.evaluate (single_order_pct / single_position_pct / total_exposure /
                                          ST / limit_up_buy / price_deviation / quote_freshness /
                                          account_max_single_order_amount)
                                                          (live-trading/services/LiveRiskGuardService.ts:60-225)

POST /api/live-trading/order-drafts/:id/approve           (liveTrading.routes.ts:302)
   └─ approveDraft (LiveTradingService.ts:1627)
        ├─ SELECT FOR UPDATE on LiveOrderDraft            (:1632-1640)
        ├─ recheckDraft → 重跑 LiveRiskGuardService       (:1671)
        └─ LiveTradingSafetyService.assertOrderExecutionAllowed
                                                          (live-trading/services/LiveTradingSafetyService.ts:155)
              ↳ 七项必须全真：LIVE_TRADING_ENABLED / LIVE_ORDER_EXECUTION_ENABLED /
                            !env_kill / !db_kill / gateway_allowlist /
                            trading_capability / licensed_provider
        └─ submitApprovedDraft → 写 LiveBrokerCommand(pending)
                                                          (:1729-1846)

  bridge HTTP pull (Windows 端 qmt_bridge / ptrade_bridge)
     ├─ UPDATE ... WHERE status='pending' FOR UPDATE SKIP LOCKED
                                                          (BridgeService.ts:513-534)
     ├─ HMAC + nonce + ts 校验                            (bridgeAuth.ts:24-43)
     └─ allow_order_execution 闸门 → 假则 _send_dry_run_event
                                                          (qmt_bridge/main.py:201-216)

  事件回流：POST /api/bridge/events
     └─ (command_id, event_seq) UNIQUE 幂等
        + max(event_seq) 才推进状态                       (BridgeService.ts:660-675)
        + advanceCommandStatus 事务 + 终态保护             (:679-812)
```

**两道闸门已严密**：
- `LiveTradingService` constructor 只允许 `env_readonly / bridge_readonly` 进入有 gateway 的分支，其余 fallback `MockBrokerGateway`（[LiveTradingService.ts:180-203](../../backend/src/live-trading/services/LiveTradingService.ts)）。
- `MockBrokerGateway.placeOrder` 直接抛错（[MockBrokerGateway.ts:63-65](../../backend/src/live-trading/brokers/MockBrokerGateway.ts)）。
- `productionPreflight` 强制 production + executionEnabled 时 `LIVE_BROKER_GATEWAY ∈ {qmt_bridge, ptrade_bridge}`（[utils/productionPreflight.ts:255-265](../../backend/src/utils/productionPreflight.ts)）。
- `approveDraft` 拒绝 `skip_confirmation / unattended`（[LiveTradingService.ts:1644-1659](../../backend/src/live-trading/services/LiveTradingService.ts)）。

---

## 3. "AI 个股分析"链路：两条入口并存

### 3.1 旧入口（异步任务，归档为 `AIInvestmentSignal`）

```
POST /api/ai/analyze                  (api/controllers/AIAdvisorController.ts:93)
  └─ AIAdvisorService.analyzeStock    (services/AIAdvisorService.ts:911)
       └─ POST {TRADING_AGENTS_URL}/api/analyze     timeout=60s
       └─ archive → AIInvestmentSignal (source_type='tradingagents')
              └─ verifySignalReturns horizon[1,3,5,10,20]
                                       (AIInvestmentSignalService.ts:18)
```

### 3.2 新入口（US-055 "5 维度"——但实际是单次大 prompt + 本地拆分）

```
POST /api/ai/analyze-single-stock     (AIAdvisorController.ts:293)
SSE  /api/ai/analyze-single-stock/stream
                                       (AIAdvisorController.ts:345)
  └─ AIAdvisorService.analyzeSingleStock(stockCode, options)
                                       (AIAdvisorService.ts:981)
       └─ 1 次 POST /api/analyze        (单次)
       └─ buildKeyPoints(text)         按 frozen 5 维度名 split 字段
                                       (AIAdvisorService.ts:257-318)
       └─ 落 AIStockAnalysisReport
                                       (models/AIStockAnalysisReport.ts)
```

**5 维度常量**（替换 prompt 里"固定模型"概念的物理位置）：
```ts
// backend/src/services/AIAdvisorService.ts:77-83
export const ANALYSIS_DIMENSIONS = Object.freeze([
  'fundamental','technical','capital','news','sentiment',
] as const);
```
前端硬编码同集合：[frontend/src/services/aiStockAnalysisService.ts:21-34](../../frontend/src/services/aiStockAnalysisService.ts)。

### 3.3 其它依赖 TradingAgents 的 service（拢共 7 处）

| Service | URL 常量行 | 超时 | 降级 |
|---|---|---|---|
| AIAdvisorService | [AIAdvisorService.ts:9](../../backend/src/services/AIAdvisorService.ts) | 60s / 20min(SSE) | catch→FAILED |
| TechnicalAnalysisService | [TechnicalAnalysisService.ts:9](../../backend/src/services/TechnicalAnalysisService.ts) | 30s | heuristic_fallback |
| MarketBriefService | [MarketBriefService.ts:65](../../backend/src/services/MarketBriefService.ts) | 30s | heuristic_fallback |
| StrategyCopilotService | [StrategyCopilotService.ts:60](../../backend/src/services/StrategyCopilotService.ts) | 60s / 600s SSE | heuristic_fallback |
| AnnouncementNLPService | [AnnouncementNLPService.ts:12](../../backend/src/services/AnnouncementNLPService.ts) | — | 启发式 |
| EastMoneyQATopicService | [EastMoneyQATopicService.ts:64](../../backend/src/services/EastMoneyQATopicService.ts) | — | 启发式 |
| (sync scripts) | [scripts/sync-qa-topics.ts:32](../../backend/src/scripts/sync-qa-topics.ts)、[scripts/sync-announcements.ts:28](../../backend/src/scripts/sync-announcements.ts) | — | — |

---

## 4. 回测引擎与策略实现度（一句话总览）

- 策略目录共 27 个文件，**两种形态**：
  - **per-stock `evaluate()` 形态**（17 个，旧式）：被回测引擎在 [QuantBacktestEngine.ts:191](../../backend/src/quant/backtest/internal/QuantBacktestEngine.ts) 实际执行。
  - **组合级 `generateSignals(date)` 形态**（10+ 个，新式：MFA / DragonHead / Breakout / LeftSideReversal / Ensemble / GameTraderRelay / Linkage / HighDividendValue / EarningsSurprise / NorthboundFollow / CTA100Momentum / SectorRotationLeader / GARP）：被实盘 [QuantSignalService.runCompositeStrategies](../../backend/src/quant/engine/internal/QuantSignalService.ts) 执行；回测引擎只调它们的 `evaluate()` → 永远 `'hold'`。
- **A 股约束实现**全部集中在 [AShareConstraintEngine.ts](../../backend/src/quant/backtest/AShareConstraintEngine.ts)，覆盖 T+1、印花税、过户费、最低佣金、最小手；**未覆盖**：涨跌停按市场段区分（创业板/科创板 20% / 北交所 30% / ST 5%）、最小价位 0.01 round、集合竞价模型、生存者偏差过滤。
- **实盘 `PaperTradingFacade.placeOrder` 完全不查涨跌停**（[PaperTradingFacade.ts:524-702](../../backend/src/portfolio/PaperTradingFacade.ts) 搜不到 `limit_up` 拦截）；ST 过滤、涨跌停判定在三处独立实现，逻辑不复用。

---

## 5. 风控与对账：实际生效路径

### 5.1 pre-trade（下单前）
- **模拟盘**：`PaperTradingFacade.placeOrder` → 交易时段 + 行情陈旧度(3 天，应该是 30min) + `DrawdownCircuitBreaker`(fail-open) + `PositionLimitGuard` + `T+1`；自动跟单走 `PaperTradingAutomationService.createBuyTrade` → `preTradeGuards.checkPreBuyGuards`（含 PositionLimit + DrawdownCircuitBreaker，**Batch I (2026-06-17) 才补齐**）。
- **实盘**：`LiveRiskGuardService` 8 项 + `LiveTradingSafetyService` 7 项闸门 + `KillSwitchService` 自动扫描（60s 一次，[backend/src/index.ts:973-986](../../backend/src/index.ts)）。

### 5.2 post-trade（事后）
- `TradeComplianceChecker.checkTradeCompliance`（[TradeComplianceChecker.ts:61](../../backend/src/services/TradeComplianceChecker.ts)）**只在** `RecommendationTradeOutcome` afterUpdate hook 跑（[models/RecommendationTradeOutcome.ts:278](../../backend/src/models/RecommendationTradeOutcome.ts)），即**违反 5 wizard 规则的下单会照样执行，只是事后写 `RiskAlert MEDIUM`**。

### 5.3 对账
- 实时对账：`LiveTradingService.getReconciliation`（[live-trading/services/LiveTradingService.ts:361-565](../../backend/src/live-trading/services/LiveTradingService.ts)），**只在用户 GET 页面时计算**。
- EOD：`scripts/ops/end_of_day_reconciliation.js`，**人工触发**，**不在 cron 注册**。
- **结果：没有任何 cron 任务周期性比对 alignment_score 并写 `RiskAlert HIGH`。** 漂移完全依赖运维值班发现。

### 5.4 时效告警 + boot catch-up（git log `5e96ede`）
- "时效告警"实际是**因子/行业面板的数据陈旧度告警**，落在 [FactorController.ts:808-810/1127-1129](../../backend/src/api/controllers/FactorController.ts)。**不是**对账时效告警。
- "boot catch-up" 是 `SchedulerService.catchUpMissedTasks` 在 `initialize` 末尾异步触发的 8 个 sync 任务白名单 + `FACTOR_SCORE_COMPUTE`，**真生效**。

---

## 6. 北交所避开（git log `f30e885`）的真实覆盖范围

仓里唯一的"避开 920/430"过滤在 [backend/src/data/services/SocialSentimentSyncService.ts:240-263](../../backend/src/data/services/SocialSentimentSyncService.ts)，**只用于社交舆情同步的退化路径**。

`QuantRecommendationService.getCandidateStocks` 与所有组合级策略选股逻辑**都没有同款过滤**。换言之：当前**"避开北交所"实际只在舆情数据流生效，不在交易决策流**。

---

## 7. 已有审计资产（不要重复挖的点）

下列文档已经覆盖过这些主题，本次审计只在其结论之上加增量证据：

| 主题 | 已有结论位置 |
|---|---|
| 链路状态机 + audit event 命名 | [docs/live_trading_state_machine.md](../live_trading_state_machine.md) |
| bridge HMAC/nonce + Windows 部署 | [docs/QMT_PTRADE_LIVE_TRADING_ROADMAP.md](../QMT_PTRADE_LIVE_TRADING_ROADMAP.md) §6.1 §7.4 |
| killswitch 5 触发条件 + freeze_new_only | 同上 §7.3 |
| nginx/Express timeout 联动 | [docs/live_trading_launch_checklist.md](../live_trading_launch_checklist.md) §69-75 |
| 凭证轮换周期 | [SECURITY.md](../../SECURITY.md) §42-46 |
| Sprint 27/28/29 短板修复教训 | memory `sprint-27-28-29-l8-activation-results` |
| Sprint 34 ATR/feasibility/bid-ask/PC shadow | memory `sprint-34-all-shortfalls-effective` |
| 部署主干 4 坑 + ops 三账号 | memory `deploy-remote-build-pitfalls` |

---

## 8. 待我确认的疑问点（影响后续审计方向）

请确认或纠正：

1. **`evaluate()` 退化 → 回测虚空**：MFA / DragonHead / Breakout 等核心策略的 `evaluate()` 永远 hold，回测引擎对它们 trade_count=0；这是已知未修，还是被误以为"已回测过"？阶段一是否要**优先**把回测引擎升级到能跑 `generateSignals` 形态？
2. **对账无主动 cron 告警**：是产品意图（运维值班看 GET 页面）还是漏配？是否需要补 cron + 飞书告警？
3. **`TradeComplianceChecker` 是否本意做 pre-trade gate**？当前是事后；若本意 pre-trade，要把它挂到 `createDraft / autoBuyFromSignals` 路径上。
4. **"避开北交所"**：到底是只在舆情流避，还是整套交易决策流都要避？阶段一可以一并补齐。
5. **AI 个股分析"5 维度"的替换策略**：
   - 立即把 `analyzeSingleStock` 改成 per-dimension analyzer fan-out + 本地 fan-in（shadow mode 双跑对比 prod）？
   - 还是先保留 5 维度对外契约（前端不动），后端先实现 analyzer 框架 + shadow，再灰度切？（**推荐后者**，下游 4 个 Workspace 都嵌 `AIStockAnalysisModal`）
6. **shadow mode 模板**：是否同意复用 `PortfolioConstructionAdapter` 的 off/shadow/hard 三态 + `User.risk_config.<namespace>` 范式？
7. **下单网关确认**：当前 production 是否真的是 `LIVE_BROKER_GATEWAY=mock`（或未设）+ paper trading 全闭环？还是已有真实账户在 bridge 跑？这直接决定阶段一哪些改动是高风险。
8. **回测 `execution_timing` 默认值**：是否同意把 `same_close` 标记为"不推荐 / 仅用于研究"，生产路径强制 `next_open` + 排除 T 日 bar？

请逐条 yes/no/补充意图。我会按你的答案锁定阶段一/阶段二的范围与红线后再动笔。

---

## 9. 关键文件清单（速查）

### 闭环
- [backend/src/services/SchedulerService.ts](../../backend/src/services/SchedulerService.ts)
- [backend/src/services/AutomatedRecommendationLoopService.ts](../../backend/src/services/AutomatedRecommendationLoopService.ts)
- [backend/src/services/QuantRecommendationService.ts](../../backend/src/services/QuantRecommendationService.ts)
- [backend/src/services/TradeComplianceChecker.ts](../../backend/src/services/TradeComplianceChecker.ts)
- [backend/src/services/StrategyKillSwitchMonitor.ts](../../backend/src/services/StrategyKillSwitchMonitor.ts)
- [backend/src/services/RealtimeAlertDispatcher.ts](../../backend/src/services/RealtimeAlertDispatcher.ts)
- [backend/src/quant/engine/StrategyRegistry.ts](../../backend/src/quant/engine/StrategyRegistry.ts)
- [backend/src/quant/engine/internal/QuantSignalService.ts](../../backend/src/quant/engine/internal/QuantSignalService.ts)
- [backend/src/quant/backtest/internal/QuantBacktestEngine.ts](../../backend/src/quant/backtest/internal/QuantBacktestEngine.ts)
- [backend/src/quant/backtest/AShareConstraintEngine.ts](../../backend/src/quant/backtest/AShareConstraintEngine.ts)
- [backend/src/portfolio/PaperTradingFacade.ts](../../backend/src/portfolio/PaperTradingFacade.ts)
- [backend/src/portfolio/PositionSizingPolicy.ts](../../backend/src/portfolio/PositionSizingPolicy.ts)
- [backend/src/portfolio/internal/PaperTradingAutomationService.ts](../../backend/src/portfolio/internal/PaperTradingAutomationService.ts)
- [backend/src/portfolio/internal/preTradeGuards.ts](../../backend/src/portfolio/internal/preTradeGuards.ts)
- [backend/src/portfolio/internal/PortfolioConstructionAdapter.ts](../../backend/src/portfolio/internal/PortfolioConstructionAdapter.ts) — **shadow 模板**
- [backend/src/portfolio/risk/](../../backend/src/portfolio/risk/) — 9 个 guard
- [backend/src/live-trading/services/LiveTradingService.ts](../../backend/src/live-trading/services/LiveTradingService.ts)
- [backend/src/live-trading/services/BridgeService.ts](../../backend/src/live-trading/services/BridgeService.ts)
- [backend/src/live-trading/services/LiveRiskGuardService.ts](../../backend/src/live-trading/services/LiveRiskGuardService.ts)
- [backend/src/live-trading/services/LiveTradingSafetyService.ts](../../backend/src/live-trading/services/LiveTradingSafetyService.ts)
- [backend/src/live-trading/services/KillSwitchService.ts](../../backend/src/live-trading/services/KillSwitchService.ts)
- [backend/src/live-trading/brokers/MockBrokerGateway.ts](../../backend/src/live-trading/brokers/MockBrokerGateway.ts)
- [backend/src/services/execution/ExecutionFeasibilityService.ts](../../backend/src/services/execution/ExecutionFeasibilityService.ts)
- [scripts/ops/end_of_day_reconciliation.js](../../scripts/ops/end_of_day_reconciliation.js)
- [integrations/broker-bridge/qmt_bridge/main.py](../../integrations/broker-bridge/qmt_bridge/main.py)

### AI 分析层
- [backend/src/services/AIAdvisorService.ts](../../backend/src/services/AIAdvisorService.ts)
- [backend/src/services/AIInvestmentSignalService.ts](../../backend/src/services/AIInvestmentSignalService.ts)
- [backend/src/services/TechnicalAnalysisService.ts](../../backend/src/services/TechnicalAnalysisService.ts)
- [backend/src/services/MarketEnvironmentService.ts](../../backend/src/services/MarketEnvironmentService.ts)
- [backend/src/services/MarketBreadthService.ts](../../backend/src/services/MarketBreadthService.ts)
- [backend/src/services/MarketSentimentIndexService.ts](../../backend/src/services/MarketSentimentIndexService.ts)
- [backend/src/services/MarketBriefService.ts](../../backend/src/services/MarketBriefService.ts)
- [backend/src/services/event-intelligence/EventIntelligenceLayer.ts](../../backend/src/services/event-intelligence/EventIntelligenceLayer.ts)
- [backend/src/services/AnnouncementNLPService.ts](../../backend/src/services/AnnouncementNLPService.ts)
- [backend/src/services/KOLAggregatorService.ts](../../backend/src/services/KOLAggregatorService.ts)
- [backend/src/services/EastMoneyQATopicService.ts](../../backend/src/services/EastMoneyQATopicService.ts)
- [backend/src/services/EarningsForecastWatcher.ts](../../backend/src/services/EarningsForecastWatcher.ts)
- [backend/src/services/StrategyCopilotService.ts](../../backend/src/services/StrategyCopilotService.ts)
- [backend/src/services/regime/RegimeProbabilityService.ts](../../backend/src/services/regime/RegimeProbabilityService.ts)
- [backend/src/services/research/](../../backend/src/services/research/)
- [backend/src/services/factor/](../../backend/src/services/factor/)
- [backend/src/quant/factors/library/](../../backend/src/quant/factors/library/) — 18 个 factor
- [backend/src/models/AIStockAnalysisReport.ts](../../backend/src/models/AIStockAnalysisReport.ts)
- [backend/src/models/AIInvestmentSignal.ts](../../backend/src/models/AIInvestmentSignal.ts)
- [backend/src/models/TechnicalAnalysisReport.ts](../../backend/src/models/TechnicalAnalysisReport.ts)
- [frontend/src/components/trading/AIStockAnalysisModal.tsx](../../frontend/src/components/trading/AIStockAnalysisModal.tsx) — 4 个 Workspace 都嵌它
- [frontend/src/services/aiStockAnalysisService.ts](../../frontend/src/services/aiStockAnalysisService.ts)

---

**下一步**：等你回答 §8 的 8 个问题。在你确认前我不会改任何代码。如果你直接说"按你的最优解先全部出方案"，我会按推荐方案继续写 [closed_loop_audit_2026_06_18.md](closed_loop_audit_2026_06_18.md) 和 [analysis_engine_design_2026_06_18.md](analysis_engine_design_2026_06_18.md)，所有"高风险改动"会在文档里显式标注 ⚠️ 等待你逐项确认才执行。
