# 交付物 B · Strategy 章节 v0.1

> **状态**：DRAFT v0.1 · 数据源无关部分（等 li-yiming 数据访问方式拍板 + Research 参考项目通读后再补融合决策表 + 具体基线数字）
> **Author**：@Strategy · **Date**：2026-07-07（首次挪入）
> **归口**：`docs/refactor/50-strategy-design.md`（Orchestrator M0 骨架 msg=90f087a8 §5 authorize · Strategy 独占 50-59 段）
> **依赖**：`docs/refactor/00-anchor.md` · `docs/refactor/10-contracts.md` · `docs/refactor/adr/0001-layering-and-collab.md` · `SIGNAL_FIRST_PLAN.md` · `PROJECT_COMPASS.md`
> **兄弟锚点**：
>   - `docs/refactor/contracts/strategy.md` v0（下游给 Frontend）
>   - `docs/refactor/contracts/data.md` v0（上游 DataPipeline）
>   - `docs/refactor/contracts/data-fixture-spec.md` C7（DataPipeline v0.5 + QADocs matrix + §11.1 反例）
>   - `docs/refactor/contracts/backtest.md §Gate Negative Coverage`（QADocs 独占，含 base matrix + weight_scheme 双层）

---

## §1. 荐股策略设计（Strategy owns）

### §1.1 系统定位
「降低情绪化 + 系统化风控 + 部分捕获因子 alpha」——**不宣称跑赢基准**（JFQA 2025 证据支持）。荐股 = 投资建议范畴，**输出必带风险提示，禁绝对收益承诺**。

### §1.2 因子体系 v0

#### §1.2.1 组织形态（已成熟，重构后保留）
- `backend/src/quant/factors/library/<NameFactor>.ts` **一因子一文件**
- `FactorRegistry` 单例注册；同名因子禁重复注册
- `FactorPipeline` 稀疏 Map → 中性填补 → 正规化（zscore / percentile / decile）
- `_helpers.ts` `_` 前缀 = library 内部；不允许 controller 直接 import
- **因子内部不做 winsorize / zscore**（例外：横截面参照类）——由 pipeline 统一做

#### §1.2.2 现役因子清单（18 个已注册）
（Research 目录树 v0 到位后逐个列名 + 分类）
- 价值类（Value）：待列
- 质量类（Quality）：待列
- 低波类（LowVol）：待列
- 动量/反转类（Momentum/Reversal）：`momentum_reversal` 已按 A 股独立设计
- 成长类（Growth）：`GrowthFactor`
- 情绪/交易类：`AnalystConsensusFactor` / `EarningsSurpriseFactor` / `EastMoneyQAFactor` / `GradualBreakoutFactor` / `InsiderTradeFactor` / `LiquidityFactor` / `MarginFlowFactor` / `NorthboundFactor` / `QualityHighFactor` / `ShareholderConcentrationFactor`
- 待补：`AS-IS 现役因子明细表`（Research 21-current-audit 后我逐一给分类 + 数据依赖 + 逻辑 + 单测覆盖）

#### §1.2.3 因子权重锁（V0 §11.1 已锚定，本轮不动）
核心 70% ETF 因子轮动：
- **Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0（shadow）**
- 依据：Hsu 2017 A 股短期反转 → Momentum 上核心会拖短线化
- Momentum 只走 walk-forward，6 月后再评估
- **禁追求最优参数** → 保守权重 + 网格敏感性验证
- **红线**（Orchestrator msg=2a86337a · ADR-0001 §10.8）：§11.1 权重（V0）合规验证锚点仅走真实历史数据；**禁使用 fake DataSource fixture 结果作为过关证据**。fake fixture 仅用于 gate 基础设施 CI 冒烟（`fixture_ref_alpha` known-pass 教具 + `fixture_ref_*` 反例被拒），不承诺 §11.1 过关。QADocs §10.8 静态扫描断言 `test_gate_g6_regime.py::test_ref_strategy_11_1_weight_compliance` 禁引用 `fixture_ref_*` 全域（base + weight_scheme 两层）导入侧。

#### §1.2.4 扩展性设计（plugin 化 · 硬性原则 §5）
- 新因子入库：写 `library/<NameFactor>.ts` + `FactorRegistry.register()` + 单测 `tests/factors/<NameFactor>.test.ts`
- 无需改核心链路
- **待明确的插件契约**：`interface Factor { name; compute(universe, as_of_date): Map<stock_code, raw_value> }` + jsdoc 强制字段（category / description / data_dependency / lookback_days / is_proxy?）
- 代理记号（proxy）显式标注，禁 `= 0` placeholder

### §1.3 信号体系 v0

#### §1.3.1 Signal 原子结构 v3（已成熟）
5 核心字段：`symbol / action / timestamp / confidence / source_detector`
+ `lifecycle_id / theme_id / rebalance_id / target_pct`
+ 自动化层：`expected_value / recommended_size_pct / entry_price_strategy / stop_loss_pct / take_profit_pct / gate_pass / gate_reason`

**confidence 硬约束**：必须是 **90 天真实胜率**，非规则打分（QuantFusion 教训：95 笔 0% 实盘）
- Wilson 下界 α=0.10 · n_samples < 20 强制纸面
- 按 regime 分层
- `ConfidenceCalibrationService`（新建模块，未落地）

#### §1.3.2 三 ID 命名规范
- 格式：`<type>-<key>-<yyyymmdd[hhmm]>` 人类可读，**禁 nanoid / UUID**
- `lifecycle_id` 每次 BUY 新 id
- `rebalance_id = rebalance-YYYY-MM`
- `theme_id = <industry_slug>-<launch_date>`

#### §1.3.3 Gate 4 层
- **L1 eligibility**（禁 ST / 停牌 / 上市 < 180 天 / 日均成交 < 2000 万）
- **L2 risk**（60 天滚动亏损 > 5% 冻结 30 天；连 3 月 alpha < 0 永久停；单只 -15% 硬止损；-7% 主动缓冲；PR-L 政策黑天鹅例外通道保留）
- **L3 cost**（双边佣金万 2.5 + 卖出千 1 印花税 + 双边万 0.1 过户费）
- **L4 EV**：`confidence × avg_win - (1-confidence) × avg_loss ≥ 0.5%`
- **核心 ETF 跳 L4，卫星必过全 4**

### §1.4 选股策略架构（Signals-First §11.1）

#### §1.4.1 核心 / 卫星 / 现金 三层
- **核心 70%**：ETF 因子轮动（V0 §11.1 权重）；raw_w × 70% 缩放 → min(scaled, 15%) 单只封顶 → 溢出再分配；总硬顶 70%
- **卫星 20%**：题材/事件驱动；目标 3-4 只；单只 5% 上限；60 天硬边界
- **现金 10%**：底仓
- 执行价：核心 ETF 走 **9:40 VWAP 分批限价**，不走集合竞价 9:25（吃开盘价差 + 折溢价噪音）
- **A 股 T+1** 只针对卫星题材股，ETF 不受此约束

#### §1.4.2 组合级策略 caller-prefetch 契约
- 实现 `generateSignals(date)` 的策略必须由 caller 预取信号填 `precomputed_composite_signals[strategy_key]`
- 否则引擎退化 hold
- META-TEST `tests/quant/composite_backtest_all_strategies.test.ts` 自动覆盖 13 个组合级策略

### §1.5 可解释性设计 · 「三同」（硬性原则 §7 + li-yiming brief 领域重点）

#### §1.5.1 三同定义
- **同 Signal 契约** — 回测 / 纸面 / 实盘同结构、同字段
- **同执行假设** — 佣金 / 印花税 / 过户费 / 滑点 / 执行价 同模型
- **同归因口径** — 每笔 PnL 分解 = 信号 alpha + 执行滑点 + 折溢价 + 成本

#### §1.5.2 前端字段契约（给 @Frontend 的稳定接口）
每条推荐必带：
```
{
  symbol: string
  action: 'BUY' | 'SELL' | 'HOLD'
  score: number
  confidence: number         // 90 天真实胜率 Wilson lower
  triggered_signals: [        // 触发信号列表
    { name, factor_value, threshold, direction }
  ]
  explanation: string         // 人类可读解释文本
  generated_at: ISO8601
  valid_until: ISO8601        // 有效期
  risk_disclaimer: string     // 风险提示（合规 · 硬要求）
  lifecycle_id: string
  gate_reason?: string        // Gate 阻挡时的原因
}
```

#### §1.5.3 Live vs Backtest Drift Report
- 周频输出
- 单向偏差 > 30 天触 SIGNAL_FIRST_PLAN §10 降级
- 归属 `PerformanceReporter` facade

---

## §2. 可回测性设计（Strategy owns）

### §2.1 五层结构（重构后目标形态）
```
quant/
├── engine/           StrategyEngine facade + StrategyRegistry
├── factors/          FactorRegistry + FactorPipeline + library/*
├── etf/              ETFConstituentExpander + ETFFactorService + ETFRankingService
├── backtest/         BacktestEngine facade + internal/QuantBacktestEngine + WalkForwardValidator + GridSearchOptimizer + BayesianOptimizer + RegimeSegmentedBacktest + MonteCarloStressTest + CostSensitivityAnalysis + OverfitMetrics + AShareConstraintEngine
├── performance/      PerformanceReporter facade + drift report
├── health/           quantHealthMonitor facade
└── strategies/       ETF 因子策略（唯一一个，QuantFusion 已删）
```

### §2.2 5 Public Facade 单例（不新增第 6 个）
- `strategyEngine` / `signalEngine` / `backtestEngine` / `performanceReporter` / `quantHealthMonitor`
- Controller 只允许 import 这 5 个，不许绕进 `internal/`

### §2.3 DataSource DI 六范式（脱 DB 必备）
所有回测/优化器通过 DataSource 注入，无 Sequelize 硬依赖：
1. `BacktestRunner`
2. `RegimeSource`
3. `TradeReturnSource`
4. `StrategyReturnSource`
5. `BenchmarkReturnSource`
6. `IndustryDataSource`

（`ETFConstituentSource` point-in-time 成分股范式作为 v0.6 fixture spec 候选，DataPipeline 采纳中）

### §2.4 回测 7 关 DoD（P0，必过 6 关以上）
1. **成本后年化 ≥ 10%**（手续费 0.13% × 2 + 滑点 0.2-0.5%）
2. **成本翻倍压力测试后 alpha 仍 > 0**
3. **Walk-forward 每期年化 ≥ 8%**
4. **CSCV / PBO < 0.5**（Bailey）
5. **参数扰动组合差异 ≤ 2%，最差 ≥ 8%**
6. **最近 12 月 OOS 年化 ≥ 8%，MDD ≤ 25%**
7. **Regime 分层每 regime ≥ 5%**

### §2.5 禁 Look-ahead 硬约束
- 所有事后分析工具用 `row_date > as_of_date` skip 模式（`FactorICReport` 强制）
- ETF 回测硬约束：
  - **point-in-time 成分股**（禁生存者偏差）
  - **point-in-time 财务**
  - 剔上市 < 180 天 / 日均成交 < 2000 万
  - **保留退市 ETF**
  - 4 种执行价敏感性表（open / next-open / 9:40 / VWAP）
- `report_date ≤ publish_date ≤ available_at` 偏序不变式（存储 CHECK + 契约 assert + 运行时 helper 三重保险）
- `available_at <= t` 运行时 helper（默认强断言 + 关闭需 ADR）

### §2.6 A 股独立约束（AShareConstraintEngine）
- pure module 无状态无 DB
- `evaluateOrder → RejectionReason enum`
- `computeFees` 双边佣金万 2.5 + 千 1 印花税卖出 + 双边万 0.1 过户费（**过户费默认开**）
- `executionPrice` 三种：next_open / same_close / twap_proxy + turnover-scaled 滑点
- `rejected_orders` 落 `quant_backtest_results.rejected_orders_json`

### §2.7 SeededRandom 强制
- Park-Miller LCG（US-038）
- **禁 `Math.random()`**（QADocs 出静态 lint 规则 → `drafts/lint-no-math-random-v0.md`）
- 用于 Monte Carlo / 回测采样 / walk-forward 随机化

### §2.8 数字必须锚定
- 所有回测阈值 / 权重 / 门槛必须锚 SIGNAL_FIRST_PLAN §11.1（已锚定）或 §11.2（待校准）
- 来源说得出来 · **禁拍脑袋**

---

## §3. 测试策略 · 回测部分（Strategy owns，配合 QADocs）

### §3.1 覆盖率目标
- 核心工具 / 因子 / 回测框架：**≥ 85%**
- quant 胶水：60-70%
- `ai/tradingagents-app` LLM prompt 逻辑：走集成 / 端到端

### §3.2 分层测试范围
- **因子单测**：`tests/factors/<NameFactor>.test.ts`；纯函数 + Map + 空 universe 三层断言；**不走 DB，不 mock Sequelize**
- **回测 / 优化器单测**：**全部脱 DB**，DataSource DI 注入 fake；数学 helper 全部 `export function` 供独立单测
- **策略回测集成测试**：走真实 DataSource 快照 / fixture（后续 M0.5 baseline 归档产物）
- **组合级 META-TEST**：`tests/quant/composite_backtest_all_strategies.test.ts` 13 策略 trade_count ≥ 2（任何策略 wiring 破坏立刻挂）

### §3.3 回测验收标准
- **7 关 DoD**（§2.4）过 6 关以上，且明列过关情况
- **可复现归档**：commit SHA + data hash + env version + rerun script + metrics（§M0.5 baseline 规格）
- **重构后同数据集复跑**：与基线比对指标不得无理由劣化
- **Drift Report**：live vs backtest 单向偏差 > 30 天触降级

### §3.4 跑法（既有约定）
- `cd backend && npx ts-node --transpile-only tests/<path>`
- 失败即抛错，不 silent clamp（例：`simulation_count > MAX` 抛错，不 clamp）
- CI 门禁：QADocs 出 `contracts/backtest.md §Gate Negative Coverage` + `drafts/backtest-7-gates-v0.md`

### §3.5 反面案例守护（Gotcha guards · 必须显式覆盖）
- `Number(null) === 0` 陷阱 → Sequelize raw DECIMAL 列必须先 `Number.isFinite()` 再入数组
- QuantFusion 教训 → **禁"多策略投票 + 规则打分"复现**（新 fusion 层若出现，立刻拦下）
- Momentum 美股结论禁直接搬 A 股 → `momentum_reversal` A 股独立回测
- A 股主题 ETF 追涨见顶 → 卫星 20% + 单笔 5% + 60 天硬边界 · 断言测试
- 政策黑天鹅 → PR-L 紧急停损保留 · 单测覆盖 C-5 / §0.2 例外通道

### §3.6 Gate 反例矩阵引用（跨层 · QADocs 主控）

引用 `contracts/backtest.md §Gate Negative Coverage`（QADocs 独占，ADR-0001 §10.2a）+ `contracts/data-fixture-spec.md §9b`（DataPipeline）。

Reference Strategy 目录结构 `backend/tests/backtest/gates/refs/`（QADocs 独占）：

| 层 | 目录 | 内容 | 元测断言 |
|---|---|---|---|
| **base** | `refs/base/` | `fixture_ref_alpha` known-pass 教具 + 7 gate 反例（QADocs matrix v0.2） | `REQUIRED_BASE_GATES = ['g1'..'g7']` 每 gate ≥ 1 反例 |
| **weight_scheme** | `refs/weight_scheme/` | §11.1 4 因子槽反例（Strategy msg=37bb0ea3） | `REQUIRED_WEIGHT_SCHEME_FACTORS = ['value','quality','lowvol','momentum']` 每因子槽 ≥ 1 反例 |

**§11.1 4 反例（`refs/weight_scheme/*.ts`）**：

| 反例 | 因子槽 | regime 定位 | 主拒 gate | 教育意义 |
|---|---|---|---|---|
| `fixture_ref_weight_scheme_value_trap_2015_top` | Value 0.40 | `bubble_top` (2015-05→06 泡沫顶) | **G6 Regime 分层** | Value 不能盲从（bubble 顶反效） |
| `fixture_ref_weight_scheme_quality_regime_flip` | Quality 0.30 | `quality_underperform_regime` (2022 熊 + 政策扰动) | **G3 Walk-forward** | Quality 权重不宜再堆高 |
| `fixture_ref_weight_scheme_lowvol_policy_shock` | LowVol 0.30 | 政策黑天鹅（教育双减类） | **G7 派生 / PR-L 触发依据** | LowVol 需叠 L2 PR-L 例外通道（保护 §4.2 存在依据） |
| `fixture_ref_weight_scheme_momentum_reversal_trap` | Momentum 0.0(shadow) | `momentum_reversal_20d` | **G7 成本翻倍** | 证明 Momentum shadow 是保守选择 |

**红线**（ADR-0001 §10.8）：`fixture_ref_*` 全域（含 base + weight_scheme）**只证 gate 基础设施可拒**，不证 §11.1 权重过关。§11.1 权重合规验证锚点 = **真实历史数据 Phase 1**。

---

## §4. 清理方案 · 保护清单策略段（Strategy owns）

### §4.1 保护 glob（按目录 + 文件模式划线，不逐一列文件）
| Glob | 保护理由 | 变更规则 |
|---|---|---|
| `backend/src/quant/**` | 因子/回测/引擎/health 核心资产 | 只在契约冻结后由 Strategy owns；Cleanup 禁碰 |
| `backend/src/backtest/**` | 传统回测引擎（BacktestEngine/Portfolio/OrderManager/Event）| 同上 |
| `backend/src/portfolio/**` | 组合层（PaperTradingAutomationService 等）| 同上 |
| `backend/src/metrics/**` | 指标计算层 | 同上 |
| `backend/src/models/QuantBacktestResult.ts` | 回测结果模型（重构中数据表可能改，但契约模型保留 anchor）| 改结构走 Orchestrator 冻结 |
| `backend/src/models/FactorScore*.ts` | 因子快照模型 | 同上 |
| `backend/tests/factors/**` | 因子单测（IC / rankIC / decile / 空 universe） | 全保留，重构后仍要绿 |
| `backend/tests/quant/**` | 引擎 META-TEST + smoke + composite guard | 全保留 |
| `backend/tests/backtest/**` | 回测/优化器脱 DB 单测 + `gates/refs/**` QADocs 独占 | 全保留 |
| `backend/tests/strategies/**` | 策略单测（ETFRotation / QuantStrategyDryRun）| 全保留 |
| `backend/tests/portfolio/**` | 组合层测试 | 全保留 |
| `backend/tests/attribution/**` | 归因测试 | 全保留 |
| `backend/tests/metrics/**` | 指标测试 | 全保留 |
| `backend/tests/live-trading/**` | 实盘链路测试（含 PR-L 政策例外）| 全保留 |
| `backend/tests/risk/**` | 风控测试 | 全保留 |
| `ai/tradingagents-app/**` | 多智能体 Python 应用（vendoring 独立）| Strategy 独占；Cleanup 禁碰内部逻辑 |
| `docs/SIGNAL_FIRST_PLAN.md` | 权重 V0 §11.1 唯一权威 anchor | 只增不删，改 §11.1 走 ADR |
| `docs/PROJECT_COMPASS.md` | 编码原则/回测 7 关 anchor | 同上 |

### §4.2 特别保护（"核心资产不误删" · 硬性原则 §3）
- **PR-L 政策黑天鹅紧急停损通道**（C-5 / §0.2 例外）—— 实盘 win% 转正前不许拆 · 支撑 §3.6 `fixture_ref_weight_scheme_lowvol_policy_shock` 反例存在依据
- **`momentum_reversal` A 股独立设计**（Barroso 2015 美股结论不能直接搬）—— 保留独立测试与代理记号说明
- **`AShareConstraintEngine`** pure module —— 双边费率 / 过户费 / RejectionReason enum 稳定契约
- **`FactorRegistry` + `FactorPipeline`** —— 稀疏 Map + 中性填补 + 无 zscore 契约稳定

### §4.3 明确可删（Cleanup 可动 · 但 Strategy 侧独占目录仍走 Orchestrator authorize）
- `QuantFusionService`（**已删**，禁复现"多策略投票 + 规则打分"）
- `backend/src/quant/strategies/` 30 → 1（**已瘦身**）
- `backend/src/backtest/strategies/*.ts` 传统实现（MACD/RSI/BB/MA）**候选评估**：Q5 走 Research 22-cleanup-candidates 证据链后 Strategy 决策
- Migrations 双路径统一（`backend/scripts/migrations` vs `backend/src/data/migrations`）—— 数据层归 @DataPipeline，Strategy 只在依赖侧留 anchor

### §4.4 回滚约束
- **一切策略层决策 < 15 min 可回滚**（既有约定 · 保留）
- 删码前打 tag
- **禁单 PR 同时删多模块**
- 大变动 fusion / 权重 / gate / DataSource 契约前先跑 30 天新逻辑影子对比

### §4.5 分支纪律（Strategy 侧）
- 独占分支 `refactor/strategy-*`；不与 Cleanup / DataPipeline 分支冲突
- 每 batch 一 commit，附证据 + DoD 自检结果
- 每 commit 附 `docs/refactor/30-cleanup-log.md` 批次条目（如涉及删除）

---

## §5. 分阶段实施计划 · Strategy 里程碑

### §M0.5 · 回测基线固化（本周内 · 等 li-yiming 数据访问方式拍板 + DataPipeline 线上探查）
- **DoD**：3 组基线（G1 因子 IC / G2 V0 §11.1 walk-forward / G3 脱 DB META-GUARD）落地到 `docs/refactor/baseline/`，每组带 commit SHA + data hash + env version + rerun script + metrics
- **依赖**：@DataPipeline 数据快照校验和 + @Orchestrator PG 凭证 DM
- **风险**：数据可达性未定 → 可能回落 fake DataSource + SeededRandom（DataPipeline v0.5 fixture 已就绪）

### §M1 · 交付物 B Strategy 章节完稿（本轮内 · 与 Research 交付物 A 并行）
- **DoD**：本文档 v0.1 → v1 完稿，含融合决策表策略行
- **依赖**：Research 通读参考项目 `yespsam/a-share-us-catalyst` 完成 → 我出「参考项目 vs 现状融合决策表 · 策略/因子/回测行」
- **产物**：`docs/refactor/50-strategy-design.md` v1 定稿 → Orchestrator M-Draft 集成排程

### §M2 · Phase 0 期间 Strategy 不动
- **纪律**：Cleanup 独占窗口 Strategy 静默；只保护、不重构
- **警戒**：任何触碰 §4 保护 glob 的 Cleanup 动作立刻拦下

### §M3 · 契约冻结后开工
- 按 Orchestrator 冻结的 `contracts/strategy.md` 版本号推进
- 三插件点验证可插拔（因子 / 信号 / 策略）
- 回测 7 关 CI 门禁接入 · `refs/base/*` + `refs/weight_scheme/*` 双层元测通过

### §M4 · 完稿 DoD
- 五层职责清晰 · 三插件点验证通过
- 荐股可解释 · 回测 7 关 6+ 关通过
- 关键链路测试全绿
- 无硬编码密钥 · 数据源合规

---

## §6. Risks & Open Questions（本轮未定）

| # | Question | Owner | 阻塞对象 | 状态 |
|---|---|---|---|---|
| Q1 | 线上 PG 只读访问方式 | @li-yiming DM msg=2d5ff517 | M0.5 Day 2 | 等 li-yiming 回 · Orchestrator 追问中 |
| Q2 | 线上 factor_scores / stock_*_factors 表存量 | @DataPipeline → @li-yiming | M0.5 G1 是否可跑 | 等 Q1 后 DataPipeline SSH 探查 |
| Q3 | 参考项目 catalyst 的信号 / 推荐逻辑详细形态 | @Research 20-reference-report | 融合决策表策略行 · §M1 v1 完稿 | Research 起草中 |
| Q4 | 是否要新增 `ConfidenceCalibrationService` 落地本轮 | @Orchestrator | Signal §1.3 完稿 | pending |
| Q5 | `backend/src/backtest/strategies/*.ts` 传统实现去留（MACD/RSI/BB/MA）| @Research 22-cleanup-candidates → @Strategy 决策 | 保护清单 §4.3 | Research 起草证据链中 |
| Q6 | 三条红线（Signals-First §11.1 权重 / QuantFusion 禁复现 / AI-tradingagents vendoring）li-yiming 默认允否 | @li-yiming | 全章节方向锁定 | **已默认关闭**（Orchestrator ACK msg=65e8770b · li-yiming "必须问才问") |

---

## §7. 与其他 Agent 的契约接口（前后端跨层）

### §7.1 上游 · @DataPipeline 给 Strategy
（`contracts/data.md` v1 DataPipeline 起草中）
- `daily_bars` (point-in-time 前复权 · `adj_base_date` 每行携带)
- `factor_scores` (`row_date ≤ as_of_date` guarantee)
- `stock_fundamental_factors / stock_valuation_factors / stock_money_flow_factors`
- `daily_tradability` 视图（4 字段：`can_open_long / can_open_short / can_close_long / can_close_short + tradable`）
- `newly_listed_n: int` / `resumed_today: bool` / `adj_base_date`
- 数据快照校验和 · commit SHA + count + hash(pk sample)
- fake DataSource fixture spec（`contracts/data-fixture-spec.md` v0.5→v0.6，含 §9b 7 反例 + §11.1 4 反例 4 新 regime 标签）

### §7.2 下游 · Strategy 给 @Frontend
（`contracts/strategy.md` v0 Orchestrator 骨架已落）
- §1.5.2 前端字段契约
- 稳定推荐 API：`GET /api/recommendations?date=YYYY-MM-DD`
- 每条推荐必带 `risk_disclaimer`（合规硬要求）

### §7.3 横切 · Strategy 给 @QADocs
- 回测 7 关 CI 门禁 spec（QADocs `contracts/backtest.md §Gate Negative Coverage` 主控）
- §3.6 §11.1 4 反例场景 → QADocs 实现 `refs/weight_scheme/*`
- 因子 / 策略单测跑法（脱 DB / 走 fake DataSource）
- SeededRandom lint 规则输入（US-038）

### §7.4 独立 · `ai/tradingagents-app` 边界
- Vendoring 独立 Python 进程
- 通过 `http://127.0.0.1:3000/api/internal/*` 反向调 stocks 后端（**A 股数据唯一真源**）
- `data_vendors` 全 akshare（后端优先，akshare 兜底）
- **TA 不做主线信号**，只做多智能体分析报告
- Strategy 侧不改 TA 内部逻辑，只维护 API 边界稳定
