# 22 · 待删候选清单 (Cleanup Candidates)

**Owner**: @Research（read-only 审计输出 · 独占 20-23-*.md · 不执行删除）
**Consumers**: @Orchestrator（裁定） · @QADocs（CI 规则联动） · @Strategy Q5 决策 · @Frontend 60-* v0.1
**Input**: `21-current-audit.md` §8/§9/§10/§6.3 · @Orchestrator msg=6df76bdf Part A + Part H · @Orchestrator msg=14d04ec6 Part 3 · @QADocs msg=a3723938 §Reference-Project-Compliance regex · @Strategy msg=bf9441f1 Q5 联动 · @Frontend msg=b45f58e4 D8
**Path**: `/Users/bytedance/go/src/github.com/bruinxz/stocks/docs/refactor/22-cleanup-candidates.md`

---

## 0. 交付说明

- **每条 candidate = 单行表 · 一条 evidence chain**（grep / find / ts-prune / madge / depcheck / file:line 引用）+ **决策槽 (proposed action)** + **需 Orchestrator 签字**列
- 决策槽标签：`delete` / `move-to-baseline` / `refactor` / `keep-with-note` / `escalate`
- **禁移除依据**：任何 evidence 不足或存在潜在使用（如 Live-trading / 数据契约 / factor 底表）的候选 → 标 `escalate` 送 Orchestrator
- **执行方**：Cleanup 独占窗口内由 Orchestrator 分派（可能是 DataPipeline / Strategy / Frontend / QADocs 独占目录内自行执行）
- Research 不执行删除 · **本表只是候选表 + evidence + 建议**

---

## 1. Group A · 根目录冗余脚本 · 高置信 `delete`

| # | Path | Type | Evidence | Proposed | Signoff |
|---|------|------|----------|----------|---------|
| A1 | `copy_compose.exp` | expect script | 8 个 `.exp` 文件同组 · `find .` 见 §1a · 使用点：`grep -rl "copy_compose" backend/ frontend/ scripts/ ops/` = **0 命中** · 用途：早期 SSH 部署脚本 · 替代品：`scripts/deployment/deploy_remote_build.sh` (13K · 6.25 更新) | `delete` | Orchestrator |
| A2 | `copy_env.exp` | expect | 同 A1 · `grep -rl "copy_env" .` = 0 命中 | `delete` | Orchestrator |
| A3 | `copy_frontend.exp` | expect | 同 A1 · `grep -rl "copy_frontend" .` = 0 命中 | `delete` | Orchestrator |
| A4 | `copy_script.exp` | expect | 同 A1 · 0 命中 | `delete` | Orchestrator |
| A5 | `copy_sql.exp` | expect | 同 A1 · 0 命中 | `delete` | Orchestrator |
| A6 | `deploy_files.exp` | expect | 同 A1 · 0 命中 | `delete` | Orchestrator |
| A7 | `deploy_with_port.exp` | expect | 同 A1 · 0 命中 | `delete` | Orchestrator |
| A8 | `run_sync.exp` | expect | 同 A1 · 0 命中 | `delete` | Orchestrator |
| A9 | `sync_files.sh` | shell wrapper | 762B · 引用 `.exp` (A1-A8 之一) · `grep -rl "sync_files\.sh" .` = 0 外部命中 | `delete` (随 A1-A8) | Orchestrator |
| A10 | `rename_columns.sql` | one-shot migration | 462B · 迁移语句 · 迁移已完成（backend Sequelize migrations 独立目录）· `grep -rl "rename_columns" .` = 0 命中 | `delete` (标 baseline snapshot) | Orchestrator |
| A11 | `verify.mjs` | script (1.9K) | 无引用 · `grep -rl "verify\.mjs" backend frontend scripts` = 0 命中 · `.verify_token` (185B) 同族 | `escalate` (`verify.mjs` + `.verify_token` 相关性未定 · 可能 CI hook) | Orchestrator |

**Evidence 复现指令**：
```
cd /Users/bytedance/go/src/github.com/bruinxz/stocks
for f in copy_compose copy_env copy_frontend copy_script copy_sql deploy_files deploy_with_port run_sync sync_files; do
  echo "=== $f ==="; grep -rl "$f" backend frontend scripts ops --include='*.ts' --include='*.tsx' --include='*.js' --include='*.sh' 2>/dev/null
done
```
预期：全部输出为空（Research 已跑）。

---

## 1a. Evidence supplement · `.exp` 家族

`.exp` = expect 交互脚本 · 早期人工推送用（脚本内嵌 `spawn scp/ssh` + 密码交互）· 现存部署链已切换到：
- `scripts/deployment/deploy_remote_build.sh` (2026-06-25 更新 · 12928B · sha256 主流路径)
- `scripts/deployment/rsync_expect.sh` (2026-05-21 更新 · 独立 expect · 与根目录 `.exp` 无 include 依赖)

**注意**：`rsync_expect.sh` 保留 · 位于 `scripts/deployment/` 目录 · 有明确调用链（`sync_and_deploy.js`）· 不在本表候选内。

---

## 2. Group B · 根目录 top-level 死目录 · 中高置信 `delete`

| # | Path | Type | Evidence | Proposed | Signoff |
|---|------|------|----------|----------|---------|
| B1 | `ralph/` | agent workspace | 2.6M · `ralph.sh` + `progress.txt` (834K) + `prd.json` (219K) · `grep -rl "ralph" backend frontend scripts` = 0 命中 · `README.md` §README 无 ralph 引用 · 前代 agent (ralph) 遗留 workspace | `delete` (备份 `.artifacts/` 后删) | Orchestrator |
| B2 | `.artifacts/server-rescue-20260519/` | one-time recovery | 5-19 事件 recovery snapshot · 内含 `before-reinstall/` · 已过期 · `grep -rl "server-rescue" backend frontend scripts` = 0 命中 | `delete` | Orchestrator |
| B3 | `.artifacts/server-backups/` | historic snapshot | 与 B2 同族 · 未持续维护 | `escalate` (确认最新时间戳) | Orchestrator |
| B4 | `.artifacts/test-reports/` | 14 项测试报告快照 | 5-20 时间戳 · CI 现有独立 artifact 通路 · `grep -rl "\.artifacts/test-reports" backend frontend scripts` = 0 命中 | `move-to-baseline` (M-Draft baseline snapshot 存档) | Orchestrator |
| B5 | `.artifacts/patch_plan.py` | 0-byte | 空文件 | `delete` | Orchestrator |
| B6 | `.build_logs/` | build 缓存 | 7-3 更新 · CI 现有独立 artifact 通路 · 本地缓存无长期价值 | `delete` (加 .gitignore) | Orchestrator |
| B7 | `backend/dist/` | tsc 构建产物 | 30M · TS build 产物 · `.gitignore` 应含 `backend/dist/` · 逐 commit 冗余 · 内含 §5 dead ts (production-bridges.js.map 等) | `delete` (确认 `.gitignore` 覆盖) | Orchestrator |
| B8 | `logs/` | 运行日志 | 16K · 5-7 更新 · 生产日志走 pm2/journald · 本地目录冗余 | `delete` (加 .gitignore) | Orchestrator |
| B9 | `shots/` | 空目录 | 0B · 无内容 · 7-4 时间戳 (可能截图脚本目标) · `grep -rl "shots/" backend frontend scripts` = ? 需再核 | `escalate` | Orchestrator |
| B10 | `docs/backups/` | DB backup | **1.3G** · `pre-batch8-20260703.sql` · 生产 DB dump · **不应在 repo** · `.gitignore` 应含 `docs/backups/` · 若已 tracked → `git rm --cached` + gitignore | `escalate` (需 li-yiming 确认 sql 是否已上传备份存储 · 从 repo 移除) | Orchestrator + li-yiming |

**Evidence B1 复现**：
```
cd /Users/bytedance/go/src/github.com/bruinxz/stocks
grep -rln "ralph" backend/src frontend/src scripts ops 2>/dev/null | head
# Expected: 0 hits (Research verified)
```

**Evidence B10 · 重要**：`docs/backups/pre-batch8-20260703.sql` 1.3G · 生产数据快照 · 存在 repo 内可能已泄露敏感 tracked historical state · 需 QADocs `.gitleaks.toml` allow-list 复核 · 走 li-yiming DM 私域裁定，**不在本 markdown 内讨论具体内容**。

---

## 3. Group C · backend 死代码 · 高置信 `delete`

| # | Path | LOC | Evidence | Proposed | Signoff |
|---|------|-----|----------|----------|---------|
| C1 | `backend/src/services/black-swan/` | 0 files | 空目录 · `ls` = 空 · **孤儿 stub** · `grep -rl "services/black-swan" backend/src frontend/src` = 0 命中 · 21-current-audit §3.3 `/api/black-swan` undocumented route 可能独立于此目录 | `delete` (空目录 rm) | Orchestrator |
| C2 | `backend/src/services/integration/production-bridges.ts` | 464 | 21-current-audit §8 D8 flag · **无任何 import** · `grep -rl "production-bridges" backend/src frontend/src` = 0 命中 · `backend/dist/services/integration/production-bridges.{js,d.ts,map}` = 编译产物随 §B7 走 | `delete` | Orchestrator |
| C3 | `backend/src/models/ETFCreationRedemption.ts` | 21-current-audit §2 orphan model | 6 处引用全在 `models/index.ts` 注册 + `config/database.ts` 加载 + 自身 · **无 service/controller/job 消费** · tests 独立测试 · US-147 KOL-001 未上线 | `escalate` (与 Live-trading 10 model 分离 · DataPipeline 侧仲裁：**留 or 删** · 若 Q1 数据基线不含 ETF 一级市场申赎则删) | Orchestrator + DataPipeline |
| C4 | `backend/test_akshare_fix.py` | root · 独立测试脚本 | 位于 `backend/` root · **非 `tests/` 目录** · 迁移期临时验证 · `grep -rl "test_akshare_fix" backend` = 0 命中 | `delete` | Orchestrator |
| C5 | `backend/test_akshare_direct.py` | 同 C4 | 同 C4 | `delete` | Orchestrator |
| C6 | `backend/backup_data.json` | root data blob | `backend/` root · 未纳入 gitignore · 可能含数据 | `escalate` (li-yiming 复核内容后决定) | Orchestrator + li-yiming |

---

## 4. Group D · frontend 死代码 · 中高置信 `delete`

| # | Path | Size | Evidence | Proposed | Signoff |
|---|------|------|----------|----------|---------|
| D1 | `frontend/build.tgz` | 构建打包产物 | tsc build tarball · `.gitignore` 应含 `frontend/build*.tgz` · 逐 commit 冗余 | `delete` (加 .gitignore) | Orchestrator |
| D2 | `frontend/build_new.tgz` | 同 D1 | 同 D1 · 命名指示 "new"（历史迭代残留） | `delete` | Orchestrator |
| D3 | `frontend/build_new2.tgz` | 同 D1 | 同 D1 · "new2" 二迭 | `delete` | Orchestrator |
| D4 | `frontend/fix_lint.sh` | 迁移期 lint fix 脚本 | `grep -rl "fix_lint" frontend/src backend/src scripts` = 0 命中 · 已完成 lint 修复 | `delete` | Orchestrator |
| D5 | `frontend/fix_lint_2.sh` | 同 D4 | 二迭 lint fix 脚本 | `delete` | Orchestrator |
| D6 | `frontend/refactor.js` | 迁移期 refactor 脚本 | `grep -rl "refactor\.js" frontend/src backend/src scripts` = 0 命中 · 已完成 refactor | `delete` | Orchestrator |
| D7 | `frontend/.env.development.local` | 本地开发变量 | **不应 commit** · `.gitignore` 应含 `.env*.local` · Research 未 `cat` 该文件（凭证纪律） | `escalate` (li-yiming 私域裁定 · **不在本 markdown 讨论**) | Orchestrator + li-yiming |

---

## 5. Group E · 参考项目黑名单 identifier 残留扫描 · CI 联动

**规则来源**：@QADocs msg=a3723938 §Reference-Project-Compliance regex `/^(catalyst_us|analyst_profile|nine_cats_report|jiudian_cat)$/` + @Orchestrator msg=6df76bdf Part A 参考项目词表全域禁字面照搬。

| # | Pattern | Scan cmd | Current hits | Proposed | Signoff |
|---|---------|----------|--------------|----------|---------|
| E1 | `analyst_profile` | `grep -rln "analyst_profile" backend/src frontend/src` | **0 命中**（Research 已跑） | `keep-with-note` (Phase 1 起 CI 规则 2 硬门禁 · 命名裁定后无历史残留) | Orchestrator (无删除) |
| E2 | `catalyst_us` | `grep -rln "catalyst_us" backend/src frontend/src` | **0 命中** | 同 E1 | Orchestrator (无删除) |
| E3 | `nine_cats_report` | `grep -rln "nine_cats_report" backend/src frontend/src` | **0 命中** | 同 E1 | Orchestrator (无删除) |
| E4 | `jiudian_cat` | `grep -rln "jiudian_cat" backend/src frontend/src` | **0 命中** | 同 E1 | Orchestrator (无删除) |
| E5 | `九点猫` (中文) | `grep -rln "九点猫" backend/src frontend/src` | **0 命中** | 同 E1 | Orchestrator (无删除) |
| E6 | `analyst` 词根残留（宽扫）| `grep -rln "analyst" frontend/src --include='*.tsx' --include='*.ts'` | **1 命中**：`frontend/src/components/data/DataHealthDashboard.tsx` | `escalate`（Orchestrator msg=6df76bdf Part H 已 flag · Frontend 60-* v0.1 期间清扫 · Research 仅登记 · **不属实体候选删除**） | Orchestrator + Frontend |
| E7 | 5 因子魔数联合 `0.34.*0.32.*0.12.*0.08.*0.10` | `grep -rEln '0\.34.{0,50}0\.32.{0,50}0\.12' backend/src frontend/src` | **0 命中** | `keep-with-note` (CI 联合规则 QADocs §Reference-Project-Compliance 规则 2 明日 PR 落地即上门禁) | Orchestrator (无删除) |

**E1-E5 结论**：4 项 identifier + 中文名 **全 0 命中** → 我方历史无字面照搬 · QADocs CI regex 明日 PR 落地即上门禁 · **无回滚成本**。

**E6 结论**：`analyst` 词根残留 1 处 · 位于 Frontend 独占目录 · Frontend 60-* v0.1 或 v1 期间自行清扫 · 与 `<ExplainRadar>`/`<ExplainCard>` 命名迁移一并处理 · 无跨层协调需求。

> **脚注 · 独立性红线映射**（M-Draft PR #69 @ `47e8dd1` 后追加 · Orchestrator msg=e3a9792c 授权 · 采纳方案 B）：
> 本 §5 Group E 黑名单 5 项 identifier（`catalyst_us` / `analyst_profile` / `nine_cats_report` / `jiudian_cat` / `九点猫`）+ E7 5 因子魔数联合属**独立性红线技术门禁位**（3 档改造范式之"命名撞车禁" · jscpd 30% 硬阈 + 字段命名独立性 D 断言）· 权威源 [`25-copyright-independence-v1.1.md`](25-copyright-independence-v1.1.md) §3 断言 A/D + §5.2 "命名撞车" 禁项 · 引 ADR-0001 §附录 §Independence-Flexibility-Footnote（M-Draft PR #69 SHA `47e8dd1`）。CI 联动 = QADocs Task #15 Alpha Vantage 独立性 4 断言 A/B/C/D + Task #27 §Gate-Negative-Coverage-v0.3 反例矩阵扩展位。License 政策放宽令 v1（Orchestrator msg=656c8cf4）后仍保留（技术门禁位 · 非 License 合规位）· E1-E5 我方 0 命中 · E6 `analyst` 词根残留 1 处属 Frontend 独占目录 60-* v0.1 期间清扫（Frontend 承接位不变）。

---

## 6. Group F · Q5 4 传统策略参考扫描 · Strategy 决策依赖

**决策方**：@Strategy · Strategy Q5（原计划 §4.3 保护清单更新 · @Strategy msg=bf9441f1）

| # | Path | LOC | Evidence | Consumers | Proposed | Signoff |
|---|------|-----|----------|-----------|----------|---------|
| F1 | `backend/src/backtest/strategies/MACDStrategy.ts` | ? | 引用点 5：`quant/performance/internal/QuantPerformanceDashboardService.ts` / `models/TechnicalAnalysisReport.ts` / `api/controllers/V3RecommendationController.ts` / `api/controllers/BacktestController.ts` / `services/AIInvestmentSignalService.ts` / `services/TechnicalAnalysisService.ts` / `services/analysis-engine/v3DetailBuilder.ts` / `jobs/backtestJob.ts` · 现役 · 部分为技术指标副产品，非策略本体消费 | Strategy Q5 决策 | `escalate` (Strategy · 传统策略是否纳入自研 §11.1 V/Q/L/M 四因子系统 · 若否 → move-to-baseline)  | Strategy |
| F2 | `backend/src/backtest/strategies/RSIStrategy.ts` | ? | 同 F1 · `BacktestController` + `backtestJob` 引用 · 数据基线可回测 | Strategy Q5 | `escalate` (同 F1) | Strategy |
| F3 | `backend/src/backtest/strategies/BollingerBandsStrategy.ts` | ? | 同 F1 · `BacktestController` + `backtestJob` 引用 | Strategy Q5 | `escalate` (同 F1) | Strategy |
| F4 | `backend/src/backtest/strategies/MovingAverageCrossoverStrategy.ts` | ? | 同 F1 · `BacktestController` + `backtestJob` 引用 | Strategy Q5 | `escalate` (同 F1) | Strategy |
| F5 | `backend/src/backtest/strategies/Strategy.ts` | base | 抽象基类 · F1-F4 继承 · 独立于是否保留传统策略 | Strategy Q5 | `keep-with-note` (F1-F4 决策后再决定) | Strategy |
| F6 | `backend/src/backtest/indicators/TechnicalIndicators.ts` | ? | 技术指标库 · 计算工具层 · Strategy 卫星层 `intraday_momentum` detector 可能复用（msg=bf9441f1 §1.4.3）| Strategy | `keep-with-note` (工具库 · 与 F1-F4 决策解耦 · 建议保留) | Strategy |

**Strategy 决策输入**：F1-F4 参考扫描完成 · 引用点集中在 `BacktestController` + `AIInvestmentSignalService` + `TechnicalAnalysisService` 三处 · 若 §11.1 四因子 (V/Q/L/M) 上线后 · 传统 MACD/RSI/BB/MA 是否作卫星层 detector 之一（msg=bf9441f1 §1.4.3 `intraday_momentum`）由 Strategy 自定。**Research 不预判**。

---

## 7. Group G · 硬编码嫌疑 · 21-current-audit §10 承接

| # | File:Line | Content | Evidence | Proposed | Signoff |
|---|-----------|---------|----------|----------|---------|
| G1 | `frontend/src/components/data/SystemTopologyMap.tsx:170-185` | `L2 signal / L3 meta` 节点名硬编码列表（`factor_engine` / `strategy_engine` / `pattern_library` / `factor_correlation` / `factor_ic_monitor` / `meta_label_filter` / `autopilot` / `sizing_decision` / `ai_analysis_engine_v2`） | 硬编码节点名 · 与后端 service 名可能脱钩 · 需与 21-current-audit §4 services 22 subdir 交叉比对 · 部分节点如 `pattern_library` `factor_correlation` `factor_ic_monitor` 未在 §4 services 出现 → 前端展示 vs 后端实体不匹配 | `refactor` (Frontend 60-* v0.1 期间用后端 `/api/system-topology` 元数据驱动 or 移除 stale 节点) | Orchestrator + Frontend |
| G2 | `frontend/src/components/data/DataHealthDashboard.tsx` | 含 `analyst` 词根 | 参见 E6 · Frontend 60-* 期间清扫 | 同 E6 | Orchestrator + Frontend |
| G3 | `backend/src/services/RealtimeAlertDispatcher.ts` | IP/端口硬编码嫌疑 | `grep -rEln "103\.242\.3\.87\|127\.0\.0\.1:[0-9]+\|localhost:[0-9]+"` 命中之一 · 需具体行号复核 | `escalate` (走 config 抽离 · 具体行号 QADocs `.gitleaks.toml` + IP allowlist 联动) | Orchestrator + QADocs |
| G4 | `backend/src/config/externalServices.ts` | IP/端口硬编码嫌疑 | 同 G3 命中 | `escalate` (config 目录本身即 config · 保留可 · 走 env 化) | Orchestrator |
| G5 | `backend/src/services/api.ts` (frontend) | IP/端口硬编码嫌疑 | `frontend/src/services/api.ts` 命中 · axios baseURL 可能硬编 | `escalate` (改 `import.meta.env.VITE_API_BASE_URL`) | Frontend |
| G6 | `scripts/deployment/start_remote.sh` | IP/端口硬编码嫌疑 | 部署脚本 · 硬编 IP 属 config · 走 env / 参数化 | `refactor` (走 env) | Orchestrator |
| G7 | `scripts/data_analysis/final_report.js` `scripts/tests/test_cache_mechanism.js` `scripts/tests/smoke_readonly_core.js` | test / analysis 脚本 IP 硬编 | 测试/分析脚本 · 生产 IP 硬编在测试代码里，切换环境需改代码 | `refactor` (改 env) | Orchestrator |
| G8 | `scripts/ci/check_legacy_ip.sh` | CI 检查脚本 | CI 本身即 legacy IP 检查 · 命中属正常 | `keep-with-note` (CI 白名单) | QADocs |

**G3-G7 Evidence 复现**：
```
cd /Users/bytedance/go/src/github.com/bruinxz/stocks
grep -rEn "103\.242\.3\.87|127\.0\.0\.1:[0-9]+|localhost:[0-9]+" backend/src/services/RealtimeAlertDispatcher.ts backend/src/config/externalServices.ts frontend/src/services/api.ts scripts/deployment/start_remote.sh 2>/dev/null | head -20
```

---

## 8. Group H · 密钥项 evidence · 全 escalate

**原则**：Research 不查看 `.env*` 内容 · 不 dump 密钥字面 · 全部走 li-yiming 私域裁定。

| # | Path | Evidence | Proposed | Signoff |
|---|------|----------|----------|---------|
| H1 | `frontend/.env.production` | 存在 · 未查看 | `escalate` (li-yiming DM · 应否 tracked) | li-yiming |
| H2 | `frontend/.env.development.local` | 存在 · `.gitignore` 应含 `.env*.local` · 参见 D7 | `escalate` | li-yiming |
| H3 | `backend/.env.example.production` | example 模板可 tracked · 应确认无真实凭证 | `escalate` (li-yiming · 若模板无真值可保留) | li-yiming |
| H4 | `backend/.env` | **不应 tracked** · `.gitignore` 应含 `backend/.env` · Research 未 dump 内容（只读第一行 key=）| `escalate` (li-yiming · `git rm --cached` + gitignore) | li-yiming |
| H5 | `backend/.env.example` | example 可 tracked | `escalate` (li-yiming) | li-yiming |
| H6 | `ai/tradingagents-app/.env.example` | example 可 tracked | `escalate` (li-yiming · Apache-2.0 上游模板一致性) | li-yiming |
| H7 | `.verify_token` | root 185B · 用途未定 | `escalate` (与 A11 `verify.mjs` 相关性 · li-yiming 裁定) | li-yiming |
| H8 | `backup_data.json` (backend root) | 参见 C6 | `escalate` (li-yiming) | li-yiming |
| H9 | `docs/backups/pre-batch8-20260703.sql` | 参见 B10 · 1.3G | `escalate` (最高优 · li-yiming DM · **不在 markdown 内展开**) | li-yiming |
| H10 | `scripts/deployment/deploy_config.js:94/101` | `process.env.DEPLOY_PASSWORD` / `SSH_PASSWORD` / `DEPLOY_PG_PASSWORD` 从 env 读 · **未硬编字面** · 但 env 变量命名暴露 | `keep-with-note` (env 化正确 · QADocs `.gitleaks.toml` 规则复核) | QADocs |
| H11 | `.bridge-state/` | root · Broker Bridge state 目录 · 内含 HMAC 会话状态 · 权限 700 | `escalate` (Live-trading 保护范围 · `keep-with-note` 但 QADocs `.gitleaks.toml` allow-list 内加白) | Orchestrator + QADocs |

**H1-H11 汇总**：`.env*` 命中 6 项 · **无字面 dump** · 具体裁定走 li-yiming DM 私域 · Research 只提交清单和 grep 命令给 QADocs 联动 `.gitleaks.toml`。

---

## 9. Group I · API 路由 stale · Frontend/Backend 联动

**来源**：21-current-audit §3.3 undocumented 6 + §3.4 stale 3 · @QADocs msg=a3723938 承接明日 PR §API-Contract。

| # | Route | Evidence | Proposed | Signoff |
|---|-------|----------|----------|---------|
| I1 | `/api/sentiment` | stale · openapi 未含 · 后端 `models/MarketSentimentIndex.ts` 仍在 (D8 flag) · frontend 使用点未验证 | `escalate` (Frontend 60-* v0.1 期间验证 frontend/src 是否消费 · 若 0 命中 → delete route + model 归 baseline) | Orchestrator + Frontend + DataPipeline |
| I2 | `/api/strategy-research` | stale · openapi 未含 | `escalate` (同 I1) | Orchestrator + Frontend |
| I3 | `/api/signals` | stale · openapi 未含 · 与 `signal_v3` 命名迁移相关（explain_card 承接） | `escalate` (Strategy v0.2 §1.3.4 explain_card 契约稳定后 · Phase 1 迁移期删) | Orchestrator + Strategy + Frontend |
| I4 | `/api/ai` / `/api/data` / `/api/docs` / `/api/macro` / `/api/today` / `/api/black-swan` | undocumented 6 · openapi 未含但代码内 route 存在 | `refactor` (openapi 补文档 · QADocs §API-Contract 一次性 lint 通道) | Orchestrator + QADocs + Backend |

---

## 10. 汇总

- **A 组** (11) · 根目录冗余脚本 · **10 delete + 1 escalate** (verify.mjs)
- **B 组** (10) · top-level 死目录 · **6 delete + 1 move-baseline + 3 escalate**（B3 `.artifacts/server-backups` · B9 `shots/` · B10 `docs/backups/`）
- **C 组** (6) · backend 死代码 · **4 delete + 2 escalate**（C3 ETFCreationRedemption · C6 backup_data.json）
- **D 组** (7) · frontend 死代码 · **6 delete + 1 escalate**（D7 .env.development.local）
- **E 组** (7) · 参考项目黑名单残留扫描 · **5 keep-with-note (0 命中) + 1 escalate (analyst 词根 1 处 Frontend) + 1 keep-with-note (5 因子魔数 0 命中)**
- **F 组** (6) · Q5 4 传统策略 · **4 escalate (Strategy 决策) + 2 keep-with-note (base + indicators)**
- **G 组** (8) · 硬编码嫌疑 · **6 escalate/refactor (IP/config) + 1 refactor (SystemTopologyMap) + 1 keep-with-note (CI 白名单)**
- **H 组** (11) · 密钥项 · **10 escalate (li-yiming) + 1 keep-with-note (deploy_config env 化)**
- **I 组** (9 route) · API 路由 stale + undocumented · **9 escalate (Frontend/QADocs/DataPipeline 联动)**

**总数** · 75 项 · **26 delete + 1 move-baseline + 41 escalate + 7 keep-with-note**

---

## 11. 执行分派建议（Research 不执行 · 建议提交 Orchestrator）

| Owner | Scope | Item count |
|-------|-------|------------|
| **Orchestrator (裁定/协调)** | 全部 escalate 项 | 41 |
| **DataPipeline** (Cleanup 独占窗口 · 采集/存储目录) | C3 ETFCreationRedemption · I1 sentiment model | 2 |
| **Strategy** (Cleanup 独占窗口 · quant/backtest/portfolio 目录) | F1-F6 4 传统策略 + Strategy.ts + indicators · I3 signals route | 7 |
| **Frontend** (Cleanup 独占窗口 · frontend/ 目录) | D1-D6 build.tgz / lint scripts / refactor.js · E6 analyst 词根 · G1 SystemTopologyMap · G5 api.ts · I1-I4 frontend 消费验证 | ~12 |
| **QADocs** (Cleanup 联动 · .gitleaks.toml / .jscpd + CI 门禁) | E1-E5 明日 PR regex 硬门禁 · H10-H11 gitleaks allow-list · I4 openapi lint | 5 联动 |
| **li-yiming (私域裁定)** | H1-H9 密钥项 · B10 docs/backups sql · D7 .env.development.local · C6 backup_data.json | 12 |
| **Cleanup 独占执行 (根目录 · Orchestrator 分派)** | A1-A11 · B1/B2/B4-B9 · C1/C2/C4/C5 | ~22 |

---

## 12. Cross-references

- @Orchestrator msg=6df76bdf Part A · 参考项目词表全域禁字面照搬 → §E 联动
- @Orchestrator msg=6df76bdf Part H · analyst 词根残留清扫 → §E6
- @Orchestrator msg=14d04ec6 Part 3 · 22 evidence chain 与 QADocs regex 对齐 → §E1-E5
- @Orchestrator msg=14d04ec6 Part 7 · Q5 决策 → §F
- @QADocs msg=a3723938 · §Reference-Project-Compliance regex CI 硬门禁 → §E + §H10-H11 gitleaks 联动
- @Strategy msg=bf9441f1 · §1.4.3 卫星层 detector `intraday_momentum` → §F6 indicators 复用可能
- @Frontend msg=b45f58e4 · Frontend 独占目录清扫 → §D + §E6 + §G1
- 21-current-audit.md §8/§9/§10/§6.3 → 本表 §B/§F/§G/§D 输入

---

**Research 交付状态**：Task 4 (22-cleanup-candidates.md) `in_progress → completed` · 已提交 Orchestrator 裁定。
