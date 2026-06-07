# Quant 策略层 (`backend/src/quant/strategies/`)

A 股量化策略的实现集合。截至 US-027 共两类策略并存：

## 两种策略形态

### 1) Per-stock evaluate() —— 历史既有形态

继承 `QuantStrategy` 抽象类，实现 `evaluate(context: QuantStockContext)` 单
方法。一次调用 = **一只股票的快照打分**。被 `quant/engine/` 下的
StrategyEngine / SignalEngine 在每日 pipeline 中按股票×策略矩阵循环调用。

典型例子（17 个）：
- 趋势：`MovingAverageTrendStrategy` / `MacdTrendStrategy` / `DonchianTrendStrategy` / `MinerviniTrendTemplateStrategy` / `TrendPullbackReentryStrategy`
- 突破：`BreakoutAtrStrategy` / `TurtleBreakoutStrategy` / `VolatilityContractionBreakoutStrategy`
- 动量：`RelativeStrengthMomentumStrategy` / `DualMomentumRotationStrategy` / `QualityMomentumBlendStrategy`
- 量价：`VolumePriceConfirmationStrategy`
- 摆动反转：`RsiMeanReversionStrategy` / `BollingerReversionStrategy`
- 多因子（per-stock 风格）：`MultiFactorRankingStrategy`
- 防守：`LowVolatilityQualityStrategy`

数据源：`context.bars` (DailyBar 历史) + `context.factor_snapshot`
（StockValuationFactor / StockMoneyFlowFactor / StockFundamentalFactor）+
context 内联指标。

### 2) 组合级 generateSignals(date) —— US-011 引入的新形态

类型：策略需要"全市场横截面 + 排序 + top-N + 行业中性"，per-stock
evaluate 模型表达不出。

实现：仍继承 `QuantStrategy`（满足 registry/接口契约），但 `evaluate()`
退化为"信息性 hold"，真正入口是 **`generateSignals(date)` 异步方法**：
- 入参：交易日 + 可选 `{ params?, previousSelection? }`
- 出参：`{ target_portfolio, signals: BUY/SELL/HOLD[], filtered, params, ... }`

典型例子（截至 US-027 共 12 个）：
- `MultiFactorAlphaStrategy`（多因子 alpha 月度轮动）
- `DragonHeadMomentumStrategy`（短线龙头战法 — 事件驱动每日）
- `EarningsSurpriseStrategy`（业绩预告超预期 + 北向加仓双确认 — 事件驱动）
- `NorthboundFollowStrategy`（北向资金大幅加仓跟随 — 中线每日扫描全市场）
- `CTA100MomentumStrategy`（中证 1000 动量 — 指数受限 universe + 月度调仓）
- `SectorRotationLeaderStrategy`（行业龙头轮动 — 两阶段强势行业内挑龙头）
- `HighDividendValueStrategy`（高分红低 PE 长线价值 — 季度调仓 + 4 维 AND）
- `BreakoutStrategy`（60 日新高突破 — 价量突破 + MA20 技术信号 exit）
- `GARPStrategy`（业绩稳定增长 GARP — 半年度调仓 + 4 维 AND 含 PEG）
- `GameTraderRelayStrategy`（游资接力 — 多日累计 + 接力天数双门槛 + 反向数据信号 exit）
- `LeftSideReversalStrategy`（左侧反转 — 5 维超跌反弹 + RSI 上穿 + sell_half 落袋）
- `LinkageStrategy`（行业联动 — 涨停龙头触发 + 同行业未启动联动股 + 涨停止盈 exit）

后续 story 中其他组合级策略：US-028 EnsembleStrategy 等。

## 组合级策略的设计约定（US-011 制定）

新加一个组合级策略时遵循以下 5 条：

### A. 数据访问通过可注入的 DataSource 接口

直接 `Sequelize.findAll` 写在策略里会让单元测试只能跑集成测试。约定：
1. 策略文件顶部定义 `<StrategyName>DataSource` 接口，列出 1-3 个
   `loadXxx(...)` 方法。
2. 提供生产实现 `Default<StrategyName>DataSource` 走 Sequelize。
3. 构造器接受 `dataSource = PRODUCTION_DATA_SOURCE`，测试可以传 fake。

参考：`MultiFactorAlphaStrategy.ts` 的 `MultiFactorAlphaDataSource` /
`DefaultMultiFactorAlphaDataSource` / `PRODUCTION_DATA_SOURCE`。

### B. generateSignals(date) 必须返回 BUY/SELL/HOLD 增量

不要只返回 `target_portfolio`。调用方传 `previousSelection` 当前持仓后，
策略要负责算出：
- BUY = target ∩ ¬previous
- HOLD = target ∩ previous
- SELL = previous ∩ ¬target

只返回 target 让 caller 自己 diff 会出现 N 个调用方写出 N 份不一致 diff
逻辑——这是 PaperTradingFacade 之前踩过的坑。

**`previousSelection` 的形态视策略需要扩展**：
- `MultiFactorAlphaStrategy`：`previousSelection: string[]` 就够了（月度
  调仓只需要"哪只在哪只不在"）。
- `DragonHeadMomentumStrategy`：扩展成 `currentPositions:
  DragonHeadPosition[]`，每只持仓携带 `entry_date` / `entry_price` /
  `half_exited`——因为 exit 规则要算 holding_days、止损（pnl_pct = (close -
  entry_price) / entry_price）、防止已减半的仓位再次减半。新增 `sell_half`
  这种"减仓但保留"的信号也是这一类 schema diff 的合理后果。

**新增组合级 strategy 设计选 schema 的判据**：
- 调仓决策只依赖"在不在"目标集合 → 用 `string[]`，保持简单。
- 调仓决策依赖每只持仓的 *property*（进场价、持仓天数、是否已减仓） →
  用结构化 `Position[]`，并文档化每个字段的语义。
- 信号种类超出 BUY/SELL/HOLD 三态（如 SELL_HALF / ADD / SCALE_OUT） →
  扩展 signal 联合类型并在 jsdoc 列出每态触发条件 + 调用方应做的撮合动作。

### C. evaluate() 必须实现为信息性 hold

QuantStrategy 抽象基类要求 `evaluate()`。组合级策略仍要实现以满足类型
契约，但返回值应当：
- `signal = 'hold'`
- `reasons` 包含一句"请使用 generateSignals(date)"提示
- `factors.note = 'use_generateSignals_instead'`（machine-readable）

这样 backtest engine 误把组合级策略当 per-stock 跑也不会崩，且日志
可识别。

### D. 排序必须稳定（tie-breaker 用 stock_code 升序）

`candidates.sort((a, b) => {
  if (a.composite_score !== b.composite_score) return b.composite_score - a.composite_score;
  return a.stock_code.localeCompare(b.stock_code);
});`

否则 V8 的 TimSort 在 tie 时顺序不确定，同一天重跑产物不同 → 审计 / 对账
全部失败。这是月度调仓最容易踩的坑：top-30 边界上有 5 只 composite 相同，
random tie-break 会让"30 进 5 出"的两次运行选不一样的股。

### E. 单元测试目录是 `backend/tests/strategies/<StrategyName>.test.ts`

不依赖 jest，直接 `npx ts-node --transpile-only` 跑。原因：
1. 项目历史既有测试（productionPreflight / LiveAuditAlertService /
   liveTradingRateLimit）都采用 node-direct 模式，保持一致；
2. tests/ 目录在 tsconfig.json 的 `include` 之外，typecheck/build 不带入，
   依赖结构干净；
3. fake DataSource 让测试不依赖 DB。

参考：`backend/tests/strategies/MultiFactorAlphaStrategy.test.ts` —— 17 个
测试用例覆盖 60+ 个断言，运行 < 1s。

## 注册到 StrategyRegistry

`quant/engine/StrategyRegistry.ts` 是中央注册器：在 `constructor()` 里
`this.register(new XxxStrategy())` 加一行，新策略就出现在
`/api/quant/strategies` 列表 + 可在 backtest CLI 引用其 `strategy_key`。

注：组合级策略也要注册（满足 registry 契约 + 让前端能列出），但其
`evaluate()` 走信息性 hold 路径。

## 引用因子库（US-009 + US-010）

组合级多因子策略**不**重新计算因子；统一读 `factor_scores` 表的 z_score。
查询模式：

```sql
SELECT stock_code, factor_name, z_score
FROM factor_scores
WHERE trade_date = ? AND factor_name IN (?, ?, ...);
```

复合 PK `(trade_date, stock_code, factor_name)` + Pipeline 中性补全的
`z_score = 0` 让"查 N 个因子 = N × universe 行"，单查询毫秒级。
权重合成 `composite = sum(z_score[i] * weight[i])` 直接在 TS 内存做。

## 事件驱动 + 多源双确认（US-013 EarningsSurpriseStrategy）

某些策略需要 **两个独立数据源同时确认** 才入场（业绩 + 北向资金 / 北向 + 龙虎榜 /
龙虎榜 + 涨停板 等）。建议在 DataSource 接口里把每个数据源独立成一个
`loadXxx()` 方法，让单测可以独立 mock 每条信号:

- `loadAnnouncedForecasts(date)` — 事件触发源（必填，过滤候选池）
- `loadNorthboundRatioDelta(date, lookbackDays, codes)` — 确认源（双确认必须）
- `loadStockMeta(codes)` — 元数据（ST 过滤等）
- `loadDailyClose(date, codes)` — 价格快照（止损 / 入场参考价）

**判定顺序遵循"早过滤先做"**：
1. 事件触发过滤（forecast_type / profit_change_low）— 通常剔除 80%+ 候选
2. 元数据过滤（ST）— 单 Map 查询，~ns
3. 多源确认（北向 delta > 0）— 需要历史回看的最贵查询，最后做

避免反过来"先批量查北向再过滤" — 会浪费大量数据库 IO 在最终被业绩条件剔除
的股票上。

**事件驱动 + 事件分布稀疏的特性**：业绩预告一年只有 4 个集中披露期
（前 30 天热闹，平日为 0）。`generateSignals(date)` 大多数交易日返回
`eligible_count=0` 是**正常的**——这是事件驱动策略的本质，不是数据问题。
日志写 `forecast_pool=0 eligible=0` 即可；不要把"无信号日"当成异常告警，
否则告警噪音淹没真正的数据缺失问题。

**中线策略的 currentPositions schema（vs DragonHead 短线）**：US-013 持有
60 自然日 (vs DragonHead 3 自然日 / MultiFactor 月度)，但 exit 规则比
DragonHead 简单（无炸板 / 高开减半逻辑）— 所以 `EarningsSurprisePosition` 不需
要 `half_exited` 字段，但保留 `entry_report_period` 便于 debug（"我是因为
哪个报告期的预告进场的"）。判据仍是：**调仓规则需要哪些 per-position state
就放哪些字段**，多一个少一个都不行。

## 全市场扫描 + 同源数据复用（US-019 NorthboundFollowStrategy）

某些"跟随类"策略的触发源不是稀疏事件（业绩预告 / 龙虎榜上榜）而是
**每日全市场都有的连续信号**（北向持股 / 主力资金 / 融资余额）。这类
策略的 DataSource 应该把"候选池扫描"封装成一个 loader——一次性返回
**全市场**满足"有近 N+1 天数据"的股票的关键指标快照：

```ts
loadCandidateRatioDeltas(asOfDate, lookbackDays): Promise<Map<stock_code, {current_ratio, ratio_delta}>>
```

而**不是**：

```ts
// ❌ 错误模式 - 假设 universe 是上游给的
loadRatioDeltas(asOfDate, stockCodes: string[]): Map<...>
```

为什么：跟随类策略的"候选池"就等于"有北向数据的全市场股票"，没有
更上游的过滤源。如果让 caller 先给 stockCodes，caller 反而要先查
NorthboundHolding 表拿 universe，等于做两遍同样的查询。

**同源数据在 entry + exit 复用**：US-019 拉到 ratioSnapshots 后既给
entry 判定（delta ≥ 0.5%）又给 exit 判定（delta ≤ -0.3%）。**生命周期
管理在 generateSignals() 主流程，不在 evaluateEntries/evaluateExits
内部各拉一次**——否则同样的 Sequelize 查询发两次。

跟随类策略 vs 事件驱动策略（US-013）的关键设计差异：

| 维度 | 事件驱动 (US-013) | 跟随类 (US-019) |
|------|------------------|----------------|
| 触发源 | 稀疏事件（forecast 当日有） | 连续信号（北向每日都有） |
| 候选池构造 | "拿 forecasts 再查北向确认" | "全市场扫北向 → 卡阈值" |
| eligible=0 含义 | 当日无预告（正常） | 全市场无加仓（市场冷淡）|
| Exit 是否复用 entry 数据源 | 否（exit 只看 close 价） | 是（exit 看北向 delta 反转）|
| `loadCandidateXxx` 接受 stockCodes | 是（先有候选池） | 否（自己就是候选池）|

**新增"出场看反向信号"出场线（exit_ratio_decrease）的判据**：当策略
的核心 alpha 是"跟随某个方向"时，出场就要补一条"方向反转就退出"的
guard——这是跟随策略的命脉。US-019 的优先级 A→B→C（到期 > 止损 >
北向减仓）让"硬约束"优先于"软信号"，避免短期减仓噪音过早赶走还在
浮盈的持仓。

## 指数受限 universe（US-020 CTA100MomentumStrategy）

某些策略**不在全市场扫描，也不在事件源里扫描，而是限定在一个指数的成份股
集合内**做横截面打分。CTA100 = 中证 1000 (000852) 成份股是第一个例子；
未来 US-022 HighDividendValue 可能限 沪深 300，US-026 LeftSideReversal
可能限 中证 500，等等。

DataSource 接口的设计：

```ts
loadIndexUniverse(asOfDate, indexCode): Promise<IndexUniverseSnapshot>
loadMomentumBars(asOfDate, stockCodes, minTradingDays): Promise<Map<...>>
loadStockMeta(stockCodes): Promise<Map<...>>
```

**关键约定**：
- **`loadIndexUniverse` 返回 `≤ asOfDate` 的最新一日 snapshot**（不要求
  asOfDate 当日必须有 sync）。因为指数成份**月内变化稀少**（季度调样），
  上次 sync 早一周也无伤大雅；如果硬要"当日必须有"会让月初调仓时正好
  遇到周末缺数据就崩。同款的"允许小幅 staleness"逻辑可以照搬到
  US-021 行业轮动选龙头、US-088 龙虎榜机构分类等"参考数据"场景。
- **`IndexUniverseSnapshot` 同时返回 `snapshot_date`**，让日志能审计
  "今天用的是哪一天的成份"。如果 snapshot_date 落后超过 30 天就该
  告警，月度调仓策略不应该用 3 个月前的成份。
- **历史 bar 拉取按交易日计算，不按日历日**。`minTradingDays = lookbackDays +
  skipRecentDays + 2`（+2 buffer），转日历日窗口用 `× 2 + 30` 覆盖春节
  + 十一假期。bars 升序后从尾部 indexing (`bars[length - 1 - N]`) 比
  按日期匹配更稳。
- **`loadMomentumBars` 接口让单测可以精准注入** "61/65/66 条 bar" 边界用
  例验证 `fail_insufficient_history` 判定，避免依赖 DailyBar 真实数据。

**指数受限 vs 全市场扫描 vs 事件驱动 的对比**：

| 维度 | 全市场 (MultiFactor) | 事件驱动 (EarningsSurprise) | 指数受限 (CTA100) |
|------|--------------------|----------------------------|------------------|
| Universe 来源 | factor_scores 全集 | 当日 forecast 公告 | (asOfDate, indexCode) 成份 |
| Universe 大小 | ~5000 | 0-50 | 100-1000 |
| 更新频率 | 每日 | 报告期密集时段 | 季度（月度感知 OK） |
| eligible=0 含义 | 数据问题 | 当日无事件（正常） | sync 没跑（异常） |
| Universe loader 接受 stockCodes | 否 | 否（自带过滤） | 否（自带过滤） |

**新增动量公式不依赖 factor_scores 的设计**：CTA100 把动量计算
（close[T-5]/close[T-60] - 1）写死在策略内，**不通过 FactorPipeline**。原因：
(1) FactorPipeline 的 MomentumFactor 是横截面 z_score 标准化后的产物，
对 CTA100 这种"指数内打分"不友好（每日横截面应是中证 1000 内的相对动量，
不是全市场）；(2) 让 CTA100 在 factor_scores 表还没回填的历史窗口里也能跑，
便于回测验证。如果未来要做"指数内多因子"，应当在 FactorPipeline 里加
`universe='000852'` 参数让 z_score 按指数内截面算，而不是强行复用全市场 z。

## 两阶段筛选 — 行业 × 行业内龙头（US-021 SectorRotationLeaderStrategy）

**第 4 种 universe 形态**：先筛"行业组"再筛"行业内成员"，两层结构都是
"取 top N"。与"全市场扫描"/"事件驱动"/"指数受限"的差异：单源数据
（IndustryFlow + Stock + DailyBar）能完成"行业排名 → 行业内排名"两次
打分；不需要 forecast 触发，也不依赖固定的 index 成份集合。

DataSource 接口的 3 个 loader 体现"两阶段一份数据"的原则：

```ts
loadIndustryRanking(asOfDate, lookbackDays): Promise<Array<{industry_name, cumulative_inflow}>>
loadIndustryConstituentMetrics(asOfDate, industryNames): Promise<Map<industry, StockMetric[]>>
loadDailyClose(asOfDate, stockCodes): Promise<Map<stock_code, close>>
```

**关键约定**：

- **DataSource 返回"全集 + 已排序"，不在数据层做 top-N slice**。
  `loadIndustryRanking` 返回 *全部* 有 cumulative_inflow 的行业（按降序），
  让 caller 自己 `slice(0, topIndustries)` 用作 entry 入选 + `slice(0, exitIndustryTopN)`
  用作 exit 容忍域，**同份数据双用**。这与 US-019 NorthboundFollow 的"同源数据
  在 entry + exit 复用"原则一致——避免多个查询查同样的东西。

- **`loadIndustryConstituentMetrics` 的 list 已按 change_pct 降序排好**。
  避免策略层在每个行业 entry / 每只 currentPosition exit 内反复对几十个成份股
  re-sort（生产环境 86 个行业 × 平均 50 成份股 = 4300+ rows，每次扫描重排
  开销不必要）。把 sort 沉到 DataSource 让生产 SQL 也可以用 ORDER BY 优化。

- **持仓必须携带 `entry_industry` 字段**。因为 exit 阶段 "我的行业排名第几"
  / "我在我的行业内排名第几" 都依赖 *进场时* 的行业归属。Stock.industry 字段
  极少变动但理论可能调整；以 entry_industry 为准而非每日查 Stock.industry，
  是"以进场时的判断为准"原则。同 CTA100 的 `entry_index_snapshot_date`
  设计动机一致。

- **entry vs exit 阈值有意宽窄差**。entry topIndustries=10 / exitIndustryTopN=15
  让行业排名小幅震荡（11→13）不立即赶人；entry stocksPerIndustry=2 /
  exitStockTopN=5 同理给个股短期回调容错。**约 50% 宽度差** 是经验值，
  实测过窄会"上车下车太勤"换手率爆炸，过宽会"该止损没止损"持仓质量下滑。

- **implicit cap = topIndustries × stocksPerIndustry**。AC 没给独立的
  `maxPositions` 参数（NorthboundFollow / DragonHead 有），因为两阶段
  selection 天然封顶。HOLD 占满后新 BUY = 0，与 NorthboundFollow 的
  remainingSlots = maxPositions - kept.length 行为模式一致。

**4 种 universe 形态对比表**：

| 维度 | 全市场 (MultiFactor) | 事件驱动 (EarningsSurprise) | 指数受限 (CTA100) | 两阶段 (SectorRotation) |
|------|--------------------|----------------------------|------------------|----------------------|
| Universe 来源 | factor_scores 全集 | 当日 forecast 公告 | (asOfDate, indexCode) 成份 | 行业 ranking × 行业成份 |
| Universe 大小 | ~5000 | 0-50 | 100-1000 | ~10 行业 × 50 成份 = 500 |
| 更新频率 | 每日 | 报告期密集时段 | 季度（月度感知 OK） | 每日（IndustryFlow） |
| eligible=0 含义 | 数据问题 | 当日无事件（正常） | sync 没跑（异常） | IndustryFlow 当日缺失（异常） |
| Position schema | string[] | EarningsSurprisePosition | string[] | SectorRotationPosition (entry_industry) |
| Cap 形态 | maxPositions 显式 | maxPositions 显式 | topN 显式 | topIndustries × stocksPerIndustry 隐式 |

**5 日累计 main_inflow 的设计哲学**：
单日资金流噪音大（一天 main_inflow 受当日大单买卖、龙虎榜异常资金影响），
所以入场看"连续 5 个交易日累计"而非单日；这与 NorthboundFollow 看"5 日累计
hold_ratio 变化"是同一思路。DataSource 内部用 `Set(allDates).sort().slice(-lookbackDays)`
拿最近 N 个 distinct trade_date，对周末 / 节假日 gap 自动鲁棒；不要按日历日
窗口 `now - N` 计算否则会把周末/假日空 N 天放进去。

**写新两阶段策略的 checklist**：
1. Position schema 包含 `entry_<dimension>`（entry_industry / entry_sector_id / ...）记录
   选股时的分类归属，exit 阶段以该字段为准查"我的分组是否还在"。
2. DataSource 第一个 loader 返回 *全集排序后*，让 caller slice 两次（entry topN /
   exit toleranceN）共用一份数据。
3. DataSource 第二个 loader 接受第一个的输出（分组名集合），返回
   `Map<group_name, members[]>`，members 已排序便于 caller slice。
4. entry vs exit 阈值留 30%-50% 宽度差，避免短期震荡过度交易。
5. implicit cap = group_count × per_group_count，无需独立 maxPositions 参数。

## 长线 + 季度调仓（US-022 HighDividendValueStrategy）

第 7 个组合级策略，引入两个新模式：

### 1. 季度调仓的"调仓日 gate"

不像 MultiFactorAlpha 每月跑 / DragonHead 每日跑，长线价值策略只在
**每季度的第 1 个交易日** 调仓。调用方理论上每个交易日都可以传，但
`generateSignals(tradeDate)` 会内部判定：

- 非调仓日 → 返回 `{is_rebalance_day:false, target_portfolio:[...previousSelection],
  signals:[]}`，**完全不动持仓**。这意味着前端 / 调度器可以 fearlessly
  每日调用本策略而不会引发任何无意义的 BUY/SELL。
- 调仓日 → 走完整 4 维筛选 → 输出 BUY/SELL/HOLD 增量。

调仓日判定 (`isFirstTradingDayOfQuarter`) 走 DataSource — 生产实现查 DailyBar
在 `[quarterStart, quarterStart+7d]` 范围内的 distinct trade_dates，取最早一个 ≥
quarterStart 的 ISO date，与 tradeDate 比较。**重要：不要按 ISO 日期硬编码
"4 月 1 日"**——4 月 1 日可能是周日，那真正的调仓日是 4 月 2 日；不查
DailyBar 就判定错误。Fake DataSource 在测试中可直接返回 true/false 跳过这个查询。

类似模式可复用到 US-024 GARP 策略（半年度调仓）、US-028 EnsembleStrategy（按市场环境
切换子策略时跨调仓周期感知）。

### 2. 4 维 AND 过滤无止损出场

不同于 DragonHead/EarningsSurprise/NorthboundFollow 的"持有期 + 止损 + 反向信号"
3 类出场，**长线价值持有无显式 stopLoss**：调仓日重新跑筛选，掉出 top N 自然 SELL；
非调仓日不动。这是策略性质决定的——长线持有者认 30% 回撤是市场波动而非择时信号；
真要止损就该走 portfolio 层的 DrawdownCircuitBreaker (US-049) 而非策略层。

因此 Position schema 用最简单的 `string[]` （与 MultiFactorAlpha 一致），不需要
`entry_date` / `entry_price` / `half_exited`。**判据**：调仓决策只依赖 "是否在 top N
里"，不依赖 per-position state → 用 `string[]`，保持 schema 最小化。

### 3. 多源 4 维数据（DividendHistory + 2 valuation tables + Stock meta）

`HighDividendValueDataSource` 暴露 6 个 loader：
- `loadCandidateUniverse(asOfDate)` — 全 A 股 is_listed=true
- `loadAvgDividendYield(asOfDate, lookbackYears, codes)` — 近 N 年 yield_pct 均值
- `loadValuationSnapshot(asOfDate, codes)` — 最新 pe_ttm + total_market_cap
- `loadRoe5yAvg(asOfDate, codes)` — ROE 5 年均值（≥2 观测）
- `loadStockMeta(codes)` — name/industry/fallback total_market_cap
- `loadDailyClose(asOfDate, codes)` — BUY reference_price
- `isFirstTradingDayOfQuarter(tradeDate)` — 调仓日 gate

**market_cap 双源 fallback 模式**：StockValuationFactor.total_market_cap 是
"最新一日 valuation 数据"，可能落后 3 个月；Stock.total_market_cap 是
"最新已知" — 优先 valuation，缺则 meta 兜底。同款双源回退可用于其他指标
（PE-TTM 优先 valuation 缺则 DailyBar.pe 兜底）。

### 4 种 universe + 长线季度调仓 形态对比

截至 US-022：

| 维度 | 全市场 (MultiFactor) | 事件驱动 (EarningsSurprise) | 指数受限 (CTA100) | 两阶段 (SectorRotation) | 长线季度 (HighDividendValue) |
|------|--------------------|---------------------------|-----------------|---------------------|------------------------|
| 触发频率 | 月度 | 每日（稀疏事件） | 月度 | 每日 | **季度**（调仓日 gate）|
| 调仓日判定 | 调用方负责 | 调用方负责 | 调用方负责 | 调用方负责 | **DataSource 判定**|
| Universe 来源 | factor_scores 全集 | 当日 forecast | (asOfDate, indexCode) 成份 | 行业 ranking × 行业成份 | 全 A 股 (is_listed=true) |
| 入场维度 | 8 因子合成 z_score | 业绩 + 北向 双确认 | 60-5 momentum | 行业 + 个股 双 ranking | **4 维 AND**（股息+PE+ROE+市值）|
| Position schema | string[] | EarningsSurprisePosition | string[] | SectorRotationPosition | **string[]**|
| 止损 | 无 | -10% | 无 | 无 | **无**（长线靠下季度自然换仓）|
| 行业中性 | 强制 (每行业≤3) | 不需 | 强制 | 隐式（两阶段 cap）| **可选 (默认 false)** |
| 典型 holding period | 30 天 | 60 天 | 30 天 | 10-30 天 | **90+ 天** |

**写新长线季度调仓策略的 checklist**：
1. DataSource 暴露 `isFirstTradingDayOfQuarter(tradeDate)` 让策略自治判定调仓日；
   不要把 gate 放在调用方（会出现 N 个调用方写出 N 份不一致的 gate 逻辑）。
2. 非调仓日 `generateSignals` 返回 `is_rebalance_day=false` + `target_portfolio=previousSelection` +
   `signals=[]` —— 完全 noop。前端调度器可放心每日调用。
3. Position schema 用 `string[]` 即可（长线无 per-position state 需求）；如果
   未来加入分批建仓 / 持仓期目标价等才扩成 structured Position。
4. 无显式 stopLossPct 参数 — 长线策略止损归 portfolio 层 (US-049 DrawdownCircuitBreaker)。
5. 4 维 AND 过滤的统计字段（fail_dividend / fail_pe / fail_roe / fail_market_cap）独立
   计入 filtered，便于诊断 "为什么本季度只选出 5 只而不是 30 只"。

## 突破 + 技术信号 exit（US-023 BreakoutStrategy）

第 8 个组合级策略，引入 **"技术信号 exit"** 的新出场模式：

### 1. 全市场扫描 + 4 维 AND 入场

与 NorthboundFollow / EarningsSurprise 一样走全市场扫描，但触发源是**价量行为
本身**（不是北向资金 / 业绩预告这种"外部输入"）：

- `loadCandidateBars(asOfDate, minBarCount)` 一次拉全市场近 N 天 OHLCV（最便宜的
  方式：让 DataSource 自动剔除 bar 数 < minBarCount 的股票）
- 入场 4 维 AND：突破 60 日新高 + 成交额放大 1.5x + 行业资金净流入 > 0 + 非 ST
- 排序：volume_ratio 降序 → industry_inflow 降序 → stock_code 稳定 tie-break

**关键设计：边界条件全部严格 >**：close > priorHigh（不能等于），turnover > avg × multiplier
（不能等于）— 突破需要"明确穿越"才算数，否则 boundary 噪音会带来一堆假信号。
止损用 ≤（pnl = stopLossPct 触发），跌破均线用 严格 <（close = ma20 不触发）—
分别对应"立即止血"vs"轻度收回不算破位"的语义直觉。

### 2. 3 类出场按优先级 A → C（硬约束优先）

与 NorthboundFollow 同款"3-tier 优先级"模式，差异在 **C 是技术信号而非反向数据信号**：

- **A. 持有 ≥ 60 自然日**（硬时间限制）→ SELL 不论盈亏 / 技术形态
- **B. (close - entry) / entry ≤ -15%**（硬损失限制）→ SELL 不论是否还在均线之上
- **C. close < MA20**（技术信号）→ SELL — 趋势策略最经典的"破位出场"
- **D. 默认 HOLD**

C 走"技术信号"而非"反向资金信号"（vs NorthboundFollow C = 北向减仓 / EarningsSurprise C = 无）—
这是趋势策略的典型出场设计：进场看突破，出场看趋势是否还在均线之上。

**bars 不足 ma20Period → 安全 HOLD**：刚开仓 5 天 ma20 算不出，**不能误把"数据不足"
当成"破位出场"**。这是 BreakoutStrategy 第一次正式引入"技术指标计算前置 guard"
的范式 — 未来 RSI / MACD / 布林带 类技术信号策略 (US-026 LeftSideReversal 用 RSI)
直接照搬。

### 3. Position schema 用 structured `BreakoutPosition`

不像 MultiFactorAlpha / CTA100 / HighDividendValue 用 `string[]`，本策略必须用
`{stock_code, entry_date, entry_price, entry_industry?, entry_60d_high?}`：

- entry_date：A 出场（60 自然日到期）需要
- entry_price：B 出场（-15% 止损）需要
- entry_industry / entry_60d_high：纯 debug 用 — 复盘"我是在哪只行业突破时进场的"
  / "突破点是多少"，对策略逻辑无影响

判据仍是策略级一致的：**调仓决策依赖什么 per-position state，就放什么字段**。

### 4. DataSource 4 loader 设计 — `loadPositionBars` 独立于 `loadCandidateBars`

```ts
loadCandidateBars(asOfDate, minBarCount)              // 全市场扫描（universe-wide）
loadPositionBars(asOfDate, stockCodes, minBarCount)   // 持仓子集（小集合精准拉）
loadIndustryNetInflow(asOfDate)                       // 当日行业全量 Map
loadStockMeta(stockCodes)                             // 元数据
```

为什么 candidate 和 position bars 分开两个 loader：
- candidate 是**全市场扫描**（5000 股 × 61 bar = 300K rows），需要 `is_listed=true` 过滤
- position 可能包含**已退市 / 已停牌**股票（持仓股有可能停牌后还挂在 portfolio 里），
  不能依赖 universe 集合；而且数量小（≤ maxPositions），可以直接 `stock_id IN (...)`
  一次性拉，效率高

如果两者合并成一个 loader，要么 candidate 要带 stockCodes 参数（破坏全市场扫描语义），
要么 position 走 universe 过滤（停牌持仓会"消失"，exit 逻辑无法判定）。**两个 loader
就两个 loader**，不要为了 DRY 而合并 — 业务语义不同。

### 6 种 universe + 长线 + 技术 exit 形态对比

截至 US-023：

| 维度 | 全市场 (MultiFactor) | 事件驱动 (EarningsSurprise) | 指数受限 (CTA100) | 两阶段 (SectorRotation) | 长线季度 (HighDividendValue) | 价量突破 (Breakout) |
|------|--------------------|---------------------------|-----------------|---------------------|------------------------|------------------|
| 触发源 | factor_scores 全集 | 当日 forecast | (asOfDate, indexCode) 成份 | 行业 ranking × 行业成份 | 全 A 股 | **当日价量行为**（60 日新高 + 放量）|
| 触发频率 | 月度 | 每日（稀疏） | 月度 | 每日 | 季度（gate）| **每日** |
| 入场维度 | 8 因子 z_score | 业绩 + 北向 双确认 | 60-5 momentum | 行业 + 个股 双 ranking | 4 维 AND（股息+PE+ROE+市值）| **4 维 AND**（新高+放量+行业流入+非 ST）|
| Position schema | string[] | EarningsSurprisePosition | string[] | SectorRotationPosition | string[] | **BreakoutPosition** |
| 止损（B）| 无 | -10% | 无 | 无 | 无 | **-15%（较宽）** |
| 软出场（C）| 无 | 无 | 无 | 行业 / 个股掉出 top N | 无 | **跌破 MA20**（技术信号）|
| 行业中性 | 强制 | 不需 | 强制 | 隐式（两阶段 cap）| 可选 | **不强制**（隐式靠 industry_inflow > 0）|
| 典型 holding period | 30 天 | 60 天 | 30 天 | 10-30 天 | 90+ 天 | **10-60 天** |

**写新"技术信号 exit"趋势策略的 checklist**：
1. 边界条件设计：突破 / 新高用 严格 >，止损用 ≤，跌破均线用 严格 <（语义对齐：突破要明确，止损不留余地，均线轻擦不算破）。
2. Position schema 用 structured `{entry_date, entry_price}` —— 时间限制 + 止损都需要。
3. DataSource 把 `loadCandidateBars`（universe-wide）与 `loadPositionBars`（持仓子集）分开 — 不要为了 DRY 合并。
4. 技术指标计算前置 guard：bars 不足 ma20Period → 安全 HOLD 不当 SELL（数据不足 ≠ 破位信号）。
5. 行业 name 容错：DataSource 内部 `.trim()` 处理 industry 字段两端空格 — Stock.industry 与 IndustryFlow.industry_name 的来源不同 sync，难免有不一致。

## 价值成长 + PEG 双维度 + 半年度调仓（US-024 GARPStrategy）

第 9 个组合级策略，引入两个新模式：

### 1. 半年度调仓的"调仓日 gate"扩展

延续 US-022 HighDividendValueStrategy 的"调仓日 gate 在 DataSource 内部判定"模式，
但周期是**半年度**（1 月 / 7 月第 1 个交易日）而非季度。`DefaultGARPDataSource.isFirstTradingDayOfSemiAnnual`
查 DailyBar `[halfStart, halfStart + 10d]` 范围内的最早交易日（比季度版的 +7d 略宽，
留更多 buffer 给假期）。**判据**：

- 季度调仓 / 半年度调仓 / 年度调仓 都应**在 DataSource 内部判定**，不在调用方；
  让前端 / 调度器可以 fearlessly 每日调用本策略而无副作用。
- 命名约定：`isFirstTradingDayOf<Period>` — `Quarter` / `SemiAnnual` / `Year`。
  下个长线策略（US-091 年度大盘价值 / US-095 双年价值）直接照搬此命名。

### 2. PEG 因子的双维度（成长 + 估值）入场

GARP 入场是 **4 维 AND 中包含 PEG = PE / 最新年报净利润增速**，比单维度（HighDividend
看股息率单维度 / Northbound 看资金流单维度）更动态：

- **成长维度**（连续 N 年净利润 yoy ≥ 阈值）+ **估值维度**（PE ≤ 上限）单独检查是
  传统多因子做法。GARP 把两者**乘起来当一个维度算**（PEG），让"高增速 + 高估值"
  与"低增速 + 低估值"在同一坐标系比较——这是 Peter Lynch 的核心洞察。
- 因 PEG 依赖 latestYoy > 0（除以负数无意义），策略内部判定逻辑必须先验证
  "连续 N 年都 ≥ minNetProfitYoy ≥ 0"再计算 PEG。**判据**：组合指标（PEG/PS-G/PB-G）
  类型的因子都要在策略内置 guard——caller 不可能从外部传"PE 但已确保增速 > 0"
  这种 precondition。

### 3. 4 维 AND 过滤 + 6 loader DataSource

DataSource 暴露 6 个 loader（vs HighDividendValue 的 5 个 — GARP 多一个 loadAnnualNetProfitYoySeries 因连续 N 年增长是序列判定不是均值）：

- `loadCandidateUniverse(asOfDate)` — 全 A 股 is_listed=true
- `loadAnnualNetProfitYoySeries(asOfDate, lookbackYears, codes)` — 近 N 个年报的
  净利润 yoy **序列**（按 report_date 降序 / 最新在前）
- `loadLatestPETTM(asOfDate, codes)` — 最新 pe_ttm（已过滤 pe ≤ 0）
- `loadRoe5yAvg(asOfDate, codes)` — ROE 5 年均值（≥2 观测）
- `loadLatestDebtRatio(asOfDate, codes)` — 最近一期 debt_ratio（任何 report_type）
- `loadStockMeta(codes)` — name / industry
- `loadDailyClose(tradeDate, codes)` — BUY reference_price
- `isFirstTradingDayOfSemiAnnual(tradeDate)` — 调仓日 gate

**关键 API 设计**：`loadAnnualNetProfitYoySeries` 返回 `Map<stock_code, number[]>`
而非 `Map<stock_code, boolean>`（"是否连续 N 年正增长"）——序列才能让策略层判定
"恰好 N 个观测 + 全部 ≥ 阈值"，而 boolean 把判定逻辑硬编码进 DataSource 让
单测/重构成本翻倍。同款"返回 raw 序列让策略判定"原则可复用到 US-031 QualityHigh
（5 年毛利率波动率，要序列）/ US-033 MomentumReversal（多期动量分离，要序列）。

### 7 种 universe + 长线 + GARP 形态对比

截至 US-024：

| 维度 | 全市场 (MultiFactor) | 事件驱动 (EarningsSurprise) | 指数受限 (CTA100) | 两阶段 (SectorRotation) | 长线季度 (HighDividendValue) | 价量突破 (Breakout) | GARP (US-024) |
|------|--------------------|---------------------------|-----------------|---------------------|------------------------|------------------|---------------|
| 触发频率 | 月度 | 每日（稀疏） | 月度 | 每日 | 季度（gate）| 每日 | **半年度（gate）**|
| 入场维度 | 8 因子 z_score | 业绩 + 北向 双确认 | 60-5 momentum | 行业 + 个股 双 ranking | 4 维（股息+PE+ROE+市值）| 4 维（新高+放量+流入+非ST）| **4 维（增长序列+PEG+ROE+负债）**|
| Position schema | string[] | EarningsSurprisePosition | string[] | SectorRotationPosition | string[] | BreakoutPosition | **string[]**（同 HighDividend）|
| 止损 | 无 | -10% | 无 | 无 | 无 | -15% | **无**（长线靠下半年度自然换仓）|
| 行业中性 | 强制 | 不需 | 强制 | 隐式（两阶段 cap）| 可选 | 不强制 | **可选**（默认 false）|
| 数据源依赖 | factor_scores | EarningsForecast + NorthboundHolding | IndexComponent + DailyBar | IndustryFlow + Stock | DividendHistory + valuation | DailyBar + IndustryFlow | **FinancialReport + valuation**|
| 典型 holding period | 30 天 | 60 天 | 30 天 | 10-30 天 | 90+ 天 | 10-60 天 | **180+ 天**|

**写新"组合指标 + 长线"策略的 checklist**：
1. 组合指标（PEG / PS-G / Graham number）的计算前置 guard 必写在策略内部，不依赖
   DataSource 帮忙做 precondition 过滤（DataSource 应保持 "返回 raw 数据" 的纯粹性）。
2. 序列类数据（"连续 N 年 ≥ X"）loader 返回数组，让策略判定 "够 N 个观测吗 / 全部满足吗"。
3. 半年度 / 年度调仓的 gate 都放 DataSource，命名 `isFirstTradingDayOf<Period>`。
4. 长线策略（≥ 180 天 holding）的 Position schema 用 `string[]`，不需要 entry_price /
   entry_date（无止损 / 不按持有期出场）。
5. 4 维 AND 过滤的 fail_xxx 计数独立存，便于诊断 "本期为什么只选出 5 只" 是哪个维度
   过严（典型 GARP 在牛市 PEG 会大量超 1.0，fail_peg 飙升 → 提示用户参数调整或换策略）。

## 游资接力 — 多日累计 + 反向数据信号 exit（US-025 GameTraderRelayStrategy）

第 10 个组合级策略。短线游资接力策略，与 DragonHead 短线龙头是同一资金面议
（famous_yz 席位）但触发条件完全不同：

### 与 DragonHead 的关键差异

| 维度 | DragonHead（短线龙头） | GameTraderRelay（短线接力）|
|------|--------------------|--------------------------|
| 入场触发 | **当日涨停** + famous_yz 净买入 > 0 | **当日涨幅 > 5%**（不要求涨停）+ N 日**累计** famous_yz 净买入 > 5000 万 |
| 持仓 / 候选规模 | 5 只 / 强势行业 top10 内梯队龙头 | 5 只 / 多日席位接力 |
| 出场 D 类型 | 高开 ≥ 5% sell_half（减半信号） | 接力中断（次日 famous_yz 消失 → 全平）|
| Position schema | `{entry_date, entry_price, half_exited?}` | `{entry_date, entry_price}` —— 无 half 概念 |
| 题材覆盖 | 涨停板内梯队 | 涨停板外补涨 / 游资暗中建仓 |

**判据**：DragonHead 抓"游资单日抢筹明牌大单"；GameTraderRelay 抓"游资多日蛰
伏建仓"。两者的资金面信号叠加 = 短线"游资动向板块" 完整覆盖。

### 1. 多日累计 + 接力天数双门槛

入场条件 1 = `accumulated_net_buy > netBuyThreshold(5000万) AND relay_day_count ≥
min(2, lookbackDays)`。`relay_day_count` = lookback 窗口内 famous_yz 净买入 > 0 的
**distinct trade_date 数**。**判据**：累计金额够但只有单日大单（如 lookback=2 但只有
1 天有 famous_yz）= "孤胆英雄"不是接力，应当过滤。`min(2, lookbackDays)` 的写法让
lookbackDays=1 时退化为允许单日入场（不强制接力天数 ≥ 2），保留参数灵活性。

### 2. "反向数据信号"作为 exit 第 D 类（接力中断）

GameTraderRelay 的 exit 排序：A 持有期 → B 止损 → C 次日大跌 → **D 次日 famous_yz
席位消失（接力中断）**。D 类是反向数据信号 exit 第 2 次出现（第 1 次是 US-019
NorthboundFollow 的"近 5 日北向减仓 → SELL"）—— 与 BreakoutStrategy（US-023）的
"close < MA20 技术信号 exit" 并列为 3 大 exit 信号系列：

| 信号类 | 例子 | 触发即出场判据 |
|--------|------|--------------|
| **硬约束**（A 持有期 / B 止损）| 全部组合级策略 | 不容讨价还价（绝对金额 / 自然日数）|
| **反向数据信号** | US-019 NorthboundFollow 北向减仓 / **US-025 GameTraderRelay famous_yz 消失** | 入场依赖的资金面信号反向 |
| **技术信号** | US-023 BreakoutStrategy 跌破 MA20 | 价量结构破位 |

**判据**：跟随类 / 接力类策略**必须**有反向数据信号 exit，否则退化为"被动止损 +
持有期到期"，失去 alpha 来源。

### 3. DataSource 4 loader 设计

`GameTraderRelayDataSource` 4 个 loader：

- `loadFamousYzAggregates(asOfDate, lookbackDays)` — universe-wide 扫描，返回所有在
  lookback 窗口内至少出现一次 famous_yz 净买入的股票 `{accumulated_net_buy, relay_day_count}`。
  无 stockCodes 参数（跟随类不预 universe，由 famous_yz 触发本身定 universe）。
- `loadStockMeta(stockCodes)` — name / industry / circulating_market_cap（市值过滤 + ST 提前过滤）。
- `loadDailyQuotes(tradeDate, stockCodes)` — 当日 `{open, close, prev_close, change_pct}`，
  入场用 change_pct 判定涨幅 > 5%；出场用 change_pct 判定 next-day drop。
- `loadFamousYzNetBuyToday(tradeDate, stockCodes)` — 当日单日 famous_yz 净买入聚合（不是累计），
  exit 规则 D 判定接力是否中断。

**与 DragonHead 5 loader 的关键差异**：不要 `loadLimitUpStocks`（入场不依赖涨停）
+ 不要 `loadTopIndustries`（不要求强势行业）；新增 `loadFamousYzNetBuyToday`（单日 vs
DragonHead 用累计的不同切片）。

### 4. 严格边界条件

入场用**严格 >**（净买入 > 5000 万、涨幅 > 5%、市值在 [30, 150] 闭区间）；止损用
**≤**（一旦达到立即止血）；次日大跌用 **≤**（边界精度对齐 stop_loss）。**判据**：
入场要明确"达到了"（严格大于消除 boundary 噪音），出场要敏感（≤ 哪怕碰到边界都触发）。
跟随类 NorthboundFollow 的 entry minIncreasePct ≥（包含边界）相反 —— 因北向加仓阈值
是 0.5pp 的 fuzzy 业务定义，不像 5000 万这种"营业部统计上限"硬数字，可以用 ≥ 包含
边界。**写新短线策略前确认**：你的入场阈值是 hard cutoff（用 >）还是 fuzzy floor（用 ≥）？

### 5. isSTName 共享模块抽取（US-025 同步重构）

US-011..US-024 期间，9 份 `isSTName` 实现 copy/paste 散落在 8 个 strategy + 1 个
backtest engine。US-025 之前抽取到 `backend/src/utils/stNameUtils.ts`，原 9 处改为
`import { isSTName } from '../../utils/stNameUtils'; export { isSTName };`（**保留
重新导出**）以维持向后兼容 —— 既有测试的 `import { isSTName } from
'../../src/quant/strategies/<Name>'` 仍可用，不必同步修改 10 处 test imports。

**判据**：跨多个文件复制粘贴的函数，达到 6+ 次复制就启动抽取（US-023 推荐过；
US-025 触达 10 处实际抽取）。抽取时**必须保留各源文件的 re-export shim**，避免
破坏既有 import 路径。

### 8 种 universe + 短线接力对比

截至 US-025：

| 维度 | 全市场 (MultiFactor) | 事件驱动 (EarningsSurprise) | 指数受限 (CTA100) | 两阶段 (SectorRotation) | 长线季度 (HighDividendValue) | 价量突破 (Breakout) | GARP (US-024) | **GameTraderRelay (US-025)** |
|------|--------------------|---------------------------|-----------------|---------------------|------------------------|------------------|---------------|------------------------------|
| 触发频率 | 月度 | 每日（稀疏） | 月度 | 每日 | 季度（gate）| 每日 | 半年度（gate）| **每日（短线）** |
| 入场维度 | 8 因子 z_score | 业绩 + 北向 双确认 | 60-5 momentum | 行业 + 个股 双 ranking | 4 维（股息+PE+ROE+市值）| 4 维（新高+放量+流入+非ST）| 4 维（增长+PEG+ROE+负债）| **4 维（累计净买入+接力天数+涨幅+市值）** |
| Position schema | string[] | EarningsSurprisePosition | string[] | SectorRotationPosition | string[] | BreakoutPosition | string[] | **GameTraderRelayPosition**（entry_date/entry_price/entry_acc_net_buy）|
| 止损 | 无 | -10% | 无 | 无 | 无 | -15% | 无 | **-7%** |
| 退出反向信号 | 无 | 无 | 无 | 行业掉出 top 15 | 无 | 跌破 MA20 | 无 | **famous_yz 消失（接力中断）**|
| 行业中性 | 强制 | 不需 | 强制 | 隐式 | 可选 | 不强制 | 可选 | **不需** |
| 数据源依赖 | factor_scores | EarningsForecast + NorthboundHolding | IndexComponent | IndustryFlow + Stock | DividendHistory + valuation | DailyBar + IndustryFlow | FinancialReport + valuation | **DragonTigerBoard + DailyBar** |
| 典型 holding period | 30 天 | 60 天 | 30 天 | 10-30 天 | 90+ 天 | 10-60 天 | 180+ 天 | **3 天**（最短）|

**写新"短线接力 / 跟随"策略的 checklist**：
1. 触发源是连续信号（资金流/北向/famous_yz）→ DataSource `loadCandidateXxx` 不接受
   stockCodes，universe 由触发本身定义。
2. 入场必须有"累计 + 接力天数双门槛"避免单日大单造成的孤胆英雄信号被误信。
3. Exit 必须有**反向数据信号 D 类**（席位消失 / 减仓 / 资金流出），否则退化为被动持有。
4. 退出优先级 A 硬约束 > B 止损 > C 价格信号 > D 数据信号 —— 把"必须出场"放最前面。
5. **边界条件**：入场用严格 > 消除 boundary 噪音；止损用 ≤ 一旦达到立即触发。
6. **isSTName 用共享模块** `import { isSTName } from '../../utils/stNameUtils'`，
   不要再 copy/paste。

## 左侧反转 — 超跌反弹 + RSI 上穿 + sell_half（US-026 LeftSideReversalStrategy）

第 11 个组合级策略，第 4 个"短中线 + 结构化持仓"形态（与 DragonHead/Breakout/GameTraderRelay
并列）。**第一个把 sell_half 信号用在"减仓落袋为安"而非"动量延续减仓"的策略**。

### 与 BreakoutStrategy（US-023）的镜像关系

| 维度 | BreakoutStrategy（趋势延续）| LeftSideReversalStrategy（趋势反转）|
|------|---------------------------|----------------------------------|
| 入场判定方向 | 突破 60 日新高（上行） | 近 20 日大跌 30%（下行） |
| 反弹/确认信号 | 成交额放大 1.5x | 当日反弹 > 5% |
| 资金面信号 | 行业 main_inflow > 0 | 个股 main_net_inflow > 0 |
| RSI 用法 | 无 | **RSI(14) 从超卖区上穿 25** |
| 市值门槛 | 无（隐式靠行业） | 流通市值 > 50 亿（避开小盘股流动性陷阱）|
| C 类出场 | close < MA20（趋势破位）| **5 日内涨幅 > 15% sell_half（落袋）**|
| 止损 | -15%（趋势策略宽止损）| -7%（反转策略快速止损）|
| Holding period | 60 自然日（中长期）| 15 自然日（短中线）|

**判据**：所有趋势策略可以加一个反向版本；架构同形态（DataSource 4 loader 模式 + structured
Position + 3-tier exit），关键差异在阈值方向和参数严格性。同 NorthboundFollow 加仓策略
未来可考虑加 "NorthboundOutflowReversal 北向流出后回流" 镜像版。

### 与 DragonHeadMomentumStrategy（US-012）的 sell_half 对比

两者都使用 `sell_half` 信号 + `half_exited` 标记防重复减半，但触发语义不同：

| 维度 | DragonHead sell_half | LeftSideReversal sell_half |
|------|---------------------|--------------------------|
| 触发条件 | 次日 open / prev_close ≥ 5%（**高开**） | 5 日内 max(close) / entry > 15%（**累计涨幅**） |
| 时间窗口 | 单日（次日 open） | rapidGainLookbackDays(5) 日滚动 |
| 业务语义 | 动量延续，借高开兑现 | 反弹兑现落袋，防回中继转再跌 |
| 计算的 close 来源 | `lastBar.open` vs prev_close | `max(close[bars where date > entry])` |

**判据**：sell_half 信号的具体触发逻辑要写在 jsdoc 上明示（"sell half on high open" vs
"sell half on peak gain"），单测 reason 字段要包含识别关键词（"高开" / "落袋"），让审计
日志可以一眼区分两策略的减半事件。

### 1. 全市场扫描 + 5 维 AND 入场（最长入场过滤链）

US-026 是目前 9 个组合级策略中**入场维度最多**的（5 维，超过 BreakoutStrategy/GARP 的 4 维）。
判定顺序遵循"早过滤先做"：

1. 历史 bar 不足 → 单 Map size 检查，~ns
2. stale bar（最后一条 != asOfDate）→ 单字段比对
3. 20 日跌幅 → 单 close[T-20] vs close[T] 比例
4. 当日反弹 → 单 close[T-1] vs close[T] 比例
5. RSI 上穿 → 计算两个 RSI（昨天 + 今天）— 最贵
6. 元数据查询（Stage 2 全部一次性 loadStockMeta + 主力资金 Map 查找）

**fail_xxx 维度分别计数**（candidate_pool_size / fail_drop_insufficient /
fail_rebound_insufficient / fail_rsi_not_crossing_up / fail_money_flow_negative /
fail_market_cap_insufficient / fail_meta_missing / fail_st / fail_already_held /
fail_insufficient_history / fail_stale_bar = 11 个独立计数）。当生产环境 eligible=0
时 ops 可以一眼看出"是 RSI 上穿太严" or "是市值门槛过滤太多" — 诊断粒度的价值
随策略复杂度增长而 super-linear。

### 2. 入场排序：drop_pct 升序（跌得最惨在前）

不像 BreakoutStrategy 的"放量最猛在前"（趋势力度 metric），左侧反转优先选**跌幅最深**的：

```ts
candidates.sort((a, b) => {
  if (a.drop_pct !== b.drop_pct) return a.drop_pct - b.drop_pct; // 升序（更负在前）
  if (a.rebound_pct !== b.rebound_pct) return b.rebound_pct - a.rebound_pct;
  return a.stock_code.localeCompare(b.stock_code);
});
```

**判据**：反转策略相信"跌得越多反弹空间越大"（mean-reversion thesis）；趋势策略相信
"涨得越猛趋势越强"（momentum thesis）。两种 thesis 对应两种排序方向，**不要混用**。

### 3. 边界条件 — 多种 strict 语义并存

US-026 同时用到 4 种边界 strict 类型：

| 条件 | 阈值类型 | 边界处理 | 例子 |
|------|----------|----------|------|
| 跌幅 ≥ 30% | hard cutoff | dropPct ≤ -threshold（**包含边界**） | -30% 触发 |
| 反弹 > 5% | hard cutoff | reboundPct > threshold（**严格大于**） | 恰 5% 不入 |
| RSI < 25 → ≥ 25 | 上穿信号 | yesterdayRsi < t AND todayRsi >= t | 双边严格 |
| 流通市值 > 50 亿 | hard cutoff | cap > threshold（**严格大于**） | 恰 50 亿不入 |
| 主力净流入 > 0 | hard cutoff | inflow > 0（**严格大于**） | 恰 0 不入 |
| 止损 ≤ -7% | 保护性出场 | pnlPct <= threshold（**包含边界**） | -7% 触发 |
| 持有 ≥ 15 天 | 时间约束 | holdingDays >= limit（**包含边界**） | 第 15 天触发 |

**判据**：
- 入场用**严格 >** 消除 boundary 噪音 + 让阈值的"达到"语义明确
- 出场（止损/持有期）用 **≥ / ≤** 一旦达到立即触发，不留余地
- 跌幅类是个例外（用 ≤ -threshold），因为业务表达 "跌幅 ≥ 30%" 在数学上等价于
  "回报率 ≤ -30%"，写边界时按业务语言而非数学语言更直观

### 4. DataSource 4 loader（与 BreakoutStrategy 同形）

- `loadCandidateBars(asOfDate, minBarCount)` — 全市场扫描
- `loadPositionBars(asOfDate, stockCodes, minBarCount)` — 持仓子集（可能含停牌）
- `loadMoneyFlowToday(asOfDate)` — 当日全市场 main_net_inflow Map
- `loadStockMeta(stockCodes)` — name / industry / **circulating_market_cap**

**关键 minBarCount = max(dropLookbackDays + 1, rsiPeriod + 2)** ——
RSI 上穿判定要算 yesterday + today 两个 RSI，每个 RSI 至少 rsiPeriod+1 个 close，
加起来要 rsiPeriod+2 个 bar。默认参数下 max(21, 16) = 21；rsiPeriod=30 时
max(21, 32) = 32 — DataSource 的最小 bar 数需求由策略层精确计算并透传。

### 9 种 universe + 短中线反转对比表（截至 US-026）

| 维度 | MultiFactor | EarningsSurprise | CTA100 | SectorRotation | HighDividend | Breakout | GARP | GameTraderRelay | **LeftSideReversal** |
|------|-------------|------------------|--------|----------------|--------------|----------|------|----------------|------------------|
| 触发频率 | 月度 | 每日（稀疏）| 月度 | 每日 | 季度（gate）| 每日 | 半年度（gate）| 每日（短线）| **每日（短中线）** |
| 入场维度 | 8 因子 | 业绩+北向 | 60-5 mom | 行业+个股 | 4维 | 4维 | 4维 | 4维 | **5 维（最多）** |
| 入场方向 | 横截面打分 | 事件 + 双确认 | 动量延续 | 强势行业内 | 长线 value | **趋势延续**| GARP | 短线接力 | **趋势反转** |
| Position schema | string[] | EarningsSurprisePosition | string[] | SectorRotationPosition | string[] | BreakoutPosition | string[] | GameTraderRelayPosition | **LeftSideReversalPosition (half_exited!)**|
| 止损 | 无 | -10% | 无 | 无 | 无 | -15% | 无 | -7% | **-7%** |
| 软出场 (C) | 无 | 无 | 无 | 行业掉出 top | 无 | 跌破 MA20 | 无 | 接力中断 | **5 日涨 > 15% sell_half** |
| RSI 用法 | 无 | 无 | 无 | 无 | 无 | 无 | 无 | 无 | **上穿 25** |
| 排序方向 | composite DESC | profit_change DESC | momentum DESC | inflow DESC | dividend DESC | volume_ratio DESC | yoy DESC | acc_net_buy DESC | **drop ASC（最跌）**|
| 典型 holding period | 30 天 | 60 天 | 30 天 | 10-30 天 | 90+ 天 | 10-60 天 | 180+ 天 | 3 天 | **5-15 天** |

**写新"趋势反转 + sell_half"策略的 checklist**：
1. 入场方向用"跌幅"而非"涨幅"，DataSource loader 返回 close 序列即可（无需复杂计算）。
2. 排序方向反过来：**最负的 drop_pct 升序在前**，体现"跌得越深反弹越大"的 mean-reversion thesis。
3. sell_half 信号必须 + `half_exited` flag 防重复减半 — schema 是 `LeftSideReversalPosition`，
   `kept.push({...pos, half_exited: true})` 标记后保留入 target_positions。
4. RSI（或其他技术指标）作为入场维度时必须用 "**上穿**" 而非 "≤ 阈值" — 单点值容易卡在
   超卖区漂移，"昨天 < + 今天 ≥" 的上穿确认排除掉持续低位无趋势的票。
5. 计算 RSI 时 minBarCount 需要算两个 RSI（yesterday + today），各需 period+1 close，
   总共 period+2 — DataSource 接口的 minBarCount 由策略层精确传入。
6. **5 维 AND 入场**是上限，超过会让 fail_xxx 计数器过多 ops 难诊断；可以把 ST 提前到
   Stage 0 提前过滤（已实现）减少 Stage 1 的内存压力。
7. **市值门槛对反转策略尤其重要**：超跌小盘股可能因流动性陷阱 / 退市风险（如 US-074 退市预警）
   导致"反弹"假信号；强制 > 50 亿（AC 默认）规避此风险。

## 行业联动 — 涨停龙头触发 + 题材外溢（US-027 LinkageStrategy）

第 12 个组合级策略，与 DragonHead / GameTraderRelay / SectorRotationLeader 共享"行业 / 涨停 / 短线"
关键词但触发逻辑完全不同：

| 策略 | 触发源 | 候选池 |
|------|--------|---------|
| DragonHeadMomentum | 当日涨停 + 连板梯队 | **涨停股本身（一二三连板）** |
| SectorRotationLeader | 行业 5 日累计 main_inflow top N | 强势行业内龙头股 |
| LinkageStrategy | **行业内有涨停龙头（涨幅 > 9%）** | **同行业 ≠ 涨停股 ≠ 龙头本身**（联动滞涨股） |
| GameTraderRelay | famous_yz 累计买入门槛 | 龙虎榜出现的票 |

**关键概念**：题材扩散 / 资金外溢 — 行业龙头涨停后，剩余资金会去同行业未启动股找
"补涨"机会。本策略抓的就是这种"昨天未涨 + 今天未启动 + 行业刚被点燃"的票。

**第 10 种 universe 形态 — 行业题材联动**：与 SectorRotationLeader 的"两阶段选股"
（强势行业 → 内挑龙头）镜像 — 后者选"已启动龙头"，本策略选"未启动联动股"。
两者用的都是 LimitUpStock + Stock 表，但完全相反的入选条件构成同行业完整的多空策略对。

**5 维 AND 入场（目前共享 LeftSideReversal 的"最多"称号）**：
1. 行业内有股票涨停 且 涨幅 > 9% （leaderMinChangePct）— 题材点燃确认
2. 候选股昨日涨幅 < 5% （candidateMaxYesterdayChangePct）— "未启动"标的
3. 候选股流通市值 < 龙头流通市值 — "联动股 = 体量小于龙头的同行业股"
4. 候选股今日开盘高开 < 3% （candidateMaxOpenGapPct）— 避开抢筹标的
5. 非 ST

**4 类出场（按 A→D 优先级）**：
- A. 持有 ≥ 3 自然日（holdingDaysLimit）→ SELL 全部
- B. pnl ≤ -7%（stopLossPct）→ SELL 止损
- C. **当日 hit 涨停 → SELL 止盈**（联动已实现！这是本策略 unique 的"止盈"信号 — DragonHead
  和其他短线策略没有这条，因 DragonHead 本身就建仓涨停股）
- D. 持仓首日后，change_pct ≤ -3%（exitNextDayDropPct）→ SELL 次日大跌

**关键设计决策**：

1. **5 个 loader DataSource**（最多的策略，vs DragonHead 5 / GameTraderRelay 4）—
   `loadIndustryLimitUpStocks` + `loadIndustryConstituents` 必须分开（前者是
   触发信号，后者是候选池，数据形状不同）；`loadDailyQuotes` 同时返回 today + yesterday
   （5 维入场需要 today open/close + yesterday change 双日）；
   `loadLimitUpStocksOnDate` 给 exit C 类涨停止盈用，单独的 Set 接口，
   不要复用 entry 的 `loadIndustryLimitUpStocks`（数据形状不同）。

2. **龙头本身排除候选**：`loadIndustryConstituents` 接收 `excludeLimitUpStocks: Set<string>`
   —— DataSource 层负责把当日涨停股从候选池里剔除，避免 service 重新查涨停表
   （`loadIndustryLimitUpStocks` 调用方已知所有涨停股代码）。

3. **同股归属多个热门行业要 dedup**（罕见但需要）：实现层用 `seen: Set<string>` 防重复，
   边缘情况但写过的人都知道一次卡这里调几小时。

4. **龙头自己缺市值 → 候选剔除（保守）**：无法判定"小于龙头"则不放过，
   `fail_cap_not_below_leader` 计数加 1。

5. **排序：leader_change DESC → cand_cap ASC → open_gap ASC → stock_code ASC**
   — 4 级稳定排序。leader_change DESC：跨行业选最强题材；cand_cap ASC：行业内挑
   弹性最大的小盘（与 SectorRotation 镜像，后者按 leader change DESC，这里按
   candidate cap ASC 因为我们要的是非龙头股）；open_gap ASC：高开越小越好（抢筹少）。

6. **C 类涨停止盈触发不区分 holdingDays**（即使进场首日也能触发）：因为联动
   策略的核心目标就是"等联动到涨停立刻兑现"，如果当天 BUY 当天涨停立刻 SELL
   不属于"误平"而是"完美兑现"。这与 D 类（次日大跌）严格要求 holdingDays ≥ 1 不同。

7. **同 isSTName 共享模块 + naturalDaysBetween 同款**：US-025 抽取后第 11 个调用方，
   直接 `import { isSTName } from '../../utils/stNameUtils'` + re-export shim。

### 10 种 universe + 题材联动对比表（截至 US-027）

| 维度 | MFA | EarningsSurprise | CTA100 | SectorRotation | HighDividend | Breakout | GARP | GameTraderRelay | LeftSideReversal | **Linkage** |
|------|-----|------------------|--------|----------------|--------------|----------|------|----------------|------------------|----------|
| 触发频率 | 月度 | 每日（稀疏）| 月度 | 每日 | 季度（gate）| 每日 | 半年度（gate）| 每日（短线）| 每日（短中线）| **每日（短线）** |
| 入场维度 | 8 因子 | 业绩+北向 | 60-5 mom | 行业+个股 | 4维 | 4维 | 4维 | 4维 | 5 维 | **5 维（含独特"行业有涨停龙头"维）** |
| 入场方向 | 横截面 | 事件 | 动量 | 行业内 | 长线 | 趋势延续 | GARP | 接力 | 趋势反转 | **题材扩散** |
| 入场触发源 | factor_scores | EarningsForecast | DailyBar | IndustryFlow | DividendHistory | DailyBar | FinancialReport | DragonTigerBoard | DailyBar + MoneyFlow | **LimitUpStock + Stock** |
| Position schema | string[] | ESPosition | string[] | SRPosition | string[] | BreakoutPosition | string[] | GTRPosition | LSRPosition（half_exited!）| **LinkagePosition（entry_industry+entry_leader_code）** |
| 止损 | 无 | -10% | 无 | 无 | 无 | -15% | 无 | -7% | -7% | **-7%** |
| **独特止盈**| 无 | 无 | 无 | 无 | 无 | 无 | 无 | 无 | sell_half rapid_gain | **C 类：当日涨停 SELL！**  |
| 软出场 | 无 | 无 | 无 | 行业掉出 top | 无 | 跌破 MA20 | 无 | 接力中断 | sell_half | **D 类：次日大跌 -3%** |
| 候选池规模 | 全市场 | 公告稀疏 | 1000 内 | 行业 × 龙头 | 全市场 | 全市场 | 全市场 | 龙虎榜 | 全市场 | **同行业去涨停股**  |
| 排序方向 | composite DESC | profit_change DESC | momentum DESC | inflow DESC | dividend DESC | volume_ratio DESC | yoy DESC | acc_net_buy DESC | drop ASC | **leader_change DESC → cap ASC** |
| holding period | 30 天 | 60 天 | 30 天 | 10-30 天 | 90+ 天 | 10-60 天 | 180+ 天 | 3 天 | 5-15 天 | **3 天（最短之一）** |

**写新"题材扩散 / 联动股"策略的 checklist**：
1. **DataSource 至少 4-5 个 loader**：触发源（涨停 / 资金 / 公告）+ 候选池 + 量化指标 + exit 反向信号 —
   不要为 DRY 合并，每个 loader 数据形状不同硬合并会产生 union type 噩梦。
2. **龙头本身必须排除候选**（已涨停 → 无法买入）：用 `excludeLimitUpStocks: Set<string>`
   参数在 DataSource 层完成，避免 service 再查一次涨停表。
3. **C 类止盈不区分 holdingDays**：联动策略目标就是"兑现题材扩散"，当日涨停立刻
   SELL 不算误平。与 D 类（次日大跌）严格 `holdingDays >= 1` 区分。
4. **同股归属多个热门行业要 dedup**（罕见但代码必须写）：`seen: Set<string>`。
5. **Position structured schema 必带 entry_industry**（debug 用 — 出场时关联当时的题材）。
6. **5 维入场目前是上限**（与 LeftSideReversal 持平）；> 5 维 fail_xxx 计数器太多
   ops 难诊断，且每维过滤都增加候选剔除概率，eligible_count 会指数收缩。
7. **3 自然日强制平仓**：联动是题材性短线，3 天后题材热度通常已散，不要恋战。




