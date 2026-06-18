# 38 — EnsembleStrategy 多策略融合（regime-aware meta）

## A. 操盘手心智

单一策略再好都有失效区间——动量策略 2018 熊市归零、价值策略 2020 抱团年绞肉、高股息 2023 H2 银行系统性下跌。**长期穿越牛熊的唯一方式是多策略并行 + 动态权重**。

老练的组合管理思路：
1. **每个策略风格清晰**（趋势/反转/价值/事件/资金/龙头）
2. **市场环境识别**（bull/bear/range/volatile 4 种 regime）
3. **regime → 子策略权重映射**（bull 偏动量 / bear 偏防御 / range 偏反转事件 / volatile 偏价值）
4. **子策略输出加权融合**（vote 投票 vs 仓位 quota）
5. **失败隔离**（单策略数据缺失不阻塞整体）
6. **平滑过渡**（regime 切换日不能一夜清仓重建）

Ensemble 是整个 alpha 引擎的"总指挥"——把 13 个子策略组织成一个稳定的 portfolio：
- 每天根据 regime 选 2-3 个子策略
- 每个子策略产 target_portfolio
- vote 加权融合产 ensemble target
- 调用方按 ensemble target 调整持仓

---

## B. 系统设计

### B.1 策略定义

证据: `backend/src/quant/strategies/EnsembleStrategy.ts:260-280`：
- strategy_key: `ensemble`
- style: `ensemble` → 基准沪深 300
- 触发: 每日
- Position: string[] (meta 只关心选哪些股)
- 不直接访问 DB（仅通过子策略间接访问）
- 不需要 DataSource 注入

### B.2 4 种 regime 子策略组合（AC 指定）

证据: `EnsembleStrategy.ts:1-100`：

| regime   | 子策略 + 权重                                              |
|----------|----------------------------------------------------------|
| bull     | MultiFactorAlpha 0.40 + DragonHead 0.30 + Breakout 0.30   |
| bear     | HighDividendValue 0.60 + LowVol 0.40 [LowVol 未实现]      |
| range    | SectorRotation 0.40 + LeftSide 0.30 + EarningsSurprise 0.30 |
| volatile | GARP 0.50 + HighDividendValue 0.50                       |

### B.3 市场环境识别

证据: `EnsembleStrategy.ts:80-100`，调 `marketEnvironmentService.getEnvironmentForStock('sh.000300', { as_of })` 拿到 6 种 raw regime，再折叠到 4 种 AC regime：
```
bull    → bull
bear    → bear
range   → range
rebound → range      (弱反弹按震荡处理 — 趋势未确认)
stress  → volatile   (高压力 / 大回撤当作高波动)
unknown → range      (数据不足时按震荡，最中性的策略组合)
```

证据底层: `backend/src/services/MarketEnvironmentService.ts:204-263` 4-state HMM + 硬规则 fallback。

### B.4 融合语义 — vote 投票

证据: CLAUDE.md L968-981：
- 每只入选股 `vote = Σ (weight × indicator[in_target])`
- 按 vote 降序取 top-N
- 优势：自动处理子策略输出股票数不等、子策略全空、多策略共振加分

vs 仓位 quota（未采纳）的关键差异：vote 让"灵活组合"代替"硬性切分"。

### B.5 LowVol 缺失降级

证据: `EnsembleStrategy.ts:982-1003`：
- `rebalanceMissingWeights=true`（默认）→ LowVol 0.4 按比例重分配给剩余子策略（仅 HighDividend）
- 输出 `degraded_substitutions: [{missing_strategy, original_weight, redistributed_to}]`
- `rebalanceMissingWeights=false` → 缺失权重作废
- 生产用 true，对照实验用 false（可量化"LowVol 缺失带来多少 alpha 损失"）

### B.6 子策略适配 + 注入

证据: `EnsembleStrategy.ts:1005-1033`：
```ts
new EnsembleStrategy()                       // 8 个生产实例
new EnsembleStrategy([fake1, fake2, fake3])  // 测试用 fake
```

`EnsembleSubstrategy` 接口 + `extractTargetStockCodes` 统一处理两种 shape（string[] vs structured Position[]）。

### B.7 子策略隔离 + 并发

- `Promise.all` 并发跑所有 effective substrategies，wall-time = max(子策略耗时)
- 每个子策略 try/catch，失败记 `error` 字段 + target_size=0
- BUY/SELL/HOLD 在 ensemble 层重新计算（忽略子策略各自的 signal 数组），统一基于 ensemble 自己的 previousSelection

---

## C. 现状 review

### C.1 已实现部分

证据: `EnsembleStrategy.ts` 826 行：
- 4 regime → 子策略组合完整
- 6 raw regime → 4 AC regime 折叠
- vote 加权融合
- 子策略并发调用 + 失败隔离
- LowVol 缺失自动降级 + degraded_substitutions 字段
- 构造器可注入 fake substrategies 完全脱 DB
- marketRegimeOverride 参数让测试跳过 MarketEnvironmentService

### C.2 ⚠️ LowVol 未实现

bear regime 配置 HighDividend 0.6 + LowVol 0.4，但 LowVol 未实现 → 自动降级到 HighDividend 1.0 独食。
- bear 整段时间 portfolio = 高股息 30 只持仓
- capacity / 风格集中度风险大
- 详见 30_strategy_overview.md / 35_high_dividend.md 改造方案

### C.3 ⚠️ regime 切换不平滑

如果某日 regime 从 bull 切到 bear，子策略集从 {MFA, DragonHead, Breakout} 完全切换到 {HighDividend, [LowVol]}，target_portfolio 可能 80% 换手——单日剧烈调仓 = 巨大滑点 + 成本。

应该：
- regime 切换需"连续 3 个交易日确认"才生效（避免单日 noise 切换）
- 切换日 portfolio 按 50% old + 50% new 平滑过渡（不一下到位）

### C.4 ⚠️ 缺 capacity 估算 vs 子策略叠加

Ensemble 产出 target_portfolio 后，没有"整体 capacity"估算。如果 DragonHead 单独 capacity 500 万 + HighDividend capacity 5000 万，Ensemble 在 bull regime 重仓 DragonHead 时整体 capacity 上限就被 DragonHead 拉到 500 万。

### C.5 ⚠️ vote 计算不考虑子策略 IC

当前权重是硬编码 0.4 / 0.3 / 0.3。但子策略 IC / sharpe 应该影响权重：如果 DragonHead 近 30 日表现极差（win_rate 跌到 30%），权重应自动降低。

### C.6 ⚠️ Ensemble backtest 跑不通（核心)

EnsembleStrategy 是组合级策略，与其他 12 个一样在回测引擎里默认 evaluate() 返回 hold（`QuantBacktestEngine.ts:144`），需要 precompute composite signals。但 Ensemble 的 precompute 要先递归 precompute 全部子策略——caller 自管成本极高。**至今 Ensemble 应该没在 backtest 里真正跑过**。

---

## D. 改造方案

### D.1 P0：补 LowVolatilityStrategy 真组合级实现

详见 30_strategy_overview.md D.1 + 35_high_dividend.md D.5。Ensemble bear regime 必须真两个子策略。

### D.2 P0：Ensemble backtest auto-precompute（递归处理子策略）

**user story**：
- QuantBacktestService.runBacktest 启动 Ensemble backtest 时
- 自动 detect 它是 Ensemble，先 precompute 所有 8 个子策略 (per date) 的 target_portfolio
- 再 precompute Ensemble 自己 (per date) 的 target_portfolio
- 全部塞进 precomputed_composite_signals 后进 BacktestEngine
- 验收: Ensemble backtest 2023-2025 trade_count > 500；alpha vs 沪深 300 ≥ +5%

### D.3 P0：regime 切换平滑机制

**user story**：
- params 加 `regimeConfirmDays: number`（默认 3）
- 加 `transitionBlendDays: number`（默认 2）
- 实现：连续 3 日 regime 一致才切换；切换日按 (currentDay / transitionBlendDays) 加权混合 old + new target
- 验收: regime 切换日单日换手 ≤ 40%（不再 80%+）

### D.4 P1：动态子策略权重（按近 30 日表现）

**user story**：
- params 加 `weightAdjustMode: 'static' | 'performance'`
- 'performance' 模式：每月按子策略近 30 日 sharpe 调权重
- sharpe ≥ 1.0 → weight × 1.2
- sharpe ≤ 0 → weight × 0.5（capped at 0.05 不完全归零）
- 验收: kill switch 不触发的子策略，权重在 ±50% 区间动态浮动

### D.5 P1：Ensemble capacity 估算

**user story**：
- Ensemble result 加 `capacity_estimate`
- = min over effective_substrategies (substrategy.capacity × substrategy.weight)
- 前端显示"当前 regime 下 portfolio 容量 = X 万"
- 实盘资金 > capacity 时飞书 ALERT

### D.6 P2：Ensemble 历史 regime 时间线可视化

**user story**：
- 前端展示过去 90 日每日 regime + 子策略权重时间线
- 切换点标注 + 切换原因（HMM 输出 vs 硬规则触发）
- 帮助 ops 判断"regime 是否切换太频繁 / 是否漏切换"

### D.7 P2：自定义 regime → 子策略组合（用户配置）

- 当前 4 regime 组合硬编码在策略里。允许用户在 admin UI 配置自定义子策略组合（如 bull 加上 NorthboundFollow 0.20 同时 MFA 降到 0.20）

---

## E. 验收口径

1. **完整覆盖**: 任意 regime 都有 ≥ 1 个生效子策略；bear 必须有 ≥ 2 个（LowVol 实现后）
2. **平滑过渡**: regime 切换日单日换手 ≤ 40%
3. **失败隔离**: 任意 1 个子策略数据缺失/抛错，Ensemble 仍能正常产 target（其他子策略接管）
4. **backtest 可跑**: 2023-2025 Ensemble backtest trade_count > 500，sharpe ≥ 1.2
5. **alpha 显著**: vs 沪深 300 alpha ≥ +5%/year；vs 单一最强子策略 sharpe 提升 ≥ 20%
6. **可观测**: 前端任意日能看到 regime / 子策略权重 / degraded_substitutions / vote 排行
7. **可控**: regime 切换需 3 日确认；切换 transition 2 日完成
