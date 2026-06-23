# BE-T2: 回测↔实盘 alpha 对齐 audit (2026-06-23)

**审计日**: 2026-06-23
**Prod**: `103.242.3.87:14126`, `stocks-postgres` (timescaledb pg14)
**审计范围**: 13 个 strategy_key 在 prod 的实际 signal vs backtest 表现

## 总评

**3 个重大发现** (按严重程度排序):

1. **CRITICAL — 13 个 composite-level strategies 全部 0 live signal**:
   audit S-1 ALPHA agent 修了 QuantBacktestEngine 的 composite 路径 (smoke test
   `tests/quant/composite_backtest_smoke.test.ts` 跑通), 但**生产 caller 没接入**:
   `quant_signals` 表里 `multi_factor_alpha` / `dragon_head_momentum` /
   `breakout_strategy` / `ensemble_strategy` / `cta100_momentum` /
   `sector_rotation_leader` / `northbound_follow` / `linkage_strategy` /
   `game_trader_relay` / `left_side_reversal` / `high_dividend_value` /
   `garp_strategy` / `earnings_surprise` 全部 0 行. **修但没生效**.

2. **HIGH — low_volatility_quality live vs backtest 28× 偏差 + sharpe=-2.12**:
   1 年回测窗口 `low_volatility_quality` 跑 32 单 (win=25%, sharpe=-2.12),
   但 prod 同窗口生成 901 个 BUY signal. 策略在回测里**确认亏钱**, 但生产
   还在批量推. 建议立即下架或加 sharpe 阈值过滤.

3. **MEDIUM — multi_factor_ranking live/backtest 3× 差**:
   live 48 buy vs backtest 16 trade. backtest sharpe=-0.40 也偏负但样本小.
   差异可能来自 backtest 仓位 / 现金限制. 可以接受但需 monitor.

## 详细 SQL 数据

### 1. Prod 实际生成 signal 的 strategy_key (近 60 天)

```
       strategy_key            |  n   |  earliest  |   latest
-------------------------------+------+------------+------------
 low_volatility_quality        | 1907 | 2026-04-20 | 2026-06-23
 ma_trend                      | 1854 | 2026-05-19 | 2026-06-23
 volume_price_confirmation     | 1582 | 2026-04-20 | 2026-06-23
 relative_strength_momentum    | 1010 | 2026-04-20 | 2026-06-23
 macd_trend                    |  823 | 2026-05-19 | 2026-06-16
 multi_factor_ranking          |  576 | 2026-04-20 | 2026-06-23
 rsi_reversion                 |  328 | 2026-05-19 | 2026-06-16
 breakout_atr                  |  129 | 2026-05-19 | 2026-06-16
 bollinger_reversion           |  123 | 2026-05-19 | 2026-06-16
 trend_pullback_reentry        |  102 | 2026-06-03 | 2026-06-16
 donchian_trend                |   22 | 2026-06-03 | 2026-06-16
 turtle_breakout               |   21 | 2026-06-03 | 2026-06-12
 volatility_contraction_breakout |  17 | 2026-06-03 | 2026-06-16
```

**13 个 strategy_key 全部是 per-stock `evaluate()` 路径**. AC mentioned strategies
(`multi_factor_alpha` / `dragon_head_momentum` / `breakout_strategy`) **不在
prod**.

### 2. 三策略 backtest vs live signal 对齐表 (1 年窗口)

| strategy_key | live BUY (1 yr) | backtest trade | live/backtest 比 | backtest win_rate | backtest sharpe |
|---|---|---|---|---|---|
| `breakout_atr` (task 42, 2025-06-10..2026-06-10) | 99 | 97 | **1.02× ✓** | 33.0% | +0.82 |
| `multi_factor_ranking` (task 41) | 48 | 16 | 3× | 37.5% | -0.40 |
| `low_volatility_quality` (task 37) | 901 (217 stocks) | 32 | **28× ❌** | 25.0% | -2.12 |

**判定**:
- `breakout_atr`: PASS — 回测可重现实盘
- `multi_factor_ranking`: WARN — 3× 偏差, 可接受 (差异来自仓位 / 现金限制)
- `low_volatility_quality`: FAIL — 28× 偏差 + backtest 亏钱

### 3. composite strategies 在 prod 真无 signal 验证

```sql
SELECT strategy_key, COUNT(*) FROM quant_signals
WHERE strategy_key IN ('multi_factor_alpha', 'dragon_head_momentum',
  'breakout_strategy', 'ensemble_strategy', 'cta100_momentum',
  'sector_rotation_leader', 'northbound_follow', 'linkage_strategy',
  'game_trader_relay', 'left_side_reversal', 'high_dividend_value',
  'garp_strategy', 'earnings_surprise')
GROUP BY strategy_key;
```

**结果**: 0 行. 13 个 composite strategies 全 0 live signal.

## 真因

### 真因 1: composite strategy caller 未接入

`backend/src/quant/CLAUDE.md` 顶部明确说:

> **注册的组合级策略 (US-016 实测 13 个)**: multi_factor_alpha /
> dragon_head_momentum / breakout_strategy / earnings_surprise / garp_strategy /
> game_trader_relay / high_dividend_value / left_side_reversal /
> linkage_strategy / northbound_follow / cta100_momentum /
> sector_rotation_leader / ensemble_strategy.

ALPHA 修了 `QuantBacktestEngine` 组合级路径 (composite_backtest_smoke test 跑过),
但是 **prod 的 signal 生成路径** (`QuantSignalService.generateSignals()` /
`QUANT_DAILY_PIPELINE` cron) **没调** 这 13 个 strategies 的 `generateSignals()`,
只调了它们的 `evaluate()` 方法. evaluate() 路径在 composite strategies 上退化
为 'hold', 所以 0 signal.

排查: `grep -rn "strategy.generateSignals\(" backend/src/quant/engine/internal/QuantSignalService.ts` —
不存在调用, 所以 prod cron 不会生成 composite signal.

### 真因 2: low_volatility_quality 28× 偏差

backtest task 37 跑 32 单 / win 25% / sharpe -2.12 ← 真实表现差.
prod 同窗口生成 901 buy signal ← 因为 strategy.evaluate() 对每只票每天都
判 buy/hold, **没有 backtest 引擎的 position / cash / concentration 约束**.
backtest 引擎拦了大量, prod signal 生成层不拦.

**前置 gate (PreTradeGuards) 在 PaperTradingFacade 拦了**, 但 quant_signals 表
是 **signal 生成层**, raw signal 直接落表. UI 看到 901 signal 会觉得"策略好火",
实际上 95% 是被 facade gates 拒掉的 noise.

## 修复建议

### Quick fix (本次不做, 留 followup):

1. **composite strategies 接入 prod signal 生成路径**:
   `QuantSignalService.generateSignals(date)` 需检测 strategy 是否实现
   `generateSignals(date)` (composite 路径), 如是, 调 composite 路径并填
   `quant_signals` 表. 当前只走 `evaluate()`.

2. **low_volatility_quality 加 sharpe 门槛**:
   在 strategy 自身 / 在 fusion / 在 PaperTradingFacade 接入"策略最近 backtest sharpe
   < 0.3 → 自动 paused" 的门槛 (类似 STRATEGY_KILL_SWITCH_CHECK 但基于回测表现).

3. **signal 生成层加 dedup / rate limit**:
   `low_volatility_quality` 一年 1907 signal 等于平均每天 8 个, 显著超过策略实际
   持仓上限. 建议 quant_signals 表落库前先按 strategy + concentration 过滤.

### 长期 (PRD 故事):

- US-NEW-1: composite strategies → prod 接入 (call generateSignals in QUANT_DAILY_PIPELINE)
- US-NEW-2: strategy auto-kill based on rolling backtest sharpe < 0.3 / win_rate < 30%
- US-NEW-3: signal-to-trade conversion rate dashboard (UI 看 signal volume vs facade pass rate)

## 后续 owner

- ALPHA agent: 接 composite strategy 到 prod signal pipeline (US-NEW-1)
- RISK agent: strategy backtest auto-kill 阈值 (US-NEW-2)
- BETA agent: signal-to-trade conversion 可视化 (US-NEW-3)
