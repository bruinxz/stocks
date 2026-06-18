# 30 — 策略总览（13 个组合级策略）

## A. 操盘手心智

"信号"和"持仓"不是一回事。同样一个"今天 PE < 15 的股票" 信号，可以：
- **多因子轮动**: 月度调仓 top-30，长持
- **价值长线**: 季度调仓 top-30，超长持（180+ 天）
- **波段交易**: 入场后 -5% 止损 / +15% 减半 / 持有期 15 天
- **事件确认**: 等到业绩公告超预期再进，60 天持

同一个 alpha 信号，不同的"持仓政策"产生完全不同的 sharpe / drawdown。**A 股要稳定盈利就必须多策略并行**：单一策略遇到 30 天逆风就归零，5 个独立风格策略能互补涨跌互掩。

每个策略要有清晰的：
1. **风格定位**（趋势/反转/价值/事件/资金/龙头）
2. **触发频率**（日/月/季/事件）
3. **入场维度**（4-5 个 AND 条件，不要单一信号入场）
4. **持仓 schema**（string[] / structured Position）
5. **出场规则**（A 时间硬限 / B 止损 / C 软信号）
6. **失效场景**（什么市场环境一定输）
7. **市场适用区间**（bull / bear / range / volatile）

---

## B. 系统设计

### B.1 13 个组合级策略风格分类

| 策略 | 风格 | 触发频率 | 入场维度 | 持仓 | 主要适用 regime |
|---|---|---|---|---|---|
| MultiFactorAlpha | 多因子 alpha | 月度 | 14 因子加权 | 30 只 | 全周期（核心）|
| DragonHeadMomentum | 短线龙头 | 每日 | 4 维 | 5 只 | bull / 题材主升浪 |
| Breakout | 趋势突破 | 每日 | 4 维 | 10 只 | bull |
| GameTraderRelay | 短线接力 | 每日 | 4 维 | 5 只 | bull / range（游资活跃）|
| LeftSideReversal | 反转 | 每日 | 5 维 | 10 只 | range / 大跌后 |
| Linkage | 题材联动 | 每日 | 5 维 | 5 只 | bull / range |
| EarningsSurprise | 事件 | 事件驱动 | 业绩+北向双确认 | 20 只 | 报告期 |
| NorthboundFollow | 资金跟随 | 每日 | 4 维 | 20 只 | 全周期（中性）|
| SectorRotationLeader | 行业轮动 | 每日 | 行业+个股 | 10 行业 × 2 = 20 | range / bull |
| HighDividendValue | 价值长线 | 季度 | 4 维（股息+PE+ROE+市值）| 30 只 | bear / volatile（防守）|
| GARP | 价值成长 | 半年度 | 4 维（PEG+ROE+负债）| 30 只 | volatile / bear |
| CTA100Momentum | 指数动量 | 月度 | 60-5 momentum | 中证 1000 内 top | bull |
| Ensemble | 多策略融合 | 每日 | meta vote | 由子策略决定 | 全周期（自适应）|

### B.2 每个策略的市场适用区间

```
            bull       range      volatile      bear
─────────────────────────────────────────────────────────
trend       DragonHead  Linkage              -
            Breakout    SectorRotation        -
            CTA100Mom              -          -
─────────────────────────────────────────────────────────
reversion   -          LeftSide    -          -
─────────────────────────────────────────────────────────
event       Earnings   Earnings   -           -
─────────────────────────────────────────────────────────
follow      Northbound Northbound GameTrader  -
            GameTrader GameTrader              -
─────────────────────────────────────────────────────────
value       MFA(轻仓)  MFA        GARP        HighDividend
                                  HighDividend GARP
─────────────────────────────────────────────────────────
meta        Ensemble   Ensemble   Ensemble    Ensemble
```

### B.3 Ensemble 加权机制（已实现）

`backend/src/quant/strategies/EnsembleStrategy.ts`：

```
| regime   | 子策略组合                                              |
|----------|--------------------------------------------------------|
| bull     | MFA 0.40 + DragonHead 0.30 + Breakout 0.30             |
| bear     | HighDividend 0.60 + LowVol 0.40 [LowVol 未实现，HD 独食] |
| range    | SectorRotation 0.40 + LeftSide 0.30 + Earnings 0.30    |
| volatile | GARP 0.50 + HighDividend 0.50                          |
```

**融合语义**: 加权 vote（不是仓位 quota）—— 每只入选股 vote = Σ(weight × indicator[in_target])，按 vote 降序选 top-N。优势：
- 子策略输出股票数不等不失衡
- 子策略全空（数据缺失）自动降级
- 多策略推荐同一只票 → 加分（共振信号）

### B.4 策略 style 字段（US-084 BenchmarkSelector）

每个策略 `definition.style` 字段决定基准指数：
- `small_cap_growth` → 中证 1000
- `mid_cap_balanced` → 中证 500
- `large_cap_value/growth` → 沪深 300
- `high_yield_defensive` → 上证指数
- `sector_rotation` → 沪深 300
- `multi_factor_alpha` → 沪深 300
- `momentum` → 沪深 300
- `mean_reversion` → 中证 500
- `low_volatility` → 沪深 300
- `short_term_event_driven` → 中证 1000
- `ensemble` → 沪深 300

---

## C. 现状 review

### C.1 13 个组合级策略文件位置

证据来自 `ls backend/src/quant/strategies/`:
- `MultiFactorAlphaStrategy.ts` 952 行
- `DragonHeadMomentumStrategy.ts` 1078 行
- `BreakoutStrategy.ts` 904 行
- `GameTraderRelayStrategy.ts`
- `LeftSideReversalStrategy.ts` 1001 行
- `LinkageStrategy.ts`
- `EarningsSurpriseStrategy.ts` 813 行
- `NorthboundFollowStrategy.ts` 785 行
- `SectorRotationLeaderStrategy.ts`
- `HighDividendValueStrategy.ts` 921 行
- `GARPStrategy.ts`
- `CTA100MomentumStrategy.ts`
- `EnsembleStrategy.ts` 826 行

### C.2 17 个 per-stock 老策略也在同目录

证据: `backend/src/quant/strategies/` 共 27 文件，扣除 13 组合级 + QuantStrategy 基类 = 13 个 per-stock 策略：MA / MACD / Donchian / Minervini / TrendPullback / BreakoutAtr / Turtle / VolatilityContraction / RelativeStrength / DualMomentum / QualityMomentum / VolumePrice / Bollinger / RsiMeanReversion / MultiFactorRanking / LowVolatilityQuality 等。

这些主要是技术指标类（用于 per-stock 评分），与组合级策略并存。

### C.3 style 字段已全部填好

证据: `grep -n "style:" backend/src/quant/strategies/*.ts` 显示 13 个组合级策略都有 style 字段，BenchmarkSelector 可自动选基准。

### C.4 ⚠️ LowVol 策略未实现

`EnsembleStrategy.ts` 注释明确写：bear 环境配置 HighDividend 0.6 + LowVol 0.4，但 LowVol 未实现，自动 fallback 把 0.4 合并到 HighDividend。**bear 环境策略组合是事实上的"单策略 HighDividend"**，alpha 失去 LowVol 的方差减少效果。

### C.5 ⚠️ 回测引擎里组合级策略默认 evaluate() hold

证据: `backend/src/quant/backtest/internal/QuantBacktestEngine.ts:144-159`，audit S-1 已识别但 caller layer 未自动 precompute。

### C.6 Ensemble 仍依赖手动 marketRegimeOverride 测试

`EnsembleStrategy.ts:553` 可注入 marketRegimeOverride 跳过 MarketEnvironmentService（DB 调用）；生产路径调 `getEnvironmentForStock('sh.000300')`。

### C.7 多策略各自的 default_params 已较合理

每个策略的 `DEFAULT_*_PARAMS` 都是 Object.freeze 常量 + AC 指定值；用户可 override。

---

## D. 改造方案

### D.1 P0：补齐 LowVolatilityStrategy 真组合级实现

**痛点**: 现有 `LowVolatilityQualityStrategy.ts` 是 per-stock evaluate() 形态，无法直接被 Ensemble 当组合级子策略调用。

**user story**：
- 新建 `backend/src/quant/strategies/LowVolStrategy.ts` 组合级形态
- 入场: 近 60 日 stddev(daily_returns) bottom 30% + 流通市值 > 50 亿 + ROE_avg > 8% + 非 ST
- 持仓: maxPositions=20，月度调仓
- 排序: stddev 升序 + dividend_yield 降序 + stock_code
- 出场: 持有 90 自然日到期 / -10% 止损
- 注册到 EnsembleStrategy 默认子策略池
- 验收: bear regime 真跑两个子策略（HighDividend + LowVol）；Ensemble degraded_substitutions 字段不再含 LowVol

### D.2 P0：补齐 backtest engine 的 composite auto-precompute（与 20_overview 联动）

详见 `20_alpha_engine_overview.md` D.1。所有组合级策略的回测都依赖此。

### D.3 P1：策略 capacity 估算 + alpha_decay 监测

**痛点**: 13 个策略上线后，没有量化"每个策略容量 5000 万够不够"、"alpha 是不是被 priced in 了在衰减"。

**user story**：
- 每个策略 daily snapshot 写 `strategy_capacity_estimate`（基于 ADV × 0.1% / position 数 / position 平均市值）
- 每月跑一次 `strategy_alpha_decay_report`: 用最近 30/90/180/365 日 sharpe 对比，下降 > 50% 触发 ALERT

### D.4 P1：策略 kill_switch_metric 真生效

证据: `MultiFactorAlphaStrategy.ts:481-483` `edge_hypothesis.kill_switch_metric = 'mean_test_sharpe_30d', threshold = 0.3`。
**当前没有 monitor 实际消费这个 metric**——指标说"kill switch threshold = 0.3"但不会真触发停策略。

**user story**：
- 每周 cron 算每个策略的 `mean_test_sharpe_30d`
- 跌破 kill_switch_threshold 自动 `definition.enabled = false`（写库 + 通知）
- 前端策略详情页显示"距 kill switch 还有多少缓冲"

### D.5 P2：补 3 个缺失风格的策略

- **小盘成长** (small_cap_growth) — 当前只有 CTA100Momentum，可补一个"小盘 ROE + 营收高增"
- **困境反转** (turnaround) — 与 turnaround 因子配对
- **新股次新** (ipo_freshman) — 与对应因子配对

### D.6 P2：策略热度版面（前端）

- 13 个组合级策略每日 eligible_count / target_size / filter 分布
- 横向对比哪个策略今天"出手最积极 / 最克制"
- 哪些股票被多个策略同时推荐（共振信号）

---

## E. 验收口径

1. **可用性**: 13 + 1 (LowVol) = 14 个组合级策略全部能跑 backtest 区间 > 100 trade
2. **风格独立**: 任意 30 日窗口，14 策略两两 corr ≤ 0.6（不要全部和大盘同涨同跌）
3. **regime 适用**: bull 月份 momentum 系策略 sharpe ≥ 1.0；bear 月份 HighDividend + LowVol 组合 sharpe ≥ 0.5
4. **kill_switch 生效**: 任意策略 mean_test_sharpe_30d < threshold 时自动 disable，48 小时内 ops 收到通知
5. **Ensemble 完整**: 任意 regime 切换日，子策略权重 + degraded_substitutions + 实际 target 全前端可见
