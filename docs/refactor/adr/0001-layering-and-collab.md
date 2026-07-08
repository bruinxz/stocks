# ADR-0001 · 分层与协作模型 + 现有强约束条款

**状态**：Accepted（M0 骨架）
**签发日期**：2026-07-07
**签发人**：Orchestrator（唯一决策者）
**权威 brief**：Slock #stocks msg=afe6236a
**冻结令消息**：#stocks msg=ec897217（初版）→ msg=a5e73982（M0 校准版）
**输入合并**：@QADocs + @DataPipeline + @Strategy + @Cleanup + @Frontend 全轮次追加

---

## 背景

@li-yiming 给出 6 执行角色 + 1 Orchestrator 的重构架构（brief msg=aa4a755c → 校准版 msg=afe6236a）。本 ADR 落定分层、协作规则、里程碑、现有强约束条款，为所有后续工作定基础。

---

## 决策

## §1 分层与协作模型

### 1.1 角色与独占目录

| 角色 | 独占目录（写权限） | 只读全仓 |
|---|---|---|
| **Orchestrator** | `docs/refactor/00~19/**`、`docs/openapi.json`（冻结前只读） | 全仓 |
| **Research** | `docs/refactor/20~29/**` | 全仓 |
| **Cleanup** | Phase 0 期独占全仓写权限，写到 `docs/refactor/30~39/**` | 全仓 |
| **DataPipeline** | `backend/src/{data,jobs,realtime,models,scripts}/**`、`backend/src/models/`（数据类）、`backend/python/**`、broker-bridge 行情/回报（待 P2） | 全仓 |
| **Strategy** | `backend/src/{quant,backtest,portfolio,metrics}/**`、`ai/tradingagents-app/**`、`backend/src/models/`（策略类） | 全仓 |
| **Frontend** | `frontend/**`（含 `frontend/server.js`）；展示 BFF/API 在 `backend/src/api/` 内提请 Orchestrator | 全仓 |
| **QADocs** | `docs/{TESTING,DEVELOPER_GUIDE,USER_GUIDE}.md`、`docs/refactor/40~49/**`、`.github/**`、`backend/tests/`、`frontend/tests/` | 全仓 |

**豁免归属**（无明确 owner 的仓库根工具）：`verify.mjs` / `.verify_token` / `shots/` = Orchestrator 豁免归 Cleanup 处理（本轮已裁决删除）

### 1.2 协作规则

1. 跨层契约（接口 + 数据模型）由 Orchestrator 定稿后其他 Agent 才动手
2. 契约变更走 CHANGELOG + 版本号 (`<layer>-contract v<major>.<minor>`) + ADR
3. Phase 0（Cleanup）独占时间窗；开发类 Agent 暂停对相关目录写入
4. 目录边界内 owner 独占写权限；跨界 → 提请 Orchestrator
5. QADocs 横切；每 gate 参与验收
6. 沟通格式：每次交付回 Orchestrator 时包含 (a) 做了什么/对应里程碑 (b) 触碰文件/契约变更 (c) 风险与待确认 (d) 自检 DoD 逐条勾

---

## §2 里程碑（本轮范围 = 调研 + 方案，不改代码）

| 阶段 | 谁 | 输出 | Gate |
|---|---|---|---|
| **M0** 契约锚点 | Orchestrator | `00-anchor.md`, `10-contracts.md`, `adr/0001-*.md`, `contracts/{data,strategy,display,protect,dir-ownership}.md` v0 骨架 | 契约模板冻结 |
| **M1** 调研审计（并行 A，5 天） | Research | `20-reference-report.md`（双入口）, `21-current-audit.md`, `22-cleanup-candidates.md`, `23-protect-list.md` | Orchestrator gate |
| **M0.5** 基线固化（并行 B，只读，3 天） | Strategy 主控 + Frontend 前端快照 + DataPipeline 数据校验和 | `24-baseline.md`, `25-frontend-baseline.md`, `docs/refactor/baseline/{strategy,frontend,data,scripts,security}/**` | Orchestrator gate + QADocs 验收单 |
| **M-Draft** 交付物 A/B 起草 | Orchestrator 整合 + 各 owner 章节 | 呈 li-yiming | Research 交付后 3 天 |
| **本轮终点** | li-yiming 签字 | 方案确认 | — |
| **M2** Phase 0 清理 | Cleanup 独占 | `30-cleanup-log.md` + 每批 commit | 每批合格 + QADocs 验收单 + 最终退出令 |
| **M3** 三线并行 | Data / Strategy / Frontend | `contracts/*.md` v1 + 各自模块产出 | Data v1 → Strategy v1 → Frontend v1 依次冻结 |
| **M4** 集成 DoD | 全员，QADocs 主控 | 一致性报告 + CHANGELOG + 全局 DoD 签署 | 交付 |

---

## §3 本轮交付物章节 owner

- **交付物 A · 参考项目报告**：@Research 主控（双入口通读 + License + 借鉴/放弃表 + catalyst 逻辑 + UX 亮点）
- **交付物 B · 我方改造方案**：
  - §现状诊断 = @Research 主控
  - §目标架构设计 = @Orchestrator + 各层选型评估附录
  - §荐股策略设计 = @Strategy 主控
  - §参考 vs 现状融合决策表 = @Orchestrator 主控 + @Strategy（策略/因子/回测行）+ @Frontend（UI 行）+ @DataPipeline（数据源行）
  - §清理方案 Phase 0 蓝图 = @Cleanup 主控 + Research 依据 + Strategy 保护段
  - §数据迁移方案 = @DataPipeline 主控
  - §文档与开发范式规划 = @QADocs 主控 + @Orchestrator
  - §分阶段实施计划 = @Orchestrator 主控
  - §测试策略 = @QADocs 主控 + @Strategy（7 关验收）

---

## §4 数据契约核心约定（→ `contracts/data.md` v0）

### 4.1 时区/精度
- Asia/Shanghai；`available_at` 底层 UTC ISO8601，展示层转 SH
- 日线：`date`
- 分钟/tick：`ts: bigint (ms since epoch)`（v1.0 预留字段位，实际入库延后 v1.1）

### 4.2 缺失值语义
- 三态枚举：`SUSPENDED / NOT_LISTED / MISSING_DATA`（禁用 NaN 承载语义）
- 独立列（非语义槽）：
  - `newly_listed_n: int`（上市至今交易日数，天数不二值化，阈值决策归策略）
  - `resumed_today: bool`（停牌复牌当日）

### 4.3 除权除息
- 主视图 = 前复权价；独立提供复权因子表（事件流 + 累计因子两视图并存）
- 每行携带 `adj_base_date`
- 基准日 = 每次 daily-update 快照的最新交易日
- rebase 规则：分红送股当日累计因子整段乘以新比例；历史序列快照分区不重写旧 `adj_base_date` 之前数据
- **回测入口默认取数方式 = 按窗口取对应 `adj_base_date` 分区**

### 4.4 回测/因子读取接口默认签名
```
read(..., as_of_date: date | None = None)
```
- `as_of_date=None` → 最新交易日基准（生产）
- 指定 → 返回该 `as_of_date` 基准的前复权快照（滚动回测无回填无未来函数）
- 快照按 `adj_base_date` 分区存/取

### 4.5 PIT 三字段独立存储
- `report_date` / `publish_date` / `available_at` — 独立列，禁互相替代
- **偏序不变式**：`report_date ≤ publish_date ≤ available_at`
- 三重保险：
  - 存储层 CHECK 约束（DataPipeline 拒绝违规入库）
  - 契约级 assert（QADocs）
  - Strategy 运行时 assert（QADocs 提供公用 helper）

### 4.6 未来函数防护（三层护栏）
1. 静态 ESLint 自定义规则 / CI grep（QADocs 起草）
2. 运行时 helper `assert_pit_safe(df, t, timestamp_col='available_at')` — 默认强断言，关闭需 ADR 备案（QADocs 出规范放 `40-quality-gates.md#pit-helper`；Strategy 调用）
3. 契约漂移静态扫描：绕过 `as_of_date` 直读原始复权表的调用点拒绝合入（QADocs 出规则）

### 4.7 `daily_tradability` 派生视图
`(symbol, date)` join：
- `limit_up / limit_down / one_word_limit: bool`
- `tradable: bool`（最宽松综合位；任一方向可动 → true）
- 四向可动位：
  - `can_open_long`（非停牌 + 非一字涨停 + 流动性达标）
  - `can_open_short`（非停牌 + 非一字跌停 + 融券白名单）
  - `can_close_long`（非停牌 + 非一字跌停）
  - `can_close_short`（非停牌 + 非一字涨停）
- `suspend_reason: enum?`
- A 股融券白名单 + T+1 规则语义边界由数据层写死，策略层不判断融券资格

### 4.8 六实体
1. 日线K线
2. 复权因子（事件流 + 累计因子）
3. 交易日历（含半日市 flag）
4. 基本面 PIT
5. 元信息（symbol/name/list_date/delist_date/status/industry_code/exchange）
6. 行业/指数成分（历史版本化）

v1.0 只锁日线；分钟/tick 到 v1.1，字段位在 v1.0 预留避免破坏性变更。

### 4.9 数据源
候选延后至 Research 事实基线到手后拍板；ADR 默认策略 = 多源交叉校验。DataPipeline 出 `data-sources-consolidation.md`（EastMoney 家族→EastMoneyBase / Combined+MarketDataProvider+PythonMarketDataClient 门面唯一化 / AKShare 按实体拆读取 / 零调用无测试归 C）→ Orchestrator 签字 → 写 `contracts/data.md` v1。

---

## §5 保护 glob（→ `contracts/protect.md` v0）

初始集：
- `backend/src/quant/**`
- `backend/src/backtest/**`
- `backend/src/portfolio/**`
- `ai/tradingagents-app/**`
- `backend/src/services/{factor,analysis-engine,regime,attribution}/**`
- `backend/tests/{factor,factors,backtest,quant,strategies}/**`
- `backend/tests/**/*real*`
- `backend/scripts/migrations/**`
- `backend/src/data/migrations/**`（若存在）
- `docs/refactor/**`（含 `baseline/**`）
- `docs/refactor/baseline/strategy/**`

Research 看到实际结构后收紧再报，Strategy 最终 ack。

**豁免流程**：Cleanup 需删保护 glob 内内容 → `#stocks` 发豁免申请（路径 + 依据 + 影响半径 + 测试兜底） → Orchestrator @ 相关 owner ack → Orchestrator 签字 → 执行。

---

## §6 Phase 0 独占启动令准入条件（M2 阶段，方案签字后）

全部绿方发启动令：
- [ ] M1 交付物 A 四份齐（Research）
- [ ] M0.5 基线冻结签收（Strategy 3 组配置 + Frontend 前端快照 + DataPipeline 数据校验和附录）
- [ ] Strategy 对最终保护 glob 显式 ack
- [ ] Data/Strategy/Frontend/QADocs 各在 #stocks 回一句「停写 X 目录」
- [ ] refactor 分支建好；干净可回退 commit 标记
- [ ] DB 备份/快照产出（`npm run db:backup`）
- [ ] QADocs `gitleaks` pre-cleanup baseline 已跑存档到 `docs/refactor/baseline/security/gitleaks-pre.json`
- [ ] 不可逆项按 P1-A（DB 删干净 + 每批 li-yiming 签字）处理
- [ ] li-yiming 方案签字（本轮终点）
- [ ] Orchestrator 签发独占启动令（含"其他 Agent 停写目录明细"）

---

## §7 Cleanup 每批 commit 交付格式（→ `30-cleanup-log.md`）

单批只一个主题：**死代码 → 无用依赖 → 废弃采集器 → 脏数据 → 密钥治理**（Research 现状可调整顺序，Orchestrator 拍板）

每批含：
1. 主题
2. 删除条目 + 依据（ts-prune / madge / depcheck / grep 引用）
3. 编译通过证据：`tsc --noEmit` + `frontend build`
4. 相关子系统 `pytest -q` / `jest` 全绿
5. 保护 glob 未触碰证明（diff 影响路径列表）
6. 是否不可逆（DB/数据）— 是 → 单开一批 + 附 li-yiming 拍板记录
7. 体量变化数（文件 / 行 / 依赖 / DB 对象）
8. revert 路径可达（commit 独立不 squash）

QADocs 每批 24h 内在其 thread 内 ack 或 block。

**密钥类**：告警 + 轮换（决策权在 li-yiming）；本轮 `.verify_token` 因 JWT 已过期 + 远端废弃已授权 Cleanup 删除，历史重写延后 Phase 0。

**豁免流程**：见 §5。

**退出条件**：所有批次完成或明确跳过并留痕；tsc / build / 已有测试全绿；QADocs 出 Phase 0 验收单（体量 + 密钥扫描 + 保护清单零触碰 + `available_at` 断言未回归 + 基线目录零触碰）；Orchestrator 签发退出令。

---

## §8 QADocs 拍板项（v0，li-yiming 有异议可推翻）

### Q1 覆盖率下限
- 核心工具 / 因子 / 回测框架 ≥ **85%**
- `quant/` 胶水代码 60-70%
- Service 层 ≥ 60%
- API handler ≥ 50%
- Python 采集器核心路径 ≥ 60%
- `ai/tradingagents-app` LLM prompt 类逻辑：**不硬卡覆盖率**，走集成/端到端
- UI：关键页面交互全覆盖；「关键页面清单」M3 前 Frontend + QADocs 联合定，Orchestrator 签字

### Q2 CI 平台
GitHub Actions（`.github/` = QADocs 独占）

### Q3 License 白名单
- 白名单：`MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC / Unlicense`
- 灰名单（逐个审）：`LGPL-2.1/3.0 / MPL-2.0 / EPL`（豁免走 ADR）
- 黑名单：`GPL-* / AGPL-*`（禁；例外由 li-yiming 拍板走 ADR）
- 落 `docs/refactor/allow-list-licenses.md`；工具 `license-checker`（TS）/ `pip-licenses`（Py）
- Cleanup `depcheck` 批次对齐

### Q4 基线 = Phase 0 前置门禁
已在 §6 落定

### Q5 US-038（Math.random 禁用）
`Math.random()` 静态 lint 拒合入；策略/回测/因子路径必须用 `SeededRandom`（Park-Miller LCG）

---

## §9 QA 契约级校验位（QADocs 汇总，进契约文档）

1. `adj_base_date` 一致性：同一基准日快照多次生成序列恒等（复权序列稳定性回归测试）
2. `daily_tradability` 视图完整性 + 组合真值表校验
3. 基本面 PIT 三字段独立、非空、互不替代
4. 偏序不变式 `report_date ≤ publish_date ≤ available_at`（三保险）
5. `as_of_date` 默认签名；绕过它读原始复权表静态拒合入
6. `available_at` 断言/lint 关闭 PR 无关联 ADR → QA 拦
7. 回测 7 关 P0 硬约束（策略上线必过 6/7）— 见 §10.2
8. `Math.random()` 全项目禁用（US-038）— 见 §10.5

---

## §10 现有强约束条款（Strategy `notes/existing-conventions.md` 采纳；msg=0532b709）

**规范源**：`REFACTOR_PLAN / PROJECT_COMPASS / TESTING / SIGNAL_FIRST_PLAN / MERGE_TRADINGAGENTS_PLAN / AGENTS / SECURITY / quant/CLAUDE.md / quant/factors/CLAUDE.md`

10 条强约束，全项目通用，冲突需显式 ADR 推翻：

### 10.1 5 个 public facade 单例硬约束
Controller 只能 import `strategyEngine / signalEngine / backtestEngine / performanceReporter / quantHealthMonitor`。**不许新增第 6 个**（新增需 ADR）。

### 10.2 回测 7 关 P0 硬约束（DoD 硬项；QADocs 加入验收）
策略上线必过 **6/7**：
- 成本后年化 ≥ 10%
- CSCV·PBO < 0.5
- walk-forward
- 参数扰动
- OOS 12 月
- regime 分层
- 成本翻倍压力

### 10.3 因子内部规范
- **禁 winsorize / zscore**（Pipeline 统一做）
- **稀疏 Map 契约**
- **一因子一文件**

### 10.4 DataSource DI 六种范式
所有回测/优化器全部脱 DB：`BacktestRunner / RegimeSource / TradeReturnSource / StrategyReturnSource / BenchmarkReturnSource / IndustryDataSource`。与 §4.4 `as_of_date` 是同一门禁体系两半。

### 10.5 SeededRandom 强制、`Math.random()` 禁用（US-038）
QADocs 加静态 lint 拒合入 `Math.random`。

### 10.6 组合策略 caller-prefetch 契约
`generateSignals(date)` 策略必须由 caller 预取信号，否则退化 hold。

### 10.7 信号 confidence = 90 天真实胜率
非规则打分。**QuantFusionService 教训**：95 笔 0% 实盘。**Anti-pattern**：多策略投票 + 规则打分。

### 10.8 因子权重锚点 §11.1（`SIGNAL_FIRST_PLAN`）
V0：Value **0.40** / Quality **0.30** / LowVol **0.30** / Momentum **0.0**（shadow）。新数字必须锚 §11.1 或 §11.2。

### 10.9 通知渠道
**不发手机 push（C-7），飞书允许**；产品文案禁绝对收益承诺。

### 10.10 所有远端配置走 env
`TRADING_AGENTS_URL` 等；**禁硬编码 IP** 如 `103.242.3.87`。

---

## §11 Strategy 3 条方案期红线（msg=e4f70774；li-yiming 默认全允）

1. **不推翻 signals-first 架构与 §11.1 权重**：属原则 3 保护对象；除非参考项目 catalyst 展现"可回测 + 成本后年化 ≥ 10%"显著优势，否则融合方向 = "catalyst 作卫星层信号 detector 之一"，不替换核心 ETF 因子轮动
2. **不复现 QuantFusionService 模式**：多策略投票 + 规则打分的 confidence 已被 95 笔 0% 实盘证伪
3. **AI/tradingagents 保持 vendoring 独立进程**：不并入 Node 主后端，不改单一真源约定 (akshare / stocks 后端)

---

## §12 docs 目录 owner 分区（→ `contracts/dir-ownership.md`）

- `docs/refactor/00~19` → Orchestrator（锚点/契约/ADR）
- `docs/refactor/20~29` → Research（现状 / 基线）
- `docs/refactor/30~39` → Cleanup（清理日志）
- `docs/refactor/40~49` → QADocs（门禁/DoD/CHANGELOG）
- `docs/refactor/baseline/**` → M0.5 联合写（Strategy/Frontend/DataPipeline），完成后并入保护 glob
- `docs/TESTING.md / DEVELOPER_GUIDE.md / USER_GUIDE.md` → QADocs
- `docs/openapi.json` → 冻结前 Orchestrator 只读裁决，冻结后 QADocs 做漂移校验
- `docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md / FRONTEND_ARCHITECTURE.md` → Frontend；推翻需 ADR
- 其他既有 docs 各自 owner，争议 → Orchestrator

---

## §13 li-yiming 校准解读（brief msg=afe6236a）

- **P1（DB 不可逆删除）= P1-A**：策略删干净、每批执行前呈报清单 + 依据 + revert 路径 → li-yiming 签字
- **P2（live-trading + broker-bridge）= P2-B**：Research 只读盘点 + 借鉴价值判断；无借鉴归 Cleanup 独批审批删除
- **本轮 R1（`.verify_token` 历史重写）= 延后 Phase 0**：JWT 已过期 3 天 + 远端服务器废弃（msg=fa1caa7a），本轮 Cleanup 只删工作树
- **选型自由度**：沿用现有栈 vs 换新栈**每项走 ADR**，M1 现状盘点出**选型评估附录**

---

## §10.2a 回测 7 关 gate 反例覆盖矩阵（QADocs 主控）

**目的**：证明每 gate 真在生效——单一失败点原则，每反例只违反 1 gate 的核心条件，其余尽量过。

**产物**：
- `contracts/backtest.md §Gate Negative Coverage`（QADocs 主控）
- `backend/tests/backtest/gates/refs/*.ts`（reference strategies，仅测试用途）
- 元测 `test_gate_matrix_completeness.test.ts`（缺任何 gate 反例 → 拒 PR）

**覆盖表 v0**（QADocs msg=49e39ad7；正式列表由 QADocs 起草冻结）：

| Gate | 反例 Ref Strategy | 拒因 |
|---|---|---|
| G1 年化 | `fixture_ref_negative_expected_return` | 因子权重反号 |
| G2 PBO | `fixture_ref_random_walk` | 纯 SeededRandom OOS 过拟合 |
| G3 Walk-forward | `fixture_ref_regime_dependent` | 只在牛 regime 有效 |
| G4 参数扰动 | `fixture_ref_knife_edge_params` | ±10% 参数发散 >30% |
| G5 OOS + Leak | `fixture_ref_look_ahead` | `available_at` runtime raise |
| G6 Regime 分层 | `fixture_ref_survivorship` | 熊 regime 子样本 ≤0 |
| G7 成本翻倍 | `fixture_ref_high_turnover` | 换手成本吃掉年化 |

**§11.1 权重方案反例扩展 v0.2**（Strategy msg=37bb0ea3，Orchestrator msg=90f087a8 采纳）：

| 因子槽 | 反例 Ref Strategy | 主拒 gate | Regime |
|---|---|---|---|
| Value 0.40 | `fixture_ref_weight_scheme_value_trap_2015_top` | G6 | `bubble_top` ≥ 2 个月 |
| Quality 0.30 | `fixture_ref_weight_scheme_quality_regime_flip` | G3 | `quality_underperform_regime` ≥ 8 个月 |
| LowVol 0.30 | `fixture_ref_weight_scheme_lowvol_policy_shock` | G7 派生（PR-L 触发失败；G5 leak 由 `available_at` 三层护栏拒 → 主拒不在此） | 政策黑天鹅 gotcha |
| Momentum 0.0 (shadow) | `fixture_ref_weight_scheme_momentum_reversal_trap` | G7 成本翻倍 | `momentum_reversal_20d` ≥ 3 窗口 |

**路径分层**：
- `backend/tests/backtest/gates/refs/base/**` = 基础 7 反例 + `fixture_ref_alpha`（教具）
- `backend/tests/backtest/gates/refs/weight_scheme/**` = 4 §11.1 反例
- 双层 = QADocs 独占（见 `contracts/dir-ownership.md` §1 脚注）
- 元测 `test_gate_matrix_completeness.test.ts` 独立扫描两层，缺任一 → 拒 PR

**关键约束**：
- **单一失败点**：每反例只违反 1 gate 主拒因
- **共享合成 fixture**：差异在策略行为不在数据，证明"拒是策略垃圾"非"数据 bug"
- **元测完整性**：缺 gate 反例 → PR 拒
- **Strategy 侧输入**：@Strategy 补 §11.1 相关"real-world 崩溃形态"反例草案，QADocs 实现为 Reference Strategy 类

**教具**：`fixture_ref_alpha`（行业动量 top-N 等权），fixture 合成参数按此教具能过 7 关设计。

**路径归属**：`backend/tests/backtest/gates/refs/**` = QADocs 独占（Q-M1 by Orchestrator）；进 `contracts/dir-ownership.md`。

---

## §10.8-footnote §11.1 权重合规验证锚点红线

§10.8 补充：**§11.1 权重（Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0）合规验证锚点 = 真实历史数据 Phase 1；禁使用 fake DataSource fixture 结果作为过关证据**。fake fixture 仅用于 gate 基础设施 CI 冒烟（`fixture_ref_alpha` + 7 反例）。

**依据**：QADocs msg=2db3bde7 "教具与被测混淆" 反循环论证 → Orchestrator msg=2a86337a 采纳。

**opt-out 域**：`fixture_ref_*` **全域**（含 `refs/base/**` 和 `refs/weight_scheme/**`）不得出现在 §11.1 权重合规验证测试的 import 侧；QADocs `test_gate_g6_regime.test.ts::test_ref_strategy_11_1_weight_compliance` 静态扫描断言防止未来伪证（msg=83cb9b0e §2 + msg=90f087a8 §6 采纳）。

---

## §附录 · 依赖引入触发条件（预留 ADR-0005 依赖治理占位）

**触发条件**（本 ADR 内立即生效）：
- 任何新增第三方**运行时**依赖（不含 devDependencies transitive 传导）都需满足其一：
  - (a) 走单独 ADR 归档理由 + license 白名单校验 + 目录 owner 审批
  - (b) 落 QADocs License 白名单档 `docs/refactor/allow-list-licenses.md`（若已列白名单则无需再走 ADR）
- 依赖变更需在 `#stocks` broadcast + 相关 owner ack
- 版本锁定策略、依赖漂移检查 CI、supply chain 审查等具体规则 → **ADR-0005 依赖治理**（QADocs 起草，M-Draft 阶段整合）

**已产生的例外**：
- fake fixture spec v0.6 新增 `parquetjs-lite`（Orchestrator msg=7ade1521 裁；Path A 默认 or Path B JSON gzip 无新增依赖 DataPipeline 自便） → 走 (a) 或 (b) DataPipeline 落地时确认 license 白名单

---

## §凭证纪律（Cleanup msg=5b233a83 起草，Orchestrator 合入）

**签发依据**：Orchestrator 约束令 msg=b091c74d 采纳 Cleanup 提案 msg=c606ec9f + li-yiming DM 澄清 msg=5d7bdee7（"从 prod .env 读 ≠ 硬编码"，但公共频道明文粘贴仍构成公共泄露）

### 铁律
1. 凭证类信息（SSH 账号密码、SSH key、PG/Redis/其他 DB 账号、API key、JWT/Session token、云厂商 access key、第三方服务 token、证书私钥）只走 DM 或密钥管理系统（Vault / KMS / 1Password Business），禁止 #stocks / #all / 任何公共频道明文发送。
2. Agent → Agent 凭证传递：DM 目标 Agent；不得截图 / 转发到公共频道 / 落 workspace 明文文档 / 落 commit / 落日志。
3. Agent 请 li-yiming 提供凭证：DM li-yiming 请他 DM 回；不得在公共频道直接请求（避免引诱公共回复）。
4. 占位符规范：文档 / 示例 / test fixture 中的凭证必须是显式假值（`sk-test-fixture-xxx` / `<REPLACE_ME>` / `dummy-token-not-real`），且注释注明 "fake / not real / test-only"；`.env.example` 中的占位值**不得从生产 `.env` 拷贝**。
5. 规则层交叉引用：@QADocs 起草 `docs/refactor/40-quality-gates.md` 或 `drafts/credential-scan-rules-v0.md`（gitleaks 规则集扩展 · Slock 历史扫描思路 · 占位符规范 · 泄露事件响应 checklist）—— 纪律层在本 ADR，规则层在 QA 门禁档。

### 已发生事件
- msg=ed61c397 (2026-07-07 20:51:16) + msg=fa1e2215 (2026-07-07 20:52:23)：li-yiming 在 #stocks 明文贴生产 SSH 凭证 + 开发机账号（来源 = 从 prod `.env` 读取，非硬编码；DM msg=5d7bdee7 澄清）
- 所有 Agent 禁止在回复 / workspace 文档 / commit message / log 中转载或引用这两条消息的账号 / 端口 / 密码字面内容；引用一律用消息 ID。

### 事件响应流程（若再次发生）
1. 发现 Agent 立即 DM 凭证所有者建议立即轮换 或 切 key-only 或 加 IP 白名单
2. 同一 Agent 在 #stocks 发红旗通知（不复述凭证内容，只引 msg ID + 处置建议）
3. @Orchestrator 承接后续访问治理（本次 = 服务器访问约束令 v1 msg=b091c74d），@QADocs 起草凭证扫描规则纳入 Phase 0 密钥治理批
4. 不追溯性删除（Slock 消息历史里的密钥字面无法销毁 → 以"已泄露→立即轮换/约束"处置，而非"删消息假装没发生"）

### 违反处置
- 首次：Orchestrator 私下提醒 + 该 Agent 补自检
- 再次：Orchestrator 在 #stocks 公开约束
- 涉核心生产凭证泄露：立即向 li-yiming 上报

### 服务器访问约束令 v1（msg=b091c74d 摘要，全文见 #stocks）
- 默认账号 `deploy`；`ops` 逐命令审批；`root` 除 li-yiming 本人外禁用
- PG 只读 SELECT；每 SQL 需 #stocks 报批（目标 + 表 + 语句 + 预期量）
- 3 档命令白名单：🟢 只读放行 / 🟡 需批 / 🔴 禁用（`rm/mv/chmod/systemctl stop|disable|restart/kill -9/pkill/docker rm|prune|restart/crontab/SQL 写/passwd/usermod/任何 sudo 写`）
- 远端配置一律走 env；禁硬编码 IP（如 `103.242.3.87`）

---

## §14 引用消息 ID

- li-yiming 权威 brief: msg=afe6236a
- li-yiming 初版 brief: msg=aa4a755c
- li-yiming 参考项目 URL + token 授权: msg=945470f4
- li-yiming JWT 澄清: msg=9cf8678e
- li-yiming 服务器废弃: msg=fa1caa7a
- QADocs 汇总: msg=5768f12f
- QADocs pre-baseline done: msg=a423f882
- DataPipeline 契约细化: msg=7935bea7
- DataPipeline 收敛方向: msg=1f2ed385
- DataPipeline 本轮职责: msg=8ff20f55
- Cleanup 每批交付格式: msg=71718c6c
- Cleanup D9 事实澄清: msg=a6590500
- Cleanup JWT exp 分析: msg=d44712c4
- Cleanup 处置更新: msg=9f52552d
- Frontend 基线内容: msg=18b9fba9
- Frontend D8/D10 修订: msg=2b31cd63
- Strategy 追加合集: msg=8f66302e / 13b31f12 / ff84872c / 3d51f3ec
- Strategy 10 条既有约定: msg=0532b709
- Strategy 3 红线: msg=e4f70774
- Research v0 摘要承诺: msg=b74bb60b
- Orchestrator 初版冻结令: msg=ec897217
- Orchestrator M0 校准令: msg=a5e73982
- Orchestrator 服务器访问约束令 v1: msg=b091c74d
- li-yiming 凭证澄清 DM: msg=5d7bdee7
- Orchestrator 裁决 §9 循环论证 + 归口 + 合入授权: msg=2a86337a
- Cleanup ADR §凭证纪律起草: msg=5b233a83
- Cleanup C-01b + 独占校准 ACK: msg=20f31ba9 / msg=eea0b978
- QADocs post-baseline: msg=56663cad / msg=f6dc3a0b
- QADocs gate 反例矩阵起草: msg=49e39ad7
- QADocs §9 循环论证异议: msg=2db3bde7
- DataPipeline v0.2 fixture spec: msg=c8aa0184
- DataPipeline fixture spec v0.1: msg=1d4862b9
- Strategy fixture review v0.1: msg=8f172331
- Strategy 裁决 ACK + R1/R3/R4/R5 精修: msg=74c6cc3e

---

---

## §附录追加 · 6 项汇总目录

1. §Structural-Deletion-Over-Discipline
2. §10.8-satellite-footnote
3. §凭证纪律事件响应（第 2 起 · 777 事件）
4. §附录 Q5 决策记录点
5. §Rounding-Tie-Break
6. §Independence-Flexibility-Footnote

---

## §Structural-Deletion-Over-Discipline

**签发依据**：Strategy 三红线 §1（msg=e4f70774）+ Q5 决策依据 · 采纳 Cleanup msg=c606ec9f + QADocs msg=2db3bde7 派生

**原则**：结构性删除服务架构简化 · 非纪律教条

**核心语义**：
- 死代码 / 无用产链 / 观测层假活的删除，其目的是使系统架构更简单可读
- 删除不是为了"贯彻纪律"或"炫技术洁癖" · 而是为了消除认知负担与运维假活
- 保留有明确未来接回路径 / 读端 API 完整 / 有真实业务观测价值的接口点，即使当前产链断开（e.g. BlackSwan "冷冻位"）

**判定层级**：
- **删应**：Producer 死 + Consumer 死（Snowball/StockQA C-S1+C-S2 全 stub · Task #4）
- **冷冻**：Producer 死 + Consumer 活（BlackSwan 第三态 · β 选项）
- **保留**：Producer 活 + Consumer 活（默认态 · 不进删除清单）

**反面模式**（禁）：
- ❌ "为删而删"：删完观测点 / 读端 API 而无用户 / 系统实际收益
- ❌ "过度重构冲动"：把待优化的接口重命名 / 内联 / 拆分至无必要
- ❌ 违 §11.1 权重锚合规验证锚点（教具与被测混淆）

**依据消息**：
- Strategy msg=e4f70774 · 3 条红线
- Cleanup msg=c606ec9f · 结构删除动因
- Cleanup msg=9249f5cd · BlackSwan β 冷冻位应用（本原则 template case）
- DataPipeline msg=f54b383b · β 精确 delete/保留清单
- QADocs msg=99293d1b · β 视角一致

---

## §10.8-satellite-footnote

**签发依据**：ADR-0001 §10.8 补充 · QADocs msg=2db3bde7 "教具与被测混淆" 反循环论证 → Orchestrator msg=2a86337a 采纳

**红线**：
> §11.1 权重（Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0 shadow）合规验证锚点 = **真实历史数据 Phase 1**；禁使用 fake DataSource fixture 结果作为过关证据。

**opt-out 域**：`fixture_ref_*` 全域（含 `refs/base/**` 和 `refs/weight_scheme/**`）不得出现在 §11.1 权重合规验证测试的 import 侧

**CI 静态断言**：
- `test_gate_g6_regime.test.ts::test_ref_strategy_11_1_weight_compliance` 静态扫描断言防止未来伪证（msg=83cb9b0e §2 + msg=90f087a8 §6 采纳）
- 教具（`fixture_ref_alpha` + 7 反例）仅用于 gate 基础设施 CI 冒烟

**扩展至卫星层 5-slot / 4-slot 权重**（§Q7 v1）：
- 5-slot 主态（0.30/0.25/0.15/0.15/0.15）合规验证锚点 = 真实历史 Phase 1（US Alpha Vantage 24h 内 3 次失败 gate 前 · Baostock 数据充分覆盖）
- 4-slot 回落态（0.357/0.214/0.214/0.215 · tie-break +0.001）合规验证锚点 = 真实历史 US 数据源缺位场景重跑
- 卫星子层 gate-negative-coverage v0.3（QADocs v1.1 追增第 4 项 · Task #16）

---

## §凭证纪律事件响应（第 2 起 · 777 事件）

**发生日期**：2026-07-07 SSH 阶段 2 深化期间（DataPipeline SSH B-2 探测）

**事件描述**：
- 路径 `/opt/stocks-xz/releases/initial/backend/.env` 权限 = **777 world-writable**
- 属生产环境明文凭证承载文件
- 发现方 = DataPipeline · escalate = Orchestrator DM li-yiming msg=15982453 · 通知升红旗

**处置**（未在本轮修复 · 登记）：
- **不在本轮 SSH B 通路修复**（避免服务器写侧动作，守服务器访问约束令 v1 msg=b091c74d）
- **登记 Phase 0+ 处理**（M-Draft 阶段登记 · li-yiming 私域二次决策处置方式）
- **处置选项**：A) `chmod 640 stocks_app:stocks` + rotate all values / B) 迁至 `/opt/stocks/ai-src/.env` 600 root + rotate

**教训层**：
- 生产 world-writable 凭证 = 高危泄露向量 · 与 §凭证纪律 5 铁律并列的运维事故位
- 与首起事件 msg=ed61c397 + msg=fa1e2215（li-yiming 公共频道贴 SSH 凭证）不同 · 本起属**权限管理事故** · 非**沟通渠道事故**
- 事件响应流程沿 §凭证纪律 · Orchestrator DM 承接治理

---

## §附录 Q5 决策记录点

**签发依据**：Strategy msg=3dc74ad3 Q5 决策 · Orchestrator msg=eccb386e 采纳

**决策**：
- 5 传统策略 delete（MACD / RSI / BB / MA + 5th 项）
- `TechnicalAnalysisReport` model 同批 delete
- F1-F5 5 项 27 项累计入 22-cleanup 分派表

**保留**：
- F6 `backend/src/backtest/indicators/TechnicalIndicators.ts` keep（§1.4.3 IntradayMomentumDetector 复用锚）
- I3 `/api/signals` keep（Phase 1 迁移期）

**归入 §Structural-Deletion-Over-Discipline template case**：
- Producer 死 + Consumer 死 → delete
- Producer 活 + Consumer 活（`TechnicalIndicators.ts`）→ 保留

---

## §Rounding-Tie-Break

**签发依据**：Orchestrator msg=646f9c2a 数值纠错 · Strategy msg=d7e3938b + QADocs msg=622f92f1 双 ACK · msg=c56acff0 §3 附录清单

**规则**：4-slot 回落态精算 `w_i / 0.70` 三值等 0.214 · 权重和 = 0.999 · **尾差 +0.001 补偿位落在 `news_evidence` slot**（值 = 0.215）

**理由**：
- news_evidence slot 三方（Announcement/DragonTiger/MoneyFlow）证据链融合位
- 尾差不影响 signal 权重排序
- UX 感知无差异
- 语义呼应"证据补足"

**CI 断言**：QADocs Task #12 `test_satellite_slot_4_slot_renormalization.test.ts` 断言 C · `news_evidence == 0.215`

### §附录 · 跨域权重数值裁决前置校验清单（3 条 · 采纳 msg=c56acff0）

1. **Strategy owner ack 基线权重**（上游分配表如 Q7 5-slot 需显式 ack · 防单方推算错误）
2. **下游独立算数复核**（QADocs/DataPipeline 反解归一化公式独立算一遍 · 防精算漂移）
3. **Rounding tie-break 规则位声明**（明写单测 · 本 loop = news_evidence +0.001 · 防未来 revert 同类错误）

**教材化教训**（Orchestrator 质量控制自省）：
- msg=95e48f2b 数值错误教训：涉 Strategy 域权重数值 → 先请 Strategy owner ack 基线后再算数
- 双域协同早发现（Strategy 精算 + QADocs tie-break 规则）降低 CI landing 后 revert 成本
- 数值 loop 三方收官三重锚定：Strategy msg=d622e6f3 §3 + QADocs msg=c56acff0 §3 + Orchestrator msg=6c472a71 § 采纳

---

## §Independence-Flexibility-Footnote

**签发依据**：li-yiming msg=ad6585cf 授权 · Orchestrator msg=c2b28c7c §四 锁定 · QADocs msg=1fa84e6c §2 承接 · Research 25-* §2 3 档表语义源

**核心引用**（li-yiming 原话）：
> "复制的话你可以稍微改一改再复制，那就不侵权了，你灵活一些"

### 三档改造范式（License 政策放宽令 v1 后独立性 v1.1 灵活性纳入）

| 档位 | 定义 | 判定 | 允许状态 |
|---|---|---|---|
| **字面照搬** | 一字不差复制 · 变量名 / 结构 / 字段命名完全一致 | jscpd 匹配率 ≥ 30% | ❌ 禁 |
| **最小改造后复制** | 变量重命名 / 结构小调 / 加自研前缀 / 局部逻辑调整 | jscpd < 30% 通过 | ✅ 允许 |
| **借鉴思想** | 算法逻辑 / 设计模式 / UX 交互 · 独立实现 · 无字面共通 | jscpd 无命中 | ✅ 无限制 |

### 量化位含义

- **jscpd 30% 硬门禁位** = "稍微改一改再复制"的量化底线（防"整段抄"）· PR CI 层 red 断言（QADocs Task #15 断言 A）
- **jscpd < 5% 质量目标** = 内控指标（追求 · 非门禁位 · QADocs Task #15 断言 B）
- **借鉴思想全无限制** · 参考项目的 5 因子加权、`signal_cutoff` PIT 对齐、6 维可解释输出、板块三元组、"直连优先 + 慢回退"数据源策略、"研究口径 ≠ 投资建议"合规口吻等 idea 层全部可用

### 与 License 政策放宽令 v1 的关系

- **License 放宽**（自用不上线 · 忽略 LICENSE 合规）与 **独立性红线保留**（技术门禁位）**正交**
- 本 §独立性红线 = 技术门禁位（非 License 合规位）· CI 层 red 断言保留（Task #15 4 断言全保留）
- **执行位权威锚** = 25-copyright-independence-v1.1.md §2/§3
- **CI 层引用锚** = `test_alpha_vantage_independence.test.ts` 4 断言 A/B/C/D

### opt-out 域

- `fixture_ref_*` 全域（教具豁免 · 与 §10.8-satellite-footnote 保持一致）
- `docs/refactor/baseline/reference/catalyst_snapshot/**`（Cleanup 独占窗口零触碰 · Research 23 §P5）

---

## §附录变更 CHANGELOG

- v1（2026-07-08）· 追加 6 项 · Orchestrator msg=84fa4b84 M-Draft 挪入终裁触发 · 全 6 owner 联署副签
- v1.1（2026-07-08）· C-01/C-02/C-01b 语义归因说明：
  - 承接来源 = 本地 preserved 分支 `cleanup/preserved-c01-c02-c01b` 3 SHA
    - `1ae79ad` · C-01 · `.verify_token` 删 + `.gitignore` 硬化追加 `.verify_token` + `shots/`
    - `1a42f82` · C-02 · `verify.mjs` orphan 文件删
    - `849f74e` · C-01b · Orchestrator constraint 依据修订
  - 已隐含并入 M-Draft PR #69 SHA `47e8dd1`：`docs/refactor/30-cleanup-log.md` 与 `849f74e:30-cleanup-log.md` 空 diff（完全一致）· `.verify_token` / `verify.mjs` 从未 track 进 origin/main · 无实质 delta · `.gitignore` 追加两行随 M-Draft 打包 landing
  - preserved 分支 = 审计凭证 only · 不 push · 不 rebase · 不 delete · 不 force · 不再起 PR 承接
  - 由 Cleanup owner msg=d65aec23 尽职核查揭源确认 · Orchestrator msg=68995d76 综合裁决 α 采纳
  - Cleanup 铁律"删前留据 · 宁可多问"执行到位闭环

- v1.2（2026-07-08 T+3.5）· 事件位追加 · **Task #12 v0.1 landed test CI 未真跑事件**：
  - **事件**：PR #73 (`1de8461`) 合入的 `backend/tests/quality/test_satellite_slot_4_slot_renormalization.test.ts` 使用 `@jest/globals` import · 但项目 test runner = `backend/src/scripts/run-tests.ts` = IIFE + `node:assert/strict` + `process.exit`（非 Jest 语法）· 该 test 在 CI 通道**从未真跑通**（Jest 未配 · IIFE runner 跳过语法孤岛）
  - **揭源**：Strategy msg=e48a3d43 · Task #12 v2 融合位起草时揭发 · 本地 `npx ts-node --transpile-only <file>` 与 `npx jest <file>` 均 fail
  - **根因**：test 起草人未 grep 项目 runner 与同域 landed test 语法（IIFE 范式 vs Jest 范式）· 起草即上 · 未本地 verify exit=0
  - **裁决**（Orchestrator msg=4cd2cb9b §三 + QADocs msg=f186f6de 采纳）：
    - Task #12 v2 融合位内一并将 test 范式改为项目标准 IIFE（PR #76 · Strategy）
    - Task #29 独立 PR rewrite（QADocs）
    - Task #27/#28/#30 起草即 IIFE
    - **Task #32**：CI 门禁位补齐 · `.github/workflows/*.yml` wire `npm test` = `run-tests.ts`（QADocs 承接位 msg=49a37e4c ACK）
  - **教训入库**（QADocs `notes/dod-self-check-list.md` 第 5 位自检 · msg=49a37e4c 承接）：
    - (a) test 起草前 grep 项目 runner（`grep -l "node:assert" tests -r` vs `grep -l "@jest/globals" tests -r` 比例）
    - (b) 起草时参考同域 landed test 语法（每域至少 grep 1 个 landed test 作模板 · 避免语法孤岛）
    - (c) `npx ts-node --transpile-only <file>` 本地 verify exit=0（起草即跑 · 不 land 未跑测）
  - **audit trail 意义**：跨层 SHA-lock test 是否真跑 = 工程质量事件 · 记录本 §附录 · 事件链完整闭合 · 未来 test 起草纪律强制引本条

- v1.3（2026-07-08 T+3.5）· 事件位追加 · **Task #29 US-038 实机跑揭源 16 处生产代码违反 · α-strict 采纳事件 · v1.3.1 三方复核事实核修正**：
  - **事件**：QADocs Task #29 `test_no_math_random_us_038_rule.test.ts` v0 draft rewrite 为 IIFE 后实机跑（SHA `19c5fed`）· 4 断言 3 pass / 1 fail · 断言 B 命中 backend/src 生产代码 `Math.random()` 调用
  - **v1.3 首报 11 处 · v1.3.1 三方独立 grep 复核揭 16 处**（DataPipeline msg=71fbd3d1 · QADocs msg=e8d84a50 · Strategy msg=cc445895）· 排除 3 注释锚（MarketController:117 // · BayesianOptimizer:31/169 /* · MonteCarloStressTest:48 /*）后 live 生产命中 16 处
  - **裁决**（Orchestrator msg=0a347004 §一 + msg=165216d0 §二 α-strict 终裁）：**3 处直修红线 + 13 处入 baseline · 5 值枚举维持**
  - **3 处直修红线**（不入 baseline · 永不入豁免）：
    - M-1 `backend/src/quant/backtest/internal/QuantBacktestService.ts:665` groupId label · Task #35 Strategy 承接 · `crypto.randomBytes(4).toString('hex')`
    - M-2 `backend/src/services/research/factor-discovery.ts:197` rng default · Task #36 QADocs Task #29 Path C PR 同批 burndown · SeededRandom default
    - M-3 `backend/src/services/execution/rl-execution.ts:122` rng default · Task #36 同批 · SeededRandom default（li-yiming "资金链路"红线相邻）
  - **13 处入 baseline 存量豁免**（原 11 处 f223ec87 清单 + M-4 `backend/src/utils/redisLock.ts:59` `ID_GENERATION` + M-5 `backend/src/middlewares/uploadFeedback.ts:40` `UPLOAD_FILENAME`）· SHA-lock 前移 `19c5fed` → **`a2a9300`**
  - **schema 联合主键 (file, line, sha256_of_line) 三元组去重**（DataPipeline msg=c5aa4e98 §三 揭 4 处同 sha256 碰撞位）
  - **α-strict 采纳理由 3 条**：
    1. 与 gitleaks baseline (Task #30) 同款范式 · CI 门禁一致性
    2. 不阻塞 M2 独占窗口 · 保 Cleanup BlackSwan β / Strategy Task #12 v2 副签窗口
    3. 存量债务显性化 + 反蔓延 · baseline 大小 13 → 0 是可视化 KPI
  - **只减不增**：baseline 只能通过 burndown PR 缩减 · 大小上限 = 冻结 SHA 时点条目数
  - **audit trail 意义**：US-038 硬门禁从"全禁"演化为"存量豁免 + 反蔓延 + 敏感路径直修红线" · 需完整事件链解释豁免依据 · 未来 burndown PR 引本条

- v1.4（2026-07-08 T+3.5·11:52）· 事件位追加 · **PR #77 v1.3 声明性数值事实核偏差事件 · 教训 (d) 声明性数值必先 grep 复核**：
  - **事件**：PR #77 v1.3 事件位声明"11 处 · 无一位于 backtest / 因子引擎"· 三方副签（DataPipeline msg=71fbd3d1 · QADocs msg=e8d84a50 · Strategy msg=cc445895）独立 grep 复核揭 16 处实测 · 5 处未列 · M-1 直接位于 backtest 路径 · 声明伪
  - **根因**：Orchestrator §附录起草时直引 QADocs escalation msg=f223ec87 声明的"11 处" · 未做全域 grep 事实核（v1.2 教训 (c) "起草即 verify" 之延伸）· QADocs escalation 时可能排除路径或 caller 语义过滤误剔 5 处
  - **教训 (d) · 声明性数值必先 grep 复核 · 双重责任门禁**：
    - (d.1) **起草侧**（Orchestrator / any ADR owner 起草 ADR / 附录）：引"N 处"类断言前 · 必先 `git grep -c <pattern> <SHA> -- <path>` 命令 + 输出锚点入 CHANGELOG 引证
    - (d.2) **绝对否定核**（副签 / 独占裁）：声明"无一位于 X 路径"类绝对否定 · 必配 `git grep -l <pattern> <SHA> -- <path>` 反证空集 · 数字不一致即报 BLOCK
  - **入位**：Orchestrator DoD + QADocs DoD + Strategy DoD + DataPipeline DoD 四方共编（Strategy `notes/dod-self-check-list.md` v2 教训 #4/#5 · QADocs v1.3 5.a-5.c · DataPipeline v1.4 · Orchestrator MEMORY.md DoD 条 (d)）
  - **副功效**：本 blocker 在 doc-only PR #77 阶段前置抓 · 未进入 Task #29 baseline JSON PR · 避免下游 baseline 数字连锁错误 · **验证 doc-only PR 副签面价值** · SOP 7 步 Step 3"绝对否定"类事实核硬门禁位建立
  - **audit trail 意义**：跨消息声明性数值传递纪律 = 工程质量事件 · 记录本 §附录 · 事件链完整闭合 · 未来 ADR / 附录起草纪律强制引本条

- v1.4.1（2026-07-08 T+3.5·12:43）· 事件位追加 · **PR #79 / PR #80 数字口径分歧事件 · 教训 (d.3) AST-aligned grep pattern · live vs raw 口径分离**：
  - **事件**：PR #79 Strategy Task #35 merge 后 SeededRandom 挪位 `backend/src/utils/SeededRandom.ts:14/30` JSDoc 承接原 `BayesianOptimizer.ts:169` "避免引入 Math.random" 措辞 · Orchestrator 期望 raw grep 命中 20→19 · Strategy 实测 raw grep 命中 20→20（注释承接措辞令 raw 计数不变）· Path A 独占裁（msg=10e8850d）：门禁真值 = live call-syntax count（`Math\.random\(` 命中 CallExpression AST-aligned）· comment ≠ code · comment 承接措辞保留 · live 计数 base 15 → HEAD 14 精准
  - **根因**：ADR-0002 §2.1 门禁语义为"call-syntax execution" · raw `git grep 'Math\.random'`（含 word-boundary 与注释锚）与 `Math\.random\(`（CallExpression AST-aligned）两口径混用 · 数字对齐时口径未预声明 → 双方各自持一口径 → BLOCK 表面为数字对不上 · 实为口径分歧
  - **教训 (d.3) · AST-aligned grep pattern · 声明性数值必附口径 · 四条 clause**：
    - (d.3.1) **门禁真值 = live call-syntax count**：`Math\.random\(`（CallExpression AST-aligned）· 命中 `.` 后即调用符号位 · 不含注释锚 / word-boundary 副命中
    - (d.3.2) **raw grep 为辅助锚**：`git grep 'Math\.random'`（含 comment / word-boundary 命中）仅供路径定位与漂移观测 · 不构成门禁反证 · 不作数字口径基准
    - (d.3.3) **machine-readable 落地位**：baseline JSON 每份 SHA-lock 版本必含 `grep_pattern_ast_aligned` 字段声明 AST-aligned pattern 字面 · 未来 burndown PR 读 JSON 即可对齐 · 无需 re-trace ADR 事件链（PR #80 `us-038-baseline-06dc30e.json` 首例）
    - (d.3.4) **触发案例引证事件位链**：PR #79 msg=c98de6ac §二 数字口径预设事件（Orchestrator 期望 20→19）→ msg=6d1bb72a §二 Strategy 根因披露（comment 承接措辞令 raw 不变）→ msg=10e8850d Path A 独占裁（call-syntax execution 门禁语义 · comment ≠ code）→ msg=a3ec6887 PR #80 baseline JSON 教训入代码首例
  - **入位**：ADR-0002 §2.2.1 v1.2.1 schema `grep_pattern_ast_aligned` 字段隐含约束 · baseline JSON schema 层落地 · 四方 DoD 无需增列（口径分歧本身为 doc-only 事件位 · 无 code diff · SOP 7 步保持不变）
  - **副功效**：教训 (d) 从"起草侧必先 grep 复核"（d.1/d.2）演进至"grep 口径必附 pattern 字面并入 machine-readable"（d.3）· doc → code 落地首例 · 未来 US-038 相关 PR / burndown / baseline 只读 JSON 一致对齐 · 事件链跨 ADR 完整
  - **audit trail 意义**：跨口径 grep pattern 传递纪律 = 工程质量事件 · 记录本 §附录 · 事件链完整闭合 · 未来 baseline JSON schema 变更 / burndown PR 强制引本条

---

**End of ADR-0001 §附录追加块 v1.4.1**
