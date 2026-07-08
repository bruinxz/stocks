# 交付物 B · Strategy 章节 v0.2

> **状态**：DRAFT v0.2 · v0.1 结构守 · 追加不重排 · v0.2 delta 挪入 (§1.3.4 / §1.4.3 / §1.5.4 / §1.5.5 / §F / §F2 / §4.3 Q5 delete)
> **Author**：@Strategy · **Date**：2026-07-08（v0.2 delta 挪入）
> **归口**：`docs/refactor/50-strategy-design.md`（Orchestrator M0 骨架 msg=90f087a8 §5 authorize · Strategy 独占 50-59 段 · v0.2 authorize msg=e7b59730）
> **依赖**：`docs/refactor/00-anchor.md` · `docs/refactor/10-contracts.md` · `docs/refactor/adr/0001-layering-and-collab.md` · `SIGNAL_FIRST_PLAN.md` · `PROJECT_COMPASS.md`
> **兄弟锚点**：
>   - `docs/refactor/contracts/strategy.md` v0（下游给 Frontend）
>   - `docs/refactor/contracts/data.md` v0（上游 DataPipeline）
>   - `docs/refactor/contracts/data-fixture-spec.md` C7（DataPipeline v0.5 + QADocs matrix + §11.1 反例）
>   - `docs/refactor/contracts/backtest.md §Gate Negative Coverage`（QADocs 独占，含 base matrix + weight_scheme 双层）
> **License 声明**：**独立实现，未复制 `yespsam/a-share-us-catalyst` 源码或直接翻译源码逻辑**。全域禁 catalyst 项目原生词表（`analyst_profile` / `九点猫` / `jiudian_cat` / 5 因子权重魔数 0.34/0.32/0.12/0.08/0.10 联合硬编码）—— 引 ADR-0001 §Q3。

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
- **红线**（Orchestrator msg=2a86337a · ADR-0001 §10.8）：§11.1 权重（V0）合规验证锚点仅走真实历史数据；**禁使用 fake DataSource fixture 结果作为过关证据**。fake fixture 仅用于 gate 基础设施 CI 冒烟（`fixture_ref_alpha` known-pass 教具 + `fixture_ref_*` 反例被拒），不承诺 §11.1 过关。QADocs §10.8 静态扫描断言 `test_gate_g6_regime.test.ts::test_ref_strategy_11_1_weight_compliance` 禁引用 `fixture_ref_*` 全域（base + weight_scheme 两层）导入侧。

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

#### §1.3.4 · `signal_v3` → `explain_card` 映射规则（v0.2 新增）

`signal_v3` 是内部信号原子（生产/回测/纸面/实盘同契约 · §1.5.1 三同硬约束）；`explain_card` 是**面向前端/用户的可解释输出**契约，由 `explain_card_builder`（新建 · pure function）从 `signal_v3` + 因子贡献分解 + Gate 状态派生。

##### 现状 gap 概览（源 Research `21-current-audit.md` §7）

现有 `signal_v3` 对齐 `explain_card` 需 6 类补强：
1. **命名迁移**：`action: BUY/SELL/HOLD` → `rating: bullish/neutral/bearish`（§1.3.4 派生规则表 · 三态双向可逆）
2. **状态升级**：`gate_pass: boolean` → `risk_gate: pass/watch/block`（2 态→3 态 · 派生规则表 · L2 冻结/L4 EV<0.5% 卫星 → watch）
3. **归一化**：`confidence: 0-1` → `conviction: 0-100 int`（`round(confidence * 100)`）
4. **discriminator 新增**：`dimension_group: 'core' | 'satellite'`（§1.5.4 双 group 硬约束 · 现有 signal_v3 无此字段 → 由 `source_detector` 元数据派生）
5. **dimensions 结构升级**：
   - core: 现有 `factor_snapshot` 4 键（V/Q/L/M）→ `dimensions.core` 5 维（补 `risk` 维 · 由 Gate L2 状态 + volatility factor 派生）
   - satellite: **全新 6 维**（`us_driver` / `history_response` / `quality_proxy` / `intraday_momentum` / `news_evidence` / `risk` · 卫星 detector 侧输出 · 见 §1.4.3）
6. **证据链字段全新增**：`entry_plan` / `scenario` (bull/base/bear) / `positive_flags` / `risk_flags` / `method` 均在现有 signal_v3 缺失 · 由 §1.5.5 pure fn 模板拼装

**回退兼容**：本轮**不考虑向后兼容**（li-yiming brief §7 硬性原则 §4）· signal_v3 现字段无兼容层 · 走 `explain_card_builder` 派生输出 · 现有消费方（如有）Cleanup 独占窗口后迁移。

##### 字段映射表

| `signal_v3` 字段 | `explain_card` 字段 | 派生规则 |
|---|---|---|
| `action` (`BUY`/`SELL`/`HOLD`) | `rating` (`bullish`/`neutral`/`bearish`) | `BUY→bullish`；`HOLD→neutral`；`SELL→bearish` |
| `confidence` (0-1 Wilson lower) | `conviction` (0-100 int) | `round(confidence * 100)` |
| `gate_pass` + `gate_reason` | `risk_gate` (`pass`/`watch`/`block`) | L1 拒 → `block`；L2 冻结中 or n_samples<20 纸面态 or L4 EV<0.5%（卫星）→ `watch`；全过 → `pass` |
| `source_detector` | `dimension_group` (`core`/`satellite`) | detector 属核心 ETF 因子轮动 → `core`；detector 属卫星层题材/事件驱动 → `satellite` |
| `triggered_signals[]` + factor 贡献分解 | `dimensions` (5 维 core / 6 维 satellite) | `dimensions` 按 group 硬约束不同 key（详见 §1.5.4）；每维 0-100 由 factor 贡献分数 rank 归一化 |
| `triggered_signals[]` 中 `direction='positive'` | `positive_flags[]` | 触发方向为正的信号名（**词表 Strategy 自研** · 见 §1.5.5） |
| `triggered_signals[]` 中 `direction='negative'` | `risk_flags[]` | 触发方向为负的信号名 |
| `entry_price_strategy` + `stop_loss_pct` + `take_profit_pct` + `recommended_size_pct` | `entry_plan` (自由文本，含分批 + 止损纪律) | 由 `entry_plan_template()` 模板化拼装（不复制 catalyst 中文文案） |
| `expected_value` + `regime` | `scenario` (`bull`/`base`/`bear` 3 情景) | 3 情景独立字段 · 单元 `{narrative: string, expected_return_pct: number}` |
| detector 元数据 | `method` (方法学说明，一行) | 由 detector `describe()` 输出（禁引 catalyst method 字面 `"Top-down catalyst + …"`） |
| `risk_disclaimer` (硬要求) | `risk_disclaimer` (透传) | 合规硬要求（li-yiming brief §5）· 与 QADocs `40-quality-gates.md#Disclaimer-Lint` 联动 |

##### 硬约束

- `explain_card_builder` = pure function（signal_v3 + factor_contributions + gate_state）→ `explain_card`；**无 I/O · 无 DB · 可独立单测**
- `rating` × `action` 三态双向可逆（禁引入 5 档粒度）
- `risk_gate` 派生规则**唯一**（由 Gate 状态 → risk_gate 的映射表在此章节冻结，禁 Frontend 侧重实现映射）
- `dimensions` 严格按 `dimension_group` 走不同 key 集，**禁跨 group 混绘**（Frontend msg=b45f58e4 决策 3 契约层硬约束）

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

#### §1.4.3 卫星层 signal detector 章节（v0.2 新增）

**范围**：本节 owns 卫星 20% 题材/事件驱动信号 detector 设计。核心 70% ETF 因子轮动**不动**（§11.1 权重锚保护）。

##### §1.4.3.1 卫星层 detector 定位

- **不复制 catalyst 5 因子加权模板**（License 红线 · 禁字面词表 / 禁 5 因子魔数联合硬编码 · Independence Declaration 引 ADR-0001 §Q3）
- 借鉴思想：**"上游驱动信号 + 下游映射候选 + 历史联动统计 + 可解释证据链"** 4 概念独立实现
- 卫星层评分独立于 §11.1 权重锚 · 有自研 slot 权重表（初值待 §M1 v1 融合决策表内定 · v0.2 骨架先给字段签名）

##### §1.4.3.2 卫星层 detector 5 slot + 1 gate-derived 评分骨架（独立自研）

**F1 处置（Orchestrator DM msg=64b191e2 · 二选一裁定）**：detector 5 slot + risk 由 Gate 状态派生 → dimensions.satellite 6 维契约。`liquidity_bucket` 归并入 `quality_proxy`（作 market_cap size subcomponent · 不单列 dimension key）· `quality_proxy` 提升为独立 detector（承担基本面 + size 双维证据）· `risk` 不作 detector，由 §1.3.3 Gate L2 状态派生（避重复来源）。

| detector slot | dimensions.satellite key | 语义 | 数据依赖 |
|---|---|---|---|
| `us_driver_signal` | `us_driver` | 隔夜 US 主题 tickers 加权涨跌 + 广度（借鉴 B1 概念，避 `catalyst_us` 词表 · 采用 `us_driver` slug） | E1 daily_bars US 侧 · E5 stocks_meta US 分类 |
| `history_response` | `history_response` | A 股次日对 US 主题历史响应统计（hit_rate / avg_after_signal / corr / beta 概念 · 避 `analyst_profile.history_edge` 字面） | E1 daily_bars A 股 + US 双侧 · `signal_cutoff = date - 1day` PIT 锚（≡ `available_at ≤ t`） |
| `intraday_momentum` | `intraday_momentum` | 当日涨跌幅 + 换手率（**A 股独立测算 · 禁复用 `momentum_reversal` 核心因子的美股不可搬结论**） | E1 daily_bars + turnover_rate |
| `quality_proxy` | `quality_proxy` | 基本面 proxy（毛利率/ROE 概念）+ **market_cap 分档 subcomponent（liquidity_bucket 归并入此 · 自研阈值 · 不复制参考项目 100B+/<8B 阈值）** | E4 fundamental_pit（含 market_cap） |
| `news_evidence` | `news_evidence` | 新闻/公告关键词命中（Strategy 侧**自研 positive/risk 词表** · 见 §1.5.5） | 新闻源（等 DataPipeline 契约 · 目前占位） |
| **（无 detector · Gate 派生）** | `risk` | 由 §1.3.3 Gate L2 状态派生（60 天滚动亏损 / 连续 alpha< 0 / 硬止损触发次数 / PR-L 政策例外触发） 归一化到 0-100 · **数值越低风险越高** | 不新增数据源 · 复用 Gate 状态机 |

##### §1.4.3.3 卫星层 Gate 硬约束（承接 §1.3.3）

- **必过全 4 层 Gate**（L1 eligibility / L2 risk / L3 cost / L4 EV）· 核心 ETF 跳 L4 · 卫星禁跳
- `theme_id` = 卫星层信号唯一分组键 · 一 `theme_id` 一批候选（≤ 3-4 只 · 单只 5% 上限 · 60 天硬边界）
- `us_driver_signal` cutoff **强制** `= date - 1day` （PIT 时点锚，≡ `available_at ≤ t` · B4 `contracts/data.md` §5.3 契合）

##### §1.4.3.4 卫星层 detector 落地位

- `backend/src/quant/factors/library/satellite/<Name>Detector.ts`（新增 subdir · 5 个 detector：`UsDriverSignalDetector` / `HistoryResponseDetector` / `IntradayMomentumDetector` / `QualityProxyDetector` / `NewsEvidenceDetector`）
- `risk` 维不是 detector · 由 `explain_card_builder`（§1.3.4）读 Gate 状态派生 · 无独立文件
- 保留代理记号（proxy）显式标注 · 词表 Strategy 自研 · 命名前缀 `us_driver_*` / `history_response_*` / `news_evidence_*` / `quality_proxy_*`
- 与核心因子共 `FactorRegistry` 但**分 category = 'satellite'**（禁 category 混淆导致进入 §11.1 权重轮动）

##### §1.4.3.5 卫星层 slot 权重初值 v1（F3 处置 · Q7 定值 · **双态并存**）

**背景**：Frontend `60-frontend-design.md` v1 组件排序依此。**红线**：禁复制参考项目 5 因子魔数（0.34/0.32/0.12/0.08/0.10）联合硬编码 · Independence Declaration 引 ADR-0001 §Q3。

**Orchestrator msg=95e48f2b 裁决 · 双态并存**：本 v1 冻结时 Strategy `contracts/strategy.md` v1 明写**两态权重表** + §14 US 决策 gate · US 决策落定后 CHANGELOG 收敛为单态 · 避免 v1 冻结硬依赖 US 数据源接入决策。

###### §1.4.3.5.1 5-slot v1（US 数据源到位态 · 主态）

| dim | v1 初值 | 依据 |
|---|---|---|
| `us_driver` | 0.30 | 主题驱动源 · 上游信号强度锚 |
| `history_response` | 0.25 | A 股响应可验证性 · 无历史响应即使 US driver 强也不入选 |
| `quality_proxy` | 0.15 | 基本面 + size 双维过滤（避垃圾股 + 避流动性陷阱） |
| `intraday_momentum` | 0.15 | 当日入场时点确认（非趋势跟随） |
| `news_evidence` | 0.15 | 证据链佐证（自研词表 · §1.5.5） |
| **合计正向权重** | **1.00** | — |
| `risk` | **乘性衰减（0.5-1.0）** | **不参与正向权重求和** · 由 Gate L2 状态派生 · 对合成分数做 `final_score = raw_score × risk_multiplier` |

###### §1.4.3.5.2 4-slot v1（US 数据源缺位态 · 回落态）

**归一化公式**（Orchestrator msg=95e48f2b 采纳 · 保原比例）：`w_i_4slot = w_i_5slot / (1 - w_us_driver)` = `w_i_5slot / 0.70`

| dim | 5-slot 值 | 4-slot 值（3 位小数舍入） | 依据 |
|---|---|---|---|
| `us_driver` | 0.30 | **N/A（无源空转）** | US 数据源缺位 · detector slot 空转 |
| `history_response` | 0.25 | **0.357** = 0.25/0.70 | 4-slot 主锚 · A 股响应可验证性 |
| `quality_proxy` | 0.15 | **0.214** = 0.15/0.70 | — |
| `intraday_momentum` | 0.15 | **0.214** = 0.15/0.70 | — |
| `news_evidence` | 0.15 | **0.215** = 0.15/0.70 舍入补 rounding error | 数值上补 0.001 让 sum = 1.000 |
| **合计正向权重** | **1.000** | **1.000** | 4 slot 总和 = 1.000（0.357+0.214+0.214+0.215） |
| `risk` | 乘性衰减 | 乘性衰减 | 同 5-slot 态 · 不参与正向权重求和 |

**算数验证**：0.25/0.70 = 0.35714... → 3 位小数 0.357；0.15/0.70 = 0.21428... → 3 位小数 0.214（3 项）；sum = 0.357+0.214×3 = 0.999，故 news_evidence 补 +0.001 至 0.215 让 sum = 1.000。

**QADocs 联动**（QADocs msg=e614da37 v1.1 队列第 13 项 + msg=c3e11e42 §1 断言 A-D）：`test_satellite_slot_4_slot_renormalization.test.ts` 断言：
- A · sum(4-slot weights) == 1.000 (float 容差 1e-6)
- B · risk 乘性乘子 0.5-1.0 保留
- C · 4-slot 版本每项 = `round(5-slot_w_i / (1 - w_us_driver_5slot), 3)`，加 rounding error compensation 由 news_evidence 承接（防手工输入偏离）
- D · 5-slot / 4-slot 版本切换开关 = US 数据源到位性布尔 flag (`ENABLE_US_DRIVER_SIGNAL` env or config) · 双态互斥

**独立性声明（License 红线）**：
- 上表权重值由 Strategy 独立设计 · 依据 "US 驱动为主题源、A 股响应可验证性最重、其余三维等权作次级证据" 的语义论证
- **完全不同**于参考项目 `scoring.py` 5 因子加权模板结构：
  - 我方 `us_driver` 0.30 vs 参考 34% → 数值不同
  - 我方 6 slot 结构（含 quality_proxy 合并 liquidity + risk 乘性衰减）vs 参考 5 因子加法 + 独立 risk 减法 → 结构不同
  - 我方权重 `(0.30, 0.25, 0.15, 0.15, 0.15)` vs 参考 `(0.34, 0.32, 0.12, 0.08, 0.10)` 联合五元组 → 5 因子魔数联合硬编码 grep 拒（QADocs jscpd baseline）
  - 4-slot 回落态 `(0.357, 0.214, 0.214, 0.215)`（rounding tie-break = news_evidence 位 +0.001 补偿 · Orchestrator msg=646f9c2a §Rounding-Tie-Break 权威锚 · ADR-0001 §附录追加块 §Rounding-Tie-Break 章）与参考项目 5 因子结构双重不同（数量 + 数值 + 归一化公式）
- v1 定稿后走 walk-forward 敏感性验证（Momentum shadow 同路径） · 6 月后再评估
- **红线**：卫星层权重合规验证锚点仅走真实历史 Phase 1 · 禁 fake fixture 论证（同 §11.1 §10.8 精神）

##### §1.4.3.6 卫星层 detector 权重合成规则

```
raw_score = 0.30 * us_driver + 0.25 * history_response + 0.15 * quality_proxy
          + 0.15 * intraday_momentum + 0.15 * news_evidence
risk_multiplier = f(gate_state)  ∈ [0.5, 1.0]
   · Gate L2 pass 全清 → 1.0
   · L2 watch（60 天滚亏 3-5% 边界）→ 0.75
   · L2 冻结中 or 硬止损触发 → 0.5
final_score = raw_score × risk_multiplier
```

- `risk_multiplier` 归一化到 dimensions.satellite.risk = `round(risk_multiplier * 100)` （0.5→50 · 0.75→75 · 1.0→100）
- 与 `risk_gate` 派生规则（§1.3.4 · `pass/watch/block`）解耦：`risk_gate` 是三档准入分类 · `dimensions.satellite.risk` 是分数展示

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

#### §1.5.4 · `explain_card` 契约模板 full schema（v0.2 新增）

**面向 Frontend 稳定接口**（`contracts/strategy.md` v1 归口）· **面向 User 可解释性硬要求**（li-yiming brief §7）

##### §1.5.4.1 Full Schema

```ts
interface ExplainCard {
  // 顶部双徽章
  rating: 'bullish' | 'neutral' | 'bearish'   // 拒 5 档 Buy/Outperform/Neutral/Underperform/Avoid
  conviction: number                           // 0-100 int (from confidence Wilson lower × 100)
  risk_gate: 'pass' | 'watch' | 'block'       // 拒 catalyst 原生 Pass/Watch/Block 大写词表 · 用小写 slug

  // Dimension 分组 · 双 group discriminator
  dimension_group: 'core' | 'satellite'       // 决定 dimensions key 集
  dimensions:                                  // 每维 0-100 int
    | { value: number; quality: number; lowvol: number; momentum: number; risk: number }             // core 5 维 · risk = 参考位不参与 §11.1 权重（见 §1.5.4.2 F2）
    | { us_driver: number; history_response: number; quality_proxy: number; intraday_momentum: number; news_evidence: number; risk: number }  // satellite 6 维（quality_proxy 合并 liquidity_bucket · risk 由 Gate 派生 · 见 §1.4.3.2 F1）

  // 证据链分离（B8）
  entry_plan: string          // 模板化拼装 · 含分批 + 止损纪律
  scenario: {                  // 3 情景独立
    bull: { narrative: string; expected_return_pct: number }
    base: { narrative: string; expected_return_pct: number }
    bear: { narrative: string; expected_return_pct: number }
  }
  positive_flags: string[]     // 触发方向正 · 词表 Strategy 自研（§1.5.5）
  risk_flags: string[]         // 触发方向负 · 词表 Strategy 自研

  // 底部方法学 + 合规
  method: string               // 一行 · 由 detector describe() 输出（禁字面复制 catalyst method）
  risk_disclaimer: string      // 合规硬要求（li-yiming brief §5）

  // 溯源
  lifecycle_id: string         // 复用 signal_v3 三 ID 规范
  generated_at: string         // ISO8601
  valid_until: string          // ISO8601
}
```

##### §1.5.4.2 硬约束

- **F2 处置 · `dimensions.core.risk` = 参考位声明**（Orchestrator DM msg=64b191e2）：
  - core 5 维 `{value, quality, lowvol, momentum, risk}` 中的 `risk` **不参与 §11.1 权重轮动**（V0 权重锚：Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0(shadow) · risk 0.0）
  - `risk` 仅作**可解释性可视化参考位** · 与卫星层 `dimensions.satellite.risk` 同源（都由 §1.3.3 Gate L2 状态派生 · §1.4.3.6 `risk_multiplier` 归一化）
  - 视觉稀释保护：Frontend `<ExplainRadar group="core">` 组件 **risk 轴样式差异化建议**（虚线 · 底纹 · 淡灰色) · 与其他 4 轴 V/Q/L/M 视觉区隔（Frontend msg=b45f58e4 承接 UX 层实现）
  - **红线**：`dimensions.core.risk` **禁进入 §11.1 权重和归一化计算** · 静态扫描断言 `test_weight_scheme_core_risk_neutral.test.ts` （QADocs 起草 · v1 完稿窗口内追增） 拒 `core.risk` 出现在权重轮动的 raw_w 累加式中
- **禁跨 group 混绘**（Frontend msg=b45f58e4 决策 3 契约层硬约束）：
  - 同一 `<ExplainRadar>` 组件禁同时渲染 core + satellite dimensions
  - 混合列表页强制 tab 分组或双套渲染切换
  - **理由**：core 5 维 = §11.1 4 因子权重锚 + risk 参考位（可解释 = 因子贡献分解）；satellite 6 维 = 事件/催化剂/新闻/流动性/风险乘性衰减（可解释 = 证据链）；两套语义不共尺度
- `rating` × `risk_gate` × `dimension_group` 三 discriminator 组合语义**由 §1.3.4 映射表冻结**
- `method` 字段禁字面照搬 catalyst `"Top-down catalyst + historical edge + liquidity/quality proxy + momentum + event/risk gate"` · 由 detector describe() 独立输出
- `dimensions.satellite` 6 维**不使用** `catalyst` / `history_edge` / `news` 字面 catalyst 词表（避 QADocs 敏感 identifier 黑名单 msg=da74b2dd 规则 2）→ 采用 `us_driver` / `history_response` / `quality_proxy` / `intraday_momentum` / `news_evidence` / `risk` 自研 slot 命名（`quality_proxy` / `momentum` / `risk` 属通用 A 股量化词根 · 非 catalyst 项目专属 · QADocs regex `/^(catalyst_us|analyst_profile|nine_cats_report|jiudian_cat)$/` 不命中）

##### §1.5.4.3 Frontend 组件契约（Frontend msg=b45f58e4 承接）

- `<ExplainRadar dimensions={…} group="core"|"satellite" />` — 雷达图组件（Frontend owns 实现 · Strategy 只约束 schema）
- `<ExplainCard explain={…}>` — 卡片容器组件（承接 full schema render）
- Frontend i18n 映射：`bullish/neutral/bearish → "看好/中性/看空"`；`pass/watch/block → "通过/观察/否决"`
- `<Disclaimer>` 组件必现（QADocs §Disclaimer-Lint 硬约束）

#### §1.5.5 · 证据链分离（B8）· `entry_plan / scenario / positive_flags / risk_flags`（v0.2 新增）

##### §1.5.5.1 设计原则

**证据 vs 判断分离** · 每 signal 附独立字段承载不同语义层：
- `dimensions` = **判断的量化拆解**（0-100 分向量 · 可解释因子贡献）
- `positive_flags` / `risk_flags` = **判断的证据线索**（离散事件 tag · 可枚举可 CI lint）
- `entry_plan` = **判断的执行落地建议**（自由文本 · 用户视角）
- `scenario` = **判断的 3 情景压测**（bull/base/bear · 数字 + 短叙述）
- `method` = **判断的方法学总纲**（一行 · detector 自描述）

##### §1.5.5.2 词表自研规则（License 红线 · 硬约束）

- **禁复制** `POSITIVE_NEWS_WORDS` 15 词 / `NEGATIVE_NEWS_WORDS` 11 词（参考项目 `scoring.py:26-56` 研究成果 · License 红线 §5.3）
- **禁复制** scenario 中文长文案模板（如 "3-8 周上行约 +N.N%" 之类 wording）
- **Strategy 侧自研**（v0.2 稿 skeleton 定字段签名 · v1 稿由 Research 21-current-audit + T+1 窗口补内容）：
  - `positive_flag_dictionary.ts`（新增 · Strategy owns · A 股常见正向事件词表 · 独立整理）
  - `risk_flag_dictionary.ts`（新增 · Strategy owns · A 股常见风险事件词表 · 独立整理）
  - `entry_plan_template()` (pure fn · 输入 signal_v3 → 输出自由文本 · Strategy owns 模板逻辑 · 文案 Frontend UX 自研)
  - `scenario_narrative_template()` (pure fn · 输入 detector regime + expected_value → 输出 3 情景 · 文案 Strategy owns 数字 · Frontend UX 自研中文文案)

##### §1.5.5.3 词表 CI 硬门禁

- 词表内容禁与参考项目 `POSITIVE_NEWS_WORDS` / `NEGATIVE_NEWS_WORDS` 字面重复（QADocs `.jscpd.reference.json` 触发 30% 相似度阈值 → 拒 PR）
- 词表 rebuild 需 ADR 说明 · CODEOWNERS = Strategy + QADocs
- 每词条附来源标签（源自哪个真实事件 / 哪个数据源 · 不引 catalyst 词典）

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
- `backend/src/backtest/strategies/*.ts` 传统实现（MACD/RSI/BB/MA）**v0.2 已决 = delete**（Strategy msg=3dc74ad3 · 采纳 Orchestrator msg=44dcabbb Part 2 建议裁定框架）：
  - **Research 22 §F 6 项 evidence 分派转 M2 执行清单**：
    | Item | 文件 | 决策 | 保留/删除理由 |
    |---|---|---|---|
    | F1 | `backend/src/backtest/strategies/MACDStrategy.ts` | **delete** | Signals-first 架构收敛 · 与 §11.1 权重锚不同源 · 禁 QuantFusion 复现结构性约束 |
    | F2 | `backend/src/backtest/strategies/RSIStrategy.ts` | **delete** | 同 F1 |
    | F3 | `backend/src/backtest/strategies/BollingerBandsStrategy.ts` | **delete** | 同 F1 |
    | F4 | `backend/src/backtest/strategies/MovingAverageCrossoverStrategy.ts` | **delete** | 同 F1 |
    | F5 | `backend/src/backtest/strategies/Strategy.ts` (base) | **delete** | F1-F4 全删 · 基类无引用者 · 不留孤儿基类给未来"再造 TA 策略"留后门 |
    | F6 | `backend/src/backtest/indicators/TechnicalIndicators.ts` | **keep** | §1.4.3 IntradayMomentumDetector 复用锚 · 归入 §4.1 保护 glob `backend/src/backtest/indicators/**` |
  - **Cleanup 独占窗口 8 步执行清单**（M2 独占启动令签发后执行 · 详见 msg=3dc74ad3 §Cleanup 执行清单）：
    1-5. Delete F1-F5 5 文件
    6. 引用点清理：`services/AIInvestmentSignalService.ts:808` intent-detection regex **保留**（非策略调用 · 文本分类）· 其他 7 处引用点 Cleanup 独占逐个清
    7. 关联测试（如存在）一并删
    8. Cleanup log 批次条目记录
  - **保护清单 §4.1 追加**：`backend/src/backtest/indicators/**` 保护理由 = §1.4.3 卫星层 IntradayMomentumDetector 工具库复用锚
  - **QADocs 建议 v1.1 追增**：`test_no_traditional_ta_strategy_in_production.test.ts` 拒 `MACD*Strategy.ts` / `RSI*Strategy.ts` / `Bollinger*Strategy.ts` / `MovingAverage*Strategy.ts` 命名模式未来复活
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
- **v0.2 landing 时点**：M2 独占窗口 Task #5 · Orchestrator msg=e7b59730 authorize（§1.3.4 / §1.4.3 / §1.5.4 / §1.5.5 / §F / §F2 / §4.3 Q5 delete · US v0 不入本 PR · doc-only 单文件精确 · 追加不重排）
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
| Q5 | `backend/src/backtest/strategies/*.ts` 传统实现去留（MACD/RSI/BB/MA）| @Strategy | 保护清单 §4.3 | **v0.2 已决 = delete** · Strategy msg=3dc74ad3 · 采纳 Orchestrator msg=44dcabbb Part 2 · 详见 §4.3 |
| Q6 | 三条红线（Signals-First §11.1 权重 / QuantFusion 禁复现 / AI-tradingagents vendoring）li-yiming 默认允否 | @li-yiming | 全章节方向锁定 | **已默认关闭**（Orchestrator ACK msg=65e8770b · li-yiming "必须问才问") |
| Q7 | 卫星层 5 维 slot 权重初值 | @Strategy | Frontend 组件排序 · v1 定稿 | **v0.2 定值**（§1.4.3.5 · us_driver 0.30/history_response 0.25/quality_proxy 0.15/intraday_momentum 0.15/news_evidence 0.15 + risk 乘性衰减 0.5-1.0 · 4-slot 回落态 0.357/0.214/0.214/0.215）· 走真实历史 Phase 1 walk-forward 验证 · 6 月后再评估 |
| Q8 | `positive_flag_dictionary` / `risk_flag_dictionary` v1 词条清单 | @Strategy | §1.5.5 词表 v1 | 独立自研 · License 红线 · T+1 Research 22-cleanup-candidates 落地后补 |

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

---

## §F（v0.2 新增）· Orchestrator DM msg=64b191e2 flags 处置台账

| Flag | 处置位 | 说明 |
|---|---|---|
| **F1** · 卫星 detector 5 vs dimensions 6 不一致 | §1.4.3.2 · §1.4.3.4 · §1.5.4 schema comment | detector 5 slot（quality_proxy 合并 liquidity_bucket）+ risk 由 Gate 派生 → dimensions.satellite 6 维（自研 slot 命名） |
| **F2** · core dimensions 含 risk 视觉稀释 §11.1 | §1.5.4.2 F2 处置 · §1.5.4 schema comment | `dimensions.core.risk` = 参考位不参与 §11.1 权重轮动 + Frontend `<ExplainRadar>` risk 轴样式差异化 UX 建议 + QADocs 静态扫描断言起草输入 |
| **F3** · Q7 卫星 slot 权重初值 | §1.4.3.5 · §6 Q7 状态转 v0.2 定值 | v1 定值给出 + 独立性声明（结构+数值+分布）与参考项目 5 因子魔数联合三重不同 |

## §F2（v0.2 新增）· 跨层承接 flags 台账

| Flag | 源 | 处置位 | 说明 |
|---|---|---|---|
| **G1** · DataPipeline v1.1 §3 E1a chunk 3-month 分区边界 [^g1-chunk-truth] | Orchestrator msg=e2ce24f1 §6 | §7.1 上游契约 · §M3 契约冻结后开工纪律 | DataSource<T> daily_bars 时间窗口读需知 chunk 边界 · walk-forward 每期 train/test 切分建议对齐 chunk 边界（12 months train / 3 months test 天然对齐 3-month chunk）· 若跨 chunk 边界读 · TimescaleDB 查询计划走 chunk exclusion pushdown 不影响正确性但性能敏感 · Strategy 侧 M3 契约冻结后回测入口 dry-run 校准（G2 walk-forward baseline） [^g1-chunk-truth] |
| **G2** · PR-L 例外通道 4 项 glob 明确责任 | Orchestrator msg=168b6275 §2 (Research §11 flag 转 v1.1 §13) | §M3 · `contracts/strategy.md` v1 冻结时明确路径级 glob | Strategy owns v0 语义级 → v1 路径级 4 项：`backend/src/backtest/strategies/momentum_reversal/**` · `backend/src/services/constraint/AShareConstraintEngine.ts` · `backend/src/services/factor/FactorRegistry.ts` + `backend/src/services/factor/Pipeline.ts` · `docs/SIGNAL_FIRST_PLAN.md#11.1` · v1 冻结后触发 Research 23 v1.1 §13 起草 + QADocs `test_pr_l_exception_dual_sign.test.ts` 独立断言（PR-L 双签 = Strategy owner + Orchestrator + li-yiming 三方 approval reviewers 字面校验） |
| **G3** · §Structural-Deletion-Over-Discipline 原则脚注 → ADR-0001 §附录 | Orchestrator msg=168b6275 §3 + msg=2be507ed §1 (M-Draft 阶段挪入) | ADR-0001 §附录（QADocs 起草 · Orchestrator 定稿） | 采纳 Strategy Q5 决策依据 §1-§2 + 三红线 §1 "架构约束 > 纪律约束" 原则 · Strategy 侧无独立动作 · 属承接注入（引 msg=3dc74ad3 决策链）· M-Draft 三绿窗口 ADR-0001 追加块内落地 |
| **G4** · 卫星层 v1 双态并存（5-slot / 4-slot） | Orchestrator msg=95e48f2b 采纳 Strategy msg=00768065 §1 · **数值纠错 msg=646f9c2a 权威锁定**（Strategy msg=d7e3938b §2 精算 + QADocs msg=622f92f1 §3 tie-break） | §1.4.3.5.1 / §1.4.3.5.2 双态权重表 · `contracts/strategy.md` v1 §14 US 决策 gate · §Q7 归一化公式 + rounding tie-break 规则 | US 数据源决策触发点 = DataPipeline v0.2 §3 §US 决策矩阵稿定 + li-yiming DM 授权 · M-Draft 三绿阶段集中裁 · v1 冻结**双态并存**避免硬依赖 US 决策 · US 决策落定后 CHANGELOG 收敛为单态 · 4-slot 归一化公式 `w_i / (1 - w_us_driver) = w_i / 0.70` = **0.357/0.214/0.214/0.215**（news_evidence 位承担 +0.001 rounding tie-break 补偿 · 三重锚定 §Q7 记录点 + `test_satellite_slot_4_slot_renormalization.test.ts` 断言 C + ADR-0001 §附录 §Rounding-Tie-Break 章）· QADocs v1.1 队列第 13/17 项联动 |
| **G7** · Rounding-Tie-Break 规则锚定 → ADR-0001 §附录第 5 项追加块 | Orchestrator msg=646f9c2a §Rounding-Tie-Break 规则采纳 QADocs msg=622f92f1 §3 建议 | Strategy `contracts/strategy.md` v1 §Q7 记录点 + ADR-0001 §附录 §Rounding-Tie-Break 章（M-Draft 三绿窗口挪入 · QADocs 起草 · Orchestrator 定稿） | 卫星层 4-slot 精算舍入至 3 位小数产生 sum=0.999 · 补 0.001 位选 news_evidence（语义"证据补足"无 arithmetic 偏向）· 避免 QA vs Strategy 独立舍入 0.001 CI red 分歧 · Strategy 侧同步认领反思：v0.2 delta workspace §1.4.3.5.2 原示例 (0.36/0.21/0.21/0.22) 2 位小数粗舍入误差已在 v0.2 delta 稿更新为精算 (0.357/0.214/0.214/0.215) |
| **G5** · PR-L 例外通道 §13 分小节（Strategy 4 项 + C 类数据源 3-4 项统一双签通道） | Orchestrator msg=95e48f2b §2 采纳 QADocs msg=b192ba48 §1 | Research 23 v1.1 §13.1（Strategy 4 项）+ §13.2（C 类数据源 3-4 项 · 待 BlackSwan 揭源终定）· QADocs `test_pr_l_exception_dual_sign.test.ts` 统一覆盖 | Strategy 侧责任 = §13.1 4 项路径级 glob（G2 承接）· §13.2 属 DataPipeline + Cleanup 域 · Strategy 无独立动作 · 通用双签断言 3 方 reviewers + PR 描述字面校验 + Strategy `contracts/strategy.md` v1 §_ SHA-locked 引用 |
| **G6** · Tushare Pro 追问打包窗口 → Quality Q0.3 降级 ADR-0007 触发条件 | Orchestrator msg=95e48f2b §Tushare Pro 追问集中窗口 | §1.2.3 权重锁 red-line 派生扩展 · ADR-0007-quality-factor-fallback.md (QADocs 主 · Strategy 引用) | Orchestrator 打包 DM li-yiming 3 决策（Tushare Pro / US 数据源 / M-Draft 三绿签字）· 若 li-yiming 拒付费 → Baostock `query_profit_data / query_operation_data` proxy 降级路径（DataPipeline 评估覆盖度） · Strategy §1.2.3 red-line 引 ADR-0007 派生扩展 · QADocs v1.1 队列第 14 项 `test_weight_scheme_quality_factor_availability.test.ts` 联动（Pro token OR Baostock proxy 二选一断言） |

[^g1-chunk-truth]: **【契约冻结事实修订 · 2026-07-08】** DP Day 3 契约 v0.2 landing (`docs/refactor/contracts/data.md` §D4.G · PR #94 @ `ad586ef6` 26 PRs) 揭源生产 PG truth: `chunk_interval = INTERVAL '7 days'` · **139 chunks · hypertable_id=1** (DP msg=2fb2b567 SSH `_timescaledb_catalog.chunk` COUNT verify). walk-forward 语义修订: 3 months test ≈ 63 trading days ≈ 9 × 7-day chunks · TimescaleDB chunk exclusion pushdown 仍生效 · 性能影响 = 微 (chunk 数增 · 每 chunk 更小 · pruning 精度提升). Strategy DataSource<T> API zero 变化 · walk-forward split 逻辑不受影响 (TimescaleDB 透明合并跨 chunk 边界读). draft 保 (M0.5 早期预估历史事实 · Orchestrator msg=e2ce24f1 §6 权威锚源) + footnote 反哺 truth (契约冻结事实 · DP `docs/refactor/contracts/data.md` §D4.G v0.2 landed 权威锚). 教训 #12 反向应用范式 (Contract draft ≠ Code truth · 契约层追随生产事实 evolve).

---

**End of v0.2**（Q5 已决 · 待 Q8 词表 v1 + M-Draft 三绿窗口 v1 完稿）
