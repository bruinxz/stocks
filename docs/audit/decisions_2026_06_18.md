# 决策与实施记录（全权决策模式）

**日期**：2026-06-18
**授权**：用户授权"全部自己决策，以合理、正确、长期价值更高、更可扩展、更有利于赚钱的角度判断"
**实施 agent**：ALPHA / BETA / GAMMA / DELTA 并行 + 后续整合
**前置文档**：[closed_loop_architecture_2026_06_18.md](closed_loop_architecture_2026_06_18.md)、[closed_loop_audit_2026_06_18.md](closed_loop_audit_2026_06_18.md)、[analysis_engine_design_2026_06_18.md](analysis_engine_design_2026_06_18.md)

---

## A. 18 个决策的统一回答

### 来自 closed_loop_architecture §8

1. **回测引擎升级支持 `generateSignals`**：✅ 做。组合级策略没有诚实回测 = 无法判断盈利能力，这是最根本的问题。
2. **对账 cron + RiskAlert HIGH**：✅ 做。漂移无人发现是高风险。
3. **TradeComplianceChecker 提升为 pre-trade gate**：✅ 做。事后告警只能用于复盘，不能保护资金。同时保留事后审计写 `RiskAlert MEDIUM`，两套并存。
4. **北交所避开扩到决策流**：✅ 做。默认在 `getCandidateStocks` 过滤 920/430，**但加 strategy override** 让明确想做 BJ 的策略可以打开。
5. **AI 替换策略**：✅ 走"per-dimension analyzer 框架 + shadow mode 双跑 + 前端契约不破"路径。
6. **shadow 复用 `PortfolioConstructionAdapter` 三态模式**：✅。
7. **当前实盘账户状态**：不假设，**所有 live-trading 路径的改动只动逻辑不动配置**，bridge secrets / .env 完全不碰。
8. **回测 `same_close` 默认值**：✅ 标 `@deprecated` + warn log，生产路径强制 `next_open` + `evaluate()` 时把 T 日 bar 从 `barsUntilDate` 排除。

### 来自 analysis_engine_design §8

9. **AI 引擎作为个股层二次确认/解释，不替代组合级策略**：✅。
10. **复用三态模式**：✅。
11. **schema migration 加 `engine_variant` + `shadow_of_report_id`**：✅，提供 Sequelize migration + 回滚 SQL。
12. **v1 不破坏前端契约**：✅。前端零改动；新字段全在 `metadata`。
13. **缺数据显式 `data_missing` + 下调 confidence**：✅，**禁止任何"中性 50 分"兜底**。
14. **TradingAgents 在 v2 降级为可选 NLP 子组件**：✅（v1 不动 AIAdvisorService）。
15. **RiskAnalyzer / EventAnalyzer 的 veto 是硬否决**：✅，aggregator 看到 veto 直接 `action='hold'` 或 `'sell'`（有持仓则建议止盈/止损）。
16. **新引擎落 `backend/src/services/analysis-engine/`**：✅。
17. **灰度切量节奏**：W0→W7 ≈ 7 周写入 runbook；**本次实施只到 W0**（代码就绪 + mode=off 默认），后续灰度由你按节奏推进。
18. **样本股**：[600519.SH](https://) 贵州茅台（沪主板，深度价值）、[000858.SZ](https://) 五粮液（深主板）、[300750.SZ](https://) 宁德时代（创业板，验证 20% 涨停），避开北交所。

---

## B. 实施切片与并行编排

### 文件级冲突表（确保并行无冲突）

| 切片 | 主要修改 | 主要新增 |
|---|---|---|
| **ALPHA — 量化核心硬化** | `quant/backtest/AShareConstraintEngine.ts`、`quant/backtest/internal/QuantBacktestEngine.ts`、`portfolio/PaperTradingFacade.ts`、`services/execution/ExecutionFeasibilityService.ts`、`live-trading/services/LiveRiskGuardService.ts`、`services/QuantRecommendationService.ts`、`services/QuantDataService.ts`、`quant/_helpers.ts`、`models/Stock.ts`（可能） | `quant/marketLimits.ts`、`quant/backtest/composite/CompositeBacktestEngine.ts`、migration（如需 delisting_date） |
| **BETA — 运营安全** | `services/SchedulerService.ts`、`portfolio/internal/PaperTradingAutomationService.ts`（pre-trade compliance）、`live-trading/services/LiveTradingService.ts`（pre-trade compliance）、`services/AutomatedRecommendationLoopService.ts`（jobId 去重） | `live-trading/services/ReconciliationAlertService.ts` |
| **GAMMA — AI 分析引擎 v1** | `models/AIStockAnalysisReport.ts`、`models/AIInvestmentSignal.ts` | `services/analysis-engine/*`（8 analyzer + aggregator + shadow service + types + tests + CLAUDE.md）、migration |
| **DELTA — 配置整治 + 因子时序** | 10 处 `TRADING_AGENTS_URL` 引用、若干 factor 文件（`MoneyFlowFactor.ts` / `IndustryMomentumFactor.ts` / `NorthboundFactor.ts`）、`docs/live_trading_state_machine.md`（aborted）、`backend/src/quant/backtest/internal/QuantBacktestEngine.ts` 252 sharpe 与 `executePendingOrders` 的次日涨停判定改用 `(bar.open - prev_close)/prev_close` | `config/externalServices.ts`、`backend/src/services/TradingCalendarService.ts`（若不存在） |

**冲突已规避**：
- ALPHA / DELTA 均会改 `QuantBacktestEngine.ts` —— 改动点分开（ALPHA 改撮合与策略路径，DELTA 改指标计算与涨停判定），但同一文件有竞态风险。**协调方案**：ALPHA 先完成对该文件的修改，DELTA 在 ALPHA 完成后再改它（或全部归 ALPHA 完成，DELTA 不动该文件）。**实施时归 ALPHA 全权**，DELTA 不动 QuantBacktestEngine。
- ALPHA / BETA 都不动 LiveTradingService / PaperTradingAutomationService 的相同方法。

---

## C. 不做 / 暂缓的事项

| 项 | 原因 |
|---|---|
| L-19 全仓 git filter-repo 抹除 `47.93.224.109` 历史 | git 历史改写是仓库级影响，等你确认 |
| 触碰 `LIVE_BRIDGE_SECRETS` / `.env` / bridge 端 secret | 红线，永远等你确认 |
| 切换 `LIVE_BROKER_GATEWAY` 到 qmt_bridge / ptrade_bridge | 红线 |
| 修改 `docker-compose.yml` / 部署脚本 | 不属于本轮 audit 范围 |
| 推送到 main / 创 PR | 等你 review 后再推 |
| 灰度切量到 mode=hard | 代码就绪即可，灰度由你按 runbook 推进 |

---

## D. 验收口径

每个 agent 在自己范围内必须：
1. 跑 `cd backend && npm run lint` 通过
2. 跑 `cd backend && npm test -- <相关文件>` 通过
3. 新增 / 修改的功能必须配套 Jest 单测
4. 不破坏现有测试（若 break，必须修，不能 skip）
5. 任何 schema 改动写双向 migration（up + down）
6. 新建目录必须配 `CLAUDE.md`（≤ 200 行，参考 [backend/src/services/CLAUDE.md](../../backend/src/services/CLAUDE.md) 风格）

最后整合阶段我会：
- 整体 `npm run lint` + `npm test` 全跑一遍
- 若有冲突或破损，逐项修复
- 写 `docs/audit/implementation_summary_2026_06_18.md` 汇总变更清单
- 列出"待你决定推进的灰度步骤"

---

## E. 重要约束（agent 必须遵守）

- TypeScript strict，无 `any`（除非有 `// eslint-disable` 注释说明）
- 不引入新的 npm 依赖（特别是不引入新的 NLP / 数据源 / runtime）
- 不修改 `.env*`、`docker-compose.yml`、`integrations/broker-bridge/`、`scripts/deployment/`
- 不触发任何真实下单 / 真实账户 API 调用
- 错误处理使用 `backend/src/utils/errors.ts` 体系
- 日志使用 `backend/src/utils/logger.ts` winston child logger
- 指标注册到 `backend/src/metrics/PrometheusRegistry.ts`

---

后续执行进度会更新到 [implementation_summary_2026_06_18.md](implementation_summary_2026_06_18.md)（执行完后生成）。
