# 00 — 总览：Signal-First ETF Core-Satellite 系统

> 本文档是 QuantX 量化系统的架构总览。
> 技术决策理由见 `docs/SIGNAL_FIRST_PLAN.md`（Signal-First 战略，§1-§9）。
> 操作手册见 `docs/USER_GUIDE.md`；工作台功能见 `docs/FUNCTION_GUIDE_AND_OPERATION_MANUAL.md`。

---

## 一、根本信念

> A 股的**个人投资者优势**不在于跑得快、信息更多，而在于**纪律与耐心**：敢于持有低估 ETF，拒绝追热点，让时间复利工作。

**旧信念（已废弃）**：多策略组合 + 严格风控 + 持续迭代  
**新信念（当前）**：Signal-First——只在有 EV 正期望值时才行动，Core 轮动机械化，Satellite 门槛极高。

核心目标：
1. **不爆仓**（年化最大回撤 ≤ 15%，Cash 10% 硬底）
2. **打得过基准**（年化超额 ≥ 沪深 300 + 5%）
3. **能解释**（每笔卫星交易能说出 EV 分解 + 3 条以上 evidence）
4. **可复盘**（月度战略镜子，4 层铁律）

---

## 二、系统架构：Core-Satellite

```
┌─────────────────────────────────────────────────────┐
│                   总仓位 = 100%                       │
├─────────────────────┬──────────────────┬────────────┤
│   Core  70%         │  Satellite  20%  │  Cash  10% │
│   ETF 因子轮动       │  题材/事件个股    │  硬底仓    │
│   月度机械换仓       │  EV gate 过滤    │  不可动用   │
│   4 因子综合分       │  Wilson 下界     │            │
└─────────────────────┴──────────────────┴────────────┘
```

### Core：ETF 四因子轮动

| 因子 | 权重 V0 | 状态 |
|---|---|---|
| Value（估值）| 0.40 | 主 |
| Quality（质量）| 0.30 | 主 |
| LowVol（低波）| 0.30 | 主 |
| Momentum（动量）| 0.00 | Shadow 只观察 |

每月最后交易日 22:00 计算 ETF 综合分排名；次月第一交易日 9:40 后执行：进 top4 买入、掉出 top6 卖出、其余持有。

### Satellite：EV gate 个股

卫星信号必须满足：

**EV = wilsonLower(胜率, 样本量) × 盈亏比 - 交易成本 > 0**

退出规则：硬止损 −15% / 止盈 +20% / 时间退出 21d（详见 `SIGNAL_FIRST_PLAN.md` §4.2）。

---

## 三、模块划分

| 模块 | 职责 | 关键文件 |
|---|---|---|
| 数据层 | 行情 / ETF 成分股 / 财报数据采集 | `01_data_sources_overview.md` |
| Alpha 引擎 | ETF 四因子计算、IC 监控、Shadow 因子管理 | `20_alpha_engine_overview.md`、`21_alpha_factor_library.md` |
| 组合构建 | Core/Satellite/Cash bucket 权重分配 | `40_portfolio_construction.md` |
| 仓位计算 | ETF ≤15%、个股 ≤5%、组合级熔断 | `41_position_sizing.md` |
| 换仓规则 | top4/top6 缓冲带、T+1 限制 | `42_rebalancing.md` |
| 卫星 Detector | EV gate + Wilson 下界 + 退出自动化 | `SIGNAL_FIRST_PLAN.md` §4 |
| 战略复盘 | 月度镜子 4 层铁律 | `docs/PROJECT_COMPASS.md`、`docs/compass/` |

---

## 四、重构历史

2026 年 6-7 月完成 Signal-First 重构：

| 批次 | 内容摘要 |
|---|---|
| 批1-4 | 删除日内策略、空壳层、社媒情绪数据源 |
| 批5-6 | ETF 因子化改造、EV gate 新建、ETF 轮动/卫星/退出服务 |
| 批7 | 前端装饰（Core-Satellite UI）、docs 重写（本文档）、战略镜子脚本 |
| 批8（计划中）| 旧策略数据库表物理删除（pg_dump 备份后）|

完整进度见 `docs/REFACTOR_PLAN.md`。

---

## 五、信息流（当前）

```
每月末
  AKShare → 日K线/成分股/ETF持仓 → DB
  DB → ETFRotationService.computeFactors() → etf_factor_scores
  etf_factor_scores → 换仓清单（Core bucket）

每日
  日K线更新 → SatelliteDetectors.detect()
  → EV gate 过滤 → satellite bucket 信号
  → 持仓退出检查（止损/止盈/时间）

月末
  bash scripts/compass/generate-draft.sh → docs/compass/YYYY-MM.md
  → 人工填写第3-4层 → git commit
```

---

*单独模块详见对应编号文档（`20_` ~ `42_`）。架构决策理由见 `docs/SIGNAL_FIRST_PLAN.md`。*
