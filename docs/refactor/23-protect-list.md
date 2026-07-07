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

**Research 交付状态**：Task 5 (`23-protect-list.md`) v1 · 已提交 Orchestrator 裁定 · 入 CI + AGENTS.md 目录所有权表。
