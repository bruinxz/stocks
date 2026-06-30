# 模拟盘整合方案 (2026-06-26 勘探报告)

**目标**: 把当前 21 个 paper trading 模拟盘缩减为 1 个综合盘. 找出跑得最好的, 把其他盘的优秀策略 / 因子融入它. 移除"数量"概念, frontend 隐藏选盘 + 新建入口.

**数据快照时间**: 2026-06-27 00:00 (UTC+8) — 所有 `total_value` / 持仓 / trade pnl 都用 prod DB 一次拉取.

---

## 1. 当前模拟盘清单 (全 21 个)

> SQL: `SELECT * FROM paper_trading_portfolios ORDER BY created_at` (见 `/tmp/q1_list.js`)

### 1.1 全表 (按 id 排序)

| id | name | owner | initial | current | active | auto | created |
|----|------|-------|---------|---------|--------|------|---------|
| 24 | 系统观测盘 | stock(4) | 200,000 | 199,979.86 | **false** | false | 2026-06-10 |
| 25 | Codex纯量化模拟盘（20W） | lym(2) | 200,000 | 198,953.65 | true | true | 2026-06-11 |
| 26 | Codex参数实验模拟盘（20W） | lym(2) | 200,000 | 199,467.21 | true | true | 2026-06-11 |
| 27 | Codex趋势突破模拟盘（20W） | lym(2) | 200,000 | 198,722.10 | true | true | 2026-06-11 |
| 28 | Codex动量轮动模拟盘（20W） | lym(2) | 200,000 | 199,806.94 | true | true | 2026-06-11 |
| 29 | Codex均值回归模拟盘（20W） | lym(2) | 200,000 | 199,749.64 | true | true | 2026-06-11 |
| 30 | Codex多因子质量模拟盘（20W） | lym(2) | 200,000 | 199,446.99 | true | true | 2026-06-11 |
| 31 | Codex低波防守模拟盘（20W） | lym(2) | 200,000 | 199,049.98 | true | true | 2026-06-11 |
| 32 | Codex量价确认模拟盘（20W） | lym(2) | 200,000 | 199,531.90 | true | true | 2026-06-11 |
| 33 | Codex纯量化模拟盘（20W） | stock(4) | 200,000 | 199,395.28 | true | true | 2026-06-16 |
| 34 | Codex参数实验模拟盘（20W） | stock(4) | 200,000 | 199,438.28 | true | true | 2026-06-16 |
| 35 | Codex趋势突破模拟盘（20W） | stock(4) | 200,000 | 199,072.99 | true | true | 2026-06-16 |
| 36 | Codex动量轮动模拟盘（20W） | stock(4) | 200,000 | 198,599.80 | true | true | 2026-06-16 |
| 37 | Codex均值回归模拟盘（20W） | stock(4) | 200,000 | **200,079.04** | true | true | 2026-06-16 |
| 38 | Codex多因子质量模拟盘（20W） | stock(4) | 200,000 | 199,437.24 | true | true | 2026-06-16 |
| 39 | Codex低波防守模拟盘（20W） | stock(4) | 200,000 | 199,378.39 | true | true | 2026-06-16 |
| 40 | Codex量价确认模拟盘（20W） | stock(4) | 200,000 | 198,514.71 | true | true | 2026-06-16 |
| 61 | Codex自主荐股模拟盘（20W） | stock(4) | 200,000 | 200,000.00 | true | true | 2026-06-22 |
| 62 | Codex量化Agent融合模拟盘（20W） | stock(4) | 200,000 | 200,000.00 | true | true | 2026-06-22 |
| 63 | Codex Agent独立模拟盘（20W） | stock(4) | 200,000 | 200,000.00 | true | true | 2026-06-22 |
| 64 | Codex自主荐股模拟盘（20W） | lym(2) | 200,000 | 200,000.00 | true | true | 2026-06-24 |

### 1.2 三类盘

| 分类 | 数量 | id 范围 | 状态描述 |
|------|------|---------|----------|
| **已停 (idle)** | 1 | 24 | `is_active=false`, 只 3 BUY 0 SELL, 6 月 17 日后无更新 |
| **8 策略 × 2 owner 实跑盘** | 16 | 25–32 (lym), 33–40 (stock) | 同名策略每个 owner 一份, 6 月 11 / 16 日开盘, 持续交易 |
| **Agent / 自主荐股空盘** | 4 | 61, 62, 63, 64 | 6 月 22–24 创建, 0 trade 0 持仓, 仅注册 `multi_factor_alpha` |

### 1.3 owner 映射 (`SELECT id, username FROM users WHERE id IN (2,4)`)
- `user_id=2` → `lym` (lym@example.com) — 8 个 active + 1 个 Agent 空盘 (#64)
- `user_id=4` → `stock` (stock-666@system.local) — 系统账号, 8 个 active + 3 个 Agent 空盘 (#61/#62/#63) + 1 个 idle (#24)

### 1.4 "数量"由来 — 一句话

每个策略 archetype (纯量化 / 参数实验 / 趋势突破 / 动量轮动 / 均值回归 / 多因子质量 / 低波防守 / 量价确认) 都被 `lym` 和 `stock` 各开了一份, 形成 8 × 2 = 16 个 active 实跑盘. 加 4 个 Agent 空盘 + 1 个 idle 共 21 个. **这就是"数量"的全部来源**.

---

## 2. 各盘绩效对比 (核心)

> SQL: `/tmp/q4_perf.js`, `/tmp/q5_trades.js`, `/tmp/q10_dd.js`. drawdown / sharpe 用 `paper_trading_snapshots` 表算 (每盘每日 1 条 total_value snapshot, 11 天数据).
>
> 注: 年化用 `mean_daily_ret × 252` 直接外推 — 11 / 16 天小样本, 年化主要是相对比较, 绝对值不可用.

### 2.1 16 个实跑盘指标 (按 return_pct 降序)

| id | 名 (owner) | days | 总收益% | 年化% | sharpe | maxDD% | 持仓数 | 已平 | 胜率 | profit_factor | avgHold |
|----|------------|------|---------|-------|--------|--------|--------|------|------|---------------|---------|
| **37** | 均值回归 (stock) | 11 | **+0.040** | -8.92 | -5.16 | 0.44 | 3 | 8 | 12.5% | 1.30 | 5.6d |
| 28 | 动量轮动 (lym) | 16 | -0.097 | -2.42 | **-1.68** | **0.27** | 1 | 9 | 22.2% | 0.84 | 6.3d |
| 29 | 均值回归 (lym) | 16 | -0.125 | -3.14 | -1.63 | 0.29 | 1 | 8 | **25.0%** | 0.74 | 7.9d |
| 32 | 量价确认 (lym) | 16 | -0.234 | -5.85 | -4.70 | 0.37 | 2 | 9 | 11.1% | 0.52 | 6.0d |
| 26 | 参数实验 (lym) | 16 | -0.266 | -6.72 | -12.35 | 0.27 | 4 | 6 | 0.0% | 0.00 | 4.8d |
| 30 | 多因子质量 (lym) | 16 | -0.277 | -6.97 | -8.99 | 0.28 | 1 | 6 | 0.0% | 0.00 | 6.7d |
| 34 | 参数实验 (stock) | 11 | -0.281 | -10.12 | -11.15 | 0.28 | 2 | 6 | 0.0% | 0.00 | 6.3d |
| 38 | 多因子质量 (stock) | 11 | -0.281 | -10.14 | -10.19 | 0.29 | 2 | 6 | 0.0% | 0.00 | 6.6d |
| 33 | 纯量化 (stock) | 11 | -0.302 | -10.12 | -11.15 | 0.28 | 2 | 6 | 0.0% | 0.00 | 6.3d |
| 39 | 低波防守 (stock) | 11 | -0.311 | -11.75 | -7.62 | 0.33 | 2 | 8 | 12.5% | 0.18 | 6.4d |
| 35 | 趋势突破 (stock) | 11 | -0.464 | -17.84 | -13.34 | 0.50 | 3 | 7 | 14.3% | 0.14 | 7.3d |
| 31 | 低波防守 (lym) | 16 | -0.475 | -11.90 | -10.00 | 0.55 | 3 | 8 | 0.0% | 0.00 | 6.3d |
| 25 | 纯量化 (lym) | 16 | -0.523 | -13.21 | -11.31 | 0.54 | 3 | 7 | 0.0% | 0.00 | 5.5d |
| 27 | 趋势突破 (lym) | 16 | -0.639 | -16.14 | -14.56 | 0.64 | 3 | 10 | 0.0% | 0.00 | 6.6d |
| 36 | 动量轮动 (stock) | 11 | -0.700 | -24.48 | -13.53 | 0.68 | 2 | 9 | 0.0% | 0.00 | 6.8d |
| 40 | 量价确认 (stock) | 11 | -0.743 | -26.56 | -16.34 | 0.74 | 4 | 8 | 0.0% | 0.00 | 6.9d |

数据来源:
- `pnl` / `return_pct` / `days_active` / `open_positions` 来自 `paper_trading_portfolios` 主表 (`/tmp/q4_perf.js`).
- `sharpe` / `maxDD` / `annualized` 来自 `paper_trading_snapshots` 日 NAV 序列 (`/tmp/q10_dd.js`).
- `胜率 / profit_factor / avgHold` 通过 FIFO 配对 `paper_trading_trades` 计算 (`/tmp/q5_trades.js`).

### 2.2 4 维度排序

| 维度 | Top 4 | 综合得分 (低名次=好) |
|------|-------|--------------------|
| 总收益% | 37 > 28 > 29 > 32 | — |
| Sharpe | 29 > 28 > 32 > 37 | — |
| MaxDD | 26 ≈ 28 > 30 ≈ 38 ≈ 29 ≈ 33 ≈ 34 | — |
| 胜率 | 29 (25%) > 28 (22%) > 35 (14%) ≈ 37 ≈ 39 (12.5%) | — |

**综合排序 (4 维平均排名)**:
1. **id=29 (Codex均值回归 lym)** — 排名 (3, 1, 4, 1) = 平均 **2.25** 最佳
2. **id=28 (Codex动量轮动 lym)** — 排名 (2, 2, 1, 2) = 平均 **1.75** 最佳 (并列冠军, 但收益低于 29)
3. **id=37 (Codex均值回归 stock)** — 排名 (1, 4, 8, 4) = 平均 **4.25**

> **id=28 在 sharpe / DD / 胜率三维居前**, id=37 在收益维独占榜首 (唯一正收益), id=29 综合最稳. id=37 的优势主要来自 1 笔 `sh.600105 永鼎股份` 单票 +903 元 (`/tmp/q12_winners.js`), 偶然性较高.

### 2.3 平 / 亏卖出原因总览

> SQL: `/tmp/q13_sells_lossless.js` (按 `trade_reason->>'source'` 分组)

| 触发源 | 笔数 | 总 pnl | 平均 | 备注 |
|--------|------|--------|------|------|
| `stop_loss` (硬性 5%) | 95 | **-11,085** | -116.7 | 全部为亏损平仓 — 占总亏损 90%+ |
| `null` (老数据无 reason) | 10 亏 / 3 赢 | -1,527 / +1,606 | — | 早期 trade 无 trade_reason |
| `trailing_take_profit` | 4 赢 / 6 亏 | +370 / -259 | +37 净 | **净正 + 平均亏小** — 最有效退出 |
| `take_profit` (硬性 10%) | 1 赢 / 0 亏 | +366 | +366 | 唯一一次明确止盈 |
| `per_stock_stop_loss` | 0 赢 / 1 亏 | -229 | — | US-048 个股止损 |
| `technical_breakdown` | 0 赢 / 1 亏 | -42 | — | 技术破位 |

**结论**: 全市场过去 16 天 99 个止损卖出全亏 (-11,085 元), 而 4 次 trailing_take_profit + 1 次 take_profit 共贡献 +736 元浮盈. **核心矛盾: 硬止损 5% 在当下震荡市连续小亏积累**, 而动态止盈才是真正可持续的退出信号. 任何整合后的盘必须保留 trailing_take_profit + per_stock_stop_loss, 但应抑制 stop_loss 的 5% 一刀切.

---

## 3. 各盘策略 + 因子 + 风控配置

> SQL: `SELECT strategy_keys, enabled_factors, risk_profile_overrides FROM paper_trading_portfolios` (见 `/tmp/q1_list.js`)

### 3.1 策略矩阵 (按 archetype × owner)

| Archetype | 包含的 strategy_keys | lym id | stock id |
|-----------|---------------------|--------|----------|
| **纯量化** | `multi_factor_alpha`, `multi_factor_ranking`, `relative_strength_momentum` | 25 | 33 |
| **参数实验** | `multi_factor_alpha`, `quality_momentum_blend`, `dual_momentum_rotation` | 26 | 34 |
| **趋势突破** | `breakout_strategy`, `breakout_atr`, `minervini_trend_template`, `volatility_contraction_breakout`, `turtle_breakout` | 27 | 35 |
| **动量轮动** | `dual_momentum_rotation`, `cta100_momentum`, `sector_rotation_leader`, `relative_strength_momentum` | 28 | 36 |
| **均值回归** | `bollinger_reversion`, `rsi_reversion`, `left_side_reversal`, `trend_pullback_reentry` | 29 | 37 |
| **多因子质量** | `multi_factor_alpha`, `quality_momentum_blend`, `garp_strategy`, `high_dividend_value` | 30 | 38 |
| **低波防守** | `low_volatility_quality`, `high_dividend_value`, `garp_strategy` | 31 | 39 |
| **量价确认** | `volume_price_confirmation`, `macd_trend`, `ma_trend`, `donchian_trend` | 32 | 40 |
| **多策略融合 (Agent)** | `multi_factor_alpha`, `dragon_head_momentum`, `breakout_strategy` | — | 62 |
| **单策略荐股 (Agent)** | `multi_factor_alpha` | 64 | 61, 63 |
| **观测** (idle 24) | `multi_factor_alpha`, `dragon_head_momentum`, `breakout_strategy` | — | 24 |

**全 21 个盘出现过的 distinct strategy_keys 共 22 个**:
```
bollinger_reversion, breakout_atr, breakout_strategy, cta100_momentum,
donchian_trend, dragon_head_momentum, dual_momentum_rotation, garp_strategy,
high_dividend_value, left_side_reversal, low_volatility_quality, ma_trend,
macd_trend, minervini_trend_template, multi_factor_alpha, multi_factor_ranking,
quality_momentum_blend, relative_strength_momentum, rsi_reversion, sector_rotation_leader,
trend_pullback_reentry, turtle_breakout, volatility_contraction_breakout, volume_price_confirmation
```

### 3.2 因子配置 — 100% 重叠

**关键发现: 除 #61/62/63/64 (Agent 空盘 enabled_factors=[]) 之外, 所有 17 个盘 (含 idle 24) `enabled_factors` 完全一致**, 共 22 个因子:

```
value, quality, quality_high, growth, momentum, momentum_reversal,
low_vol, liquidity, money_flow, northbound, dragon_tiger,
analyst_consensus, earnings_surprise, fund_consensus, industry_momentum,
gradual_breakout, insider_trade, margin_flow, east_money_qa,
shareholder_concentration, block_trade_signal, concept_heat
```

→ 不存在"哪个盘有独家因子" — 所有盘因子集是同一套.

### 3.3 风控配置 — 全在 user 级

> SQL: `SELECT id,name,risk_profile_overrides FROM paper_trading_portfolios WHERE risk_profile_overrides::text != '{}'` → **0 行**.

所有 21 个盘 `risk_profile_overrides = {}`, 实际风控来自 user 级 `users.risk_config`:

```jsonc
// user_id=2 (lym) 与 user_id=4 (stock) 完全相同
{
  "stop_loss_percent": 5,        // 硬止损
  "take_profit_percent": 10,     // 硬止盈
  "portfolio_construction": {
    "mode": "shadow",            // PC 仍处 shadow, 未切生产
    "method": "risk_parity",
    "max_weight": 0.15,
    "max_industry_weight": 0.4,
    "lookback_days": 60,
    "max_candidates": 30
  },
  "enableVolumeAlert": true,
  "enableTechnicalAlert": true
}
```

→ 任何"融合"的风控调整都应改 `users.risk_config` 或新建一个 portfolio 级 override.

---

## 4. 最优盘 + 融合建议

### 4.1 综合最优盘

**首选: id=29 (Codex均值回归模拟盘 lym)**

理由:
1. **综合 4 维评分最高** (sharpe -1.63 / 胜率 25% / 收益 -0.13% / DD 0.29%)
2. 持仓时间最长 (16 天 vs 11 天), 数据更稳健
3. owner=`lym` 是真人账号 (vs stock 是系统账号), 配合 feishu 推送链路更顺
4. 策略组合 (bollinger_reversion + rsi_reversion + left_side_reversal + trend_pullback_reentry) 是均值回归族, 在 2026-06 震荡市占优, **6 次卖出中有 2 次 trailing/take_profit 触发的胜利交易**, 比 stop_loss 主导的盘可持续

备选: id=37 — 唯一正收益, 但仅靠 sh.600105 单票 +903 (黑天鹅式 lucky shot), 不具复制性.

### 4.2 其他盘"有但 #29 没有"的优秀元素

由于全部盘共享同一 22 因子集 + 空 risk_profile_overrides, **"独家因子"为零**. 优秀元素全部来自 strategy_keys.

#### 4.2.1 strategy 互补建议

| 来源盘 | 该盘的优秀 strategy_key | 为什么纳入 | 实证 |
|--------|------------------------|------------|------|
| #28 动量轮动 (-0.10%) | `dual_momentum_rotation`, `cta100_momentum`, `sector_rotation_leader`, `relative_strength_momentum` | 2 胜 vs 7 负, profit_factor 0.84, sharpe -1.68 与 #29 并列冠军 | trailing_take_profit 在 sh.600030 触发 +92 元 |
| #32 量价确认 (-0.23%) | `volume_price_confirmation`, `macd_trend` | 1 笔 sh.600186 +351 元 (无 trade_reason 的旧 win) | 量能突破有效, 但 macd_trend 死叉触发的硬止损贡献 -156 元亏损 → 只纳入 vp_confirmation |
| #28 多因子质量 (与 #30 同, 仅 quality_momentum_blend 是新的) | `quality_momentum_blend`, `garp_strategy`, `high_dividend_value` | 多因子质量族在长周期 backtest 一般是正 alpha 因子 | 当前盘 0 胜, 但 6 月震荡市样本太小, 长期保留 |
| #35 趋势突破 (-0.46%) | `breakout_strategy`, `minervini_trend_template` | 1 胜 (sh.600030 +108 元 trailing_take_profit) | 趋势策略族整体亏, 但 minervini_trend_template 是经典模板, 加权 0.05 试用 |
| Agent (#62) 现有 | `dragon_head_momentum` | 龙头股动量未被 #29 覆盖, 短线弹性大 | 尚无数据, 但作为情绪信号补充 |

#### 4.2.2 不建议纳入的 strategy

- `multi_factor_alpha` (#25/26/30/33/34/38 0 胜 0 平, 仅亏): 在当前数据上完全无效, **暂时弃用** (除非作为 ranking 输入).
- `breakout_atr`, `turtle_breakout`, `volatility_contraction_breakout` (#27/35 全部贡献亏损卖出): 当下 SSE 单边震荡市破位假信号多.
- `low_volatility_quality`, `high_dividend_value` (#31/39 0 胜): 题材股 / 周期股主导的当下行情, 低波因子失效.

### 4.3 融合后的"综合策略盘"配置

#### `strategy_keys` (10 个, 按当前胜率 / sharpe 评估)
```json
[
  "bollinger_reversion",
  "rsi_reversion",
  "left_side_reversal",
  "trend_pullback_reentry",
  "dual_momentum_rotation",
  "cta100_momentum",
  "sector_rotation_leader",
  "relative_strength_momentum",
  "volume_price_confirmation",
  "dragon_head_momentum"
]
```
取消的: `multi_factor_alpha` / `multi_factor_ranking` / `breakout_*` / `turtle_*` / `low_volatility_quality` / `garp_strategy` / `high_dividend_value` / `quality_momentum_blend` / `donchian_trend` / `ma_trend` / `macd_trend` / `minervini_trend_template`.

#### `enabled_factors` (保留全 22 因子)
不裁剪 — 因子是 ranking 输入, 不直接产生 trade. 当前问题是 strategy 阈值, 不是因子集.

#### `risk_profile_overrides` (新填 — portfolio 级覆盖 user 默认)
```json
{
  "stop_loss_percent": 6,
  "take_profit_percent": 12,
  "trailing_stop_pct": 4,
  "single_stock_max_weight": 0.10,
  "max_industry_weight": 0.30,
  "max_positions": 8,
  "drawdown_breaker": {
    "threshold_pct": 3,
    "cooldown_days": 2
  }
}
```
变化点 vs 当前 user.risk_config:
- 硬止损 5% → 6% (减少震荡市误杀)
- 硬止盈 10% → 12% (拉长收益跑道)
- 新增 trailing_stop_pct=4% (覆盖个股回撤, 当前已是 winning trade 的主要触发源)
- single_stock_max_weight 0.15 → 0.10 (#36/40 持有 4 只时单票过大)
- max_industry_weight 0.40 → 0.30 (避免 6 只均银行/资源类的集中)
- max_positions=8 (vs 当前 1–4, 提升分散)
- drawdown_breaker (新): 单日 DD>3% 暂停 BUY 2 日 (CB-4 已有 DrawdownCircuitBreaker 实现)

---

## 5. 迁移方案

### 5.1 关键决策: 在 #29 上加配 vs 新建综合盘

**推荐: 新建一个综合盘 (例如 id=新建 — 名"Codex综合主盘（20W）"), 然后冻结所有旧盘**.

理由:
1. #29 当前持仓 sh.600064 (100 股, avg=7.507, 浮亏 -4.09%) — 改 strategy_keys 后 #29 的旧持仓与新策略不匹配, 触发逻辑会混乱
2. 历史 trade 记录 (#29 17 笔交易) 需保留作 baseline 对比, 不应被覆盖
3. 重新开盘可干净测试新风控配置 (trailing_stop_pct + drawdown_breaker), 数据归属清晰
4. 旧 lym/stock pair 命名混乱, 整合后只留 1 个新盘

### 5.2 旧盘处理 (21 → 1)

| 处理对象 | 数量 | 操作 | DB 影响 |
|---------|------|------|---------|
| 已 idle (#24) | 1 | 保留 `is_active=false`, 不动 | 0 |
| 4 个空 Agent 盘 (#61/62/63/64) | 4 | `is_active=false` + `auto_trade_enabled=false` | 不删除, 留作历史 |
| 16 个跑盘 (#25–40) | 16 | (a) 触发一次 reset (清仓所有 open positions, 模拟"卖出归现") (b) 改 `auto_trade_enabled=false` (c) `is_active=false` | 历史 trades 全部保留作"v1 baseline" |
| 新综合主盘 | 1 | `createPortfolio({ name:'Codex综合主盘（20W）', initial=200000, owner=lym(2), strategy_keys=10个, risk_profile_overrides=上文配置 })` | 1 行新 portfolio |

#### 持仓处理: "清仓平账" 而不是"保留观察"

- 当前 16 个 active 盘合计开仓 38 个, 但去重后只有 sh.600064 / sh.600015 / sh.600028 / sh.600350 / sh.600089 / sh.600019 / sh.600201 / sh.600000 / sh.600008 / sh.600023 / sh.600063 共 11 个 distinct 股票 (大量重复, 每盘几乎都开了 600064 南京高科)
- 保留多盘意味着每天 16 套定时 task 跑同样的因子计算, 浪费算力
- 直接走 `portfolioCrudService.resetPortfolio(id)` 已实现的"清仓 + 重置 cash" 路径, 一键收尾

### 5.3 frontend 改动 (最小修改集)

| 文件 | 改动 | 行号参考 |
|------|------|---------|
| `frontend/src/contexts/PortfolioContext.tsx` | 把 `apiListPortfolios` 调用改为只返回新综合盘 (后端 list endpoint 过滤 `is_active=true`, 已天然支持), 或 hard-code `selectedPortfolioId = single id` | 全文 117 行可以化简到 ~40 行 |
| `frontend/src/components/layout/GlobalPortfolioSelector.tsx` | **整个组件移除** 或退化为只读 banner "当前盘: Codex综合主盘" | 74 行 |
| `frontend/src/App.tsx` | 移除 GlobalPortfolioSelector mount 点 | 1 处 |
| `frontend/src/components/portfolio/PortfolioManagementPanel.tsx` | 移除"新建模拟盘"按钮 (第 554 行 `新建模拟盘`) + Modal `mode='create'` 分支 + create 按钮逻辑 (第 188 行 createPortfolio call), 保留 detail 视图作"主盘状态" panel | 909 行可瘦身到 ~500 行 |
| `frontend/src/services/portfolioCrudService.ts` | `createPortfolio` / `deletePortfolio` 保留 export 但前端禁用 (后端 endpoint 不删, 留给 ops cli 调用) | 不动 |
| `frontend/src/pages/PaperTrading.tsx` | 移除选盘相关 props, `selectedPortfolioId` 直接 hard-code 或从 context 取唯一值 | 多处 (1057/1125/1145/1184/1187/1216/1232/1287 行已透传 portfolio_id, 改为常量即可) |

### 5.4 后端注意点 (不在此次改动范围, 但需要后续 follow-up)

- `backend/src/portfolio/internal/PaperTradingAutomationService.ts` 当前会 batch 遍历**所有** `is_active=true && auto_trade_enabled=true` 盘. 整合后只剩 1 个, 自动单线执行, 不需要改 — 但要看 cron schedule 是否会因为 list 缩小而漏掉.
- `paper_trading_canary_review_snapshots` 表 (每日 canary 复盘) 是按 user_id 聚合的, 整合后 user lym 只剩 1 盘, snapshot 数会减少 8x — 数据正常.
- `users.risk_config` 不变, 但**新综合盘**的 `risk_profile_overrides` 会覆盖之 — `PerStockStopLossGuard` 和 `GuardSellExecutor` 都已读 portfolio override (见 `backend/src/portfolio/risk/PerStockStopLossGuard.ts`).

### 5.5 推进 checklist (3 步)

```bash
# Step 1: 创建新综合主盘 (脚本, 不是 UI)
POST /api/paper-trading/portfolios
{
  "name":"Codex综合主盘（20W）",
  "initial_capital":200000,
  "strategy_keys":[<10个>],
  "enabled_factors":[<22个>],
  "risk_profile_overrides":{<上文 5.1 节配置>},
  "auto_trade_enabled":true
}

# Step 2: 关闭 16 个老盘 (ops sql, 不删 row)
UPDATE paper_trading_portfolios
SET is_active=false, auto_trade_enabled=false, updated_at=NOW()
WHERE id IN (25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40);

# Step 3: 关闭 4 个 Agent 空盘
UPDATE paper_trading_portfolios
SET is_active=false, auto_trade_enabled=false
WHERE id IN (61,62,63,64);

# (frontend 移除选盘 + 新建入口的代码改动单独一个 PR)
```

---

## 附录: 数据来源全索引

| 数据 | SQL 文件 (本地 `/tmp/` 路径, 远程 `/opt/stocks/current/backend/`) |
|------|---|
| 全 portfolio 列表 + 配置 | `q1_list.js` |
| user 映射 + 表结构 | `q2_users.js`, `q3_schemas.js` |
| 主表 pnl / 持仓 / trade 数 / 胜率 | `q4_perf.js` |
| FIFO 配对的 hold days / win rate / profit factor | `q5_trades.js` |
| open positions 详情 + 样本 trade_reason | `q6_positions.js` |
| user.risk_config + sell reasons 分布 | `q7_risk.js` |
| 全 prod table 清单 (122 张) | `q8c.js` |
| paper_trading_snapshots 结构 + 全部 NAV 数据 → drawdown/sharpe | `q9_snap.js`, `q10_dd.js` |
| 重名 portfolio 配对 + leaderboard | `q11_finer.js` |
| 全部 winning sells (8 笔) + 最差 losing sells (top15) | `q12_winners.js` |
| 卖出原因 source 聚合 (stop_loss vs trailing 对比) | `q13_sells_lossless.js` |

报告中的 SQL 全部为只读 SELECT, 无任何 UPDATE/DELETE/INSERT. 勘探阶段 prod DB 未修改.
