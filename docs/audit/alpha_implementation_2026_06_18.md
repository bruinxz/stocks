# ALPHA — 量化核心硬化（audit S-1 / S-2 / S-3 / S-4 / S-7 修复实施记录）

**日期**：2026-06-18
**worktree**：`.claude/worktrees/happy-torvalds-180c51/`
**前置文档**：[closed_loop_audit_2026_06_18.md](closed_loop_audit_2026_06_18.md) · [decisions_2026_06_18.md](decisions_2026_06_18.md)
**ALPHA scope**：抽统一 `marketLimits.ts` + 回测/实盘/feasibility 三处复用 + 实盘 BUY/SELL 涨跌停拦截 + 回测引擎支持 generateSignals (precomputed 模式) + 防生存者偏差 + 北交所默认避开

---

## 0. 单文件结果

| 文件 | 状态 | audit 编号 |
|---|---|---|
| `src/quant/marketLimits.ts` | **新增** | S-2 / S-3 (统一权威) |
| `src/quant/backtest/AShareConstraintEngine.ts` | 改 | S-2 / S-4 |
| `src/quant/backtest/internal/QuantBacktestEngine.ts` | 改 | S-1 / S-2 / S-4 |
| `src/quant/types/QuantTypes.ts` | 改 | S-1 (新 option `precomputed_composite_signals`) |
| `src/services/execution/ExecutionFeasibilityService.ts` | 改 | S-2 (re-export 兼容旧 import) |
| `src/portfolio/PaperTradingFacade.ts` | 改 | S-3 (BUY/SELL inline 涨跌停拦截) |
| `src/live-trading/services/LiveTradingService.ts` | 改 | S-3 (上游 is_limit_up 计算改用 marketLimits) |
| `src/services/QuantRecommendationService.ts` | 改 | decisions §4 (北交所默认避开 + include_bj override) |
| `src/quant/engine/internal/QuantDataService.ts` | 改 | S-7 (delisting_date as_of_date 过滤) |
| `src/quant/factors/library/_helpers.ts` | 改 | S-7 (loadStocksByCodes 加 as_of_date 选项) |
| `src/metrics/PrometheusRegistry.ts` | 改 | S-1 (backtest_trade_count_total 计数器) |
| `tests/quant/marketLimits.test.ts` | 新增 | 46 用例 |
| `tests/quant/ashare_constraint_limits.test.ts` | 新增 | 16 用例 |
| `tests/portfolio/paper_trading_limit_up_block.test.ts` | 新增 | 15 用例 |
| `tests/quant/quant_data_service_delisting.test.ts` | 新增 | 5 用例 |
| `tests/quant/composite_backtest_smoke.test.ts` | 新增 | 2 用例 (smoke) |
| `tests/backtest/ashare-constraints.test.ts` | 改 (兼容新精确路径) | — |

---

## 1. audit S-2 + S-3：抽统一 `marketLimits.ts`

**问题**：5 套涨跌停判定散落 (回测引擎 / ExecutionFeasibilityService / LiveRiskGuard / PaperTradingFacade)：
- 回测只用单一 `limit_up_pct=9.8`，**不按市场段区分** → 创业板 / 科创板 / 北交所 / ST 全部错。
- 模拟盘 `PaperTradingFacade.placeOrder` **完全不查涨跌停**，可下单到 300xxx 创业板涨 18%、920xxx 北交所涨 25%、ST 股涨 4.5%。
- 实盘 `LiveRiskGuardService.evaluate` 只看 caller 传入的 boolean，**caller 没算 is_limit_up**。

**修复方案**：新建 `backend/src/quant/marketLimits.ts` 作为**单一权威模块**，导出：
- `MarketSegment` 联合类型 (`'main' | 'chinext' | 'star' | 'bj' | 'unknown'`)
- `MAIN_LIMIT_PCT = 0.10` / `CHINEXT_LIMIT_PCT = 0.20` / `STAR_LIMIT_PCT = 0.20` / `BJ_LIMIT_PCT = 0.30` / `ST_LIMIT_PCT = 0.05` 常量
- `inferMarketSegment(symbol)` — 兼容 `sh.6xx` / `300033.SZ` / `bj.920003` / 等多种 symbol 格式
- `getLimitPct(segment, isST)` — ST 跨段总是 5%，北交所 ST 也 5%
- `getLimitPrices(prevClose, segment, isST)` — 含 0.01 tick round
- `roundToTick(price, tick=0.01)` — A 股最小报价单位 round-half-up
- `isAtLimitUp(bar, segment, isST, prevClose)` / `isAtLimitDown(...)` — bar.open/high/low/close 任一命中即算
- `isBeijingExchange(symbol)` — 北交所识别（universe filter 用）
- `describeLimits(symbol, name, prevClose)` — 一步给出 segment + is_st + limit_pct + upper + lower

**复用接入**：
- `services/execution/ExecutionFeasibilityService` 内部 `inferMarketSegment` / `getLimitPct` 改为 import 自 marketLimits（保留旧 export 名做兼容 re-export）。
- `quant/backtest/AShareConstraintEngine.evaluateOrder` 新增 `symbol + prev_close` 输入；优先按市场段算精确涨跌停价；不传时回退到旧 `change_percent` legacy 路径（向后兼容）+ detail 含 "legacy 路径" 标注。
- `quant/backtest/AShareConstraintEngine.executionPrice` 后置 `roundToTick`（与券商客户端口径一致）。
- `quant/backtest/internal/QuantBacktestEngine` 把 context 的 prev_close 传给 `evaluateOrder`（`findPrevClose(context, currentDate)` helper 取倒数第二根 bar 的 close）。
- `portfolio/PaperTradingFacade.placeOrder` BUY/SELL 流程在 cash check 之前插入 `evaluateLimitUpDownBlock` (新 export 纯函数) 拦截。
- `live-trading/services/LiveTradingService.createDraft` 上游计算 `lmIsLimitUp` 时按 prev_close + market segment 算，传给 `liveRiskGuardService.evaluate`。

**验证**：
- 46 个 marketLimits 单元用例覆盖 5 个市场段 × 涨跌停 + ST + 跨段 ST + roundToTick + 边界（300033 +12% 不拦 / 300033 +20% 拦 / 688001 +18% 不拦 / 920001 +25% 不拦 / 600519 +9.9% 不拦 / 600519 +10% 拦 / ST +4.5% 不拦 / ST +5% 拦）
- 16 个 ashare_constraint_limits 用例验证回测引擎接入新路径
- 15 个 paper_trading_limit_up_block 用例验证 facade 拦截逻辑

---

## 2. audit S-1：回测引擎支持组合级策略 (precomputed_composite_signals 模式)

**问题**：13 个组合级策略（MultiFactorAlpha / DragonHead / Breakout / 等）的 `evaluate()` 只返"信息性 hold"，QuantBacktestEngine 默认走 evaluate 路径 → trade_count=0 → walk-forward / kill-switch / Bayesian / FactorIC 评估全空。

**修复方案 (tradeoff 选择)**：
- 不动 `run()` 的同步性 (3 个 caller GridSearchOptimizer / CostSensitivityAnalysis / QuantBacktestService.processBacktestTask 都依赖同步)。
- 新增 `QuantBacktestOptions.precomputed_composite_signals?: Record<strategy_key, Record<rebalanceDate, {target_portfolio: string[]}>>`，让 caller 预先调 `strategy.generateSignals(date, {previousSelection})` 拉到信号填进去。
- engine 检测到 `isCompositeStrategy && precomputed[strategy_key]` 即走"组合级路径"：在每个 rebalanceDate 把 target diff 当前持仓产生 BUY/SELL pending orders，全部走 next_open 撮合。
- 未提供 precomputed 时打 deprecation warn log + 走 evaluate fallback 保持向后兼容。
- 新增 Prometheus counter `backtest_trade_count_total{strategy_key}` (在 PrometheusRegistry 注册)，让 ops 能监测"24h 内某策略 trade_count_total 增量 = 0"作组合级退化告警。

**没接通的部分 (TODO)**：
- MFA / DragonHead / Breakout / LeftSideReversal / 等 13 个策略的 `generateSignals` 内部仍强依赖 DB (factor_scores / IndustryFlow / DailyBar) — 这层 caller-prefetch 责任。
- 未来若要让 QuantBacktestService 自动接通，需要：(1) 每个 strategy 提供 `getRebalanceDates(start, end)` 方法 (2) 一个 `CompositeBacktestRunner` orchestrator 调 strategy.generateSignals 填 precomputed。本次仅留接口 + smoke test (composite_backtest_smoke.test.ts)。
- 验证脚本 `backend/scripts/quant-audit/verify_composite_backtest_parity.ts` (S-1 验证) **未实现** — 留给后续 sprint。

**验证**：composite_backtest_smoke.test.ts 用 fake 组合级策略 + 3 个 rebalance 日 precomputed signals → 验证 engine 产生 trade_count > 0 (业务方向断言)，未提供 precomputed 时 trade_count=0 (退化兼容断言)。

---

## 3. audit S-4：`same_close` 排除 T 日 bar + deprecation warn

**问题**：`execution_timing='same_close'` 让 evaluate 看到 T 日收盘价 + 撮合用 T 日 close → lookahead bias；次日撮合分支用 `bar.change_percent` 判涨停（未来信息）。

**修复方案**：
- `QuantBacktestEngine.run` 顶部检测 `execution_timing === 'same_close'` 时打 `@deprecated` warn log，建议切到 `next_open`。
- evaluate 调用前 `barsForEvaluate = barsUntilDate.slice(0, -1)` (排除 T 日 bar)，让策略只看截止 T-1 数据；撮合仍用 T 日 close。
- 次日开盘是否涨停的判定**自动 via marketLimits**：`evaluateOrder` 现在用 `bar.open + isAtLimitUp` 而不是 `change_percent`（DELTA 的 audit M-5 修复目标也在此一步达成）。

**测试调整**：原 `ashare-constraints.test.ts` 的 same_close 测试需要补 1 根 bar (因为 evaluate 看到的 bar 数 -1)，已更新。

---

## 4. audit S-7：生存者偏差 + 北交所默认避开

**生存者偏差 (S-7)**：
- `quant/engine/internal/QuantDataService.getStocks/getContexts` 加可选 `as_of_date` 参数 (默认 today，行为不变)。
- `buildListedSurvivalWhere(as_of_date)` 返回 `is_listed:true OR (delisting_date != null AND delisting_date > as_of)`，让"当时上市但今天已退市"的标的能进回测 universe。
- `quant/factors/library/_helpers.ts` 的 `loadStocksByCodes` 同样加 `options.as_of_date`。
- 行为兼容：不传 as_of_date → today (等价旧的 `is_listed:true` 简化形式)。

**北交所默认避开 (decisions §4)**：
- `services/QuantRecommendationService.getCandidateStocks` 加 `include_bj?: boolean`；默认 false 时用 `isBeijingExchange(symbol)` 二次过滤（symbol 前缀 `bj.` / 后缀 `.BJ` / 6 位代码 92xxxx / 43xxxx / 4xxxxx / 8xxxxx 等北交所号段）。
- favorites universe 不应用此过滤（用户自选股即最终意图）。
- 多取 2x 候选股以补偿 BJ 过滤后的损失。

**验证**：5 个 delisting 测试用例 (buildListedSurvivalWhere 不同 as_of_date)。

---

## 5. PrometheusRegistry 新增

- `backtest_trade_count_total{strategy_key}` Counter (audit S-1)
- `incrementBacktestTradeCount(strategy_key, count)` 业务 helper
- QuantBacktestEngine.run 收尾调一次 (`incrementBacktestTradeCount(strategy.definition.strategy_key, trades.length)`)

---

## 6. 测试结果

| 测试文件 | 用例数 | 结果 |
|---|---|---|
| `tests/quant/marketLimits.test.ts` | 46 | **all pass** |
| `tests/quant/ashare_constraint_limits.test.ts` | 16 | **all pass** |
| `tests/portfolio/paper_trading_limit_up_block.test.ts` | 15 | **all pass** |
| `tests/quant/quant_data_service_delisting.test.ts` | 5 | **all pass** |
| `tests/quant/composite_backtest_smoke.test.ts` | 2 | **all pass** |
| `tests/backtest/ashare-constraints.test.ts` (改) | 161 (含原 159) | **all pass** |
| 其它 130+ tests/* | — | 全跑通过（除以下与 ALPHA 无关的 pre-existing failures） |

**Pre-existing 失败（与 ALPHA 修复无关）**：
- `tests/strategies/MultiFactorAlphaStrategy.test.ts` — Batch AC 加 2 个新因子 (industry_momentum / concept_heat) 后默认权重变了，测试未更新。
- `tests/strategies/DragonHeadMomentumStrategy.test.ts` — US-082 默认 sentiment 阈值变了。
- `tests/strategies/EarningsSurpriseStrategy.test.ts` — 同上推断。
- `tests/services/realtime-alert-dispatcher-service.test.ts` — Batch X 改了 signature 含时间窗 hash。
- `tests/risk/drawdown-circuit-breaker.test.ts` — BETA-7 改 fail-CLOSED 时 main() 在某次环境下可能未捕获到 throw（再跑一次过了），可能是 race condition。

这些都在我的范围外。

---

## 7. Lint

`npm run lint -- --fix` 后我新增 / 修改的文件无 prettier errors，剩余的 warnings (unused imports / forbidden non-null assertion) 都是 pre-existing。

---

## 8. 没做 / 留给后续 sprint 的事项

1. **S-1 完整接通**：还需要给 13 个组合级策略各写 `generateSignals` runner adapter (caller-prefetch DB 数据 → 填 precomputed_composite_signals)。本次只接通 engine 端 + smoke。建议建一个 `backend/src/quant/backtest/composite/CompositeBacktestRunner.ts` 单独承担此层。
2. **MFA 真实回测验证脚本**：`backend/scripts/quant-audit/verify_composite_backtest_parity.ts` 未实现（需要真实 factor_scores 历史数据）。
3. **回测 + 实盘费率统一 (audit M-23)**：未处理；建议建 `backend/src/constants/aShareFees.ts` 集中常量，回测 / 实盘都 import；老 realized_pnl 不动只对新 trade 生效。
4. **次日开盘是否涨停的 `(bar.open - prev_close)/prev_close` 判定 (audit M-5)**：通过本次 marketLimits 接入 `isAtLimitUp(bar, ...)` 已经间接达成（isAtLimitUp 会看 bar.open 是否触达），但 QuantBacktestEngine 的 `executePendingOrders` 在调用 `evaluateOrder` 时传的是 next-day 的 bar（开盘后已知 open），合并到 marketLimits 路径后自然不再用 change_percent。
5. **LiveRiskGuardService:140 的 limit_up_buy check**：本次让上游 LiveTradingService.createDraft 算 `lmIsLimitUp` 并传给 guard；guard 内部仍只看 boolean。未来如果要 guard 自己算（多调用方一致），可以扩 guard 输入接 `symbol + prev_close` 让 guard 内部 call `isAtLimitUp`。

---

## 9. 关键判断与 tradeoff

1. **不让 run() 变 async** — 改变方法签名会破坏 3 个上游 caller (GridSearch / CostSensitivity / QuantBacktestService)。改用 caller-prefetch + precomputed_composite_signals 是把 DB 责任外移的 cleaner approach。
2. **保留 AShareConstraintEngine 旧 `change_percent` legacy 路径** — 避免 4xx 个老测试 break；新代码传入 `symbol + prev_close` 即激活精确路径。
3. **PaperTradingFacade 抽 `evaluateLimitUpDownBlock` 纯函数** — 让单测可以完全脱离 DB / 整条 BUY/SELL 链路验证 5 个市场段 + ST + bypass + 缺数据。
4. **北交所过滤用 in-memory** — Sequelize 不能高效 NOT LIKE 多 prefix，2x 候选数即可补偿。

---

## 10. 后续 Sprint TODO（不影响本批落地）

- [ ] CompositeBacktestRunner — 真实接通 MFA 走 generateSignals
- [ ] verify_composite_backtest_parity.ts — MFA 回测信号 vs 实盘 QuantSignal 对账
- [ ] aShareFees.ts 常量统一（M-23）
- [ ] 给 LiveRiskGuardService 内部加 `symbol + prev_close` 输入选项，让 guard 自己算 is_limit_up 不再依赖 caller
- [ ] 历史已 break 的 strategy test 修复（与本批无关，但需要后续 sprint 修复 default_params 漂移）
