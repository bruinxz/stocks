# 20 — Alpha 引擎总览

## A. 操盘手心智

A 股能持续赚到的钱可拆成 9 大类：**价值 / 成长 / 动量 / 反转 / 低波 / 资金流（北向/主力/游资/融资）/ 事件（业绩/解禁/政策）/ 行业轮动 / 龙头共振**。每一类都对应若干个**可观测、可量化的因子**——例如"价值 = 低 PE + 低 PB"、"动量 = 过去 N 月相对收益"、"龙头共振 = 同板块连板溢价"。

但单一因子永远只在某个**市场状态**有效——价值因子 2020 抱团时被压制了 2 年，动量因子 2018 熊市归零，小盘成长 2017 蓝筹年绞肉。所以高级操盘手不是"赌单一信号"，而是：
1. 把每个因子拆成"经济学逻辑 + IC/IR 阈值 + 失效区间"，知道**它什么时候不灵**。
2. 用 **regime-aware 加权**让不同环境下不同因子主导（牛市偏动量、熊市偏低波/红利、震荡偏反转/事件）。
3. 把因子组合成 **多个独立策略**（不是一个大杂烩），每个策略风格清晰、可单独评估、可单独熔断。
4. 每天 / 每月**复盘哪些因子失效了**（IC < 0.02 持续 3 个月即下线），让策略组合能进化。

Alpha 引擎是这一切的"信号工厂"——上游吃数据，下游产出"今天 5000 只股票每只的因子横截面 z_score + 策略级 top-N 持仓建议"。它不下单、不管仓位，只产信号。

---

## B. 系统设计

### B.1 三层架构（信号工厂）

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 1 — 因子层 (Factor Library)                            │
│   22 个 Factor 文件，每个 compute(ctx) → Map<stock, raw>     │
│   FactorPipeline.runForDate(date) 调度 → 横截面标准化         │
│   → factor_scores 表（trade_date, stock_code, factor, z, pct）│
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│  Layer 2 — 信号层 (Signal Generation)                         │
│   - per-stock evaluate(): 17 个老策略，每日按股 × 策略矩阵跑   │
│   - generateSignals(date): 13 个组合级策略，吃 factor_scores  │
│     + DataSource → target_portfolio + BUY/SELL/HOLD 增量      │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│  Layer 3 — 融合层 (Ensemble / Fusion)                         │
│   - EnsembleStrategy.generateSignals(date): regime → 子策略池  │
│     加权 vote → meta target_portfolio                         │
│   - QuantFusionService.runDailyPipeline: 策略权重决策           │
└──────────────────────────────────────────────────────────────┘
                              ↓
                  下游：Paper Trading / 风控 / 实盘
```

### B.2 因子与策略的多对多关系

22 个 factor 不是"每个策略私有"，而是**共享池**——多个策略可以共用同一个因子，但赋不同权重：

```
                                                ┌─→ MultiFactorAlpha(14 因子加权)
value/quality/growth/momentum                   ├─→ HighDividendValue(只看 value+dividend)
low_vol/northbound/money_flow/dragon_tiger ────→├─→ DragonHeadMomentum(只看 dragon_tiger+money_flow)
liquidity/analyst_consensus/quality_high/       ├─→ NorthboundFollow(只看 northbound delta)
earnings_surprise/momentum_reversal/            ├─→ EarningsSurprise(只看 earnings + northbound)
east_money_qa/shareholder_concentration/        ├─→ Breakout(不读 factor_scores, 自查 DailyBar)
gradual_breakout/insider_trade/margin_flow/     ├─→ LeftSideReversal(不读 factor_scores)
industry_momentum/concept_heat/                 ├─→ SectorRotationLeader(不读 factor_scores)
fund_consensus/block_trade_signal               └─→ Ensemble(meta, 不直接读因子)
```

**MultiFactorAlpha 是唯一"吃 factor_scores 全量加权合成"的策略**；其余 12 个策略大多用 1-2 个核心因子的原始数据 + 自己的 DataSource 查 DailyBar / IndustryFlow / LimitUpStock 等，更"垂直"。

### B.3 信号产出节奏

| 节奏 | 触发 | 例子 |
|---|---|---|
| 每日横截面 | FactorPipeline 17:30 cron | 22 个 factor 全市场 z_score 写入 factor_scores |
| 每日 strategy | strategy.generateSignals(date) | DragonHead / Breakout / NorthboundFollow / LeftSide / Linkage / GameTraderRelay |
| 月度 strategy | caller 在月初触发 | MultiFactorAlpha / CTA100Momentum |
| 季度 strategy | caller 每日传，策略内部 gate | HighDividendValue |
| 半年度 strategy | caller 每日传，策略内部 gate | GARP |
| 事件驱动 strategy | caller 每日传，无事件时返回空 | EarningsSurprise |
| meta | EnsembleStrategy 每日按 regime 重选子策略集 | Ensemble |

---

## C. 现状 review（仓内代码）

### C.1 因子库现状

实际注册 22 个（不是 prompt 所说的 18 个，Batch AC 后扩展）：
- 文件: `backend/src/quant/factors/library/index.ts:30-51` 列出 22 个 import
- 8 个老因子 (US-010): value / quality / growth / momentum / low_vol / northbound / money_flow / dragon_tiger
- 10 个新因子 (US-029..US-091): liquidity / analyst_consensus / quality_high / earnings_surprise / momentum_reversal / east_money_qa / shareholder_concentration / gradual_breakout / insider_trade / margin_flow
- 4 个 Batch AC/AD: industry_momentum / concept_heat / fund_consensus / block_trade_signal

### C.2 Pipeline 现状

- 入口: `backend/src/quant/factors/FactorPipeline.ts:84-169`
- 串行调度 (`for (const factor of targets)` 第 119 行)，单因子失败不影响其他
- 横截面标准化: winsorize(1%, 99%) → zscore → percentile (`FactorPipeline.ts:198-208`)
- **已修 bug** (Batch Y, 2026-06-17): zscore 与 percentile 都基于 winsorized 数据 (`FactorPipeline.ts:192-208`)，之前 z 用 winsorized 但 percentile 用 raw 导致下游 MFA / Workspace 两套 top-30 不一致
- 中性补全: 缺数据股 raw_value=null, z_score=0, percentile=0.5 (`FactorPipeline.ts:246-256`)
- 默认 universe: 全 A 股 `is_listed=true` (`FactorPipeline.ts:285-305`)

### C.3 策略层现状

- 27 个 strategy 文件 (`backend/src/quant/strategies/`)
- 17 个 per-stock `evaluate()` 老策略 (technical indicator 类，MA/MACD/RSI/Bollinger/Donchian/Turtle/Minervini ...)
- 13 个组合级 `generateSignals(date)` 策略 — 完整列表见 `backend/src/quant/strategies/CLAUDE.md:35-49`
- 注册: `backend/src/quant/engine/StrategyRegistry.ts`

### C.4 ⚠️ 关键问题：组合级策略在回测引擎里默认"hold"

`backend/src/quant/backtest/internal/QuantBacktestEngine.ts:144-159` audit S-1 已经识别这个问题并加了 `precomputed_composite_signals` 注入路径：

```ts
const isCompositeStrategy = typeof (strategy as any).generateSignals === 'function';
const compositeSignalsForStrategy = options.precomputed_composite_signals?.[strategy.definition.strategy_key];
const useCompositePath = isCompositeStrategy && compositeSignalsForStrategy && ...;
if (isCompositeStrategy && !useCompositePath) {
  logger.warn(...组合级策略...这条路径在组合级策略上退化为 'hold' 信号导致 trade_count=0...);
}
```

但 **caller 层 (`QuantBacktestService.runBacktest`) 还没有自动在 backtest 启动时跑 generateSignals 预填这个 map**——所以回测 ad-hoc 跑组合级策略仍会得到 trade_count=0 + 警告日志。

### C.5 EnsembleStrategy / 市场环境 regime 现状

- `backend/src/quant/strategies/EnsembleStrategy.ts:1-826` 已实现 4 regime → 子策略组合，**LowVol 子策略未实现** → bear 环境降级到 HighDividend 独食
- `backend/src/services/MarketEnvironmentService.ts:204-263` 4-state HMM 已集成 (v5)，regime 输出 bull/bear/range/rebound/stress/unknown 6 类
- EnsembleStrategy 内部把这 6 类折叠到 AC 指定的 4 类 (bull/bear/range/volatile)

### C.6 QuantRecommendationService 的另一套权重（与 Alpha 引擎并行）

`backend/src/services/QuantRecommendationService.ts:376-431` 用 `getStyleWeights(style)` 给 5 维 (trend/volume/quality/valuation/risk + Batch AD 新加 today_burst/industry_regime) 静态加权，是**面向"前端推荐池"的另一条 alpha 通路**，不走 factor_scores 表。这条路径与 Alpha 引擎是**并行存在**关系，本系列文档不展开它的改造（属于上层 UX 路径）。

---

## D. 改造方案

### D.1 P0：补齐 backtest caller adapter 让组合级策略真能跑回测

**痛点**：13 个组合级策略中**只要没人手动构造 `precomputed_composite_signals`，跑回测就 trade_count=0**。

**user story**：
- 标题: 给 `QuantBacktestService.runBacktest` 加 "auto-precompute composite signals" 路径
- 描述:
  - 在 BacktestService 启动单个组合级策略 backtest 前，循环回测区间所有 rebalance dates，逐日调 `strategy.generateSignals(date, { previousSelection })` 累积 target_portfolio map，注入 `precomputed_composite_signals[strategy_key][date]` 后再进 BacktestEngine
  - previousSelection 在循环里自维护（前一日 target 作为下一日的 previousSelection）
  - 失败隔离：单日 generateSignals 抛错降级为空 target_portfolio + warning 日志
- 验收: 任意组合级策略 backtest 跑 2023-2025 不再 trade_count=0；rejected_orders 仍然有合理的 T+1/涨跌停/ST 拒单分布

### D.2 P1：因子注册数与 docs 同步

**痛点**：docs/CLAUDE.md 仍写"18 个 factor"，实际 22 个；factors/CLAUDE.md 也只列到 US-091（18 个）。

**user story**：
- 更新 `backend/src/quant/factors/CLAUDE.md` 的因子表追加 4 行（industry_momentum / concept_heat / fund_consensus / block_trade_signal）
- 更新 `library/index.ts` jsdoc 顶部的因子清单

### D.3 P2：因子分类（category）落到 FactorRegistry 上让前端可分桶

**痛点**：22 个 factor 当前在前端列表里平铺，没有按 value/quality/growth/momentum/flow/sentiment/event/liquidity 分组。

**user story**：
- factor.category 字段已存在（Factor 接口里就有），但 FactorRegistry.listByCategory() 还没暴露
- 加 `factorRegistry.listByCategory(): Map<category, Factor[]>`
- FactorScore 表加 `factor_category` 物化列（避免每次 JOIN）；factorPipeline 写入时同步填
- 前端 FactorWorkspace 按 category 折叠展示

### D.4 P2：因子血缘文档（哪些策略用了哪些因子）

每加一个策略，应在 strategy.definition.uses_factors 字段列出依赖；前端"策略画像"页可显示"本策略基于的 3 个核心因子 IC 是多少"。

---

## E. 验收口径

1. **完整性**: backtest 任意组合级策略，2023-01-01 ~ 2025-12-31 区间 trade_count > 0；rejected_orders 占比 < 20%（与现有 per-stock 策略一致）
2. **正确性**: 同一日 (date) 重复跑 `factorPipeline.runForDate` 与 `strategy.generateSignals`，输出 target_portfolio 完全一致（stable sort + idempotent）
3. **可观测性**: 任一交易日，前端能看到「22 个因子的覆盖率（universe 中有 raw_value 的占比）」「13 个组合级策略的 eligible_count + filtered 分布」「Ensemble 当日选用的 regime + 子策略权重 + degraded_substitutions」
4. **一致性**: `factor_scores.z_score` 与 `factor_scores.percentile` 排序结果完全一致（Batch Y 已修，加回归测试覆盖）
