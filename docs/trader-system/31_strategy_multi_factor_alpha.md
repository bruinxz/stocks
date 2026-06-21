# 31 — MultiFactorAlpha 策略详解

## A. 操盘手心智

"多因子 alpha 月度轮动" 是量化最经典也最稳健的核心策略——把 14 个独立因子合成总分，按总分选 top-30，月度调仓，行业中性，长期跑赢沪深 300 5-8%。

但很多人做着做着踩进 3 个坑：
1. **权重硬编码不变**：市场风格切换时（动量失效 / 价值复活）继续按 6 个月前的权重，alpha 立刻归零
2. **月度调仓没做行业中性**：top-30 全挤进同一行业（如 2020 半导体），单一行业回撤就全军覆没
3. **调仓成本不算**：top-30 月度全换 = 100% 换手，年化 12 次 × 0.3% 成本 = -3.6% 净拖累，吃掉 alpha 一半

好的 MFA 策略要：
- **权重动态调** (IC weighted / regime aware / crowding adjust)
- **强制行业中性 + 市值中性**
- **持仓重叠率 ≥ 60%**（每月只换 30% × 30 = 9 只，不是全换 30 只）
- **capacity 估算清晰**（top-30 平均流通市值 × 0.1% 容量上限）

---

## B. 系统设计

### B.1 策略定义

- strategy_key: `multi_factor_alpha`
- style: `multi_factor_alpha` → 基准沪深 300
- 触发: 月度（caller 在每月第 1 个交易日调用）
- 持仓: string[] 30 只
- 出场: 月度调仓自然换仓；无止损（长线相信因子）

### B.2 入场流程

```
generateSignals(date, { params, previousSelection })
  ├─ resolveParams() 合并 default + override
  ├─ factorNames = Object.keys(weights).filter(w > 0)  # 14 个
  ├─ effectiveWeights = computeEffectiveWeights(weights, weightMode, icMap, icTimeSeries)
  │   ├─ 'static' → 原样
  │   ├─ 'equal' → 1/N
  │   ├─ 'ic_weighted' → max(0, ic_mean) per factor
  │   └─ 'crowding_adjusted' → static × crowding_multiplier ∈ [0.2, 1.0]
  ├─ normalizedWeights = normalizeWeights(effective) sum→1.0
  ├─ factorMap = dataSource.loadFactorScores(date, factorNames)  # ~5500 × 14 = 77k 行
  ├─ stockMeta = dataSource.loadStockMeta(universe)
  ├─ for stockCode in universe:
  │   composite = Σ z[factor] × weight[factor]
  │   if all z=0 (全缺数据) → filtered.no_factor_data += 1
  │   if ST → filtered.st += 1
  │   if 上市 < 60 自然日 → filtered.new60d += 1
  │   else → candidates.push({ stock_code, meta, composite, factor_z_scores })
  ├─ candidates.sort(composite DESC, stock_code ASC)
  ├─ industry-neutral cap: 选 top-N where 每行业 ≤ maxPerIndustry(3)
  └─ diff vs previousSelection → BUY/SELL/HOLD 信号
```

### B.3 默认参数

```ts
DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS = {
  value: 0.084, quality: 0.084, growth: 0.084, momentum: 0.084,
  low_vol: 0.067, northbound: 0.067, money_flow: 0.067, dragon_tiger: 0.067,
  quality_high: 0.059, analyst_consensus: 0.059,
  east_money_qa: 0.05, momentum_reversal: 0.067,
  industry_momentum: 0.10, concept_heat: 0.06,
}

default_params = {
  topN: 30,
  rebalancePeriod: 'monthly',
  industryNeutral: true,
  maxPerIndustry: 3,
  excludeST: true,
  excludeNew60d: true,
  weightMode: 'static',  // 可切 equal / ic_weighted / crowding_adjusted
  icLookForwardDays: 20,
  icLookbackDays: 90,
}
```

### B.4 weightMode 4 种模式

证据见 `MultiFactorAlphaStrategy.ts:796-889` `computeEffectiveWeights`：

- **static**: 默认；返回 staticWeights 浅拷贝
- **equal**: 所有正权重因子赋 1.0（归一化后 1/N）
- **ic_weighted**: per-factor `out[name] = (ic > 0 ? ic : staticWeights[name])`；整体 fallback：所有因子无正 IC → 整体回退 static
- **crowding_adjusted** (Sprint 44-B): `out[name] = staticWeights[name] × crowdingMultiplier`；缺时序回退 static

---

## C. 现状 review

### C.1 已实现的部分

证据：`backend/src/quant/strategies/MultiFactorAlphaStrategy.ts`（952 行）：
- 14 因子默认权重 sum=1.0（`L:88-106`）
- DataSource 接口 4 个 loader（loadFactorScores / loadStockMeta / loadRecentFactorICs / loadFactorICTimeSeries）
- 4 种 weightMode 实现（`L:796-889`）
- 行业中性 cap（`L:646-661`）
- BUY/SELL/HOLD 增量信号计算（`L:668-707`）
- 稳定排序 (composite DESC + stock_code ASC `L:640-643`)
- 中性补全 z=0 处理 (`L:606-616`)
- 17 个测试用例，60+ 断言 (`backend/tests/strategies/MultiFactorAlphaStrategy.test.ts`)

### C.2 ⚠️ default weightMode='static' 但权重不感知 regime

整个 generateSignals 函数不读 MarketEnvironmentService — 任何 regime 都用同一套权重。
- bull 应该重 momentum / industry_momentum / dragon_tiger
- bear 应该重 low_vol / dividend_yield / quality_high
- 当前一刀切 → bear 月份 alpha 大概率为负

### C.3 ⚠️ 是否真月度调仓 — caller 自管理

`rebalancePeriod='monthly'` 字段是 metadata，generateSignals **不检查** tradeDate 是不是月初。调用方必须自己在每月第 1 个交易日触发，否则每日都调会出现"月内换手 N 次"。

HighDividend / GARP 是把 gate 写在 DataSource 内部（isFirstTradingDayOfQuarter / SemiAnnual），但 MFA 没有 monthly gate — 调用方责任。

### C.4 ⚠️ 调仓成本未估算 / 未控制

generateSignals 计算 BUY/SELL/HOLD 增量后没有 "本月预估换手率 × 成本" 估算；用户拿到 target_portfolio 不知道月度换手是 30% 还是 100%。

### C.5 ⚠️ 因子全缺数据剔除条件过严

`L:614-616` `if coveredFactorCount === 0 → filtered.no_factor_data`。但只要 1 个因子有 z_score ≠ 0 就通过。次新股可能只有 momentum 有效，其余全 0，composite 会被极度低估但仍然进 candidates。

更合理: 加 `minFactorCoverage` 参数（默认 5），少于 5 个因子有数据的股票剔除（避免 single-factor 噪音主导）。

### C.6 ⚠️ Capacity 估算缺

generateSignals 输出无 capacity 估算 — 用户跑 backtest 报 alpha=8%，实盘可能因 top-30 平均流通市值才 50 亿（× 0.1% = 500 万），实盘 5000 万入场就把价格打 1% 走，alpha 立刻 -1%。

### C.7 卖出条件过简

非月度调仓日完全不动持仓；如果某只股月内出 ST 公告 / 退市预警 / 黑天鹅，MFA 当月不会卖。靠风控层 (PaperTradingFacade + KillSwitch) 兜底，但策略层缺"事件触发卖出"通道。

---

## D. 改造方案

### D.1 P0：加 regime-aware weightMode

**user story**：
- weightMode 新增 'regime_aware' 模式
- params 加 `regimeWeights: Record<regime, Record<factor, weight>>`
- generateSignals 调 marketEnvironmentService 拿 regime（缓存当日同一 regime 不重查）
- 验收: bull / bear 切换日 top-30 换手 ≥ 30%；动量因子在 bull 时权重 ≥ 0.3

### D.2 P0：加 minFactorCoverage 过滤

**user story**：
- params 加 `minFactorCoverage: number`（默认 5）
- candidates 阶段加 `if coveredFactorCount < minFactorCoverage → filtered.insufficient_coverage`
- 验收: 上市 < 90 自然日的次新股几乎全被剔除（缺 momentum / low_vol / IC 类因子）

### D.3 P1：加月度调仓 gate（与 HighDividend 同款）

**user story**：
- DataSource 加 `isFirstTradingDayOfMonth(tradeDate)` loader
- generateSignals 开头判断：非调仓日 → 返回 `is_rebalance_day=false, target_portfolio=previousSelection, signals=[]`
- 调用方可 fearlessly 每日调用
- 验收: 月内重复调用 generateSignals 10 次，BUY/SELL signal count = 0

### D.4 P1：调仓成本估算 + 换手率监测

**user story**：
- generateSignals 输出加 `expected_turnover_pct`, `expected_cost_bps`（基于 BUY/SELL stock 数与平均仓位）
- 累计写入 `quant_strategy_turnover_history` 表
- 单月换手率 > 60% 触发飞书 ALERT（"权重剧烈漂移"）

### D.5 P1：Capacity 估算字段

**user story**：
- generateSignals 输出加 `capacity_estimate: { liquidity_floor: number, total_capacity: number }`
- liquidity_floor = top-30 中最小 ADV × 1%；total_capacity = liquidity_floor × N positions
- 前端"策略容量"页面展示，红字提示"实盘资金 > 容量 → 滑点风险"

### D.6 P1：卖出条件细化

**user story**：
- 月内事件触发卖出通道：策略增加 `evaluateEventExits(currentPositions)` 方法，每日扫一遍持仓的 ST 公告 / 退市预警 / 大额减持公告
- 触发即在月内信号里加 SELL（不等月初）
- 卖出原因写入 reason 字段（"中途触发 ST 卖出"）

### D.7 P2：动态 topN（按市场状态）

**user story**：
- bull 时 topN=30；bear 时 topN=15（仓位减半）
- volatile 时 topN=30 但 maxPerIndustry=2（更分散）

---

## E. 验收口径

1. **稳定性**: 同 (date, params, previousSelection) 重跑 generateSignals 输出完全一致
2. **行业分散**: 任意 target_portfolio 单行业占比 ≤ 10%（top-30 × maxPerIndustry=3 / 30 = 10%）
3. **换手可控**: 6 个月月度调仓平均换手率 ∈ [20%, 50%]；> 60% 触发告警
4. **regime 切换有效**: bull → bear regime 切换月 top-30 换手 ≥ 30%（证明权重真切换）
5. **成本透明**: 每次 generateSignals 输出含 expected_turnover_pct + capacity_estimate；UI 可见
6. **回测可跑**: backtest 2023-2025 区间 trade_count > 1000；alpha vs 沪深 300 ≥ +5%/year；max_dd < 18%
