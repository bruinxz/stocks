# 32 — DragonHeadMomentum 短线龙头策略

## A. 操盘手心智

游资板块（涨停连板梯队）是 A 股最暴力的 alpha 来源 — 一个一字板隔天高开 5% 就够吃一个月。但同样也是最危险的：
- 一字板抢不到货（卖单一秒挂掉）
- 高位连板（5 板以上）追进去就是接最后一棒
- 题材切换 — 今天 AI 明天减肥药，连板梯队整体崩
- 炸板（封板失败）次日大概率低开

老练的游资手法：
1. **挑首板 / 二板 / 三板**（不追 5 板以上高位）
2. **挑强势行业**（行业当日 main_inflow 排名 top 10）
3. **要有知名游资席位介入**（龙虎榜 famous_yz 净买入）—— 散户跟单的核心
4. **流通市值 30-200 亿**（小于 30 容易拉爆 + 容易被消息打死；大于 200 拉不动）
5. **次日高开 5%+ 减半落袋**（动量延续兑现）
6. **炸板 / 持有 3 自然日 / -7% 止损** — 三条硬止损

风险等级高（risk_level=high），但 expected_edge_pct=12% 是 13 策略中最高的，capacity 小（~500 万级）但很适合做 alpha 增厚。

---

## B. 系统设计

### B.1 策略定义

证据: `backend/src/quant/strategies/DragonHeadMomentumStrategy.ts:537-558`：
- strategy_key: `dragon_head_momentum`
- style: `short_term_event_driven` → 基准中证 1000
- 触发: 每日
- 持仓: `DragonHeadPosition[]` structured (entry_date / entry_price / entry_continuous_days / half_exited)
- maxPositions: 5
- 持有 ≤ 3 自然日
- expected_edge_pct: 12% / expected_holding_days: 3
- kill_switch: win_rate_5d < 0.45 → 自动 disable

### B.2 入场 5 维 AND

证据: `DragonHeadMomentumStrategy.ts:46-55`：
1. 当日涨停 (LimitUpStock 表)
2. 连板数 ∈ [1, 3]
3. 行业当日 main_inflow 排名 ∈ top 10
4. 龙虎榜出现 famous_yz 且 net_amount > 0
5. 流通市值 ∈ [30 亿, 200 亿]
+ 市场情绪闸门（US-082）: MarketSentimentIndex.index_value ≥ minMarketSentiment(默认 30)

### B.3 出场优先级 A→E

证据: `DragonHeadMomentumStrategy.ts:56-62`：
- A. 持有 ≥ holdingDaysLimit(3) → SELL 全部
- B. (close - entry_price) / entry_price ≤ stopLossPct(-7%) → SELL 全部
- C. 当日不再涨停（炸板）→ SELL 全部
- D. 次日开盘高开 ≥ highOpenSellHalfPct(5%) → sell_half + 标 half_exited=true
- E. 默认 HOLD

### B.4 DataSource 5 个 loader

1. `loadLimitUpStocks(date)` — 当日涨停股 + continuous_days
2. `loadTopIndustries(date, lookbackDays)` — 行业 main_inflow 排名 top N
3. `loadFamousYzNetBuy(date, codes)` — 龙虎榜 famous_yz 净买入
4. `loadStockMeta(codes)` — name / industry / 流通市值
5. `loadDailyQuotes(date, codes)` — open / close / prev_close (sell_half 触发用)

### B.5 排序与稳定 tie-break

由"连板天数升序（首板优先）→ industry_inflow 降序 → famous_yz net 降序 → stock_code 升序"4 级稳定排序，让同一日重跑结果完全一致。

---

## C. 现状 review

### C.1 已实现部分

证据: `DragonHeadMomentumStrategy.ts` 1078 行：
- 5 维入场 + 5 阶出场全实现
- structured Position with `half_exited` flag 防重复减半
- 市场情绪闸门 US-082 (`L:64-72`)
- minMarketSentiment 缺数据时 fail-OPEN（不阻塞）
- expected_edge_pct=12% 是 13 策略中最高
- DataSource 5 个 loader 注入 fake 完全脱 DB

### C.2 ⚠️ 连板天数没有"对应风险等级"

当前 minContinuousDays=1 / maxContinuousDays=3 是硬区间，所有进入候选的股票被同等对待。但：
- 1 板（首板）= 风险中等，胜率高
- 2 板 = 风险偏高，胜率中
- 3 板 = 风险极高，胜率低（但赢面大）

应该让不同连板的仓位 size 不同（首板加仓、3 板减仓），或者评分不同。

### C.3 ⚠️ 炸板止损是 next-day reactive

当前 C 类炸板出场是"次日不再涨停 → SELL"。但实际游资操作是**当日尾盘判断"封单是否够强"**：盘中 14:50 看封单金额 / 流通市值 比例 < 1% → 当日就卖。系统化只能 next-day。

### C.4 ⚠️ 没有"龙头共振"触发同板块二线

DragonHead 当日选出来的 5 只都是涨停股本身。但游资真实操作还包括"一线龙头涨停后买同板块二线（次涨停股）"——这是 LinkageStrategy (US-027) 的领域。两者本应配对使用，但 Ensemble 未在 bull regime 同时纳入两者。

### C.5 ⚠️ 一字板已剔除但缺真实成交模拟

`excludeOneWordBoard=true` 已剔除一字板。但即使非一字板，封单很大时实际成交价大概率是涨停板，回测引擎用 next_open 撮合可能高估实际入场可行性。

### C.6 next-day high open sell_half 时间窗未明示

D 类 sell_half 触发依据是"次日 open"，但卖出动作发生在何时？9:25 集合竞价开盘价已确定 — 应该 9:30 开盘后 5 分钟内尽快卖。回测引擎只能按 next_open 价撮合，与实盘略有差异（可能开盘后 5 分钟回落 1-2%）。

### C.7 maxPositions=5 偏少，无法充分覆盖

bull / 题材热的日子涨停股可能 30+，能 famous_yz 净买入 + 强势行业 + 30-200 亿市值的候选可能仍有 10+，但 maxPositions=5 卡死。

---

## D. 改造方案

### D.1 P0：分级仓位（连板数对应风险等级）

**user story**：
- params 新增 `positionSizeByBoardLevel: {1: 1.0, 2: 0.7, 3: 0.4}`
- generateSignals 输出在 BUY signal 上加 `position_weight` 字段
- 调用方按 position_weight 实际下单（首板 100% 标准仓 / 二板 70% / 三板 40%）
- 验收: 3 板出场胜率应高于 1 板（即使损失也较少）；总 sharpe 提升

### D.2 P0：炸板止损改"当日尾盘判断"（近似）

**痛点**: 当前等到次日才发现炸板，可能 -10% 才能卖出。

**user story**：
- 加 D 类：盘中 14:50 数据触发器，查 LimitUpStock 该股是否仍封板 + 封单金额 < 流通市值 ×封单阈值(0.01)
- 触发即在当日加 SELL pending order（next_open 撮合）
- 数据源：需要 RealtimeQuote 14:50 snapshot
- 验收: 炸板股次日均价 vs 当日 14:50 价差距 ≤ 3%（即使没真实当日尾盘卖，next_open 已经比"等炸板次日开盘"少损失）

### D.3 P1：龙头共振触发同板块二线

**user story**：
- DragonHead 选出 5 只龙头后，把它们的 industry 输出给 Linkage 策略
- Linkage 在 bull regime 优先扫这些 industry 找未启动股
- Ensemble 在 bull regime 同时纳入两者（DragonHead 0.30 + Linkage 0.20，MFA 降到 0.30 + Breakout 0.20）

### D.4 P1：maxPositions 按市场情绪动态

**user story**：
- bull regime + market_sentiment > 70 → maxPositions=10（题材热时多开）
- range / volatile → maxPositions=5
- bear → maxPositions=0（不开仓，纯持有等出）

### D.5 P2：开盘集合竞价 5 分钟窗口出场

**user story**：
- D 类 sell_half 改为：next 9:30 开盘后 5 分钟内 TWAP 卖出一半（不是一次性全卖 open price）
- 由 ExecutionPolicyRouter 处理（不在策略层 scope）

### D.6 P2：连板梯队映射前端可视化

**user story**：
- 前端"龙头梯队"页面：今天 1 板 / 2 板 / 3 板 候选数 / 入选数 / 已持仓数 / 已减半数 / 已平仓数
- 横向对比"今天梯队是否完整"（有 1 板没 2 板 = 题材弱化）

---

## E. 验收口径

1. **稳定性**: 同 (date, params, currentPositions) 重跑输出一致
2. **风险控制**: 单股最大亏损 ≤ -7% (止损线)，单日组合亏损 ≤ -3.5%（5 只 × -7%）
3. **alpha 显著**: backtest 2023-2025 trade 数 > 200，平均胜率 ≥ 55%，期望 edge > 8% / trade
4. **kill_switch**: win_rate_5d < 0.45 时策略自动 enabled=false
5. **DataSource 可 mock**: 全测试用例脱 DB，run-time < 2s
6. **题材热度感知**: bull + sentiment > 70 日 maxPositions 动态扩到 10
