# 42 — 再平衡（Rebalancing）

> "好策略 + 不动" ≠ 好回报。市场会让你的持仓自然偏离目标——涨多的涨更多，跌的越来越小占比 → 风险结构悄悄改变。但每天再平衡也是错的——成本会吃掉 alpha。**只在偏离 > 阈值 + 控制频率**。

---

## A. 操盘手心智

我把再平衡分两类：

1. **结构性再平衡**：目标权重变了（策略调仓 / 月度因子重算 / regime 切换） → 全 portfolio 重新分配。
2. **维护性再平衡**：目标权重没变，但市场波动让实际偏离了（A 涨 30%、B 跌 10% → A 仓位从 8% 变 10.4%） → **只调超阈值的几只**。

两条铁律：

- **每天调 = 死路**：日内换手率超 50% 时年化成本 ≥ 6%（commission 0.025 + slippage 0.1 + impact 0.05 一次往返 ≈ 0.35%，每月 20 次 = 7%）→ 直接吃完 alpha。
- **不调 = 慢性中毒**：3 个月不调，组合可能从"分散"漂成"3 只重仓"。

工程化：
- 维护性 → daily 跑，但 `min_trade_pct = 0.5%`（偏差 < 0.5% 不动）
- 结构性 → 策略调仓事件触发 / 月初触发，强制 + 走 dry_run preview

---

## B. 系统设计

### B.1 触发条件

| 触发方式 | 条件 | 默认参数 |
|---|---|---|
| **drift 触发**（维护性） | 任一持仓 \|实际 - 目标\| > 3% | 每日 14:30 跑 |
| **target 变更触发**（结构性） | `PortfolioConstructionService.buildTargetPortfolio` 输出 vs 上次 hash 不同 | 每日收盘后 16:30 跑 |
| **regime 切换触发** | `MarketRegimeAlertService` 检测到 regime 翻转 | 立即评估 + 次日开盘执行 |
| **risk guard 触发** | `IndustryConcentrationGuard.evaluateAfterClose` / `DrawdownCircuitBreaker LEVEL_2` | 见 50/53/54 |
| **手动按钮** | Settings → "Rebalance Now" | dry_run=true 默认 |

### B.2 算法

```ts
// 位于 backend/src/portfolio/RebalanceEngine.ts
function computeTradePlan({
  total_value,
  positions,         // 现有持仓
  targetWeights,     // Map<symbol, weight>
  priceMap,          // Map<symbol, current_price>
  minTradePct = 0.005,
}): RebalanceOrder[]
```

每只 stock（target ∪ held）：
1. target_value = total_value × weight
2. diff_value = target - current；diff_pct = |diff| / total
3. `diff_pct < minTradePct` → HOLD
4. BUY 用 `floor(diff/price/100) × 100`（防 cash 超支）
5. SELL 用 `ceil(|diff|/price/100) × 100`，上限 held quantity

排序：SELL → BUY → HOLD（先释放 cash 再买，链式失败概率↓）

### B.3 成本约束

- `minTradePct=0.5%` 是为了过滤"调一手 100 元无意义"
- 计划生成后估算 `expected_cost_pct = Σ |diff_value| × (commission + slippage) / total_value`
- 若 `expected_cost_pct > 0.3%`（单次 rebalance 成本上限）→ 触发"second pass"：只保留 top-N 偏离最严重的 stock，其余 HOLD

### B.4 与执行算法的接力

- RebalanceEngine 只产**意图**（BUY/SELL/数量）；
- 真实下单的拆单策略由 `ExecutionPolicyRouter` 决定（详见 43_execution_algos.md）；
- 调用方 `RebalanceEngine.rebalance({execute:true})` 内部走 `facade.placeOrder / facade.closePosition` → automation 路径会再过一次 `executionPolicyRouter.route`。

---

## C. 现状 review

### C.1 通用 RebalanceEngine 已就绪 (US-086)

- **入口**：`backend/src/portfolio/RebalanceEngine.ts:1-200`（665 行），7 个纯函数 helper export 单测齐全。
- **关键不变量**：
  - line 102-105：`DEFAULT_REBALANCE_OPTIONS = { minTradePct: 0.005, dryRun: true }`，Object.freeze
  - line 93：`MIN_TRADE_LOT_SIZE = 100`（A 股 1 手）
  - SELL → BUY → HOLD 排序，先释放 cash
  - lazy-require facade 解循环依赖

### C.2 ⚠️ 但 caller 仍是 TODO

- `backend/src/portfolio/RebalanceEngine.ts:74-77` 自承"不直接绑定 HTTP route……设计为可被 (a) controller endpoint 直接调用（未来故事落地）、(b) 策略层 generateSignals 输出直接调用、(c) PortfolioOptimizer 事后分析结果落地调用"。
- **现状**：grep `RebalanceEngine` 在生产路径仅找到本文件自引用 + 单测；没有 cron / controller / automation 调用。
- **后果**：US-086 的"通用 rebalance"在生产链路上**0 调用次数**。所有真实 rebalance 都走 US-052 `IndustryConcentrationGuard.rebalanceIndustry`（行业级 + 应急）。

### C.3 行业级 rebalance 是唯一生效路径

- `backend/src/portfolio/risk/IndustryConcentrationGuard.ts:1028 行` —— `rebalanceIndustry` 是 POST 路由（`/api/portfolio/rebalance-industry`）+ 系统自动应急（`dry_run=false` 默认）。
- 仅处理"超 35% 行业卖 1-2 只到 < 30%"，不解决全 portfolio drift。

### C.4 drift 监控完全缺失

- 无 cron 跑"扫所有 portfolio 检查 drift > 3% 的 stock"。
- IndustryConcentrationGuard 是事件触发的（cron 默认每日 15:30，见 `SchedulerService.ts`），但只看行业不看单 stock。

### C.5 结构性触发也没有

- 没有"target_weights hash 变化 → 自动 rebalance"的链路。
- `PortfolioConstructionService` 本身还不存在（见 40 文档）。

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-RB-1 | **新建 cron `PORTFOLIO_DRIFT_REBALANCE`**：每日 14:30 跑，扫所有 enabled portfolio，按 5% 阈值（high water）找 drift > 5% 的 stock，调用 `RebalanceEngine.rebalance({ execute: false })` 写 RiskAlert MEDIUM + dashboard preview | cron 注册成功，dry_run 输出 plan 写 `RiskAlert.metadata.rebalance_plan` |
| US-RB-2 | **结构性触发**：`PortfolioConstructionService.buildTargetPortfolio` 输出 + 写 hash 到 `target_weights_snapshots`；当日 16:30 检测 hash 变化 → 跑 `rebalanceEngine.rebalance({execute:false})` 写 preview | 一个集成测：targetWeights 变化 → preview 出现 |
| US-RB-3 | **手动按钮 + preview UI**：Settings → "Rebalance Now"，先 dry_run 展示 plan，用户点"Execute" 才真下单；execute=true 时再过一次 RiskAlert.metadata 保留 audit | UI 能跑完 dry → execute 两段流程 |
| US-RB-4 | **成本上限第二轮**：plan 估算总 cost > 0.3% total_value → 保留 top-N 偏离严重的 stock，其余 HOLD，再产 plan | 单测：构造高换手场景，第二轮 plan order 数 < 第一轮 |
| US-RB-5 | **rebalance 频率限制**：同 portfolio 24h 内 execute > 1 次 → 拒，写 RiskAlert HIGH（防止 UI 误点 / 脚本 bug） | 单测：两次 execute 第二次 throw `REBALANCE_COOLDOWN` |
| US-RB-6 | **drift 监控可观测**：Prometheus `portfolio_drift_pct{portfolio_id,symbol}` gauge，每日 cron 推送；Grafana 面板"drift heatmap" | metric 在 /metrics 可查 |

### D.2 与 US-052 行业 rebalance 的关系

- US-052 = 行业风控触发的"局部应急 rebalance"（卖超标行业 1-2 只）。
- 本 US-RB-1 = 全 portfolio 维护性 rebalance（drift > 5%）。
- US-RB-2 = 全 portfolio 结构性 rebalance（target 变化）。
- 三者**互不重叠**：US-052 是应急、本两者是日常。
- 现实顺序：先跑 US-052（高优先级、强约束）→ 再跑 US-RB-1（drift）→ 周末跑 US-RB-2（结构性）。

---

## E. 验收口径

- 跑 60 天 paper：rebalance 月均执行次数 ≤ 12 次/portfolio
- 单次 rebalance 成本占比 < 0.3% total_value
- drift > 5% 的 stock 占比 < 10%（防止"调了不及时"）
- 24h cooldown 防误触
- 文件位置：`backend/src/portfolio/RebalanceEngine.ts`（已存在）+ 新 cron `SchedulerService.PORTFOLIO_DRIFT_REBALANCE`
