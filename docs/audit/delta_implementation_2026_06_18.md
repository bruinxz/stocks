# DELTA implementation report — 2026-06-18

**Scope**：配置整治 + 因子时序修复 + 状态机文档同步 + 回测指标补全（audit L-19 / L-20 / M-6 / M-8 / M-9）

**Status**：✅ 完成。原 agent 进程在写报告时 EOF 中断，但所有 source 改动 + migration + tests 都成功落地；本文档由 orchestrator 收尾整理。

---

## 改动清单

### 1. TRADING_AGENTS_URL 集中常量（audit L-19）

**新建**：[backend/src/config/externalServices.ts](backend/src/config/externalServices.ts)
- export `TRADING_AGENTS_BASE_URL`
- 默认 `http://127.0.0.1:8000`（loopback，不暴露内网 IP）
- 顶部 jsdoc 写清升级路径 + CI lint 兜底 grep 命令

**修改 11 处引用全部 import 这个常量**（grep `from.*config/externalServices` 命中清单）：
- [backend/src/index.ts](backend/src/index.ts)
- [backend/src/api/controllers/AIAdvisorController.ts](backend/src/api/controllers/AIAdvisorController.ts)
- [backend/src/data/services/DataSourceHealthService.ts](backend/src/data/services/DataSourceHealthService.ts)
- [backend/src/services/EnhancedTradingJournalService.ts](backend/src/services/EnhancedTradingJournalService.ts)
- [backend/src/services/AIAdvisorService.ts](backend/src/services/AIAdvisorService.ts)
- [backend/src/services/MarketBriefService.ts](backend/src/services/MarketBriefService.ts)
- [backend/src/services/TechnicalAnalysisService.ts](backend/src/services/TechnicalAnalysisService.ts)
- [backend/src/services/StrategyCopilotService.ts](backend/src/services/StrategyCopilotService.ts)
- [backend/src/services/AnnouncementNLPService.ts](backend/src/services/AnnouncementNLPService.ts)
- [backend/src/services/EastMoneyQATopicService.ts](backend/src/services/EastMoneyQATopicService.ts)
- [backend/src/scripts/sync-qa-topics.ts](backend/src/scripts/sync-qa-topics.ts)
- [backend/src/scripts/sync-announcements.ts](backend/src/scripts/sync-announcements.ts)

**`.env.example` 整治**：[backend/.env.example:33-35](backend/.env.example) 把硬编码 `http://47.93.224.109:8000` 改成 `http://127.0.0.1:8000` 默认，注释提示"prod 走团队私聊给的真实地址"。

**验证**：`grep -rn "47\.93\.224\.109" backend/src/ | grep -v externalServices.ts` 零命中。
（`externalServices.ts` 顶部 jsdoc 自己描述"修复前曾硬编码 47.93..."属正常历史说明。）

### 2. 因子用交易日窗口（audit M-9）

**新建**：[backend/src/quant/factors/library/_tradingDayWindow.ts](backend/src/quant/factors/library/_tradingDayWindow.ts) — 复用 `DataService.getTradingDays`，导出 `tradingDayLookbackStartDate(asOf, n)` 返回精确 n 个交易日前的日期。

**修改 3 个 factor 用真实交易日窗口**：
- [MoneyFlowFactor.ts](backend/src/quant/factors/library/MoneyFlowFactor.ts) `WINDOW_TRADING_DAYS=10`（之前 WINDOW_DAYS=14 自然日近似）
- [IndustryMomentumFactor.ts](backend/src/quant/factors/library/IndustryMomentumFactor.ts) `5 trading days`（之前 7 自然日）
- [NorthboundFactor.ts](backend/src/quant/factors/library/NorthboundFactor.ts) `20 trading days`（之前 +10 自然日兜底节假日）

收益：春节/十一节假日窗口不再少计 5-7 交易日，因子值时序正确。

### 3. 因子分母用历史市值（audit M-8）

**新建**：[backend/src/quant/factors/library/_historicalMarketCap.ts](backend/src/quant/factors/library/_historicalMarketCap.ts) — 抽出 `loadHistoricalCirculatingMarketCap(universe, asOfDate)`：
- 优先 `StockValuationFactor.factor_date ≤ as_of_date` 最新一条（30 自然日 lookback 兜底次新股）
- 兜底 `Stock.circulating_market_cap`（旧 snapshot 行为，向后兼容）
- 双兜底都缺 → 不入 Map（让 Pipeline 中性补全）

**修改 2 个 factor 用 historical mcap helper**：
- [MoneyFlowFactor.ts](backend/src/quant/factors/library/MoneyFlowFactor.ts) 改用 `loadHistoricalCirculatingMarketCap(universe, ctx.as_of_date)`
- [InsiderTradeFactor.ts](backend/src/quant/factors/library/InsiderTradeFactor.ts) 同款；jsdoc 顶部同步（说明走 historical 而非 snapshot）

**`MarginFlowFactor.ts` 不需要改**：它的分母是 `fin_balance`（融资余额）自身，本就是 per-trade-day，不是市值。审计原列入清单是误判，实际不涉及。

收益：2020 年回测时分母不再用"今天的市值"除"当时的资金流"，因子值无系统性偏差。

### 4. State machine 文档同步 aborted（audit M-6）

修改 [docs/live_trading_state_machine.md](docs/live_trading_state_machine.md)：
- §41 终态枚举加 `aborted`
- mermaid 图 §51 新增 `pending --> aborted: KillSwitch 激活`
- §66 `aborted --> [*]`（终态）
- §76 转移规则表新增一行
- §82-88 加 "**`aborted` 终态特别说明**" 段落，写清触发源 / 终态语义 / 不会回到 active

修改 [backend/src/models/LiveBrokerCommand.ts](backend/src/models/LiveBrokerCommand.ts:67) 注释加 `aborted` 字面量 + audit M-6 引用。

### 5. 回测指标补全（audit L-20 + 量化决策）

修改 [backend/src/quant/backtest/internal/QuantBacktestEngine.ts](backend/src/quant/backtest/internal/QuantBacktestEngine.ts):
- 年化口径统一交易日 252（之前 annual 用 365 / sharpe 用 252 口径不一致）
- 新增 4 个指标到 `diagnostics`：
  - `calmar_ratio = annualReturn / abs(maxDrawdown)`
  - `sortino_ratio`（downside deviation 分母）
  - `turnover_ratio = Σ(trade_amount) / mean(equity)`
  - `cost_ratio = (commission + stamp_tax + transfer_fee + slippage_cost) / max(total_pnl, 1)`

收益：客观评估"是否赚钱"的指标完整化；annual 与 sharpe 在同一年化口径。

---

## 测试

新增（DELTA 范围）：
- [backend/tests/config/externalServices.test.ts](backend/tests/config/externalServices.test.ts) — env 覆盖 / 默认值
- [backend/tests/quant/factors/tradingDayWindow.test.ts](backend/tests/quant/factors/tradingDayWindow.test.ts) — 跨春节窗口
- [backend/tests/quant/factors/moneyFlowFactor.historicalMcap.test.ts](backend/tests/quant/factors/moneyFlowFactor.historicalMcap.test.ts) — historical mcap 验证
- [backend/tests/quant/backtest/metrics.calmar_sortino.test.ts](backend/tests/quant/backtest/metrics.calmar_sortino.test.ts) — 4 个新指标公式

全测全跑：`cd backend && npm test` → **140 files, 140 passed, 0 failed**（EPSILON 收尾后）。

---

## 验证 grep 清单

| 主题 | 命令 | 期望 |
|---|---|---|
| 内部 IP 残留 | `grep -rn "47\.93\.224\.109" backend/src/` | 仅 `externalServices.ts` 的历史说明 jsdoc |
| 旧 env 直接读 | `grep -rn "process\.env\.TRADING_AGENTS_URL" backend/src/` | 仅 `config/externalServices.ts:32` |
| 因子交易日窗口 | `grep -rn "tradingDayLookbackStartDate" backend/src/quant/factors/library/` | 3 个 factor 命中 |
| 因子历史市值 | `grep -rn "loadHistoricalCirculatingMarketCap" backend/src/` | 2 个 factor 命中 |
| state machine aborted | `grep -in "aborted" docs/live_trading_state_machine.md` | 6+ 行命中 |
| 模型注释 aborted | `grep -in "aborted" backend/src/models/LiveBrokerCommand.ts` | 4 行命中 |
| 回测新指标 | `grep -n "calmar\|sortino\|turnover_ratio\|cost_ratio" backend/src/quant/backtest/internal/QuantBacktestEngine.ts` | 8+ 命中 |

---

## 未做 / 推迟

- **git filter-repo 抹掉历史 IP**：仓库级影响，跳过（仅清理当前 source + .env.example）
- **更多 factor 改 historical mcap**：当前仅 MoneyFlow / InsiderTrade（MarginFlow 分母非市值）；其它如 `BlockTradeSignalFactor`、`FundConsensusFactor` 是否需同款改造由后续 sprint 评估

---

## 不触碰清单

- `.env*`（仅改 .env.example，未触 .env / .env.production）
- `docker-compose.yml`
- `integrations/broker-bridge/`
- live-trading 的下单 / bridge / kill switch 逻辑
- git commit / PR
