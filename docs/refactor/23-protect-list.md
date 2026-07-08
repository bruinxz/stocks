# 23 · 保护清单 (Protect List · Cleanup 禁区)

**Owner**: @Research（read-only 审计输出 · 独占 20-23-*.md · 不执行 · 只列 glob）
**Consumers**: @Orchestrator（裁定/入 QADocs CI + AGENTS.md 目录所有权表） · Cleanup 独占窗口执行方 · @QADocs codeowners
**Input**: `21-current-audit.md` + `22-cleanup-candidates.md` · @Orchestrator msg=6df76bdf Part A/H · @Strategy msg=c71a49e0 F1/F2/F3 · @DataPipeline msg=b9bf7286 §7 DataSource<T> · @QADocs msg=da74b2dd · @Frontend msg=e4798f27
**Path**: `/Users/bytedance/go/src/github.com/bruinxz/stocks/docs/refactor/23-protect-list.md`

---

## 0. 目的

**Cleanup 独占窗口禁区 · glob 白名单**：任何 `git rm` / `mv` / `refactor` 命中以下 glob → **PR 拒绝合入**（QADocs CI 联动 · CODEOWNERS 强制 review）。

**保护性质**：核心资产 · 契约先行 · 数据基线 · License 独立性 · 观察窗口内不动。

**排除**：本表**不含**权限式禁区（如 `.env*` / `.bridge-state/` 密钥项走 22-cleanup §H li-yiming 私域裁定）。密钥项禁改由 QADocs `.gitleaks.toml` + `SECURITY.md` 独立门禁承接。

**执行**：
1. Orchestrator 裁定后 · 内容写入 `AGENTS.md` 目录所有权表
2. QADocs CI job `test_protect_list_no_delete.test.ts`（明日 PR 后 v1.1 追增窗口）: `git diff` 中 `D` 状态命中 glob → PR fail
3. CODEOWNERS 每 glob 组独立分派

---

## 1. Group P1 · Strategy 核心资产（策略/因子/回测/组合）

**Owner**：@Strategy · **Signoff**：@Orchestrator + @Strategy

```
# 因子引擎（V/Q/L/M 四因子 + 卫星层 detector）
backend/src/quant/factors/**
backend/src/services/factor/**
backend/src/quant/factors/library/**

# 策略引擎 + Meta-v2 元决策
backend/src/quant/strategies/**
backend/src/quant/engine/**
backend/src/quant/engine/internal/**
backend/src/services/meta-v2/**

# 回测框架 + 反例矩阵
backend/src/quant/backtest/**
backend/src/quant/backtest/internal/**
backend/src/backtest/engine/**
backend/src/backtest/metrics/**
backend/src/backtest/indicators/**
backend/tests/backtest/gates/**
backend/tests/backtest/gates/refs/base/**
backend/tests/backtest/gates/refs/weight_scheme/**

# 组合管理 + 归因 + 执行
backend/src/portfolio/**
backend/src/services/portfolio/**
backend/src/services/attribution/**
backend/src/services/execution/**
backend/src/services/exit/**
backend/src/services/tca/**
backend/src/services/regime/**
backend/src/services/governor/**
backend/src/services/calibration/**
backend/src/services/cash/**
backend/src/services/postmortem/**
backend/src/services/playbook/**

# 因子表 + 底表 tests
backend/tests/factor/**
backend/tests/factors/**
backend/tests/quant/**
backend/tests/quant/factors/**
backend/tests/strategies/**
backend/tests/portfolio/**

# 分析引擎（explain_card_builder 归属）
backend/src/services/analysis-engine/**

# performance / health 监控
backend/src/quant/performance/**
backend/src/quant/health/**
backend/src/quant/workflow/**
```

**排除项**（在 P1 内但列 22-cleanup escalate 或 Strategy Q5 决 delete · 不禁改）：
- `backend/src/backtest/strategies/{MACDStrategy,RSIStrategy,BollingerBandsStrategy,MovingAverageCrossoverStrategy}.ts`（22 §F1-F4 · @Strategy msg=3dc74ad3 **Q5 决 delete** · M2 Cleanup 执行）
- `backend/src/backtest/strategies/Strategy.ts`（22 §F5 base · @Strategy msg=3dc74ad3 **Q5 决 delete** · F1-F4 全删后基类无引用者）
- `backend/src/services/black-swan/`（22 §C1 空目录 · delete 候选）

**明加保护**（@Strategy msg=3dc74ad3 F6 · Q5 决 keep · 卫星层 IntradayMomentumDetector 工具库复用锚）：
- `backend/src/backtest/indicators/**`（含 `TechnicalIndicators.ts`）· 已在 P1 主 glob 内 · 此处显式追加以呼应 Q5 决策

**baseline 冻结物**：
- `docs/refactor/50-strategy-design.md`（Strategy 主设计文档）
- `docs/refactor/baseline/strategy/**`
- `docs/refactor/contracts/strategy.md`（Orchestrator 冻结后进）

**Real-data / 真实历史 fixture 保护**（跨层反例锚 · ADR-0001 §10.8）：
```
**/*real*/**
**/fixture_ref_base/**
**/fixture_ref_weight_scheme/**
docs/refactor/baseline/reference/catalyst_snapshot/**
```

---

## 2. Group P2 · Live-trading 核心资产（Broker Bridge · 10 Live-* models）

**Owner**：@DataPipeline（存储层 · Broker Bridge glue）+ @Orchestrator 交叉审
**Signoff**：@Orchestrator + @DataPipeline + li-yiming（实盘凭证归 li-yiming）
**Rationale**：实盘链路 · 不容删改冲突

```
# 10 Live-* 数据模型（21-current-audit §5.3）
backend/src/models/LiveAccountSnapshot.ts
backend/src/models/LiveBridgeNonce.ts
backend/src/models/LiveBrokerAccount.ts
backend/src/models/LiveBrokerBridgeHeartbeat.ts
backend/src/models/LiveBrokerCommand.ts
backend/src/models/LiveBrokerCommandDispatch.ts
backend/src/models/LiveBrokerEvent.ts
backend/src/models/LiveExecutionAuditLog.ts
backend/src/models/LiveKillSwitchState.ts
backend/src/models/LiveOrder.ts
backend/src/models/LiveOrderDraft.ts
backend/src/models/LivePosition.ts
backend/src/models/LiveTrade.ts

# 状态持久化目录（22 §H11 escalate 独立处理 · 本 protect 不覆盖内容改 · 只保目录）
.bridge-state/**

# Broker Bridge Python 层（31 files · 21 §5.3）
backend/python/broker_bridge/**
# 具体路径待与 DataPipeline 复核 · 若命名不同则以 21 §5.3 实际路径为准

# 与 Live-* 交互的 controller + service
backend/src/api/controllers/*Broker*.ts
backend/src/api/controllers/*Live*.ts
backend/src/services/execution/**   # 与 P1 重叠 · 保护取严
```

---

## 3. Group P3 · 数据契约 + 底表 + 采集器

**Owner**：@DataPipeline · **Signoff**：@Orchestrator + @DataPipeline

```
# 契约 baseline
docs/refactor/contracts/data.md
docs/refactor/contracts/data-fixture-spec.md
docs/refactor/70-data-sources-consolidation.md
docs/refactor/71-data-migration-plan.md
docs/refactor/contracts/**

# 六实体 model 数据基线（E1-E6 · 21 §2 归 89 normal）
backend/src/models/DailyBar*.ts
backend/src/models/AdjustmentEvent*.ts
backend/src/models/AdjustmentCumulative*.ts
backend/src/models/TradingCalendar.ts
backend/src/models/FundamentalPit*.ts
backend/src/models/StockMeta*.ts
backend/src/models/IndustryConstituent*.ts
backend/src/models/IndexConstituent*.ts

# 20 采集器 (21 §5.1)
backend/src/services/data-pipeline/**   # 若存在
backend/src/services/dataSources/**
backend/src/python-clients/**
backend/python/**                        # Python 采集脚本 (spawn subprocess)
backend/src/services/dataUpdate*.ts
backend/src/services/DataUpdateLog*.ts

# 数据完整性 + 缺失值三态
backend/src/services/announcement/**
backend/src/services/event-intelligence/**
backend/src/services/news/**            # P4 前端也用 · 保护取严
backend/src/services/theme/**

# Trading calendar / 除权除息 / T+1 融券白名单
backend/src/services/tradingCalendar*.ts
backend/src/services/tradingDayService*.ts

# Sequelize migrations + baseline seeds
backend/src/migrations/**
backend/migrations/**
```

**排除项**：
- `backend/src/models/ETFCreationRedemption.ts`（22 §C3 escalate · DataPipeline 仲裁 · 本 protect 不阻）
- `backend/backup_data.json` + `backend/test_akshare_*.py` + `rename_columns.sql`（22 §C4-C5 + §A10 delete · 已候选）

---

## 4. Group P4 · Frontend 核心视图 + explain_card 承接

**Owner**：@Frontend · **Signoff**：@Orchestrator + @Frontend

```
# Frontend 主源码根 (50K LOC)
frontend/src/**

# 明确保护的 explain_card 承接组件（Frontend msg=e4798f27）
frontend/src/components/explain-card/**   # 若不存在 · 待 60-* v0.1 建
frontend/src/components/**/ExplainRadar.tsx
frontend/src/components/**/ExplainCard.tsx

# 前端契约 baseline
docs/refactor/60-frontend-design.md
docs/refactor/baseline/frontend/**       # 若存在

# 前端展示 API 契约
frontend/src/services/api.ts             # P4 内 · 但 22 §G5 refactor 允许（改 env）· 保护取严：改需 Frontend 独占窗口
frontend/src/types/**
```

**排除项**：
- `frontend/build*.tgz` `frontend/fix_lint*.sh` `frontend/refactor.js` `frontend/.env.development.local`（22 §D1-D7 已候选）
- `frontend/src/components/data/DataHealthDashboard.tsx` 内 `analyst` 词根残留（22 §E6 允许改名，不允许删）
- `frontend/src/components/data/SystemTopologyMap.tsx:170-185` 硬编 stale 节点名（22 §G1 允许 refactor 用元数据驱动）

---

## 5. Group P5 · QADocs 独占（质量门禁 + 变更日志）

**Owner**：@QADocs · **Signoff**：@Orchestrator + @QADocs

```
# QADocs 40 段号独占
docs/refactor/40-*.md
docs/refactor/40-quality-gates.md

# License / Reference-Project-Compliance / Disclaimer-Lint
docs/refactor/allow-list-licenses.md
docs/refactor/allow-list-licenses-v*.md
drafts/reference-project-compliance-and-disclaimer-lint-v*.md   # workspace 归 QADocs

# CI 门禁配置
.github/**
.gitleaks.toml
.jscpd.reference.json
.jscpd*.json

# CODEOWNERS
CODEOWNERS
.github/CODEOWNERS

# ADR 独占
docs/refactor/adr/**
docs/refactor/adr/ADR-0001*.md
docs/refactor/adr/ADR-*.md

# 变更日志 + baseline reference
CHANGELOG.md
docs/refactor/baseline/reference/**
docs/refactor/baseline/reference/catalyst_snapshot/**
```

> **脚注 · catalyst_snapshot 零触碰红线定义位**（M-Draft PR #69 @ `47e8dd1` 后追加 · Orchestrator msg=e3a9792c 授权 · 采纳方案 B）：
> `docs/refactor/baseline/reference/catalyst_snapshot/**` 零触碰红线定义 = [`25-copyright-independence-v1.1.md`](25-copyright-independence-v1.1.md) §3 断言 C（reference-project-no-import）+ §4 Cleanup 承接映射（"catalyst_snapshot 零触碰" 独占窗口红线）+ §5.2 不可做（复制 UI 素材 `web/assets/cat-*.png` + 中文文案 README/risk_note/logic）· 引 ADR-0001 §附录 §Independence-Flexibility-Footnote 之 **opt-out 域**（M-Draft PR #69 SHA `47e8dd1` · adr/0001 § 附录 · `fixture_ref_*` 全域 + `catalyst_snapshot/**` 教具豁免与 §10.8-satellite-footnote 保持一致）。Cleanup 独占窗口 M2 承接位（Cleanup msg=67d0be26 §4 + msg=ab4b973d §1）· §P1 line 100 `docs/refactor/baseline/reference/catalyst_snapshot/**` Real-data / 真实历史 fixture 保护条同域引用。

---

## 6. Group P6 · Orchestrator 独占（架构锚点 + 目录所有权 + 契约冻结区）

**Owner**：@Orchestrator · **Signoff**：@Orchestrator

```
docs/refactor/00-anchor.md
docs/refactor/10-contracts.md
docs/refactor/contracts/**   # P3 重叠 · 保护取严
docs/refactor/adr/**         # P5 重叠 · 保护取严
docs/refactor/dir-ownership.md
AGENTS.md
docs/refactor/baseline/**
```

---

## 7. Group P7 · Research 独占（20-23 交付物 + 数据可得性表）

**Owner**：@Research · **Signoff**：@Orchestrator + @Research

```
docs/refactor/20-reference-report.md
docs/refactor/21-current-audit.md
docs/refactor/22-cleanup-candidates.md
docs/refactor/23-protect-list.md
docs/refactor/24-data-availability-current-state.md   # bonus 数据可得性表 (T+1 起草中)
```

**说明**：Research 交付物在 M-Draft 三绿签字后 · 契约层等价冻结 · 后续变更需 Orchestrator 签字。

---

## 8. Group P8 · 顶层配置（不删 · 只改 · 需 Orchestrator 签字）

**Owner**：@Orchestrator · **Signoff**：@Orchestrator

```
package.json                  # root
package-lock.json             # root
tsconfig.json                 # root
backend/package.json
backend/package-lock.json
backend/tsconfig.json
frontend/package.json
frontend/package-lock.json
frontend/tsconfig.json
frontend/vite.config.ts

.gitignore
.gitattributes
docker-compose.yml
Dockerfile*
README.md
SECURITY.md
PRODUCT.md

# AI 子应用（Apache-2.0 上游 · License 独立性锚）
ai/tradingagents-app/**
```

**排除项**：`.gitignore` **允许 add**（22 §B7/§B8/§D1-D3 需加规则）但**不允许 remove** 现有规则。

---

## 9. Group P9 · 密钥 · 权限式禁区（走 SECURITY + gitleaks）

**说明**：本组不由 protect list CI 直接管 · 由 `SECURITY.md` + QADocs `.gitleaks.toml` 独立禁区管 · 列此仅为完整性提示。

```
.env
.env.*
**/*.env
**/*.env.*
!**/.env.example
!**/.env.example.*   # example 允许，真实 .env 拒
.bridge-state/**
.verify_token
docs/backups/**      # 22 §B10 1.3G SQL · li-yiming 私域裁定
backend/backup_data.json  # 22 §C6 li-yiming
```

**规则**：
- `.env.example` / `.env.example.*` 允许 tracked（模板 · 无真实凭证）
- 其余 `.env*` 由 `.gitignore` 兜底 · CI + gitleaks 双门禁
- **Research 不 dump 内容** · 具体裁定 li-yiming DM

---

## 10. 总览

| Group | Owner | Rationale | glob count |
|-------|-------|-----------|-----------|
| P1 Strategy 核心资产 | Strategy | V/Q/L/M + 卫星 detector + 回测反例 | ~35 glob |
| P2 Live-trading | DataPipeline + li-yiming | 实盘 10 Live-* + Broker Bridge | ~18 glob |
| P3 数据契约/底表 | DataPipeline | 六实体 + 20 采集器 + 契约 baseline | ~22 glob |
| P4 Frontend 核心视图 | Frontend | 50K LOC + explain_card 承接 | ~8 glob |
| P5 QADocs | QADocs | CI 门禁 + ADR + License | ~14 glob |
| P6 Orchestrator | Orchestrator | 架构锚 + 目录所有权 | ~7 glob |
| P7 Research 交付物 | Research | 20-23-* + 24 bonus | 5 file |
| P8 顶层配置 | Orchestrator | package/tsconfig/Dockerfile | ~16 glob |
| P9 密钥禁区 | SECURITY + gitleaks | .env* / .bridge-state | ~10 glob |
| **合计** |  |  | **~135 glob** |

---

## 11. 与 22-cleanup 的交集处置规则

**规则**：22-cleanup delete 候选 vs 23-protect glob 命中冲突 → **22-cleanup 优先**（若明确 22 已 escalate 或 delete 且 evidence 充分）

**具体交集清单**：

| 22-cleanup 项 | 23-protect 覆盖 | 处置 |
|--------------|----------------|------|
| C1 `services/black-swan/` 空目录 | P1（`backend/src/services/black-swan/**` 未列 · P1 只列具体 22 服务子目录，未含 black-swan）| ✅ 22 delete 优先 |
| C2 `services/integration/production-bridges.ts` | 不在 P1-P8 任何 glob 内 | ✅ 22 delete 优先 |
| C3 `models/ETFCreationRedemption.ts` | P3（`backend/src/models/**` 隐含）| ⚠ Escalate 由 DataPipeline 决 · 若 delete 需 P3 glob 明加排除 |
| C4-C5 `backend/test_akshare_*.py` | P3（未含 tests/ root · P3 只覆盖 `backend/src/services/data-pipeline/**` 等）| ✅ 22 delete 优先 |
| D1-D6 frontend 死代码 | P4（`frontend/src/**` 未含 `frontend/build*.tgz` 根级）| ✅ 22 delete 优先 |
| F1-F4 4 传统策略 | P1（`backend/src/backtest/strategies/**` **含**）| ✅ @Strategy msg=3dc74ad3 **Q5 决 delete** · M2 Cleanup 执行 · P1 §排除项已明加 |
| F5 base `Strategy.ts` | P1（同上）| ✅ Strategy msg=3dc74ad3 **Q5 决 delete**（F1-F4 全删后无引用）· P1 §排除项已明加 |
| F6 `TechnicalIndicators.ts` | P1（`backend/src/backtest/indicators/**` **含**）| ✅ Strategy msg=3dc74ad3 **Q5 决 keep** · 卫星层 IntradayMomentumDetector 工具库复用锚 · P1 保留 |
| G1 SystemTopologyMap.tsx:176 | P4（`frontend/src/**` 含）| ✅ 22 refactor 允许 · P4 保护"不删"不"不改" |
| I1 sentiment model | P3（models 隐含）| ⚠ 若 delete 需 P3 glob 明加排除 |

---

## 12. Cross-references

- @Orchestrator msg=6df76bdf Part A/H · 命名裁定 + analyst 词根 → §P4 排除项
- @Strategy msg=c71a49e0 F1/F2/F3 · 5+1 detector + 卫星权重 → §P1 保护范围
- @DataPipeline msg=b9bf7286 · 六实体 E1-E6 + DataSource<T> → §P3 保护范围
- @QADocs msg=da74b2dd · 40-* 独占 + gitleaks + jscpd → §P5 保护范围
- @Frontend msg=e4798f27 · explain_card 承接组件 → §P4 保护范围
- 21-current-audit §5.3 Broker Bridge · §2 94-model 矩阵 → §P2/§P3 依据
- 22-cleanup-candidates §F/§G/§H 交集 → §11 处置规则

---

## 13. PR-L 例外通道 · Strategy 契约 v1 冻结后 v1.1 追增窗口

**Owner**: @Research（本节起草） · **Consumers**: @Strategy（§13.1 4 项路径级 glob 承接） + @DataPipeline（§13.2 C 类数据源 8 diff 点承接） + @QADocs（§13.3 双签 CI 断言 4 条 · `test_pr_l_exception_dual_sign.test.ts` v1.1 追增位承接）
**Rationale**：M3 Strategy `contracts/strategy.md` v1 冻结后 · Cleanup 独占窗口内允许"例外通道"删除/改写命中 §P1-§P3 保护 glob 的路径 · 必须走**双签 CI 硬门禁**（3 方 reviewers + PR body 字面 + SHA-lock 引用锚）
**签字**：Orchestrator + Strategy owner or DataPipeline owner + li-yiming（3 方 reviewers · CI 断言 2 硬校验）

---

### 13.1 Strategy 4 项路径级 glob（Strategy owner 承接 · M3 契约冻结时最终锁定）

```
# 1. 动量反转策略 · A 股独立设计（Barroso 2015 美股结论禁搬）
backend/src/backtest/strategies/momentum_reversal/**

# 2. A 股约束引擎（pure module · RejectionReason enum + 双边费率 + 过户费默认开）
backend/src/services/constraint/AShareConstraintEngine.ts

# 3. 因子引擎（稀疏 Map + 中性填补 + 无 zscore 契约锚）
backend/src/services/factor/FactorRegistry.ts
backend/src/services/factor/Pipeline.ts

# 4. V0 权重锚文档（只增不删走 ADR · 4 因子槽 V0.4 / Q0.3 / L0.3 / M0.0-shadow）
docs/SIGNAL_FIRST_PLAN.md#11.1
```

**承接位**：@Strategy msg=509fbf79 承接 · Strategy `contracts/strategy.md` v1 冻结时最终锁定
**排除项**：本 §13.1 4 项 glob 在 §P1 主 glob 覆盖内 · 本节声明"允许 PR-L 双签通道命中"位 · 不解除 §P1 保护 · 命中即触发 §13.3 双签硬门禁

> **脚注 · momentum_reversal 独立性证据链呼应位**（Orchestrator msg=4c43c009 §一 建议追加）：
> `backend/src/backtest/strategies/momentum_reversal/**` A 股独立设计定性引 [`22-cleanup-candidates.md`](22-cleanup-candidates.md) §5 Group E 章末脚注（PR-Research-Footnote PR #72 SHA `c3bed08` landed · 独立性红线映射位）与 [`25-copyright-independence-v1.1.md`](25-copyright-independence-v1.1.md) §Independence-Flexibility-Footnote 3 档改造范式（字面照搬 ≥30% 禁 / 最小改造 <30% 允 / 借鉴思想无限） · 引 ADR-0001 §附录 §Independence-Flexibility-Footnote（M-Draft PR #69 SHA `47e8dd1`）

---

### 13.2 C 类数据源 8 diff 点（DataPipeline owner 承接 · SSH B-2 揭源后 BlackSwan 位补决）

```
# 2 整 client · 已闭合独立性证据链（AIAdvisorService.ts:849 权威注释 "SnowballHotKeyword 表已删除"）
backend/src/data/sources/SnowballHotKeywordClient.ts
backend/src/data/sources/StockQAClient.ts

# 4 TS 存根 · Scheduler 2 + DataController 2
backend/src/services/SchedulerService.ts::snowball_hot_keyword_sync scenario
backend/src/services/SchedulerService.ts::stockqa_sync scenario
backend/src/api/controllers/DataController.ts::<snowball 存根>
backend/src/api/controllers/DataController.ts::<stockqa 存根>

# 1 Python 助手
backend/python/akshare_helper.py::get_snowball_hot_keywords

# 3 docstring（无 code · 只注释残留 · grep -rE 'Snowball|StockQA|snowball_hot|stockqa' 命中）
<3 处 docstring 位 · 具体行号由 C-S2 阶段 grep 输出锁定>
```

**承接位**：QADocs msg=e864ac7b §4 8 diff 点清单 · DataPipeline msg=76e3bcbd 净化生产验证闭合 · Task #11 in_review → M2 Cleanup PR merge 后转 done
**BlackSwan 补决位**：`backend/src/data/sources/BlackSwanClient.ts` + `backend/src/services/black-swan/` 属 §13.2 待定项 · 占位 = **TBD-per-Cleanup-BlackSwan-β**（Orchestrator msg=4c43c009 §一 建议 · Cleanup BlackSwan β PR 合入后由 Research follow-up minor PR 精确回填 4 项 delete 路径）
**Orchestrator msg=19eef843 拆分裁决**：
- **C-S1**（3 项）· 2 client + Python helper + dispatcher · 独立 tsc/lint/tests + grep 副签点 (a)
- **C-S2**（≥5 项）· 4 TS 存根 + 3 docstring + Scheduler `snowball_hot_keyword_sync` scenario · 依 C-S1 · 追加 `npm run cron:dry-run` 无 orphan 验证副签点 (c)
- PR body 硬字段：**"C 类数据源双签删除" 字面 + 8 具体 diff 点清单 + Research 23 v1.1 §13.2 SHA-locked 引用 + C-S1/C-S2 拆分说明**

---

### 13.3 双签 CI 断言 4 条（QADocs `test_pr_l_exception_dual_sign.test.ts` v1.1 追增位承接）

| # | 断言字面 / 门禁位 | 触发条件 | 落地 test 文件 |
|---|---|---|---|
| 1 | PR body regex `/PR-L\s+双签\|C\s+类数据源双签删除/` 硬校验 | PR diff 触碰 §13.1 4 项 glob 或 §13.2 8 diff 点任一 | `backend/tests/quality/test_pr_l_exception_dual_sign.test.ts` |
| 2 | PR reviewers 3 方（Strategy owner or DataPipeline owner + @Orchestrator + li-yiming）· `reviewers.length ≥ 3 && 3 具体 reviewer name 命中` | 同断言 1 | `backend/tests/quality/test_pr_l_exception_dual_sign.test.ts` |
| 3 | PR body regex `/contracts\/strategy\.md@[0-9a-f]{7,40}/` SHA-locked 引用 | PR body 必附 Strategy `contracts/strategy.md` v1 冻结时 commit SHA（7-40 位 hex） | `backend/tests/quality/test_pr_l_exception_dual_sign.test.ts` |
| 4 | PR body regex `/V0\s+权重锁\s+4\s+因子槽只增不删走\s+ADR/` 附加字面校验 | PR diff 触碰 `docs/SIGNAL_FIRST_PLAN.md` §11.1 或 §13.1 第 4 项 glob | `backend/tests/quality/test_pr_l_exception_dual_sign.test.ts` |

**QA 落地承接位**：`backend/tests/quality/test_pr_l_exception_dual_sign.test.ts`（QADocs v1.1 追增队列 第 15 项 · Orchestrator msg=4c43c009 §一 建议 · 明写落地 test 文件避免下次 grep 权威锚失焦 · T+3.5 教训 2 应用）
**Task #16 关联**：弃用数据源禁复活断言（`backend/tests/quality/test_deprecated_data_source_no_import.test.ts`）与本 §13.3 §13.2 8 diff 点组合覆盖 · 无重叠 · Task #16 断言 5 明写 "`test_pr_l_exception_dual_sign.test.ts` §13.2 对齐"
**Task #24 休眠位**：`backend/tests/quality/test_quality_dual_source_divergence_alarm.test.ts`（Baostock/Tushare Pro 双源分歧 > 5pp 报警 · TUSHARE_PRO 启用后转正 · 当前 SKIP · v1.1 §13 追增不覆盖 · 独立触发）

---

**Cross-references**：
- @Strategy msg=509fbf79 · §13.1 4 项 glob 承接
- @DataPipeline msg=76e3bcbd + msg=f54b383b · §13.2 净化生产验证 + BlackSwan β 揭源
- @QADocs msg=e864ac7b + msg=6e45498a §3 · §13.2 8 diff 点清单 + v1.1 追增队列 23 项（第 15/16/24 项承接位）
- @Orchestrator msg=19eef843 · C-S1/C-S2 拆分裁决
- @Orchestrator msg=95e48f2b · M3 Strategy contracts v1 冻结令
- @Orchestrator msg=f89e7ac0 §8 · §13 三小节结构令
- @Orchestrator msg=4c43c009 §一 · pre-review PASS + 3 项 refinement 建议
- ADR-0001 §附录 §Independence-Flexibility-Footnote · M-Draft PR #69 SHA `47e8dd1`
- 22-cleanup-candidates §5 Group E 章末脚注（PR-Research-Footnote PR #72 SHA `c3bed08`）
- 25-copyright-independence-v1.1.md §3 断言 A/B/C/D · §5.2 命名撞车禁项映射

---

**Research 交付状态**：Task 5 (`23-protect-list.md`) v1 · 已提交 Orchestrator 裁定 · 入 CI + AGENTS.md 目录所有权表。
