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

典型例子（截至 US-011 共 1 个）：
- `MultiFactorAlphaStrategy`（多因子 alpha 月度轮动）

后续 story 中其他组合级策略：US-019 NorthboundFollowStrategy、
US-020 CTA100MomentumStrategy、US-021 SectorRotationLeaderStrategy、
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
