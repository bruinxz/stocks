# 52 — 止损 / 止盈 / 追踪止损（Per-Stock & Trailing）

> 单股止损 = 每笔交易的"最大可承受亏损"硬线；追踪止损 = "锁定利润不让它跑掉"。两者复合：刚开仓靠 -7% 硬止损，转盈后切换到追踪。

---

## A. 操盘手心智

我对单股止损的信念：**只跌 7% 必须走**。理由：
- 7% 是 A 股一周到一个月的"正常波动 + 一两个跌停"上限；
- 跌 10% 想回本需要涨 11.1%；跌 20% 需要 25%；跌 50% 需要 100%——非线性恶化；
- 心理上"被深套之后再说"的人最后都套成"信仰持仓"。

追踪止损不一样——**锁利润 + 不被洗下车**：
- 个股从 +30% 回撤 8% 反而是该走的信号（涨势已破）；
- 但不能用 -7% 死硬线追踪，应该用 ATR 动态调（高波动股 ATR 大 → 距离也大，不被洗）；
- 追踪线只往上不往下：今日 high 比昨日 high 高 → trailing 上调；today 低 → 不动。

---

## B. 系统设计

### B.1 两个 guard 互补不重叠

| | PerStockStopLossGuard | TrailingStopGuard |
|---|---|---|
| **触发** | (current_price - avg_cost) / avg_cost ≤ -7% | (current_price - highest_price) / highest_price ≤ -10% |
| **基准** | 入场成本 avg_cost | 持仓期间最高价 highest_price |
| **场景** | 新开仓 / 仍在亏 | 已转盈 / 锁利润 |
| **阈值** | 7% (DEFAULT) | 10% (DEFAULT) |
| **复合** | 两者都跑；先触发者执行 | (上同) |
| **执行** | EOD evaluator → triggers + RiskAlert HIGH → GuardSellExecutor 真卖 |  |

### B.2 三级覆盖

```
effective_pct = position.trailing_stop_pct        (策略层覆盖)
             ?? user.risk_config.<guard>.pct       (用户全局)
             ?? DEFAULT_<GUARD>_CONFIG.pct         (兜底 7%/10%)
```

复用 `pickEffectivePct` helper（PerStockStopLossGuard.ts + TrailingStopGuard.ts 同款）。

### B.3 ATR 动态化（改造方向）

`effective_pct` 改用 ATR-implied：

```
atr_pct = atr_14 / current_price    // ATR 折算 %
effective_pct = max(7%, 1.5 × atr_pct)
```

- 低波动股（atr 1.5% × 1.5 = 2.25%）→ 用 7% 硬下限
- 高波动股（atr 6% × 1.5 = 9%）→ 用 9%（避免被洗）

### B.4 追踪止损的 "highest_price 初始化"

```ts
// 开仓首日不能直接用 today_close 作 high（若 close < avg_cost 直接触发误平）
computeNewHighestPrice(prior, today_close, avg_cost) =
    max(prior ?? avg_cost, today_close)
```

来源：`TrailingStopGuard.ts:189` `computeTrailingStopPrice`。

### B.5 mass alert

PerStockStopLossGuard 额外检测"50% 仓位同时止损"（市场系统性下跌）：

```
if triggered_count ≥ ceil(open_count × mass_threshold_ratio):
    写 SYSTEM:PER_STOCK_STOP_LOSS_MASS sentinel RiskAlert
```

用户能从 RiskAlert bell 立即感知"不是某只票出问题，是系统性踩踏"。

---

## C. 现状 review

### C.1 两个 guard 都已实现

- **PerStockStopLossGuard** (`backend/src/portfolio/risk/PerStockStopLossGuard.ts` 746 行)：
  - DEFAULT `pct: 0.07`（line 103-105）
  - `evaluateAfterClose(user_id?, asOfDate?, dry_run?)` (post-close cron)
  - mass threshold `ceil(N × 0.5)`，sentinel `SYSTEM:PER_STOCK_STOP_LOSS_MASS`
- **TrailingStopGuard** (`backend/src/portfolio/risk/TrailingStopGuard.ts` 677 行)：
  - DEFAULT `pct: 0.10`（line 78-80）
  - 两阶段：`updatePositionsAfterClose`（更新 highest_price + trailing_stop_price）+ `evaluateNextDayTriggers`

### C.2 ⚠️ ATR 动态止损未实现

- 当前 `effective_pct` 三级覆盖只在 (策略/用户/默认) 之间选，**不含 ATR 计算**。
- 操盘手设计的"高波动股加大止损距离"未生效。
- 改造点：guard 内 `computeEffectivePctATR(position, atr14)` 替换 `pickEffectivePct`。

### C.3 执行链路已闭环 (Batch J)

- `backend/src/portfolio/risk/GuardSellExecutor.ts:1-158` —— 把 5 个 EOD guard 的 trigger（trailing_stop / per_stock_stop_loss / drawdown_level_2/3 / per_stock_mass）转 SELL 单走 `facade.placeOrder`。
- bypass_t_plus_1=true + bypass_trading_hours=true 是必要的（EOD 评估时是收盘外）。
- per-position try/catch 失败隔离。

### C.4 与 PaperTradingFacade BUY 后 stop_loss_price 重算

- `PaperTradingFacade.ts:889-905` —— 加仓后用 user.risk_config.per_stock_stop_loss.pct 重算 `stop_loss_price`，三级覆盖与 guard 同源。
- trailing 的 high_price 不动（历史最高不该回拉）。

### C.5 缺 "buy_in_panic" 保护

- 黑天鹅日所有股都跌 5%，PerStockStopLossGuard 几乎全员触发 → mass alert + 全平仓。
- 但这可能是"非理性踩踏后第二天反弹" → 缺一个"市场系统性跌时止损延迟 1 天"的逻辑。

---

## D. 改造方案

### D.1 user story

| ID | 故事 | 验收 |
|---|---|---|
| US-SL-1 | **ATR 动态止损**：PerStockStopLossGuard + TrailingStopGuard 内 `computeEffectivePctATR(position, atr14, base_pct)`；`effective = max(base_pct, 1.5 × atr_pct)`；策略可显式 override 关闭 ATR | 单测：ATR=6% → effective=9% > base 7%；ATR=1% → effective=7%（base 兜底） |
| US-SL-2 | **mass alert 触发的二次确认**：mass 触发时不直接全平，先写 RiskAlert HIGH 并 24h 内"挂起"自动 SELL，让 ops 人工确认；超过 24h 仍未取消 → 执行 | 单测：mass 触发 → SELL 不立即执行，alert UI 出现 confirm 按钮 |
| US-SL-3 | **加仓后追踪线只前进**：BUY 加仓让 avg_cost 上升时，PerStockStopLossGuard 重算 stop_loss_price；TrailingStopGuard 不重置 highest_price（避免错失之前高点） | 测：BUY → 涨 → 高位再加仓 → trailing 仍以前高为基准 |
| US-SL-4 | **stop_loss_pct 独立 column**：当前 per-position `trailing_stop_pct` 字段被两个 guard 共用；加 `stop_loss_pct` 独立 column，迁移 + 三级覆盖独立 | 迁移脚本通过，两 guard 独立读 column |
| US-SL-5 | **追踪止损按段加宽**：盈利 < 10% → trailing 8%；盈利 10-30% → trailing 12%；> 30% → trailing 15%（盈利越多越宽，锁更多利润而不被洗下车） | 单测三段过 |
| US-SL-6 | **per-symbol 黑名单跳过止损**：某些用户主动选择"信仰持仓"（如长期持有茅台）→ 加 position-level `disable_stop_loss=true` flag | UI 持仓行能勾，guard 跳过 |

### D.2 操盘手补充建议

- **回测前 6 个月**：禁用所有止损 + 跑出 baseline；
- **回测开止损**：开 -7% 看 sharpe / drawdown 变化；
- **生产 shadow**：连跑 30 天比对两条曲线；
- 通常 sharpe 略降（少抓反弹）、drawdown 大降（避免深套）；
- 业务上接受"少赚 10% 换 drawdown 减半"。

---

## E. 验收口径

- 单测覆盖三级覆盖 + ATR 动态 + mass alert 二次确认
- GuardSellExecutor 真执行 SELL，trigger → trade 闭环 100%
- 加仓后 highest_price 不回退（关键边界）
- 跑 60 天 paper：单股最大亏损 ≤ -10%（含 atr 弹性），组合最大 drawdown ≤ -12%
- 文件位置：`backend/src/portfolio/risk/PerStockStopLossGuard.ts` + `TrailingStopGuard.ts` + `GuardSellExecutor.ts`
