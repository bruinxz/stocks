# Quant 策略层 (`backend/src/quant/strategies/`)

A 股量化策略的实现集合。截至 US-011 共两类策略并存：

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

典型例子（截至 US-021 共 6 个）：
- `MultiFactorAlphaStrategy`（多因子 alpha 月度轮动）
- `DragonHeadMomentumStrategy`（短线龙头战法 — 事件驱动每日）
- `EarningsSurpriseStrategy`（业绩预告超预期 + 北向加仓双确认 — 事件驱动）
- `NorthboundFollowStrategy`（北向资金大幅加仓跟随 — 中线每日扫描全市场）
- `CTA100MomentumStrategy`（中证 1000 动量 — 指数受限 universe + 月度调仓）
- `SectorRotationLeaderStrategy`（行业龙头轮动 — 两阶段强势行业内挑龙头）

后续 story 中其他组合级策略：US-022 HighDividendValueStrategy、
US-028 EnsembleStrategy 等。

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
