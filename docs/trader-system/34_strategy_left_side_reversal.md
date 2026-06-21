# 34 — LeftSideReversal 左侧反转策略

## A. 操盘手心智

"近 20 日跌 30% + 当日反弹 5% + 主力净流入 + RSI 上穿 25 + 流通市值 > 50 亿" 是 5 维超跌反弹信号。背后逻辑：
- **20 日跌 30%** = 恐慌性抛售，超卖
- **当日反弹 5%** = 卖盘衰竭，多头试探
- **主力净流入 > 0** = 机构在底部接货
- **RSI 上穿 25** = 技术上脱离超卖区（双边严格：昨天 < 25 + 今天 ≥ 25）
- **市值 > 50 亿** = 避开退市 / 流动性陷阱小盘股

左侧反转最大的风险是"接刀"——跌到 -30% 不代表底，可能还有 -50%。所以必须 5 维 AND 同时满足（不是 OR），并配合：
- **-7% 严苛止损**（反转策略给紧止损，不像趋势策略给 -15%）
- **5 日内涨 > 15% sell_half 落袋**（防中继反弹后再次下跌）
- **15 自然日强制平仓**（不指望反转变趋势）

避免"左侧 + 右侧" 完全分离的方法：要求 RSI 上穿（不是 < 25 立马进）= 已经"右侧化"了——左侧识别底，右侧确认止跌。

---

## B. 系统设计

### B.1 策略定义

证据: `backend/src/quant/strategies/LeftSideReversalStrategy.ts:425-450`：
- strategy_key: `left_side_reversal`
- style: `mean_reversion` → 基准中证 500
- 触发: 每日
- maxPositions: 10
- 持有 ≤ 15 自然日
- structured LeftSideReversalPosition with entry_date / entry_price / half_exited

### B.2 入场 5 维 AND

证据: `LeftSideReversalStrategy.ts:28-39`：
1. 近 20 日跌幅 ≥ 30% (close[T] / close[T-20] - 1 ≤ -0.30)
2. 当日反弹 > 5% (close[T] / close[T-1] - 1 > 0.05)
3. 当日 StockMoneyFlowFactor.main_net_inflow > 0
4. RSI(14) 从 < 25 上穿 ≥ 25（双边严格）
5. 流通市值 > 50 亿
+ 非 ST

### B.3 出场优先级 A→C

证据: `LeftSideReversalStrategy.ts:40-45`：
- A. 持有 ≥ 15 自然日 → SELL
- B. (close - entry_price) / entry_price ≤ -7% → SELL
- C. (max(close[entry+1..T]) - entry_price) / entry_price > 15% AND !half_exited → sell_half + half_exited=true
- D. 默认 HOLD

### B.4 排序

`drop_pct ASC（跌得最惨在前）→ rebound_pct DESC → stock_code ASC`：反转策略相信"跌得越深反弹空间越大"，与 Breakout 的"放量最猛在前"完全相反。

### B.5 DataSource 4 个 loader

- `loadCandidateBars(date, minBarCount)` — 全市场扫描（minBarCount = max(21, 16)）
- `loadPositionBars(date, codes, minBarCount)` — 持仓子集
- `loadMoneyFlowToday(date)` — 当日全市场 main_net_inflow Map
- `loadStockMeta(codes)` — name / industry / 流通市值

**minBarCount 关键计算**: RSI 上穿要算 yesterday + today 两个 RSI，每个 RSI 至少 rsiPeriod+1 个 close，加起来要 rsiPeriod+2；同时要算 20 日跌幅，需 dropLookbackDays+1。两者取 max。

### B.6 11 个 filtered 计数器

`candidate_pool_size / fail_drop_insufficient / fail_rebound_insufficient / fail_rsi_not_crossing_up / fail_money_flow_negative / fail_market_cap_insufficient / fail_meta_missing / fail_st / fail_already_held / fail_insufficient_history / fail_stale_bar` — 5 维入场最多的诊断粒度。

---

## C. 现状 review

### C.1 已实现部分

证据: `LeftSideReversalStrategy.ts` 1001 行：
- 5 维入场 + 4 阶出场完整实现
- RSI 上穿双边严格 (`yesterdayRsi < threshold AND todayRsi >= threshold`)
- sell_half + half_exited flag 防重复减半（与 DragonHead 同款）
- 排序方向 drop ASC (mean-reversion thesis)
- 11 个 filtered 计数器
- DataSource 4 loader 分离 (candidate vs position)
- minBarCount 由策略层精确计算 = max(dropLookbackDays+1, rsiPeriod+2)
- 边界条件多种 strict 语义并存（见 CLAUDE.md L788-810）

### C.2 ⚠️ 缺"左侧 + 右侧融合"避免接刀

当前 5 维入场已经在筛"已有反弹信号"的票（反弹 > 5% + RSI 上穿）。但仍可能接到"二次下跌前的中继反弹"。

更稳健的"左侧 + 右侧"融合：
- 左侧识别：跌幅 + 主力净流入 + RSI 超卖（已有）
- 右侧确认：等"反弹 5% 后第 2 天 close > 第 1 天 close" 才入场（不在反弹当日入场）
- 这样过滤掉"反弹 5% 后第 2 天又破位"的中继反弹

### C.3 ⚠️ 主力净流入单日噪音大

`main_net_inflow > 0` 是单日值；反转日常出现"主力出货掩护拉升"。应该看近 3 日累计 main_net_inflow > 0 + 当日 > 0 double 确认。

### C.4 ⚠️ 流通市值阈值偏死

`minCirculatingMarketCap = 50 亿` 是硬阈值。但 bear regime 整体跌 50% 后，本来 80 亿的票可能跌到 40 亿被剔除。应该用相对值（如：流通市值 > 全市场 median × 0.5）。

### C.5 ⚠️ 持有期 15 天过短

反转走得好的票（如底部确认后启动主升）通常需要 30-60 天。当前 15 天到期强卖，错失 50%+ 涨幅。

可考虑：如果到 15 天浮盈 > 10%，自动延期到 30 天 + trailing stop。

### C.6 sell_half 计算精度

C 类基于 `max(close[entry+1..T])`，但 close 是日级数据。如果 close 没有触发，但 high 触发了 15% 涨幅，会错过 sell_half。

更精确：用 `max(high[entry+1..T])` 而不是 close。

---

## D. 改造方案

### D.1 P0：右侧二次确认

**user story**：
- 新增 param `requireRightSideConfirm: boolean`（默认 false 兼容，启用后增加 1 维入场）
- 启用时入场延迟 1 天：候选先记录"已满足左侧 5 维"，等次日 close > 前日 close 才真入场
- 验收: 启用后胜率提升 ≥ 5pp，但 alpha 整体下降 ≤ 10%（牺牲一些初始涨幅换稳定性）

### D.2 P0：主力净流入 3 日累计确认

**user story**：
- 第 3 维改为：近 3 日累计 main_net_inflow > 0 AND 当日 > 0
- DataSource 加 loadMoneyFlow3DaysCumulative
- 验收: 排除"主力出货掩护拉升"假信号

### D.3 P1：流通市值相对阈值

**user story**：
- param 改为 `minCirculatingMarketCapPercentile: number`（默认 0.5 = 全市场中位数）
- DataSource 加 loadMarketCapPercentiles 一次返回 universe-wide 分位数
- 验收: bear 整体跌 30% 时仍能正常筛出标的，不会因为绝对值下滑导致候选骤减

### D.4 P1：动态持有期 + trailing stop

**user story**：
- 到 15 天时若浮盈 > 10%，延长至 30 天 + 启用 trailing stop（peak - 2 × ATR_10）
- 到 30 天若浮盈 > 25% 再延长至 60 天 + trailing stop 收紧到 1.5 × ATR
- 验收: 反转走通的票（涨 ≥ 30%）平均收益从 +20% 提升到 +30%

### D.5 P1：sell_half 改 high 不用 close

**user story**：
- C 类改用 `max(high[entry+1..T])` 触发 sell_half
- 验收: sell_half 触发次数提升（捕捉到盘中冲高）

### D.6 P2：分级仓位（按跌幅）

- 跌幅 30-40% → 标准仓
- 跌幅 40-50% → 1.2 倍仓（深跌弹性大）
- 跌幅 > 50% → 0.7 倍仓（可能黑天鹅，谨慎）

---

## E. 验收口径

1. **稳定性**: 同 (date, currentPositions) 重跑结果一致
2. **风控**: -7% 止损硬触发，单股最大亏损 ≤ -7%（除非次日开盘 gap down）
3. **胜率**: backtest 2023-2025 trade 数 > 100，胜率 ≥ 55%
4. **alpha 显著**: 平均 return / trade ≥ +5%
5. **诊断**: 11 个 filtered 计数器全部 ≥ 0，eligible=0 时能准确判断"是哪 1-2 维过滤太严"
6. **风格独立**: 与 Breakout 同期 backtest 收益相关性 ≤ 0.3（趋势 vs 反转互补）
