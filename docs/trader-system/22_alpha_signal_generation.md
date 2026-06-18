# 22 — Alpha 信号生成 Pipeline

## A. 操盘手心智

因子是"原料"，信号是"成品"。一个好的信号 pipeline 要满足：
1. **横截面可比**：今天 5000 只股票的 PE 和北向流入差异巨大，必须 winsorize + zscore + percentile 三连，才能和其他因子合成有意义的总分。
2. **跨日稳定**：今天 stockA 的 z_score = 1.2，明天 z_score = 1.18，是稳定的；不是今天 1.2 明天 -3。
3. **缺数据可控**：22 个因子覆盖率参差，某些只有 30%；缺数据股要走"中性补全"（z=0, percentile=0.5）而不是被剔除。
4. **可幂等重跑**：同一天重跑 pipeline，写入 factor_scores 完全一致，下游对账才能稳。
5. **regime-aware**：牛市动量因子权重应高于熊市；如果"权重 = 静态硬编码"，等于忽略市场状态。

---

## B. 系统设计

### B.1 FactorPipeline.runForDate 流程

```
runForDate(tradeDate, factorNames[], options)
  ├─ resolve universe (默认 = stocks where is_listed=true，约 5500 只)
  ├─ for each factor in factorNames:
  │   ├─ factor.compute(ctx) → Map<stock_code, raw_value>
  │   ├─ 过滤 null / NaN / Infinity → cleanedPairs
  │   ├─ winsorize(1%, 99%) → winsorized
  │   ├─ zscore(winsorized) → zScores[i]
  │   ├─ percentileRanks(winsorized) → percentiles[i]
  │   ├─ 对 universe 中缺数据的 stock 补 (raw=null, z=0, pct=0.5)
  │   └─ bulkCreate FactorScore + updateOnDuplicate
  └─ 返回 { trade_date, universe_size, factor_results[], total_upserted, total_failed }
```

### B.2 横截面标准化三件套

- **winsorize(values, 1%-99%)**: 截掉极端值（小盘股 PE = 800 / 流动性 = 30% turn 等噪音），让 z_score 不被尾部样本主导
- **zscore(values)**: `(x - mean) / std`，让因子值无量纲、可加权合成
- **percentileRanks(values)**: 0~1 的分位数；UI 友好（"该股 PE 在全市场前 10%"）

**重要修正 (Batch Y, 2026-06-17 fact-1)**: 之前 zscore 用 winsorized，percentile 用 raw，导致同一只股票 z 排序 ≠ percentile 排序。修复后两者都用 winsorized，下游 MFA（用 z）与 FactorWorkspace（用 pct）的 top-N 一致。证据: `backend/src/quant/factors/FactorPipeline.ts:192-208`。

### B.3 加权方案

下游策略对 factor_scores 的"加权使用"分 3 大类：

#### B.3.1 MultiFactorAlpha 加权合成（最复杂）

`backend/src/quant/strategies/MultiFactorAlphaStrategy.ts:88-106` 的 `DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS`（14 因子）：

```
value=0.084  quality=0.084  growth=0.084  momentum=0.084
low_vol=0.067  northbound=0.067  money_flow=0.067  dragon_tiger=0.067
quality_high=0.059  analyst_consensus=0.059
east_money_qa=0.05  momentum_reversal=0.067
industry_momentum=0.1  concept_heat=0.06   # Batch AC 新增
```

每只股票的 `composite_score = Σ (z_score[factor] × weight[factor])`，按 composite_score 降序选 top-30。

**4 种 weightMode**（已实现）：
- `static`: 默认，用 `params.weights` 原值（向后兼容 US-011）
- `equal`: 所有正权重因子一律 1/N
- `ic_weighted`: 查 FactorICResult 表近 90 日 ic_mean (look_forward_days=20)，权重 = max(0, ic_mean)；缺数据回退 static
- `crowding_adjusted` (Sprint 44-B): 用 FactorOrthogonalizationService.computeCrowdingScore 算"拥挤度"，crowded 因子降权 0.2-1.0×

#### B.3.2 单因子策略（DragonHead / NorthboundFollow / 等）

直接读单一数据源 (LimitUpStock / NorthboundHolding / IndustryFlow ...)，不走 factor_scores 表也不做合成；属于"自己当 factor 自己用"模式。

#### B.3.3 Ensemble vote 投票

EnsembleStrategy 不做因子加权，做**策略加权投票**：每只股的 vote = Σ(strategy_weight × indicator[in_target])，按 vote 降序选 top-N。

### B.4 regime-aware 加权（理想）vs 现状（部分实现）

**理想**: factor weight 应该按 market regime 切换 — 例如：

| regime | value | momentum | low_vol | northbound | dragon_tiger |
|---|---|---|---|---|---|
| bull | 0.08 | 0.18 | 0.05 | 0.10 | 0.10 |
| bear | 0.10 | 0.05 | 0.18 | 0.05 | 0.04 |
| range | 0.10 | 0.10 | 0.10 | 0.10 | 0.08 |
| volatile | 0.05 | 0.05 | 0.15 | 0.05 | 0.05 |

**现状**: MultiFactorAlphaStrategy 内部**没有 regime-aware 加权**，只有 EnsembleStrategy 在**策略级**做 regime → 子策略组合切换（不是因子级）。

---

## C. 现状 review

### C.1 Pipeline 串行调度

证据: `backend/src/quant/factors/FactorPipeline.ts:119` `for (const factor of targets)` — 串行。
设计理由（CLAUDE.md）: 并行收益小（单因子 < 1s）+ 串行日志可读 + 失败不影响别的。

### C.2 中性补全

`FactorPipeline.ts:246-256` 对 universe 中没出现在 compute 输出的 stock_code 补 (raw=null, z=0, percentile=0.5)。

**好处**: 下游 MFA 不需要 LEFT JOIN，每个 (date, stock, factor) 都有行；缺数据股票 z=0 自然不贡献到 composite_score。

**坏处**: 看 percentile=0.5 分不出"真中位数股"和"缺数据股"；要看 raw_value 是否为 null 才能区分。

### C.3 写入策略 bulkCreate + updateOnDuplicate

证据: `FactorPipeline.ts:261-263`，幂等写入。同一日重跑 = 同样结果（依赖 winsorize/zscore 实现 deterministic — 当前实现是 array sort + index，所以是 deterministic 的）。

### C.4 权重当前是硬编码 + 用户传入

`MultiFactorAlphaStrategy.ts:88-106` DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS 是 Object.freeze 的硬编码常量。用户可通过 `params.weights` override，但**不存在"按当日 regime 自动重选权重表"路径**。

### C.5 ic_weighted 模式已实现但生产可能未用

证据: `MultiFactorAlphaStrategy.ts:540-548` weightMode='ic_weighted' 路径，调 `dataSource.loadRecentFactorICs(...)` 查 FactorICResult 表。但 `definition.default_params.weightMode = 'static'`（第 460 行），生产默认走静态权重。

### C.6 crowding_adjusted 模式 (Sprint 44-B) 已实现

证据: `MultiFactorAlphaStrategy.ts:838-883`，调 `computeCrowdingScore` 给 crowded 因子降权 (multiplier ∈ [0.2, 1.0])。但同样 default 不开启。

### C.7 ⚠️ MFA 不感知市场 regime

`MultiFactorAlphaStrategy.generateSignals` 整个函数不读 MarketEnvironmentService，等于"任何 regime 都用同一套权重"。EnsembleStrategy 才在更高层做 regime → 子策略组合切换。

---

## D. 改造方案

### D.1 P0：MFA 加 regime-aware weightMode

**user story**：
- 标题: MFA 新增 `weightMode='regime_aware'`
- 描述:
  - 入参增加 `params.regimeWeights: Record<regime, Record<factor, weight>>` 4 张子表
  - generateSignals 内部调 `marketEnvironmentService.getEnvironmentForStock('sh.000300', { as_of: tradeDate })` 拿到当日 regime
  - 用 `regimeWeights[regime]` 当 staticWeights 走 normalizeWeights
  - 缺 regime 配置时回退 default（向后兼容）
- 验收: bull regime 时动量类因子（momentum / momentum_reversal / gradual_breakout / industry_momentum）权重总和 ≥ 0.35；bear regime 时低波/红利类（low_vol + dividend_yield 当上线后）≥ 0.30；切 regime 后 top-30 应有 ≥ 20% 换手

### D.2 P0：把"权重当前 effective 是什么"暴露到前端

**痛点**: 用户看到 MFA 跑出 top-30，不知道是 static / equal / ic_weighted 哪个模式跑的，不知道 4 种 weightMode 之间结果差多少。

**user story**：
- generateSignals 返回 result 加 `effective_weights: Record<factor, weight>`（用户可以看到实际生效的权重）
- 前端 FactorWorkspace 加"权重模式对比"按钮：同一天 4 种模式各跑一遍 top-30 对比

### D.3 P1：FactorPipeline 加 quality control 报警

**痛点**: 某天某 factor 覆盖率突然从 50% 跌到 5%（数据源挂了），pipeline 不会自动报警，下游 MFA 当作"中性补全"全跑出失真结果。

**user story**：
- runForDate 完成后，对比每个 factor 的本日 `effective` 数与近 30 日平均 `effective` 数；下降 > 50% 触发 RiskAlert
- skipFactors 跑出 = 0 effective 时也告警（说明因子完全失败）

### D.4 P1：FactorScore 落库添加 source 字段细分

**痛点**: 当前 source 字段固定为 `'pipeline'`，无法区分"原值"vs"中性补全"。

**user story**：
- source 改为 `'pipeline_raw' / 'pipeline_neutral'` 二分，让下游 query 可以 `WHERE source = 'pipeline_raw'` 只看真有效数据
- factor_coverage 物化视图: 每日每因子的 raw / neutral 比例

### D.5 P2：normalization 模块加 robust z-score（替代均值/标准差用 median/MAD）

**痛点**: 极端事件日（如熔断日）winsorize 1%/99% 还不够，单 z_score 仍可能爆 ±5；MAD 抗极端值更好。

---

## E. 验收口径

1. **稳定性**: 同 (date, factorNames, universe) 重跑 runForDate，factor_scores 表完全一致
2. **regime 切换可见**: bull / bear 切换日，MFA top-30 换手 ≥ 30%（证明权重真切换了）
3. **覆盖率监测**: 22 个因子 effective_ratio 30 日 rolling 均值都 ≥ 30%，单日跌破 15% 自动告警
4. **多模式产出对比**: 4 种 weightMode 跑同一天 MFA，top-30 至少 60% 重合（核心 alpha 一致）但又有 20-30% 差异（模式有区分价值）
