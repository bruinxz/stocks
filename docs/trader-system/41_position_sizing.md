# 41 — 仓位算法（Position Sizing）

> "信号告诉我这只票可能涨；仓位算法告诉我下多少钱。"——下多少钱基本决定了夏普比的下限。仓位 = min(Kelly, ATR_implied, MaxPosition_cap)。

---

## A. 操盘手心智

不能"每次都按 5% 等权"——会发生两件惨事：

1. **波动率没考虑**：60% 年化波动的电力股和 18% 的银行股拿一样仓位 → 组合波动被高波动股主导。
2. **凯利没用上**：有 200 笔历史的策略胜率 60%、盈亏比 1.8（f* ≈ 0.38），却只敢下 5% → 长期复利效率差一个数量级。

**三轨并行 + 取最小** = 风险约束 + 期望收益约束 + 硬上限三重保险：

1. **Kelly 轨**：`f* = (p·b - q)/b`，取 1/4 Kelly（业界稳健值）。要求样本 ≥ 50。
2. **ATR 轨**：每笔最多亏 1% equity；`shares = (equity × 1%) / atr`。
3. **VolTarget 轨**：每个仓位贡献年化 15% 波动；高波动股自动小仓位。
4. **硬 cap**：单股 ≤ 8%，但 max_position_pct 默认 12%（允许个别强信号超 8% 至 12%）。

输出 = `min(三轨, max_position_pct, available_cash × 0.98)`。

---

## B. 系统设计

### B.1 配置 schema

```jsonc
// User.risk_config.sizing_policy
{
  "method": "equal_pct" | "vol_target" | "atr_based" | "kelly",
  "base_position_pct": 5,         // equal_pct 用
  "max_position_pct": 12,         // 任何方法的硬上限
  "vol_target_pct": 0.15,         // vol_target 用：年化目标波动 15%
  "atr_risk_pct": 1.0,            // atr_based 用：每笔最多亏 1% equity
  "atr_period": 14,
  "kelly_fraction_multiplier": 0.25,  // 1/4 Kelly
  "kelly_min_sample_size": 50,
  "hard_cutover_enabled": false   // false=shadow, true=真生效
}
```

### B.2 主入口

```ts
// 位于 backend/src/portfolio/PositionSizingPolicy.ts
function decideSizing(policy: SizingPolicyConfig, ctx: SizingContext): SizingDecision
```

四步：
1. 按 `policy.method` 选算法，得 raw target_amount。
2. 应用 `max_position_pct` cap。
3. 应用 `available_cash * 0.98` cap（留 2% buffer 防四舍五入）。
4. < `min_trade_amount`（默认 5000 元）→ 返回 0 + 跳过原因。

### B.3 算法细节

- **equal_pct**：`equity × base_position_pct × conviction`（Phase 0 兼容）
- **vol_target**：`equity × min(1, vol_target_pct / sigma) × conviction`；sigma 缺失退化到 base
- **atr_based**：`(equity × atr_risk_pct / 100) × current_price / atr`；atr 缺失退化
- **kelly**：`equity × f* × fraction_multiplier`；样本 < min 退化；f* ≤ 0 直接返 0（负期望不下注）

---

## C. 现状 review

### C.1 算法层已就绪

- `backend/src/portfolio/PositionSizingPolicy.ts:281-330` — `computeKellyFraction` + `computeKellySize` + `computeAtrBasedSize` + `computeVolTargetSize` 四个纯函数全 export 单测齐全。
- `backend/src/portfolio/PositionSizingPolicy.ts:350-468` — `decideSizing` 主入口，三层 cap 处理完整，min_trade_amount fail-back 返回 0 + reason。
- `backend/src/portfolio/PositionSizingPolicy.ts:135-146` — `DEFAULT_SIZING_POLICY` Object.freeze；默认 `method='equal_pct'`，`max_position_pct=12`，`kelly_fraction_multiplier=0.25`。

### C.2 ⚠️ 生产仍走 equal_pct（硬切换默认关）

- **证据**：`backend/src/portfolio/PositionSizingPolicy.ts:118-130` — `hard_cutover_enabled` 默认 `false`，注释明确"shadow mode，实际下单仍走原有 effectiveTargetPct"。
- **调用方**：`backend/src/portfolio/internal/PaperTradingAutomationService.ts:2516-2615` —
  - line 2516：`shadowSizingDecision = decideSizing(sizingPolicy, {...})` 算出 sizing 但只 log；
  - line 2606-2615：仅当 `sizingPolicy.hard_cutover_enabled === true && shadowSizingDecision.position_pct > 0` 时才用新 sizing 替换 `effectiveTargetPct`；
  - 没人翻 `hard_cutover_enabled=true` 时，整个 Kelly/ATR/VolTarget 算法在生产路径上**0 生效**。
- **后果**：仓位还在按"用户在工作区配的 base_position_pct（默认 5%）×conviction"算，**没有任何波动率或凯利成分**。Memory `sprint-34` 的"真生效"叙述与此处冲突。

### C.3 ATR 数据来源已对齐 (Sprint 34 完成)

- 之前 ATR 走 high-low proxy；Sprint 34 短板 #1 已切换到真 ATR (来自 `quant/factors/library/AtrFactor` 或 DailyBar 14 期)。
- `SizingContext.atr` 由 PaperTradingAutomationService 在 createBuyTrade 入口准备好。

### C.4 Kelly 输入缺位

- 单次 sizing 需要 `historical_win_rate / historical_payoff_ratio / historical_sample_size`，应来自 `RecommendationTradeOutcome` per-strategy-per-symbol 聚合。
- 仓内**没有一处**真实聚合提供这些值；automation 永远传 `undefined`，Kelly 路径必然退化到 `base_position_pct`。

### C.5 SizingPolicyService 几乎空

- `backend/src/portfolio/risk/SizingPolicyService.ts:1-74` — 仅 74 行，是 CRUD wrapper，不做计算决策。

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-PS-1 | **shadow 数据落库 + 报表**：把 `[shadow-sizing] / [hard-sizing]` log 落到 `sizing_shadow_decisions` 表（method / shadow_pct / actual_pct / delta），dashboard 出"过去 30 天，如果切 hard sizing，组合 sharpe / 换手率会变化多少" | 跑 30 天后能看到 4 method × 30 天 × 用户的 shadow 报表 |
| US-PS-2 | **Kelly 输入聚合**：新增 `StrategyOutcomeAggregator.getKellyInputs(user_id, strategy_key, symbol)` 滚动 90 天 / 50 笔 outcome 聚合返回 `(win_rate, payoff_ratio, sample)`；automation `createBuyTrade` 入口注入到 SizingContext | Kelly 路径不再 100% 退化，至少有 5 个策略有真实 f* > 0 输出 |
| US-PS-3 | **Per-user 真实开关 UI**：SettingsWorkspace 加 "Sizing Policy" tab，能 GET/PUT method + 4 个核心参数 + hard_cutover_enabled toggle | 用户能切，PUT 后 7 天内可看到实际 trade 仓位变化 |
| US-PS-4 | **审计 hard_cutover 切换**：每次 PUT `hard_cutover_enabled` 写 `RiskAlert(level='LOW', rule_id='sizing_policy_changed')`；切换 30 天内禁止再切回（防止套利） | 1 个 UI 测试：连续切两次第二次被拒 |
| US-PS-5 | **三轨取最小**：当 `method='kelly'` 时，同时算出 vol_target + atr_based 的值，取 `min(kelly, vol_target, atr_based, max_position_pct_cap)` 而不是单选；保留 `method='kelly'` 表示"主信号"，min 是"防御" | 1 个单测：Kelly 算 8%、ATR 算 3% → 最终 3% |
| US-PS-6 | **历史不可信回退**：< 50 笔时 Kelly 退化到 vol_target 而非 base_position_pct（vol_target 也比 equal_pct 安全） | 单测：sample=20 时 method='kelly' 输出等于 vol_target 算的值 |

### D.2 与 US-044 PortfolioOptimizer 的关系

- Optimizer 决定**策略级** capital allocation；sizing 决定**单笔 trade**的仓位。
- 两者复合：`single_trade_size = strategy_capital × decideSizing(...)`，自然就把策略 cap 传递下去。

### D.3 与 PositionLimitGuard 的关系

- sizing 算完后还要过 PositionLimitGuard（`backend/src/portfolio/risk/PositionLimitGuard.ts:71-75`）：单股 10% + 单行业 30% + 持仓数 20 三道闸。
- 注意 max_position_pct 默认 12% 比 PositionLimit 单股 10% 宽松，最终生效是 PositionLimit 的 10%（取严）。建议统一到一个常量（详见 50_risk_overview）。

---

## E. 验收口径

- 单测覆盖 4 个 method × (正常 / 缺数据 / 触 max cap / 触 cash cap) ≥ 16 个 case
- 翻 `hard_cutover_enabled=true` 跑 1 周，组合月度换手率变化 < 30%（防止上线日 churn）
- Kelly 路径在至少 1 个策略上能基于真实 outcome 输出 f* > 0
- shadow_delta 报表能 SQL 查询出"如果上线节省 / 多花了多少 commission"
- 文件位置：`backend/src/portfolio/PositionSizingPolicy.ts`（保留）+ 新 `StrategyOutcomeAggregator`
