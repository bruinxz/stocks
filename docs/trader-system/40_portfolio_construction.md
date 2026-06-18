# 40 — 组合构造（Portfolio Construction）

> 把 N 个策略各自给出的 signal/score 融合成一份**全账户级**的目标持仓（target_portfolio），再交给 sizing → 风控 → 执行落地。这一步决定了"组合的方差从哪里来"——做得不好，10 个策略合起来的 sharpe 还不如最好那一个。

---

## A. 操盘手心智

我同时跟 6-10 个策略：MFA / DragonHead / Breakout / LeftSideReversal / HighDividendValue / EarningsSurprise / NorthboundFollow / CTA100Momentum / SectorRotationLeader / GARP。每个策略每天给我一份**候选清单**（symbol → conviction_score）。我做四件事：

1. **去重**：两个策略同时推 600519，不能算两份仓位。
2. **冲突仲裁**：MFA 想 BUY 600519、LeftSideReversal 想 SELL 600519 → 谁说了算？默认按"近 30 天 IR 加权"或硬优先级表。
3. **配权**：MFA 在 bull regime 加权 0.4，在 bear regime 降到 0.15。
4. **去相关**：单股聚合后还得看行业相关性——10 个仓位全在新能源就完蛋。

输出一份 `Map<symbol, target_weight>`，sum(weight) ≤ 0.95（留 5% 现金缓冲）。

---

## B. 系统设计

### B.1 数据流

```
策略 1: generateSignals(T) → {symbol, signal, score, conviction}[]
策略 2: ...
策略 N: ...
                ↓
        SignalFusion
   ┌──────────────────────────┐
   │ 1. 去重 (per-symbol agg) │
   │ 2. 冲突仲裁              │
   │ 3. regime 加权融合       │
   │ 4. 因子级相关性扣减      │
   │ 5. 归一化到 sum(w) ≤ 0.95│
   └──────────────────────────┘
                ↓
    Map<symbol, target_weight>
                ↓
   PortfolioOptimizer (可选: 最大化 sharpe)
                ↓
    RebalanceEngine.rebalance(targetWeights)
                ↓
   生成 BUY/SELL 单 → facade.placeOrder
```

### B.2 融合算法

**Step 1 — Per-symbol score aggregation**：

```
combined_score(s) = Σ_i w_i * normalize(score_i(s)) * regime_multiplier(i)
```

- `w_i` = 策略 i 的基础权重（由 IR/IC monitor 滚动维护）
- `normalize` = 把每个策略的 score 映射到统一 [0, 100] 分位区间
- `regime_multiplier` = 当前市场 regime 下该策略的加权倍数（bull/bear/range）

**Step 2 — 冲突仲裁**：

| 场景 | 仲裁规则 |
|---|---|
| 一只票被 A BUY、被 B SELL | 取 combined_score 高者；若打平按"防御优先"（SELL 胜） |
| 两个 BUY 候选行业冲突（行业上限 25%） | 按 combined_score 排序，行业累计 cap |
| 同 symbol 被多个策略 BUY | combined_score 取 weighted avg，attribution 记每个策略贡献 |

**Step 3 — Regime 加权**：

```
regime_multiplier(strategy_i, regime):
  bull:  momentum 类 1.3, low_vol 0.7, dividend 0.5
  bear:  momentum 0.5, low_vol 1.3, dividend 1.5
  range: 趋势类 0.7, 反转类 1.3, 龙头 0.9
```

regime 来源：`MarketRegimeAlertService.getMarketRegimeStatus()` (位于 `backend/src/portfolio/risk/MarketRegimeAlertService.ts`)

**Step 4 — 相关性扣减**：

每天根据 FactorCorrelationReport 输出的相关性矩阵，对"两两 ρ > 0.7"的策略：把更小 IR 的那个的权重 × 0.5。

**Step 5 — 归一化**：

```
sum_w = Σ target_weight
if sum_w > 0.95:
    scale = 0.95 / sum_w
    target_weight[s] *= scale   # 留 5% 现金
```

### B.3 输出契约

```ts
interface PortfolioConstructionResult {
  trade_date: string;
  target_weights: Map<string, number>;   // symbol → weight (sum ≤ 0.95)
  regime: 'bull' | 'bear' | 'range';
  contributing_strategies: Record<string, string[]>;  // symbol → [strategy_key,...]
  evidence_per_symbol: Record<string, { score: number; reasons: string[] }>;
  diagnostics: {
    n_strategies_run: number;
    n_symbols_pre_dedup: number;
    n_symbols_post_dedup: number;
    conflict_count: number;
    cash_buffer_pct: number;
  };
}
```

---

## C. 现状 review

### C.1 没有真正的"组合构造层"

- **入口**：`backend/src/quant/engine/internal/QuantSignalService.ts:496-601` — `runCompositeStrategies` 调每个组合级策略的 `generateSignals(trade_date)`，把结果**线性 concat**成 `QuantSignalResult[]` 写 `QuantSignal` 表，**没有跨策略融合**。
- **后果**：MFA 出 30 个 BUY、DragonHead 出 20 个、Ensemble 出 25 个 → 数据库 75 行 QuantSignal，对同一只 600519 可能 3 行 conflict，但没人合并。

### C.2 fusion 真正发生在 PaperTradingAutomationService.autoBuyFromSignals

- **证据**：`backend/src/portfolio/internal/PaperTradingAutomationService.ts:3091-3197` — 在最末端"按 QuantSignal 逐行 createBuyTrade"时按 strategy_key/portfolio 维度逐条下单，没有 portfolio-level 目标权重的概念。
- 每个策略实际上**独立维护自己的 portfolio**（用 portfolio_id 隔离），不存在"全账户 target weight"。
- 多策略共账场景目前是"先到先得 + cash 抢占"，不是组合构造。

### C.3 PortfolioOptimizer 存在但**未接入**

- **证据**：`backend/src/quant/backtest/PortfolioOptimizer.ts:1-100,711-784` — US-044 已实现 projected_gradient 求解器，能在 N 个策略历史日收益上求 max-sharpe 权重。
- 主要消费方仅 CLI `optimize-portfolio.ts` + 未来 US-016 实验室 tab；**生产链路 0 调用**。
- 即使有人调，输出 `weights: {strategy_key → weight}` 是**策略级权重**，不是**symbol 级目标权重**——需要再下一步把"策略 → symbol"的目标传到 RebalanceEngine。

### C.4 regime 加权未实现

- `MarketRegimeAlertService` (`backend/src/portfolio/risk/MarketRegimeAlertService.ts:1-100`) 只产 RiskAlert（3 日跌 / 20 日跌 / 死叉），**没有暴露 regime 状态**给策略融合层。
- MFA `evaluate` 退化为 hold (`MultiFactorAlphaStrategy.ts:500-517`)，也没读 regime；只在 generateSignals 内部按自己的 sub-strategy 做权重，不跨策略融合。

### C.5 conflict 检测靠数据库 UNIQUE

- `QuantSignal` 表 (UNIQUE on `(strategy_key, symbol, trade_date)`) 让同策略同票同日只能写一条，但**跨策略 conflict 无任何检测**。
- 一只票被 5 个策略推荐时，下游 `autoBuyFromSignals` 会跑 5 次 createBuyTrade（被 PositionLimitGuard 兜底）。

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-PC-1 | **创建 `PortfolioConstructionService`** 位于 `backend/src/portfolio/PortfolioConstructionService.ts`；入口 `buildTargetPortfolio(user_id, trade_date)` 读 QuantSignal 当日所有 strategy 输出 → 跑融合 → 返回 `PortfolioConstructionResult` | 1 个 happy-path 单测：3 个策略 + 重叠 symbols，输出 weight sum ≤ 0.95 |
| US-PC-2 | **regime 加权 hook**：把 `MarketRegimeAlertService.getMarketRegimeStatus()` 输出的 3 个信号映射到 `regime: bull/bear/range` 枚举；融合时用 regime_multiplier 表 | 1 个单测：bear regime 下 momentum 类策略权重确认被乘 0.5 |
| US-PC-3 | **接入 PortfolioOptimizer**：构造层用最近 60 日 strategy IR 跑 `optimize` 拿权重作为融合先验，每月跑一次写 `StrategyWeightSnapshot` 表 | 跑一次得到非空 weights，权重之和 = 1.0 |
| US-PC-4 | **接 RebalanceEngine**：自动撮合 cron 在 `autoBuyFromSignals` 之前先调 `PortfolioConstructionService.buildTargetPortfolio` → `rebalanceEngine.rebalance(target_weights, {execute:true})`；旧 autoBuy 路径作为 fallback | 一个集成测：构造 → rebalance 全链路，最终 portfolio 持仓符合 target_weights ± 0.5% |
| US-PC-5 | **conflict 仲裁审计**：`QuantSignalAttribution` 表新增 `conflict_resolution` 字段（'unanimous' / 'winner_takes_all' / 'weighted_avg'），融合时记录 | dashboard 能查"过去 7 天有多少 conflict 被仲裁，哪些 symbol 频繁冲突" |
| US-PC-6 | **shadow → hard cutover 切换**：默认 `portfolio_construction_enabled=false`，开启后才走新链路；连跑 2 周 shadow，shadow_delta 报表呈现"如果上线，今日实际持仓会变化哪些" | 用户在 SettingsWorkspace 翻 toggle，shadow log 进 `[shadow-construction]` |

### D.2 与 PortfolioOptimizer 的关系（明确）

- **PortfolioOptimizer (US-044)** 答：每个策略给多少 capital 上限（策略级权重 `w_i`）。
- **PortfolioConstructionService (本 US-PC-1)** 答：根据每个策略的具体 signal，全账户应持什么 symbol、多大权重（symbol 级 `w_symbol`）。
- 关系：`w_symbol = Σ_i (w_i × conviction_i_on_symbol × regime_multiplier_i × correlation_penalty)`。
- 顺序：每月 optimizer 跑一次更新 `w_i` → 每日 construction 跑用 `w_i` 融合 signals → 写 target_weights。

---

## E. 验收口径

- 跑 3 个月历史 paper trading：组合 sharpe ≥ max(单策略 sharpe) × 1.2
- 同 symbol 跨策略 conflict 仲裁审计可查
- regime 切换（bull → bear）触发后 7 天内组合仓位明显倾向 low_vol / dividend
- shadow vs hard cutover 的"今日持仓 delta"小于 5%（防止上线日大换手）
- 文件位置：`backend/src/portfolio/PortfolioConstructionService.ts`（新建）+ 引用方 `PaperTradingAutomationService.ts` 改成 construction-first 路径
