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

典型例子（截至 US-019 共 4 个）：
- `MultiFactorAlphaStrategy`（多因子 alpha 月度轮动）
- `DragonHeadMomentumStrategy`（短线龙头战法 — 事件驱动每日）
- `EarningsSurpriseStrategy`（业绩预告超预期 + 北向加仓双确认 — 事件驱动）
- `NorthboundFollowStrategy`（北向资金大幅加仓跟随 — 中线每日扫描全市场）

后续 story 中其他组合级策略：US-020 CTA100MomentumStrategy、
US-021 SectorRotationLeaderStrategy、US-028 EnsembleStrategy 等。

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
