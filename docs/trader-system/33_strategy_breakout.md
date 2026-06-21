# 33 — Breakout 60 日新高突破策略

## A. 操盘手心智

"突破 60 日新高 + 量能放大" 是经典的趋势跟踪入场信号 — Turtle Trading 的核心、Minervini Trend Template 的简化版。背后逻辑：
- **创新高 = 阻力位被突破**：上方无套牢盘，价格"上方真空"容易加速
- **量能放大确认**：缩量新高 = 散户无人参与 = 假突破；放量新高 = 资金真共识
- **行业资金面同步**：行业 main_inflow 正 = 板块整体被买，不是单一股孤军

但突破策略最常踩 3 个坑：
1. **假突破** — 创新高 1 天后立刻跌回，套在最高点；通常发生在缩量突破或者震荡市
2. **回踩不验证就追** — 突破后回踩 5 日均线 / 突破点必须有量能止跌确认
3. **趋势破位不止损** — 跌破 20 日均线已经是趋势终结，但因为浮盈中而不舍卖

老练的趋势交易者：
- 突破要 turnover ≥ 5 日均 × 1.5（量价配合）
- 行业 main_inflow > 0（板块共振）
- 跌破 20 日均线 → 卖（不论盈亏）
- -15% 止损（趋势策略给宽容差）
- 持有 60 自然日到期换仓（不无限期持）

---

## B. 系统设计

### B.1 策略定义

证据: `backend/src/quant/strategies/BreakoutStrategy.ts:380-410`：
- strategy_key: `breakout`
- style: `momentum` → 基准沪深 300
- 触发: 每日
- maxPositions: 10
- 持有 ≤ 60 自然日
- structured Position with entry_date / entry_price / entry_industry / entry_60d_high

### B.2 入场 4 维 AND

证据: `BreakoutStrategy.ts:23-29`：
1. 当日 close > max(close[-60..-1])（严格 >，不含今日，不含 boundary）
2. 当日 turnover > avg(turnover[-5..-1]) × 1.5（成交额放大）
3. 所属行业当日 IndustryFlow.main_inflow > 0
4. 非 ST / *ST

### B.3 出场优先级 A→C

证据: `BreakoutStrategy.ts:31-37`：
- A. 持有 ≥ 60 自然日 → SELL
- B. (close - entry_price) / entry_price ≤ -15% → SELL（趋势策略给宽止损）
- C. close < MA20（跌破 20 日均线）→ SELL（技术信号 exit）
- D. 默认 HOLD

### B.4 边界条件设计

- 突破 / 新高用 严格 >（语义"明确穿越"，消除 boundary 噪音）
- 止损用 ≤（"达到即触发"）
- 跌破均线用 严格 <（"轻擦不算破"）

### B.5 排序

`volume_ratio DESC → industry_inflow DESC → stock_code ASC` 三级稳定排序：先看放量幅度（趋势力度），再看行业资金支持，最后字典序 tie-break。

### B.6 DataSource 4 个 loader

- `loadCandidateBars(date, minBarCount)` — 全市场扫描
- `loadPositionBars(date, codes, minBarCount)` — 持仓子集（可能含已停牌）
- `loadIndustryNetInflow(date)` — 当日全行业 main_inflow Map
- `loadStockMeta(codes)` — name / industry

**关键**: candidate 和 position 必须分两个 loader — position 可能含已退市/停牌股，不能用 universe 过滤。

---

## C. 现状 review

### C.1 已实现部分

证据: `BreakoutStrategy.ts` 904 行：
- 4 维入场 + 3 阶出场完整实现
- bars < ma20Period 时 C 类技术信号安全 HOLD（数据不足 ≠ 破位）`L:481-487` 范式
- 11 个 filtered 计数器（candidate_pool / already_held / insufficient_history / stale_bar / no_new_high / volume_insufficient / industry_flow_negative / meta_missing / st）让 eligible=0 时可精准诊断
- DataSource 4 loader 分离 (candidate vs position 不合并)
- 边界条件严格语义统一（突破>、止损≤、跌破<）

### C.2 ⚠️ 缺假突破识别

当前任何"close > 60 日新高 + 量比 ≥ 1.5"都入场。但假突破特征通常是：
- 量比 1.5 但当日上影线长（高开冲高回落）
- 量比 < 2 + 当日涨幅 < 3%（"擦边新高"通常缺资金共识）
- 突破日是周一 / 月初（避险情绪反弹的伪突破）

### C.3 ⚠️ 缺回踩验证

当前突破当日立即买入。更稳健的做法：突破后等 1-3 天回踩 5 日均线 / 突破点 + 量能止跌再买。能避免 60% 假突破，但牺牲 20% 真突破的初始涨幅。

### C.4 ⚠️ 缺跟踪止损 trailing stop

当前止损是基于 entry_price 的固定 -15% 线。趋势走得好时（如已涨 30%），仍然按 entry_price ×0.85 计算止损 = 完全没保护浮盈。

应该引入 ATR-based trailing stop：止损价 = max(entry_price × 0.85, peak_close - 3 × ATR_20)。

### C.5 ⚠️ MA20 单一信号易被噪音击穿

A 股震荡市经常一根长上影 + 一根中阴跌破 MA20 又快速收回。当前 C 类 close < MA20 即触发 SELL，可能"擦破即卖"错失真趋势。

更稳健：连续 2 天 close < MA20 才触发 / close < MA20 × 0.97（3% 缓冲）。

### C.6 行业 trim 容错处理

`BreakoutStrategy.ts` DataSource 在 loadStockMeta + loadIndustryNetInflow 都做 `.trim()`，因为 Stock.industry 与 IndustryFlow.industry_name 的 sync 来源不同，可能有不一致空格。

---

## D. 改造方案

### D.1 P0：假突破识别

**user story**：
- 入场加第 5 维: 当日涨幅 > 3% AND (close - low) / (high - low) > 0.7（确保收阳实体强）
- 周一 / 周五优先级降低（短线小心震荡）
- 验收: 假突破率（次日 close < entry_price × 0.97）应降低 ≥ 20%

### D.2 P1：回踩验证

**user story**：
- 新增 param `requirePullbackConfirm: boolean`（默认 false 兼容）
- 当 true 时，入场不在突破当日，而是等突破后 1-3 天回踩到 5 日均线附近 + 量能缩到正常水平
- DataSource 加 `loadBreakoutCandidatesHistory` 跟踪过去 5 日是否有未入场突破
- 验收: 启用 requirePullbackConfirm 后 backtest 胜率提升 ≥ 5pp，alpha 不显著下降

### D.3 P1：ATR-based trailing stop

**user story**：
- Position 加 `peak_close` 字段
- 每日更新 peak_close = max(peak_close, close[T])
- 加 D 类出场: close ≤ peak_close - trailingStopAtrMultiplier(3) × ATR_20 → SELL
- 验收: 趋势走得好的票（涨 ≥ 20%）能保护浮盈不被整个回调吃光

### D.4 P1：MA20 双确认 / 缓冲

**user story**：
- C 类改为 `close[T] < MA20 × (1 - ma20BufferPct(0.02))`（2% 缓冲）OR `close[T-1] < MA20 AND close[T] < MA20`（连续 2 日）
- 验收: 减少 MA20 假破出场次数 ≥ 30%

### D.5 P2：分级仓位（按 volume_ratio）

- volume_ratio ∈ [1.5, 2.0] → 标准仓
- volume_ratio ∈ [2.0, 3.0] → 1.3 倍仓（强突破）
- volume_ratio > 3.0 → 1.5 倍仓（极强）

### D.6 P2：行业 momentum 联动

- 第 5 维: 所属行业近 5 日 IndustryFlow 累计 main_inflow > 0（不只是当日）
- 与 IndustryMomentumFactor 联动

---

## E. 验收口径

1. **真突破比例**: 入场后 5 日 close ≥ entry_price 的比例 ≥ 55%
2. **趋势保护**: 涨 ≥ 20% 的票最终平均收益 ≥ +15%（trailing stop 起作用）
3. **持仓周期**: 60% 持仓 ≤ 30 天，40% 持仓 ≥ 30 天（趋势分化）
4. **行业分散**: 任意时点 top-10 持仓覆盖 ≥ 5 个行业
5. **backtest 表现**: 2023-2025 sharpe ≥ 1.0 / max_dd ≤ 18% / trade 数 > 300
6. **assertions**: 同 (date, currentPositions) 重跑输出完全一致
