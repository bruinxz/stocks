# 20 — Alpha 引擎总览（ETF 因子轮动主线）

> 本文档已随「Signal-First + 核心-卫星」重构改写。旧的「22 因子 / 多策略 / 个股横截面信号工厂」架构已删除，主线收敛为 **ETF 因子轮动 (核心 70%) + 题材事件驱动 (卫星 20%) + 现金 (10%)**。决策依据见 `docs/SIGNAL_FIRST_PLAN.md` §4；本文只讲工程实现。

## A. 操盘手心智

散户中频拍板个股长期难赢（JFQA 2025）。所以 Alpha 引擎不再赌「今天 5000 只股票每只该怎么办」，而是只做一件被学术支撑的事——**机械化地在几十只 ETF 里做因子轮动**，把情绪从选股里彻底剥掉：

1. **核心是 ETF，不是个股**。ETF 一篮子成分股，天然分散，月度换手，波动小到不需要单笔止损。个股只在卫星层（20% 硬上限）以题材事件方式参与。
2. **因子有经济学锚**。只用有 JFE/JAM/MSCI 论文支撑的 Value / Quality / LowVol 三个主因子；Momentum 因子降级为 shadow（权重 0，只观察不入实盘），因为 Hsu et al. (2017) 证明 A 股短期动量会反转。
3. **信号只产出，不下单**。引擎产出「本月该持有哪 4-6 只 ETF + 各占多少仓位」，交给 gate → sizing → 执行落地。引擎不碰仓位、不碰风控。
4. **可信度回灌回测**。同一份信号灌回回测，回答「这信号可不可信」——成本后年化 ≥ 10%、最大回撤 ≤ 25%、换手 ≤ 200%/年 才允许上线。

> ⚠️ **证据迁移警告**：A 股股票因子有效 ≠ ETF 能稳定捕获同等 alpha。ETF 受跟踪误差、成分调整、规模流动性、折溢价、上市时间、幸存者偏差影响。因此回测必须用真实可交易 ETF 历史价（含分红调整）、point-in-time 成分/财报、真实交易成本，并做成本翻倍压力测试。（详见 §4.1 回测 P0 硬约束）

---

## B. 系统设计

### B.1 主线数据流（信号工厂）

```
┌────────────────────────────────────────────────────────────────┐
│  Layer 1 — ETF 因子层                                            │
│   ETFConstituentExpander: ETF → 成分股 (index_components /       │
│     fund_top_holdings fallback, point-in-time 月末快照)          │
│   ETFFactorService: 每只 ETF 的 value/quality/lowvol/mom(shadow) │
│     raw + z + total_score (§4.1 口径)                            │
│   quant/etf/                                                     │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│  Layer 2 — 排名 + 换仓层                                          │
│   ETFRankingService (纯函数): total_score 排名 → top4 买/top6 卖  │
│     缓冲带 → BUY/SELL/HOLD + 目标权重 (70% 硬顶 + 单只 15% 封顶)  │
│   ETFRotationStrategy: 封装成 QuantStrategy.generateSignals()    │
│   quant/etf/ · quant/strategies/                                 │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│  Layer 3 — 信号落库 + 可信度层                                    │
│   ETFRotationService: 月度编排 → 附 confidence (Wilson 下界) →   │
│     生成 rebalance_id → 落 AIInvestmentSignal (action=           │
│     TARGET_WEIGHT, target_pct, rebalance_id)                     │
│   ConfidenceCalibrationService: source_type 分组真实胜率校准     │
│   services/etf/ · services/calibration/                          │
└────────────────────────────────────────────────────────────────┘
                              ↓
              gate (§5.2 L1/L2/L3) → sizing → 执行
```

### B.2 关键模块清单

| 模块 | 路径 | 职责 |
|---|---|---|
| `ETFConstituentExpander` | `backend/src/quant/etf/` | ETF → 成分股展开（跟踪指数 + 基金前十 fallback），point-in-time 月末快照 |
| `ETFFactorService` | `backend/src/quant/etf/` | 四因子打分：Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0 shadow |
| `ETFRankingService` | `backend/src/quant/etf/` | 纯函数：排名 → top4 买 / top6 卖缓冲带 → 目标权重（70% 硬顶 + 15% 封顶） |
| `ETFRotationStrategy` | `backend/src/quant/strategies/` | 把打分 + 排名封装成 `QuantStrategy.generateSignals(asOf)` |
| `ETFRotationService` | `backend/src/services/etf/` | 月度编排、附 confidence、生成 rebalance_id、落 `AIInvestmentSignal` |
| `ConfidenceCalibrationService` | `backend/src/services/calibration/` | Wilson 下界 confidence + 5 项校准指标（§5.1） |

> **注册表瘦身 (D10-A)**：`quant/engine/` 的 `StrategyRegistry`/`StrategyEngine` 骨架保留（7 关回测 / PaperTrading / 绩效看板反向依赖），但注册表只剩 1 个 ETF 因子策略；原 29 个个股策略 + `QuantFusionService` 已删。

### B.3 因子权重 V0

| 因子 | 权重 V0 | 状态 | 计算口径（详见 21_alpha_factor_library.md） |
|---|---|---|---|
| Value | **0.40** | 主 | 成分股 z(1/pb)+z(1/pe_ttm)+z(dividend_yield) → 成分权重加权 → ETF 层 |
| Quality | **0.30** | 主 | 成分股 z(roe)+z(-stddev_5y_net_profit)+z(roe_5y_avg) → 加权 → ETF 层 |
| LowVol | **0.30** | 主 | ETF 层直接算 z(-vol_60d)×0.6 + z(-vol_20d)×0.4（不下沉成分股） |
| Momentum | **0.0 (shadow)** | 观察 | ETF 层 z(return_20d) − z(return_5d)×0.3，单独存不入 total_score |

`ETF_FACTOR_WEIGHTS_V0` 是 candidate，不是已验证结论。允许在保守权重网格 {(0.4/0.3/0.3), (0.35/0.35/0.3), (0.5/0.25/0.25)} 上做敏感性验证，**禁止追求最优参数**（会过拟合）；若网格差异 < 2% 年化则取最保守组。

### B.4 综合分公式

```
etf_total_score(t) =
    0.40 × z(etf_value_raw)
  + 0.30 × z(etf_quality_raw)
  + 0.30 × z(etf_lowvol_raw)
  + 0.00 × z(etf_momentum_raw)   -- shadow only
```

### B.5 触发时机

- 计算：每月最后交易日 22:00（`SchedulerService` cron `ETF_FACTOR_ROTATION_REBALANCE`）
- 执行：次月第一交易日 9:40 后分批限价 / VWAP（执行细节见 42_rebalancing.md）
- 幂等：`findOrCreate` by (source_type=`etf_factor_rotation`, source_id=`etf_<code>_<rebalance_id>`)，`rebalance_id = rebalance-YYYY-MM`

---

## C. 边界（引擎不做什么）

- **不下单**：只产 `AIInvestmentSignal`，下单由 PaperTrading / 执行层负责
- **不做个股信号**：个股只在卫星层以题材事件驱动（见 22 卫星文档 / §4.2）
- **ETF 组合级不设单笔止损止盈**：波动小，月度换仓足够风控；组合级 PR-L 熔断保留
- **不用 EV gate**：核心 ETF 跳过 L4 EV gate（月度因子排名替代），但必须过 L1/L2/L3（§5.2）
