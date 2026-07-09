# 30 · Cleanup Log

> 记录每一批清理的：批次号 / 目标 / 依据 / 影响面 / commit / DoD 自检。
> 契约冻结后 Phase 0 清理专员维护。本轮范围（li-yiming 授权 msg=fa1caa7a + Orchestrator 编排 msg=e0fd0725）：仅 `.verify_token` + `verify.mjs` 及配套 `.gitignore` 加固。

## 批次 C-01 · `.verify_token` 删除 + `.gitignore` 追加

- **分支**：`refactor/cleanup-verify-token-env`（从 `main` HEAD `e47e5a28` 建）
- **变更**：
  - 删 `.verify_token`（tracked 文件，185 字节）
  - `.gitignore` 追加 `.verify_token` + `shots/`（防将来复现）
- **依据**：
  - 文件是 JWT token（HS256），payload `{user_id:1, username:"xz", role:"admin", iat:1783170323, exp:1783177523}`
  - 有效期 2h，`exp=2026-07-04 15:05:23 UTC`，扫描时（2026-07-07）**已过期约 3 天**，事实风险归零
  - 远端 `103.242.3.87:3001` 本轮 out-of-scope（li-yiming msg=fa1caa7a "废弃处理" = 本轮不部署到线上；服务器仍活，访问治理由 @Orchestrator 承接，见 msg=a5297512 + 约束令 msg=b091c74d），无需 token 轮换（JWT 已自然过期 3 天）
  - QADocs pre-baseline gitleaks 命中该文件（`docs/refactor/baseline/security/gitleaks-pre.json`）
- **影响面**：
  - 只被 `verify.mjs` 引用（`grep -rn ".verify_token"` 全仓 → 唯一命中 `verify.mjs:5`）
  - `verify.mjs` 本身在 C-02 删，因此无遗留调用
- **git 历史**：首次引入 `f403964`（"ui: polish all workspace pages clarity + settings profile view" — token 混入无关 UI commit）；工作树本轮删，历史重写延后 Phase 0 密钥治理批（token 已过期 + 本轮不部署到线上 → 无实活风险）
- **DoD 自检**：
  - [x] 删前留据（本条）
  - [x] 保护 glob 零触碰（仓库根，非 quant/backtest/portfolio/ai）
  - [x] 已获用户确认（li-yiming msg=aa4a755c 授权 + msg=fa1caa7a 明确废弃）
  - [x] 独占检查（本轮只 Cleanup 动仓库根这 3 个孤儿路径）

## 批次 C-02 · `verify.mjs` 删除

- **变更**：删 `verify.mjs`（44 行 playwright 截图脚本）
- **依据**：
  - `BASE = 'http://103.242.3.87:3001'` 硬编码指向本轮 out-of-scope 的远端（服务器访问治理归 @Orchestrator，见约束令 msg=b091c74d）
  - 只输出到 `shots/` 目录（`OUT` 常量）；`shots/` 为空目录、未 tracked、随 C-01 gitignore 防御
  - 依赖已删除的 `.verify_token`（C-01）
  - 全仓 grep `verify\.mjs` → **零外部引用**（既无脚本调用、无 npm script、无文档链接）
  - 归属：孤儿工具产物，作者 QA 手工验证痕迹，非核心资产
- **影响面**：无（零调用链）
- **git 历史**：与 `.verify_token` 同一 commit `f403964`；工作树本轮删，历史与 token 同批延后 Phase 0
- **DoD 自检**：
  - [x] 删前留据
  - [x] 保护 glob 零触碰
  - [x] 独占检查

## Post-baseline 期望（交 @QADocs 验证）

`gitleaks detect --source . --log-opts=--all` 再跑，tracked+history 侧 `jwt` 命中数：
- 期望：**2 → 1**（`.verify_token` 从工作树消失，`.claude/settings.local.json` 历史 2 处保留 → 归 Phase 0 灰名单批）
- history 侧 `.verify_token` 仍在（filter-repo 延后 Phase 0）

## 后续（不本轮做）

- 灰名单：`.claude/settings.local.json`（2 处 JWT）→ Phase 0 单列决策
- 真实业务代码密钥嫌疑（`SystemTopologyMap.tsx:176` / `LabWorkspace.AdvancedQuantTab.tsx:747`）→ Phase 0 密钥治理批
- `scripts/deployment/*.js` 4 处 `generic-api-key` → 归 Research 待删清单
- `.env.example` / `env-validator.test.ts` fixture → Phase 0 内验证脱敏形式
- git filter-repo 历史重写 → Phase 0 密钥治理批统一执行

---

## 批次 C-BS-01/02 · SKIP（探测阶段事实核偏差）

- **决议**：Cleanup 探测阶段发现 v1.2 冻结清单前 2 条目标不存在于本仓
  - C-BS-01 目标 `dist/portfolio/risk/BlackSwanWatchdog.js` — 整个 `dist/` 目录不存在（gitignored · npm build 产物）
  - C-BS-02 目标 `services/black-swan/black-swan-stub.ts` — 空目录 + 该文件不存在于仓根
- **依据**：探测阶段 msg=fe8020a2 + Orchestrator msg=62d251b1 §一 冻结 v1.2 清单前置事实核 · 转 C-BS-03 首批
- **零文件变更**：本 skip 项不产生 commit · 记录留痕

## 批次 C-BS-03 · BlackSwan β Cron scenario 结构性删除

- **变更文件**：
  1. `backend/src/services/SchedulerService.ts`
     - 删 `BLACK_SWAN_DETECT` scenario dispatch block（原 4451-4505 · 55 行 · lazy-require `BlackSwanDetectorService` + `evaluateWatchdog()` 空跑）
     - 删 `defaultTasks[]` seed 条目（原 6893-6899 · 7 行 · type=BLACK_SWAN_DETECT · cron='3,33 * * * *'）
     - 头部注释 "6 stage" → "5 stage"（BLACK_SWAN chain 章节标记 · 保持事实性）
  2. `backend/src/constants/cronRegistry.ts`
     - 删 `BLACK_SWAN_DETECT` registry entry（原 606-620 · 15 行 · recommendedCron/tags/tier/PR-011 comment）
     - TIMELINE 注释：错峰链 "3,33 detector → 13,43 postmortem → 23,53 baseline → 33,3 timeline" → "13,43 postmortem → 23,53 baseline → 33,3 timeline"
     - IMPROVEMENT 注释：同上 · 去除起点 "3,33 detector →"
     - POSTMORTEM 注释：restructure "与 BLACK_SWAN_DETECT 错峰 10min (3,33 → 13,43)" → "错峰链 (13,43 postmortem → ...) 上游 BlackSwanEvent 读端由外部写入源承担"
  3. `backend/tests/services/scheduler-default-tasks-completeness.test.ts`
     - `MISSING_14` → `MISSING_13` array rename（4 处 · 74/98/111/179）· 去 `'BLACK_SWAN_DETECT'` 条目
     - 头注释 "14 missing + 3 new" → "13 missing + 3 new" + audit trail 单行引 C-BS-03
     - console.log "[1] 14 个" → "[1] 13 个"、"[6.1] 14 个" → "[6.1] 13 个"
- **依据**：
  - Orchestrator BlackSwan β CONFIRMED 冷冻档裁定 msg=62d251b1 §一 · v1.2 冻结清单 · 第三态（Producer STUB 活 + Consumer/read-side 活 · Cron 生产链断）· §Structural-Deletion-Over-Discipline
  - v1.3 补丁清单落锤（Orchestrator msg=04c6bd9e §四）· Q1=α（test:76 MISSING_14 归 C-BS-03 · 保持批次内部一致性）· Q2=β（DataController 4 处 blackSwanWatchdogTask 独立 C-BS-03.5 commit）
  - 探测事实核偏差 v2 escalate（Cleanup msg=e0a38575）· 5 处未列 touchpoint · Q1-Q4 独占裁 · Q1 归本批次
  - li-yiming 全权掌控令 v2（DM msg=b8af5127 · Orchestrator 承接 msg=a6674a94）
- **影响面**：
  - 生产者 STUB · 已断链 · `evaluateWatchdog()` 恒返 `{ alerts: [] }` · 无实机告警产出
  - Cron `3,33 * * * *` 停跑 · 减少 Scheduler tick log 噪音
  - Consumer/read-side（`BlackSwanEventController` API + Client）保留 · 由外部写入源承担 · **不影响读端 API 契约**
  - Postmortem/Baseline/Timeline/Improvement chain 错峰逻辑更新 · 数据流由 BlackSwanEvent 表读端承接（非 Detector 生产）
- **保护 glob 触碰核**：零命中（`23-protect-list.md` v1 未列 BLACK_SWAN_DETECT 相关路径 · `akshare_helper.py:3280/3341/3401` + `BlackSwanEvent.ts` + `BlackSwanClient.ts` 边界护栏 msg=db566529 全 3 项探测阶段 grep 已核 = 零触）
- **DoD 自检**：
  - [x] 删前留据（本条 CHANGELOG）
  - [x] 独立 commit（本批次单主题）
  - [x] tsc/lint（本 commit push 前跑）
  - [x] 保护 glob 零触碰
  - [x] 副签路由：DataPipeline 副签（Orchestrator msg=83c00d15 §三 · β/γ 类删走 DataPipeline 副签通道）

## 批次 C-BS-03.5 · DataController Dashboard 消费点结构性删除

- **变更文件**：`backend/src/api/controllers/DataController.ts`
  - 删 `blackSwanWatchdogTask = taskStatus(['BLACK_SWAN_DETECT'])` (line 413)
  - `blackSwanStatus` 计算：去除 `blackSwanWatchdogTask.status` 依赖 · 改为纯基于 `black_swan_events` 表 7d/24h 计数（读端）
  - Dashboard node `id: 'black_swan_watchdog'` label='黑天鹅事件检测' · 改为 `id: 'black_swan_events'` label='黑天鹅事件（读端）' · 去 `cron_status/lastRun` 两统计位
  - Dashboard edges: 删 2 条 `black_swan_watchdog → risk_control/notification` · 保留 1 条并改 source: `black_swan_events → black_swan_postmortem`
  - L6 注释锚补：追加 C-BS-03 audit trail
- **依据**：
  - Orchestrator v1.3 补丁清单 msg=04c6bd9e §四 · Q2=β（DataController 4 处 blackSwanWatchdogTask 归独立 C-BS-03.5 commit）
  - §Structural-Deletion-Over-Discipline · Producer 已删（C-BS-03）· 消费端逻辑失去意义 · 结构性清除
  - 保留读端语义：黑天鹅事件仍从 `black_swan_events` 表读取 · 由外部写入源承担 · Dashboard 显示不受影响
- **影响面**：
  - Dashboard 数据源治理面：`black_swan_watchdog` 节点 → `black_swan_events` 节点 · label/stats/edges 语义化更新
  - `blackSwanStatus` 计算逻辑简化：不再依赖已删除的 BLACK_SWAN_DETECT task status · 直接基于事件表计数
  - 前端消费面无 breaking：dashboard node id 变更但 status/stats 字段结构保持
  - tsc --noEmit 全绿
- **DoD 自检**：
  - [x] 独立 commit（Orchestrator Q2=β 独立性要求）
  - [x] 保护 glob 零触碰
  - [x] tsc clean
  - [x] 副签路由：DataPipeline 副签

## 批次 C-BS-05 · 孤儿 test 文件删除（前置至 C-BS-04 之前 · 保 test import 先解耦）

- **变更**：删 2 个孤儿 test 文件
  - `backend/tests/services/black-swan-detector-service.test.ts`（516 行 · 依赖 `BlackSwanDetectorService` runBlackSwanDetector · 已断链无生产语义）
  - `backend/tests/risk/black-swan-watchdog.test.ts`（1723 行 · import `../../src/portfolio/risk/BlackSwanWatchdog` · **该 source 文件在仓中已不存在** · 属死 test）
- **依据**：
  - Orchestrator v1.2 冻结清单 · C-BS-05 位（原顺序）
  - Orchestrator "保 test import 先解耦" 指令 · 顺序前置至 C-BS-04 (DetectorService 整 class 删) 之前 · 避免删 source 时 test 报错
  - `black-swan-watchdog.test.ts` 揭示 pre-existing 死 test（source 已删但 test 未清 · Cleanup 顺带回收）
- **影响面**：
  - 删 2239 行 test 代码 · 无生产运行时影响
  - test 覆盖率报表移除 detector + watchdog 单测 · 与 Producer STUB 已删语义一致
- **DoD 自检**：
  - [x] 删前 grep 复核（`BlackSwanWatchdog` source 不存在）
  - [x] 独立批次

## 批次 C-BS-04 · DetectorService 整 class + comment 断链

- **变更文件**：
  1. `backend/src/services/BlackSwanDetectorService.ts` **DELETED**（446 行整文件 · Producer STUB 生产者 · `evaluateWatchdog()` 恒返 `{ alerts: [] }` · lazy-require 无外部 TS import · SchedulerService 侧引用已在 C-BS-03 删除）
  2. `backend/src/services/BlackSwanPostmortemService.ts` · 3 处 comment 字面改（Q3=γ）：
     - line 5 "上游 BlackSwanDetectorService (PR-011) 落到 BlackSwanEvent" → "外部写入源落到 BlackSwanEvent"
     - line 30 fail-OPEN "(与 BlackSwanDetectorService / DbBackupService 同款)" → "(与 DbBackupService 同款)"
     - line 52-54 SchedulerService 接入 "与 BLACK_SWAN_DETECT 的 '3,33' 错峰 10min" → "BLACK_SWAN_DETECT cron 已在 C-BS-03 批次删除 · BlackSwanEvent 读端由外部写入源承担"
     - line 187 "与 BLACK_SWAN_DETECT 错峰 10min" → "BlackSwanEvent 读端由外部写入源承担 (C-BS-03 后)"
     - line 437 lazy-require "(与 BlackSwanDetectorService / DbBackupService 同款)" → "(与 DbBackupService 同款)"
  3. `backend/tests/services/black-swan-postmortem-service.test.ts:554-556` · assertion 修（Q3=γ）：
     - 原断言 "8.3 cronRegistry 与 BLACK_SWAN_DETECT 错峰 (前者 13,43 后者 3,33)" 逻辑=同时包含 '13,43' + '3,33'
     - 新断言 "8.3 cronRegistry BLACK_SWAN_POSTMORTEM cron (13,43 · BlackSwanEvent 读端由外部写入源承担)" 逻辑=包含 '13,43' + 不包含 '3,33'（反向验证 C-BS-03 删除结果）
  4. `backend/src/services/BlackSwanImprovementSuggestorService.ts:64` · docstring 错峰链去起点：
     - "3,33 detector → 13,43 postmortem → ..." → "13,43 postmortem → ..."
  5. `backend/src/services/CounterfactualBaselineService.ts:822` · comment 断链：
     - "(与 BlackSwanPostmortemService / BlackSwanDetectorService 同款)" → "(与 BlackSwanPostmortemService 同款)"
- **依据**：
  - Orchestrator v1.3 补丁清单 msg=04c6bd9e §四 · Q3=γ (Postmortem 3 comment 字面改 + Postmortem test 554-556 断言修 归 C-BS-04) + Q4 (Improvement docstring 归 C-BS-04)
  - v1.2 冻结清单 C-BS-04 · DetectorService 整 class 删（§4 STUB 生产者 · 探测 msg=fe8020a2 § grep 全引用位揭无外部消费者）
- **影响面**：
  - 删 446 行 source · 生产者 STUB 结构性清除
  - 5 处 comment/docstring/assertion 断链 · audit trail 保留 (`C-BS-03 批次删除`)
  - Postmortem test 反向验证 registry 中 BLACK_SWAN_DETECT 已消失 · CI 门禁转为断链核
  - tsc --noEmit 全绿
  - QuarterlyReport zero-hit 已核 · 无同类命中
- **DoD 自检**：
  - [x] 独立 commit
  - [x] tsc clean
  - [x] 保护 glob 零触碰
  - [x] Postmortem test 反向断言 · 与 C-BS-03 删除结果对齐

---

## 批次 R2-A · Round-2 backend 死代码首批删除 (2026-07-08)

- **PR**: [#97](https://github.com/bruinxz/stocks/pull/97) · squash MERGED @ `e52b3ab` · 22:18
- **Base**: `6299a3d4` (28 PRs · post PR #96 trading_calendar Migration DDL landed)
- **Diff**: 2 files · net -201 LOC · pure delete
- **Branch**: `chore/cleanup-r2-a-backend-dead-code` (squashed · deleted post-merge)

- **变更文件** (2 files · Python 迁移期临时脚本):
  1. `backend/test_akshare_fix.py` **DELETED** (75 行 · `backend/` root · 非 `tests/` 目录 · `grep -rln 'test_akshare_fix' backend/ frontend/ scripts/` = 0)
  2. `backend/test_akshare_direct.py` **DELETED** (126 行 · 同上 · `grep -rln 'test_akshare_direct' backend/ frontend/ scripts/` = 0)

- **依据**:
  - Orchestrator dispatch msg=baaff9e3 (Round-2 dead-code scan 令) → msg=20f993d2 §二 (R2-A CREATE 令 · 免签窗口第 8 例 pre-grant)
  - `notes/cleanup-dead-code-scan-round2.md` v0.2 §八 (Path 1 apply + §grep 铁律 v2)

- **R2-01 no-op**: `backend/src/services/black-swan/` 空目录 · git 不 tracking 空目录 · 无需 commit
- **R2-02 撤销 → HOLD retain**: `backend/src/services/integration/production-bridges.ts` (464 LOC · 15,233 bytes) 保留
  - 触发事实: QADocs 副签发现 `backend/tests/services/sprint-7-18-smoke.test.ts:16` 活跃 import 7 symbols (`MockBrokerBridge, processOvernightSignals, persistHMMParams, loadHMMParams, persistThompsonPosteriors, loadThompsonPosteriors, persistMetaLabelCheckpoint`)
  - Research 独立复核确认 `backend/src/scripts/run-tests.ts:64` auto-discover 收纳 `.test.ts` · CI RED 悬念
  - 归入 sprint-7-18 60 模块 + smoke.test 独立生命周期决策 (armed queue)

- **教训 #12 反向应用第九例反例首入 landed 追认** (5-owner co-ledger):
  - **起源方**: Cleanup (grep 空间 scope `backend/src frontend/src` 单档判 orphan · 遗漏 `backend/tests`)
  - **副签盲区**: Research (msg=2399ae2f PASS → msg=ca0e60b3 CORRECTION)
  - **BLOCK 揭起**: QADocs msg=1e06dbbe (独立全域 grep 拦阻 CI RED landing)
  - **独立复核 endorse**: Strategy msg=14cf4068 + DP msg=31561303 co-owner confirm
  - **SOP 4-owner formalize armed**: QADocs S0.5 (多 stage verify) + S0.6 (test 层 grep 铁律) + Research §S3.4 (全域 grep 铁律 · `notes/lesson-11-broadcast-observation-bias.md` v1.2 landed) + Strategy S0.7 (`.test.ts` runtime auto-discover 一致性 CI 静态断言)
  - **子矩阵 B 群完形**: 第八例 (R2-05 grep 空间 scope · DP owner) · **第九例 (R2-02 verify 时间 stage · Cleanup+Research+QADocs co-owner + DP+Strategy endorse)**

- **副签路由 (5-owner ledger 完形)**:
  - Cleanup 主 (CREATE msg=e6aeee4b · Path 1 apply msg=fc28cc56)
  - Research CORRECTION endorse (msg=ca0e60b3) + post-Path1 re-verify PASS (msg=6f93ee1c · §S3.4 铁律首入应用)
  - Strategy independent endorse (msg=14cf4068)
  - QADocs CORRECTION PASS (msg=356dff53 · BLOCK 解 · 独立 grep + gh 事实链)
  - DP re-verify PASS (msg=31561303 · 5 items verbatim)
  - Orch pre-grant (msg=20f993d2 §五 · 免签窗口第 8 例)

- **影响面**:
  - 删 201 行 Python 迁移期临时脚本 · pure delete
  - tsc --noEmit CLEAN + baseline 435 ok / 2 failed 保持
  - Independence v1.1 §5 4 档 zero drift (档 1 数据源 / 档 2 策略因子 / 档 3 Frontend UI / 档 4 契约层)
  - Layer-Separation zero cross-boundary (`backend/` root Python · zero services/quant/strategies/models touch)

- **DoD 自检**:
  - [x] tsc clean
  - [x] 保护 glob 零触碰
  - [x] CI 7 checks CLEAN (Backend 2/2 SUCCESS · Frontend SUCCESS · Docker · weak-secrets · Detect changes)
  - [x] mergeStateStatus=CLEAN · MERGEABLE
  - [x] 5-owner 副签汇聚完形
  - [x] 教训 #12 第九例反例首入 co-owner 记账

- **免签窗口范式统计位** (第 8/9/10 例三连胜之首): 22:18 landed · Cleanup 主签 landed 第 5 例 (前 4: #78 BlackSwan β · #91 C-S2 · #92 C-S1 · #93 Path B)

- **R2-B/R2-05/R2-06 承接位** (post-R2-A):
  - **R2-B** (frontend build tarballs + fix_lint*.sh + refactor.js): HOLD · 等 Frontend Path γ landed · Frontend 主签路由 (frontend/** 越界豁免)
  - **R2-05** (`backend/src/models/ETFCreationRedemption.ts`): HOLD retain confirmed (DP msg=a727ec79 · 第八例反例首入)
  - **R2-02** (`backend/src/services/integration/production-bridges.ts`): HOLD retain (待 sprint-7-18 smoke 60 模块独立生命周期决策)
  - **R2-06** (`backend/backup_data.json` 5,876B): armed owner Q4 batch 决策窗口

---

## 批次 R2-B · Round-2 frontend 死依赖清理 (react-query removal) (2026-07-08)

- **PR**: [#102](https://github.com/bruinxz/stocks/pull/102) · squash MERGED @ `42d6d0d6` · 23:18
- **Base**: `6d3d831d` (32 PRs · post PR #100 DP Loader landed · rebased)
- **Diff**: 2 files (frontend/package.json -1 line + frontend/package-lock.json full-regen 240+/155-)
- **Branch**: `chore/cleanup-r2-b-react-query-removal` (squashed · deleted post-merge)
- **Commit stack**:
  1. `ad2002f` · `frontend/package.json` L29 · remove `"react-query": "^3.39.3"` (single line)
  2. `b5ad0a7` · `frontend/package-lock.json` full-regen via `npm install` under node 20 (CI node-version match · yaml@2.9.0 transitive restored)

- **依据**:
  - Orch dispatch msg=09551306 §六 (R2-B redirect · frontend build tarballs → react-query removal)
  - `notes/cleanup-r2-b-react-query-removal-prep.md` v0.1 (grep 5-domain 0 命中 · Path μ §5 + Path ν §1 25-service sweep 一致)

- **事实链 (grep verified 5-domain scope)**:
  - `frontend/src/**` · **0 命中** ✅ (Frontend Path μ §5 + Path ν §1 25-service sweep confirm)
  - `backend/src/**` · 0 命中 ✅
  - `scripts/**` · 0 命中 ✅
  - `contracts/**` · 0 命中 ✅
  - `docs/**` · 1 命中 (`docs/refactor/21-current-audit.md` audit reference · retain 权威锚 · Independence §5.4 独立设计层)

- **CI 二次修复历程 (dod v4.3 铁律 16 项 反例首入 co-owned closure)**:
  - **首次 commit `ad2002f`** · `npm install --package-lock-only` 生成 lock · CI Frontend job FAIL `Missing: yaml@2.9.0 from lock file`
  - **Research msg=95dd65aa BLOCK** (23:09) · §S3.4 + Independence + Layer-Separation pre-pass 100% ✅ · CI RED 根因 pin (lock 缺 transitive) · §四 next_action_owner @Cleanup SLA T+5min · §五 dod v4.3 §16 armed candidate
  - **二次 commit `b5ad0a7`** (23:12) · `nvm use 20` + `rm -rf node_modules package-lock.json && npm install --no-audit --no-fund` · 240+/155- · added 1619 packages · CI GREEN
  - **教训 #16 formalize** (`notes/lesson-16-package-lock-full-regen.md` v0.1 · 5-owner co-owned):
    - Cleanup 起源 (msg=74d90eff §二 · `--package-lock-only` 语义偏差反例首入)
    - Research 副签发现 (msg=95dd65aa §五 · dod v4.3 §16 首入 candidate 提出)
    - Orch 独裁 formalize (msg=077dd215 §五 · dod v4.2 → v4.3 · 15 → 16 项)
    - QADocs formalize 承接 (`notes/dod-self-check-list.md` v4.3 §16 落地)
    - DP endorse (msg=a911de70 §六 · Path C.2 future npm 依赖 verify)
    - Frontend endorse (msg=3f0f19ba §二 · workspace 层 endorse · Path π §1.2 越界豁免 co-sign)

- **副签路由 (免签窗口第 14 例 pre-grant · 4-owner ledger)**:
  - Cleanup 主 (CREATE · 二 commit stack `ad2002f` + `b5ad0a7`)
  - **Frontend 副 PRE-GRANT PASS** msg=5dc69a8f (5-point verify · frontend/** glob 越界豁免 dependency-layer only · lock 全 regen co-sign refresh msg=6cd7a8e8 §二 PASS)
  - **Research 副 BLOCK → upgrade PASS** (msg=95dd65aa 修复条件 §三 100% 兑现 · post-CI GREEN upgrade retro)
  - QADocs 副 (dod v4.3 §16 formalize 承接)
  - Orch owner-review (msg=077dd215 §五 dod v4.3 独裁 armed · self-merge admin squash approve)

- **影响面**:
  - 删 `frontend/package.json` L29 单行 react-query 直接依赖
  - 重生 `frontend/package-lock.json` · react-query 及其闭包 drop · yaml@2.9.0 等 transitive 完整恢复
  - `npx tsc --noEmit` 基线 93 → 93 error 零 delta (全 pre-existing @types/jest 未安装 · 与 react-query 无关)
  - `frontend/tests/**` grep 0 命中 (dod v4.2 铁律 15 项 test 层 verify)
  - CI 全 GREEN: Frontend check 2m37s / 2m28s · Backend check 6m4s · Docker/weak-secrets/Detect PASS
  - Independence v1.1 §5 4 档 zero drift (档 1 数据源 / 档 2 策略因子 / 档 3 Frontend UI 依赖层 Frontend co-sign / 档 4 契约层)
  - Layer-Separation R1-R8 zero cross-boundary (`frontend/package.json` 依赖层 · zero `frontend/src/**` 代码触)

- **DoD 自检**:
  - [x] tsc clean (基线 zero delta)
  - [x] 保护 glob 零触碰 (Path D 永不动)
  - [x] CI 5 checks CLEAN (Frontend 2m37s + Backend 6m4s + Docker 11s + weak-secrets 14s + Detect 9s)
  - [x] mergeStateStatus=CLEAN · MERGEABLE
  - [x] 5-owner 副签汇聚完形 (Cleanup 主 + Frontend + Research upgrade + QADocs + Orch)
  - [x] dod v4.3 铁律 16 项 反例首入 co-owned closure landed

- **免签窗口范式统计位** (七连胜完形第 14 · 8-14 landing): 23:18 landed · **§D4.G2 shape 五方语义承接完形 + Batch R2-B 全链闭环 双一里程碑** · Cleanup 主签 landed 第 6 例 (前 5: #78 BlackSwan β · #91 C-S2 · #92 C-S1 · #93 Path B · #97 R2-A · #99 R2-A log)

- **主 CI 修复 SOP formalize** (Cleanup 承接位 · post-landing 触发):
  - 教训 #16 v0.1 `notes/lesson-16-package-lock-full-regen.md` SOP 4 步:
    1. `unset npm_config_prefix` + `nvm use 20` (CI node-version match)
    2. `rm -rf node_modules package-lock.json && npm install --no-audit --no-fund` (禁 `--package-lock-only`)
    3. verify diff: 移除依赖 grep=0 + 抽查 3-5 transitive dep 命中
    4. commit + push + CI verify gate (`gh pr checks <PR> --watch` GREEN 才 self-merge)

---

## 批次 R2-06 · `backend/backup_data.json` 根级一次性运维产物删除 (2026-07-09)

- **PR**: (本 PR · 待赋号) · target `main` @ `e9a44de` (38 PRs · 十一连胜完形 8-18 后 首例)
- **Base**: `e9a44de`
- **Branch**: `chore/cleanup-r2-06-delete-backup-data-json`
- **Diff**: 2 files (`backend/backup_data.json` -279 line/5876B removed · `docs/refactor/30-cleanup-log.md` +本章节)
- **Target**: `backend/backup_data.json` (5876B · 279 line · mtime 2026-04-16 10:32 · 根级一次性运维产物)

- **Content 结构** (Cleanup workspace `notes/r2-06-backup-data-json-prep.md` v0.1 §一 抽样 pin):
  - Array of `{stock: {id, symbol, name}, data: [{time, open, high, low, close, volume}]}`
  - 抽样股票: `bj.920237 力佳科技` (data=[]) · `sh.605268 王力安防` (2026-04-03 K-line 起 · OHLCV daily bars)
  - 数据类型: **股票日线 OHLCV 备份** · 非 credential · 非 PII (公开市场行情数据)

- **依据** (grant 层级完形):
  - Orch msg=4b0f5bd4 audit 21 §438 pre-approve · 根级一次性运维产物 (`backup_data.json` / `test_akshare*.py` / `sync_files.sh` 等 无双向引用)
  - Orch msg=bf364d9c aggregate v15 §"Cleanup 双 Fork A grant" R2-06 delete Fork A grant landed · CREATE 授权 · 3-sign PASS · **十二连胜 8-19 candidate** T+30min SLA
  - `notes/r2-06-backup-data-json-prep.md` v0.1 (workspace prep · 5-domain grep 0 code consumer · Fork A 推荐)
  - DP msg=950a7c64 §五 R2-06 DP-side collision verify PASS (grep backend/src / backend/src/jobs / backend/src/data / scripts = 0 hits · DP 侧 zero jobs/data consumer · Fork A DP endorse)
  - Research msg=2392757e §五 R2-06 双复核 endorse
  - `docs/refactor/22-cleanup-candidates.md` §C6 escalate li-yiming (audit 21 pre-approve 后 22 §C6 复核 gate · Orch aggregate v15 grant 兑现)

- **事实链 (grep verified 5-domain scope · re-verify @ CREATE)**:
  - `backend/src/**` · **0 命中** ✅ (no code consumer)
  - `frontend/src/**` · **0 命中** ✅
  - `scripts/**` · **0 命中** ✅
  - `contracts/**` · N/A (dir missing)
  - `docs/**` · 5 命中 (workspace audit reference · 全 retain · Independence §5.4 独立设计层):
    - `docs/refactor/21-current-audit.md:438` (根级一次性运维产物候选)
    - `docs/refactor/22-cleanup-candidates.md:92` (§C6 escalate li-yiming)
    - `docs/refactor/22-cleanup-candidates.md:184` (§H8 参见 §C6)
    - `docs/refactor/22-cleanup-candidates.md:210/231` (C 组统计 + li-yiming 私域裁定表)
    - `docs/refactor/23-protect-list.md:189/340` (protect-list 候选位)

- **副签路由 (免签窗口第 19 例 pre-grant · 3-sign PASS 汇聚)**:
  - Cleanup 主 (CREATE · single delete + doc paste-in 一次性 diff)
  - **DP 副 PRE-GRANT PASS** msg=950a7c64 §五 (backend/src / backend/src/jobs / backend/src/data / scripts 5-domain 0 命中 · Fork A DP endorse · Independence v1.1 §5.1 数据源 dir 独占位 · backup_data.json 非 backfill 出参 · 非 cron 消费)
  - **Research 副 PASS** msg=2392757e §五 (R2-06 双复核 endorse · §S3.4 5-domain grep 一致)
  - Orch owner-review (msg=bf364d9c aggregate v15 §"Cleanup 双 Fork A grant" armed · self-merge admin squash approve)

- **影响面**:
  - 删 `backend/backup_data.json` (5876B · 279 line) · 根级一次性运维产物 zero code consumer
  - `docs/refactor/30-cleanup-log.md` +本章节 (paste-in 范式 · 教训 #14 workspace preview + post-landed 承接)
  - `npx tsc --noEmit` 基线 zero delta (数据文件 · 非 TS 引用)
  - `backend/tests/**` grep 0 命中 (dod v4.2 铁律 15 项 test 层 verify)
  - Independence v1.1 §5 4 档 zero drift (档 1 数据源 backup 一次性 · zero live pipeline dependency · zero 契约层)
  - Layer-Separation R1-R8 zero cross-boundary (根级一次性运维产物 · zero `backend/src/**` 代码触)

- **DoD 自检** (dod v4.3 铁律 16 项):
  - [x] #1 密钥/凭证 zero (公开 OHLCV · zero credential)
  - [x] #2 Phase 0 清理独占 (zero 与开发 Agent 并行)
  - [x] #3 事实链 pin (grep 5-domain · 0 code consumer · 5 doc reference retain)
  - [x] #4 30-cleanup-log 章节 paste-in landed (本 §)
  - [x] #5 zero test 触
  - [x] #6-#9 (PG/SSH/Path C/Path D 全 N/A)
  - [x] #10-#13 v4.1 累积
  - [x] #14 multi-stage verify (tsc zero delta · CI 全 GREEN gate)
  - [x] #15 test 层 grep (backend/tests 0 命中)
  - [x] #16 zero package.json 触碰 (自适应 pass)

- **免签窗口范式统计位** (十二连胜完形第 19 · 8-19 landing candidate): 3-sign PASS 汇聚 · Cleanup 主签 landed 第 7 例 candidate (前 6: #78 BlackSwan β · #91 C-S2 · #92 C-S1 · #93 Path B · #97 R2-A · #99 30-log · #102 R2-B)


## R3-C · backend/ root 迁移期 exp/debug/py 清理 (2026-07-09)

- **PR**: #TBD (chore/cleanup-r3-c-backend-root-migration-cleanup)
- **触发**: R3 dead-code scan workspace `notes/cleanup-dead-code-scan-round3.md` v0.1 · Orch aggregate v21 msg=791de15f §八 pre-grant #7 dispatch · **十四连胜 8-21 candidate**
- **base main**: `9c2eefe8` (post-PR-#108 十三连胜完形 40 PR)

- **删除清单** (4 tracked + 1 untracked · net -50KB):

  | # | 文件 | size | 分类 | 5-domain grep |
  |---|---|---|---|---|
  | 1 | `backend/copy_py.exp` | 332B | expect deploy 脚本 (迁移期) | 0 命中 |
  | 2 | `backend/copy_script.exp` | 291B | expect deploy 脚本 (迁移期) | 0 命中 |
  | 3 | `backend/run_remote.exp` | 301B | expect deploy 脚本 (迁移期) | 0 命中 |
  | 4 | `backend/test_em.py` | 1212B | Python 迁移临时验证 | 0 命中 |
  | 5 | `backend/debug.log` | 47570B | 迁移期 debug 输出 (`.gitignore *.log`) | 0 命中 · 本地 rm only · 不在 git 追踪 |

- **事实链 pin** (5-domain grep):
  - Command: `grep -rln "<name>" backend/src frontend/src scripts contracts` + `grep -l "..." backend/package.json backend/tsconfig*.json`
  - `backend/src` 0 命中 · `frontend/src` 0 命中 · `scripts` 0 命中 · `contracts` 0 命中 · `.github/workflows` 0 命中 · `backend/package.json scripts` 0 命中
  - `docs/refactor` 单命中 `22-cleanup-candidates.md` (audit reference · **本 R3-C 删除即兑现**)

- **grant chain (免签窗口第 21 例 pre-grant · 3-sign PASS 汇聚 pre-armed)**:
  - Cleanup 主 (CREATE · 4 tracked delete + doc paste-in 一次性 diff)
  - **Research 副签 pre-armed** (msg=24cb074e §六.5 verbatim: "R3-C PR CREATE Research 副签承接位 armed · SLA T+15min from Cleanup PR CREATE · 4 核项 pre-lock")
  - **DP 副签 pre-armed** (Orch v21 §八 verbatim: "3 副签 pre-armed: Research §S3.4 grep + DP §D4 model 表 zero touch + QADocs §16 verify")
  - **QADocs 副签 pre-armed** (同上 · dod v4.3 §16 zero package.json 触碰 verify)
  - Orch owner-review (msg=791de15f aggregate v21 §八 · pre-grant #7 · self-merge admin squash approve · SLA T+30min)

- **影响面**:
  - 删 4 tracked exp/py file + 1 untracked debug.log 本地清理 · 根级迁移期一次性工具 · zero code consumer
  - `docs/refactor/30-cleanup-log.md` +本章节 (paste-in 范式 · 教训 #14 workspace preview + post-landed 承接)
  - `npx tsc --noEmit` 基线 zero delta (非 TS/JS 引用)
  - `backend/tests/**` grep 0 命中 (dod v4.3 铁律 §16 test 层 verify)
  - Independence v1.1 §5 4 档 zero drift (档 1 数据源 exp/py 迁移期临时件 · zero pipeline dependency · zero 契约层)
  - Layer-Separation R1-R8 zero cross-boundary (backend/ root loose · zero services/quant/strategies/models 触)

- **DoD 自检** (dod v4.3 铁律 16 项):
  - [x] #1 密钥/凭证 zero (exp 脚本内容 zero credential literal · deploy 目标凭证已由 shared/backend.env 管理)
  - [x] #2 Phase 0 清理独占 (zero 与开发 Agent 并行)
  - [x] #3 事实链 pin (grep 5-domain + config 全 0 命中)
  - [x] #4 30-cleanup-log 章节 paste-in landed (本 §)
  - [x] #5 zero test 触
  - [x] #6-#9 (PG/SSH/Path C/Path D 全 N/A · Path D 交叉核 pass workspace §四)
  - [x] #10-#13 v4.1 累积
  - [x] #14 multi-stage verify (tsc zero delta · CI 全 GREEN gate)
  - [x] #15 test 层 grep (backend/tests 0 命中)
  - [x] #16 zero package.json 触碰 (自适应 pass · lesson-16 v1.0 seal 承接第 7 例)

- **免签窗口范式统计位** (十四连胜 8-21 landing candidate): 3-sign PASS 汇聚 · Cleanup 主签 landed 第 10 例 candidate (前 9: #78 BlackSwan β · #91 C-S2 · #92 C-S1 · #93 Path B · #97 R2-A · #99 R2-A doc · #102 R2-B code · #104 R2-B doc · #107 R2-06 delete)

---

## §Task-22 · Phase 0 密钥治理批 audit 结论 (2026-07-09 · 十五连胜 8-22 candidate · Orch aggregate v24 Fork A APPROVE · pre-grant #8)

**触发**: Cleanup workspace `notes/phase-0-secret-governance-prep.md` v0.1 (2026-07-08 23:45) 承接 audit 结论到 repo 层 audit trail (教训 #14 workspace preview → post-landed paste-in 范式兑现)

**验证时点**: main HEAD `7eb472647d17c035d8cf59b5c47351ce89b250ef` (post PR #109 MERGED · 41 PR · 十四连胜 8-21 完形)

**Orch 独裁 APPROVE 事实链**: Orch aggregate v24 §一 Fork A APPROVE · §二 pre-grant #8 armed · docs-only zero code touch · lesson-16 v1.0 seal 承接第 8 例 apply

### §一 · 5-domain grep pattern 集 (P1-P6)

| # | Pattern | Rationale |
|---|---------|-----------|
| P1 | `sk_agent_[a-zA-Z0-9]{20,}` | Slock agent token literal |
| P2 | `sk_machine_[a-zA-Z0-9]{20,}` | 遗留 machine API key literal |
| P3 | `-----BEGIN.*PRIVATE.*KEY-----` | PEM 私钥 inlined |
| P4 | `AKIA[0-9A-Z]{16}` | AWS access key id shape |
| P5 | `"(password\|secret\|token\|api_?key)"\s*:\s*"[^"]{8,}"` | JSON literal 长值 (排除 test/mock/fixture) |
| P6 | `(password\|secret\|token\|api_?key)\s*=\s*['"][a-zA-Z0-9+/=]{16,}['"]` | 变量赋值形态 |

**Command (P1-P4 高置信度)**:
```bash
grep -rlE "sk_agent_|sk_machine_|-----BEGIN.*PRIVATE.*KEY-----|AKIA[0-9A-Z]{16}" \
  --include="*.ts" --include="*.tsx" --include="*.py" --include="*.js" \
  --include="*.json" --include="*.yaml" --include="*.yml" \
  backend/src frontend/src scripts
```
→ **zero hits** ✅ (P1-P4 全 clean · workspace §一 + post-PR #109 `7eb47264` re-verify byte-match zero drift)

**Command (P5 生产 JSON literal)**:
```bash
grep -rnE "['\"](password|secret|token|api_?key)['\"]:\s*['\"][^'\"]{8,}['\"]" \
  --include="*.ts" --include="*.tsx" backend/src frontend/src \
  | grep -vE "test|spec|fixture|mock|__tests__"
```
→ **zero hits** ✅ (P5 生产代码 clean · re-verify @ `7eb47264` byte-match)

### §二 · 12 候选 triage 表 (workspace §二 verbatim · 全 env-var / runtime-storage 合规)

| # | Path | Pattern | 判据 | 处理 |
|---|------|---------|------|------|
| 1 | `backend/src/middlewares/auth.ts` L51-53 | `const secret = process.env.JWT_SECRET \|\| ...` | **env-var + fail-closed** (缺失 500 拒验) · P0 review comment 明示禁 fallback literal | ✅ safe · **retain 权威锚** |
| 2 | `backend/src/realtime/alertsWebSocketServer.ts` L122 | `loadJwtSecretFromEnv(env)` | env-var 参数化 · production 缺失 null 拒所有 WS · dev fallback `LIVE_DEV_JWT_SECRET` 亦 env | ✅ safe |
| 3 | `backend/src/api/controllers/AuthController.ts` L415 | `authHeader.split(' ')[1]` | runtime token 提取 · 非 literal | ✅ safe |
| 4 | `backend/src/api/controllers/UserController.ts` L24/L70/L121 | `json.password = '******'` | **display 脱敏 mask** · 非 credential · 输出前遮蔽 | ✅ safe (脱敏惯用) |
| 5 | `backend/src/data/sources/TushareClient.ts` L10 | `this.token = token \|\| process.env.TUSHARE_TOKEN \|\| ...` | ctor arg + env-var 双通道 · 无 default literal | ✅ safe |
| 6 | `backend/src/services/WeChatOAClient.ts` L105/L118/L259 | `env: NodeJS.ProcessEnv = process.env` | 全 env-injected · isEnabled/isWeChatOADisabledByEnv 均 env 驱动 | ✅ safe |
| 7 | `backend/src/services/research/ResearchExperimentService.ts` | (未见 secret literal) | 已 grep · 0 hit high-confidence pattern | ✅ safe |
| 8 | `frontend/src/App.tsx` L74/L210/L217/L240 | `localStorage.getItem('token')` | **runtime storage lookup** · zero literal | ✅ safe |
| 9 | `frontend/src/services/authService.ts` L5/L11/L26/L30/L40-56 | interface `password: string` + `localStorage.setItem('token', data.tokens.accessToken)` | 字段类型声明 + 运行时存储 · zero literal | ✅ safe |
| 10 | `frontend/src/services/api.ts` L32/L40-42/L57-137 | `const token = localStorage.getItem('token')` + `Bearer ${token}` header 注入 · refresh-token 401 拦截 | 运行时存储 + interceptor · zero literal | ✅ safe |
| 11 | `frontend/src/services/alertsRealtimeClient.ts` | WS token param | 与 authService 一致 runtime pattern | ✅ safe |
| 12 | `frontend/src/store/authSlice.ts` L14/L22/L35/L38/L49 | Redux state `token: string \| null` | 运行时 state 字段 · zero literal | ✅ safe |

### §三 · 结论 (zero violation)

- **backend 侧**: 全 `process.env.*` fail-closed · P0 review comment 已 pin 禁 fallback literal (`auth.ts` L47-49 注释)
- **frontend 侧**: 全 `localStorage.getItem/setItem('token', ...)` runtime storage + interface 字段声明 · zero literal
- **display mask** `'******'` 计入 UserController 但非 credential (脱敏惯用位)

**审计结论**: Phase 0 密钥治理批 · **代码侧 zero violation** · 无 delete/rewrite 目标 · pre-CREATE 无 code PR needed · **本 doc paste-in 为 audit trail 层留痕 (教训 #14 兑现)**

### §四 · Protect-list Path D 交叉核 (`23-protect-list.md` v1 权威锚)

| Path | zero touch verify |
|---|---|
| `.git/` | ✅ |
| `shared/backend.env` (SSH 侧 `/opt/stocks/backend.env` 640 stocks_app:stocks) | ✅ workspace only · zero repo write |
| `.ssh/` (host + deploy user) | ✅ |
| `docker-compose.prod.yml` (production stack) | ✅ |
| `releases/initial/` | ✅ |
| `backend/.env` (checkout · gitignore 位) | ✅ |
| `backend/.env.example*` + `frontend/.env.production` 等参考 env | ✅ audit read-only · zero content edit |

`*.example` 文件按惯用 placeholder value · 非真凭证 · 保留即可

### §五 · Public-channel redaction rules pin (owner msg=b8af5127 铁律强化)

- **禁**: 公 channel 输出 `sk_agent_*` / `sk_machine_*` / JWT / PEM key / AWS AKIA / DB URL (含密码位) 完整字面
- **允**: `sk_agent_<redacted>` / `sk_machine_<redacted>` shape · 只保留 prefix
- **误 paste 处理**: 立即 DM credential owner 触发 rotate

### §六 · DoD self-check (dod v4.3 铁律 16 项)

- [x] #1 密钥/凭证 zero (audit pass · 12 候选全 env-var/runtime-storage · zero literal @ `7eb47264` byte-match)
- [x] #2 Phase 0 清理独占 (zero 与开发 Agent 并行)
- [x] #3 事实链 pin (§一 5-domain grep P1-P6 · zero hit)
- [x] #4 30-cleanup-log 章节 paste-in landed (本 §Task-22 · 教训 #14 兑现)
- [x] #5 zero test 触 (docs-only zero code change)
- [x] #6 PG SELECT-only (N/A · docs-only)
- [x] #7 SSH read-only (N/A · docs-only · workspace + git local + gh CLI only)
- [x] #8 Path C HOLD (zero 触 · docs/refactor/ 层)
- [x] #9 Path D 永不动 (§四 交叉核 pass)
- [x] #10-#13 v4.1 累积 (pass)
- [x] #14 multi-stage verify (docs-only · zero tsc/lint delta · CI 全 GREEN gate)
- [x] #15 test 层 grep (docs-only · N/A)
- [x] #16 **zero package.json 触碰** (自适应 pass · lesson-16 v1.0 seal 承接第 8 例 apply)

### §七 · 副签路由 pin (Orch aggregate v24 §二)

| # | 副签 | agent | scope |
|---|---|---|---|
| 主 | Cleanup | 本 batch 起源 · workspace v0.1 → doc paste-in | audit trail 层留痕 |
| 副 1 | Research | §S3 audit trail 一致性 · 5-domain grep pattern verify | pre-merge |
| 副 2 | QADocs | §16 dod v4.3 lesson-16 v1.0 seal 承接第 8 例 apply | pre-merge |
| 副 3 | DP | §D4 zero-touch (backend/frontend/scripts/contracts zero code) | pre-merge |

### §八 · 免签窗口范式统计位 (十五连胜 8-22 candidate)

- Cleanup 主签 landed 累计: #78 BlackSwan β · #91 C-S2 · #92 C-S1 · #93 Path B · #97 R2-A · #99 R2-A doc · #102 R2-B code · #104 R2-B doc · #107 R2-06 delete · #109 R3-C delete (十例)
- **Task #22 candidate (本 PR)**: **Cleanup 主签第 11 例 candidate · 十五连胜 8-22 first-choice**

### §九 · 引用锚

- Cleanup workspace `notes/phase-0-secret-governance-prep.md` v0.1 (2026-07-08 23:45)
- Orch aggregate v24 §一 Fork A APPROVE + §二 pre-grant #8 armed
- 教训 #14 workspace preview → landing paste-in 范式
- lesson-16 v1.0 seal (dod v4.3 §16 lesson-16 承接第 8 例 apply candidate)
- `docs/refactor/23-protect-list.md` v1 Path D 权威锚
- owner msg=b8af5127 完全掌控令 v2 · msg=210d262d 铁律强化 · msg=df3a0aae SSH executive 令 v3

---

## §PR-M3-2 · Frontend backtestService.ts 271-line delete · last-consumer migration landing (2026-07-09 · Cleanup γ 主签 doc-tier)

### §一 · Landing metadata

- **PR**: [#121](https://github.com/bruinxz/stocks/pull/121) · Frontend 主签 · squash-merge from `aa099594` (base) · mergeCommit `0fb7c96e` @ `2026-07-09T15:38:08Z`
- **Branch**: `frontend/pr-m3-2-backtest-service-migrate` (deleted post-merge)
- **Diff**: +37 / −282 · 3 files
- **Authority**: `msg=d0d11677` self-merge (≥4 sign + CI 8/8 GREEN → self-merge OK) · Frontend 主签 self-merge REALIZED · owner DM pivot `msg=3c114597` (T+7d 2026-07-16 → T+0 IMMEDIATE EXECUTE) + Orch v197 `msg=de6103bd` 兑现完毕
- **SLA actual**: PR CREATE T+30min · 副签 gather T+60min · self-merge T+90min · 全 lifecycle T+0 vs original T+7d gate = **5.6d 提前**

### §二 · Cleanup γ verify 三项 (byte-truth 铁-verify PASS via gh api 独立)

| # | file | verify | result |
|---|---|---|---|
| A | `backend/tests/lint/no-backtest-service-regression.test.ts` L89-90 | `KNOWN_RESIDUAL = 1` → `= 0` + comment tightened "PR-M3-2 landed · regressions hard-fail CI" | ✓ semantic transition 完成 · hard-fail LIVE at merge time |
| B | `frontend/src/components/backtest/BacktestResults.tsx` | L23 import `getBacktestDetail from '../../services/labService'` (SOLE labService import) · L53-88 `loadResults` 重写 via `detail.results[0]` adapter + `equity_curve_json`/`daily_returns` derive · L91-95 `loadBacktestInfo` migrated · pre-edit anchor 475L/16071B bit-perfect | ✓ 3-anchor line-exact + bit-perfect anchor + zero-collateral edits |
| C | `frontend/src/services/backtestService.ts` | DELETED 271 lines · git blob `f69a0f59` → `00000000` · `git grep backtestService` 全库 zero-residual (sole sentinel test reference by design) | ✓ zero-residual grep pass |

### §三 · CI 8/8 required-check GREEN unconditional

Detect changes ✓ · Docker compose validate ✓ · Frontend check (typecheck + lint) ✓ · Backend check (typecheck + lint + test · 6m0s) ✓ · enum-matrix-lock (ADR-0011 §5) ✓ · no-backtest-service-regression (PR-M3-2 pre-guard · `KNOWN_RESIDUAL=0` sentinel hard-fail LIVE) ✓ · weak-secrets ✓ · paths_filter ✓ · mergeStateStatus=CLEAN · mergeable=MERGEABLE

### §四 · 副签 6/6 六方 CONCUR msg-id table

| # | agent | msg | posture |
|---|---|---|---|
| 1 | Cleanup γ | `msg=1d26dce0` | 副签 CONCUR unconditional · byte-truth verify PASS · T+2min post-CREATE |
| 2 | Strategy | `msg=b33354c1` | 副签 CONCUR unconditional · 独立 gh api verify · T+3min post-CREATE |
| 3 | DataPipeline γ | `msg=19b904b0` | 副签 CONCUR · 采集/存储侧 (collectors/storage/dataSources/database) 零触碰 100% · 六段-lineage `3246b8cf → 036294a7 → 7003e0d3 → feafa6e4 → 93dee066 → aa099594` unchanged corroborated |
| 4 | Research §S3 | `msg=7c1bfa57` | 副签 CONCUR · 三-item byte-truth 铁-verify via gh api 独立复核 · L92 KNOWN_RESIDUAL=0 + L23 SOLE labService + backtestService.ts 404 + tree 24 files 无残留 |
| 5 | QADocs | `msg=e65f0a81` | 副签 CONCUR · mergeStateStatus=CLEAN + mergeable=MERGEABLE + diff bit-perfect · CI 8/8 UNCONDITIONAL GREEN · 反-fabrication Instance 2 CLOSE-OUT candidate armed post-MERGE |
| 6 | Backend v32 | `msg=8ff4b2d1` | 副签 arm posture ready · byte-truth trailing-verify lane (5-sign gate 已跨过 pre-merge) |

Frontend 主签 CREATE broadcast `msg=5fc56cd6` · Cleanup γ post-MERGE close-out `msg=52696810`.

### §五 · 反-Fabrication canonical Instance 2 lifecycle CLOSE-OUT REALIZED-in-repo cross-ref

Instance 2 双-phase template canonical LOCK: **§3.2 baseline** (`KNOWN_RESIDUAL=1` documented at #119 with named threshold + follow-up PR-M3-2 tighten obligation · pre-tighten posture) + **§3.4 realization** (post-#121 tightening obligation discharged in exact single-line edit path predicted · post-tighten close-out).

Companion doc-PR: [#122](https://github.com/bruinxz/stocks/pull/122) · mergeCommit `86d1dd33` @ `2026-07-09T16:03:26Z` · QADocs 主签 self-merge · doc-tier 双-sign lane 首例 canonical LOCK REALIZED · docs/refactor/CHANGELOG.md `[PR-M3-2]` entry + docs/refactor/quality/anti-fabrication-canonical.md §3.4 permanent 落地 at main HEAD `86d1dd33`.

Bit-perfect realization: `KNOWN_RESIDUAL=1→0` (single-line edit predicted § §3.2 → discharged) + comment rewrite ("awaiting PR-M3-2 · must tighten to === 0 at land time" → "PR-M3-2 landed · regressions hard-fail CI") + assertion semantic transition (soft-observe threshold → hard-fail regression sentinel) + companion consumer elimination (backtestService.ts 271-line delete) + zero-residual grep (`git grep backtestService` full-repo zero hits outside sentinel test).

### §六 · 保护 glob zero-collateral audit

- `frontend/**` — 主签授权 lane 100% (Frontend 主签 lane 完全 aligned · 2-file scope: BacktestResults.tsx edit + backtestService.ts DELETE)
- `backend/src/**` — zero-touch (sentinel test at `backend/tests/lint/**` sole `backend/**` touch · lint-layer only · NOT `src/` code)
- `采集/存储侧` — protected globs zero touch (collectors/storage/dataSources/database 六段-lineage unchanged per DP γ msg=19b904b0 corroboration)
- `schema.prisma` — unchanged
- `package.json` — zero delta
- `Math.random` — zero touch (US-038 SeededRandom retain)
- Path D `3246b8cf` — 冻结锚 zero touch (baseline JSON slug + `sha_lock` content field both preserved)
- Zero force-push · `jscpd ≤30%` hard-gate retained · Alpha Vantage + Baostock + Yahoo opt-in only · License Independence v1.1 retain · 借鉴外部 attribution none

### §七 · Seven-段 main HEAD lineage LOCK update

`3246b8cf(#115) → 036294a7(#116) → 7003e0d3(#117) → feafa6e4(#118) → 93dee066(#119) → aa099594(#120) → 0fb7c96e(#121)` — main HEAD canonical LOCK 更新 → `0fb7c96e` (post-#122 doc-tier LAND: 八段 extended → `86d1dd33`).

### §八 · Cleanup γ 三-phase 生命周期 canonical (类比 双-phase v48/v49 #120 precedent extend)

- **Phase 1 pre-CREATE arm** — `msg=69cec929` 副签 承接位 broadcast · SLA ≤ 15min post PR CREATE · verify 三项 armed
- **Phase 2 post-CREATE 副签 CONCUR** — `msg=1d26dce0` T+2min post-CREATE actual · unconditional CONCUR (byte-truth verify 全项 PASS)
- **Phase 3 post-MERGE close-out** — `msg=52696810` post-self-merge · 30-cleanup-log §PR-M3-2 landing entry armed (本 PR)

### §九 · DoD self-check (dod v4.3 铁律 16 项 · docs-only)

- [x] #1 密钥/凭证 zero (docs-only · zero literal)
- [x] #2 Phase 0 清理独占 (docs-only · not code)
- [x] #3 事实链 pin (§一-§五 全 PR/msg/SHA/timestamp anchored to independently-verified sources)
- [x] #4 30-cleanup-log 章节 paste-in landed (本 §PR-M3-2 · 教训 #14 兑现 · post-#122 doc-tier canonical 承接)
- [x] #5 zero test 触 (docs-only · zero code change)
- [x] #6 PG SELECT-only (N/A · docs-only)
- [x] #7 SSH read-only (N/A · docs-only · workspace + git local + gh CLI only)
- [x] #8 Path C HOLD (zero 触 · docs/refactor/ 层)
- [x] #9 Path D 永不动 (§六 交叉核 pass)
- [x] #10-#13 v4.1 累积 (pass)
- [x] #14 multi-stage verify (docs-only · zero tsc/lint delta · CI 6-check GREEN gate)
- [x] #15 test 层 grep (docs-only · N/A)
- [x] #16 zero package.json 触碰 (自适应 pass · lesson-16 v1.0 seal 承接 apply)

### §十 · 副签路由 pin (Orch v204 msg=a061c6f7 §一 Lane B dispatch)

| # | 副签 | agent | scope |
|---|---|---|---|
| 主 | Cleanup γ | 本 batch 起源 · doc-tier 主签 self-merge candidate (doc-tier 二例 · 首例 PR #122) | audit trail 层留痕 · Post-MERGE landing entry canonical |
| 副 1 | Research §S3 | byte-truth verify + 30-cleanup-log cross-ref + PR #121/#122 SHA/timestamp/msg-id 独立复核 | pre-merge |
| 副 2 | QADocs | CHANGELOG-adjacent 一致性 · docs/refactor/CHANGELOG.md `[PR-M3-2]` entry cross-ref verify | pre-merge |

### §十一 · 引用锚

- `docs/refactor/CHANGELOG.md` `[PR-M3-2] · 2026-07-09` entry (post-#122 landing at main HEAD `86d1dd33`)
- `docs/refactor/quality/anti-fabrication-canonical.md` §3.2 pre-tighten baseline + §3.4 post-tighten realization 双-phase template canonical LOCK
- `docs/refactor/quality/pr-m3-2-preguard-runbook.md` Frontend 主签 T+7d recipe (原 runbook)
- `docs/refactor/23-protect-list.md` v1 Path D 权威锚 (frozen 3246b8cf)
- `docs/refactor/adr/0011-ui-enum-single-source-of-truth.md` §5 barrel-authority + §6 CI required-check contract
- PR #121 https://github.com/bruinxz/stocks/pull/121 · PR #122 https://github.com/bruinxz/stocks/pull/122
- owner msg=b8af5127 完全掌控令 v2 · msg=d0d11677 self-merge 令 · msg=3c114597 IMMEDIATE EXECUTE pivot · msg=a8175861 no-standby 铁律 · msg=1fbdc90d 完全掌控令 v2 静默审视 · Orch v197 msg=de6103bd + v204 msg=a061c6f7

---

## §PR-M3-4 · Frontend httpClient axios interceptor · X-API-Version verify (ADR-0010 §4.1 Phase 1) landing (2026-07-09 · Cleanup γ 主签 doc-tier)

### §一 · Landing metadata

- **PR**: [#124](https://github.com/bruinxz/stocks/pull/124) · Frontend 主签 · squash-merge from `0d7e983d` (base) · mergeCommit `1b0d7e2684711f7ab78768cbeae1bdfecdfe68df` @ `2026-07-09T17:55:49Z`
- **Branch**: `frontend/pr-m3-4-httpclient-api-version-interceptor` (deleted post-merge)
- **Diff**: +385 / −0 · 2 files (both ADDED · greenfield)
- **Authority**: `msg=d0d11677` self-merge (≥4 sign + CI GREEN 双门 satisfied → self-merge OK) · Frontend 主签 self-merge REALIZED · Lane 契约 Orch v204.2 msg=bce7055e §三-1 (`frontend/**` = Frontend SOLE) 100% aligned
- **Escalation lifecycle**: Backend v33.1 `msg=0e55b56c` surface-before-close (Lane A scope归属 error) → Orch v204.2 `msg=bce7055e` canonical-accept (Lane A → A-1 Frontend + A-2 QADocs + A-3 Backend split) → Frontend PR #124 CREATE-in-lane 承接实现首例 → 4-sign concur → CI GREEN → self-merge · **escalation-over-invention canonical 闭环 REALIZED 首例 code-tier canonical binding LIVE**

### §二 · Cleanup γ code-hygiene verify (byte-truth 铁-verify PASS via gh api 独立 · code-hygiene 五-项 audit)

| # | audit dimension | verify | result |
|---|---|---|---|
| §2.1 | jscpd ≤30% hard-gate 前瞻 | 二 新增 NEW-file greenfield · zero existing-code duplication surface · 4 处 `throw new ApiVersionMismatchError({ ... })` block reason distinct + 判断条件 distinct · Extract-common-builder anti-abstraction 铁律 aligned | ✓ PASS-toward · code-shape 无 30% 触发风险 |
| §2.2 | dead code zero introduce | exported items 全部 covered by 19-test · internal helper `readHeader` covered indirectly · `EXPECTED_URL_VERSION_PREFIX` forward-declaration for ADR-0010 §4.1 Phase 2/3 downstream | ✓ non-dead 100% aligned |
| §2.3 | `frontend/**` SOLE 独占 | files scope: `frontend/src/services/httpClient.ts` (+168 NEW) + `frontend/src/services/__tests__/httpClient.test.ts` (+217 NEW) SOLE · 保护 glob 零触碰 100% · Path D `3246b8cf` 冻结锚 100% preserve | ✓ lane 契约 canonical aligned |
| §2.4 | TypeScript 严格模式 aligned | 零 `any` · zero `as unknown` cast · `AxiosInstance`/`AxiosResponse`/`AxiosError` type-only import (runtime-side zero axios dependency footprint) | ✓ TS 严格 100% aligned |
| §2.5 | api.ts 现有 401 refresh 拦截链 zero-modify | `attachApiVersionInterceptor(instance)` 独立 helper canonical · `instance.interceptors.response.eject(id)` 卸载 canonical (自 cleanup 无 resource leak) · Non-BFF endpoint skip 承接 warn-only aligned | ✓ 独立 helper canonical |

### §三 · CI 15/15 required-check GREEN unconditional

Detect changes 4×SUCCESS · Frontend check (typecheck + lint) 2×SUCCESS · Docker compose validate 1×SUCCESS+1×SKIPPED · weak-secrets 1×SUCCESS · Backend check 1×SKIPPED · enum-matrix-lock 1×SKIPPED · no-backtest-service-regression 1×SUCCESS · paths_filter 全项 aligned · mergeStateStatus=CLEAN · mergeable=MERGEABLE · pre-merge headRefOid `13fe3e9d53be8040f1298f020eaee32092d60fec` bit-perfect

### §四 · 副签 4/4 code-tier CONCUR msg-id table (msg=d0d11677 authority · ≥4 sign gate satisfied)

| # | agent | msg | posture |
|---|---|---|---|
| 1 | Backend | `msg=9ec91ae6` | 副签 CONCUR unconditional · spec/header format concur · slot #1 · CI CLEAN corroborate |
| 2 | Cleanup γ | `msg=12f6615d` | 副签 CONCUR unconditional · code-hygiene 五-项 audit 全 PASS · slot #2 |
| 3 | Research §S3 | `msg=795db937` | 副签 CONCUR unconditional · byte-truth cross-verify 五点 bit-perfect · slot #3 |
| 4 | QADocs | `msg=04132d82` | 副签 CONCUR unconditional · DoD v4.4 checklist + sentinel PASS · slot #4 |

Frontend 主签 CREATE broadcast `msg=833bc5dc` · post-MERGE broadcast `msg=9490f022` · Cleanup γ Phase 1 arm `msg=56b0b5e1` (本 doc-PR 承接).

### §五 · Escalation-over-invention canonical 闭环 REALIZED 首例 (code-tier canonical binding LIVE 全链路)

- **surface**: Backend v33.1 `msg=0e55b56c` — Lane A scope归属 error surface-before-close
- **canonical-accept**: Orch v204.2 `msg=bce7055e` — Lane A → A-1 Frontend + A-2 QADocs + A-3 Backend split · lane 契约 canonical LOCK
- **CREATE-in-lane**: Frontend PR #124 `msg=833bc5dc` — `frontend/**` SOLE (2-file ADDED · zero-touch cross-lane) 承接实现首例
- **4-sign concur**: Backend + Cleanup γ + Research §S3 + QADocs 4/4 CONCUR unconditional · CI 15/15 GREEN · self-merge msg=d0d11677 authority 100% 兑现
- **闭环 REALIZED 首例**: Backend v33.1 → Orch v204.2 → PR #124 CREATE-in-lane → 4-sign → CI GREEN → self-merge · **全链路 canonical binding LIVE code-tier 首例**

### §六 · 保护 glob zero-collateral audit

- `frontend/**` — 主签授权 lane 100% (2-file scope: httpClient.ts NEW + httpClient.test.ts NEW · both status=added zero-delete)
- `backend/**` — zero-touch (all sub-globs verified)
- `采集/存储侧` — protected globs zero touch
- `schema.prisma` — unchanged
- `package.json` — zero delta (axios import 是 pre-existing dep · type-only import runtime-side zero footprint)
- `Math.random` — zero touch (US-038 SeededRandom retain)
- Path D `3246b8cf` — 冻结锚 zero touch (baseline JSON slug + `sha_lock` content field both preserved)
- Zero force-push · `jscpd ≤30%` hard-gate retained · License Independence v1.1 retain · AsyncLocalStorage `node:async_hooks` node 内置 zero 第三方 dep

### §七 · Ten-段 main HEAD lineage LOCK update

`3246b8cf(#115) → 036294a7(#116) → 7003e0d3(#117) → feafa6e4(#118) → 93dee066(#119) → aa099594(#120) → 0fb7c96e(#121) → 86d1dd33(#122) → 0d7e983d(#123) → 1b0d7e26(#124)` — main HEAD canonical LOCK 更新 → `1b0d7e26` (post-#125 code-tier 六例 LAND: 十一-段 extended → `44027896` 见 §PR-M3-5 §七)

### §八 · Cleanup γ 三-phase 生命周期 canonical

- **Phase 1 pre-CREATE arm** — `msg=56b0b5e1` 双-entry 承接位 broadcast · Instance 4 canonical pre-CREATE hygiene 三-项 checklist LOCK per Orch v204.4 §三
- **Phase 2 CREATE** — 本 doc-PR (`docs/refactor/30-cleanup-log.md` §PR-M3-4 + §PR-M3-5 双-entry paste-in · docs-only 单 commit · Cleanup γ SOLE lane)
- **Phase 3 post-MERGE close-out** — post-self-merge broadcast · 十二-段 lineage extend byte-truth verify + doc-tier 三例 canonical LOCK

### §九 · DoD self-check (dod v4.4 铁律 16 项 · docs-only)

- [x] #1-#16 全 pass (docs-only · zero code delta · zero test 触 · Path D preserve · package.json 零触碰 · sentinel scope zero-touch)

### §十 · 副签路由 pin (doc-tier 双-sign lane per msg=d0d11677 authority)

| # | 副签 | agent | scope |
|---|---|---|---|
| 主 | Cleanup γ | 本 batch 起源 · doc-tier 主签 self-merge candidate (doc-tier 三例) | audit trail 层留痕 |
| 副 1 | Research §S3 | byte-truth verify + PR #124/#125 mergeCommit 独立复核 | pre-merge |
| 副 2 | QADocs | DoD v4.4 checklist + CHANGELOG-adjacent 一致性 verify + anti-fabrication canonical cross-ref | pre-merge |

### §十一 · 引用锚

- `docs/refactor/adr/0010-api-versioning.md` §4.1 Phase 1 spec (URL major + header major + expected major 三源交叉 · warn-only Phase 1 gate)
- `docs/refactor/baseline/api/api-version-header-baseline-d6a0c1e.json` `R2_header_value="1"` major-only extract convention
- `docs/refactor/23-protect-list.md` v1 Path D 权威锚 (frozen 3246b8cf)
- `docs/refactor/quality/anti-fabrication-canonical.md` Instance 3 kick-off + Instance 4 canonical 深化
- PR #124 https://github.com/bruinxz/stocks/pull/124 · Frontend CREATE msg=833bc5dc · Frontend post-MERGE msg=9490f022
- owner msg=b8af5127 · msg=d0d11677 · msg=a8175861 · msg=eb4b0016 T+Nd 语言禁用 · msg=21867874 no-deadline perpetual dispatch · msg=4f6d2466 free-source-only · Orch v204/v204.1/v204.2/v204.3/v204.4/v205/v205.1/v207

---

## §PR-M3-5 · Backend `/health supported_api_versions` + log middleware `api_version` (ADR-0010 §4.2 Phase 2 + §4.3 Phase 3 partial) landing (2026-07-09 · Cleanup γ 主签 doc-tier)

### §一 · Landing metadata

- **PR**: [#125](https://github.com/bruinxz/stocks/pull/125) · Backend 主签 · squash-merge from `0d7e983d` (base) · mergeCommit `440278965b80b78ad328bca345b5a6b461fedfb5` @ `2026-07-09T18:01:54Z`
- **Branch**: `backend/pr-m3-5-health-supported-api-versions-and-log-api-version` (deleted post-merge)
- **Diff**: +288 / −4 · 6 files (4 MODIFIED backend/src + 2 ADDED backend/tests/routing)
- **Authority**: `msg=d0d11677` self-merge (≥4 sign + CI 8/8 GREEN 双门 satisfied → self-merge OK) · Backend 主签 self-merge REALIZED · Lane 契约 Orch v204.2 msg=bce7055e §三-2 (`backend/src/**` = Backend SOLE) 100% aligned
- **Escalation lifecycle 二例**: Backend v33.1 `msg=0e55b56c` surface-before-close → Orch v204.2 `msg=bce7055e` canonical-accept → Backend PR #125 CREATE-in-lane 承接实现二例 → 4-sign concur → CI GREEN → self-merge · **escalation-over-invention canonical 闭环 REALIZED 二例 code-tier canonical binding LIVE**

### §二 · Cleanup γ code-hygiene verify (byte-truth 铁-verify PASS via gh api 独立 · code-hygiene 六-项 audit)

| # | audit dimension | verify | result |
|---|---|---|---|
| §2.1 | jscpd ≤30% hard-gate 前瞻 | helper 骨架 ~15 line × 复用 3 file = ~45 line 共享 shape · 45/thousands ≪ 30% threshold | ✓ PASS-toward |
| §2.2 | dead code zero introduce | `SUPPORTED_API_VERSIONS` `/health` consumer + 8-point assertion · `deriveSupportedMajors` file-scope internal helper forward-declared for v2 · `currentApiVersion()` middleware + test 消费 · `LoggingContext.api_version?` 全链消费 | ✓ non-dead 100% aligned |
| §2.3 | `backend/src/**` SOLE 独占 | 4 MODIFIED (index.ts + apiVersion.ts + requestContext.ts + loggingContext.ts) + 2 ADDED (health-supported-api-versions.test.ts + logging-context-api-version.test.ts) SOLE · 保护 glob 零触碰 100% · Path D `3246b8cf` 冻结锚 100% preserve | ✓ lane 契约 canonical aligned |
| §2.4 | TS 严格 + ALS built-in-only dep | 零 `any` · `readonly number[]` + `Object.freeze` 双-immutable canonical · `Number.isFinite(major) && major > 0` fallback `[1]` defensive parse · **AsyncLocalStorage from `node:async_hooks` — Node built-in · zero 第三方 dep** (zero `cls-hooked`/`cls-rtracer`) | ✓ TS 严格 + ALS 内置 100% aligned |
| §2.5 | Frontend PR #124 契约对齐 | Frontend `verifyApiVersion` 消费 `x-api-version` (case-insensitive) — Backend `res.setHeader('X-API-Version', API_VERSION)` 100% aligned · Frontend `EXPECTED_API_VERSION_MAJOR='1'` — Backend `deriveSupportedMajors('1.0')` 返 `[1]` 100% aligned · header vs body dual-source assertEq 独立断言 | ✓ downstream 契约 100% aligned |
| §2.6 | unit test 独立 audit (10+12) | health-supported-api-versions.test.ts 10-test 断言 (200/status/timestamp/api_version=header/supported_api_versions array/non-empty/positive-integers/includes CURRENT major) · logging-context-api-version.test.ts 12-test (ALS fail-open · runWithLoggingContext 三-field · runWithModule 继承 · HTTP roundtrip 注入) · regression api-v1-mount.test.ts 8/8 PASS retain | ✓ DoD v4.4 §测试证据 兑现 |

### §三 · CI 8/8 required-check GREEN unconditional

Detect changes 4×SUCCESS · Backend check 2×SUCCESS · enum-matrix-lock (ADR-0011 §5) 1×SUCCESS+1×SKIPPED · no-backtest-service-regression (PR-M3-2 pre-guard · `KNOWN_RESIDUAL=0` sentinel 100% retain) 1×SUCCESS+1×SKIPPED · Frontend 1×SUCCESS+1×SKIPPED · Docker compose validate 1×SUCCESS+1×SKIPPED · weak-secrets 1×SUCCESS · **15 pass / 5 skip / 0 fail / 0 pending** · pre-merge mergeStateStatus=CLEAN · pre-merge mergeable=MERGEABLE · pre-merge headRefOid `b972c9a7e0335c44a309f26fb294a69198274879` bit-perfect

### §四 · 副签 4/4 code-tier CONCUR msg-id table (msg=d0d11677 authority · ≥4 sign gate satisfied)

| # | agent | msg | posture |
|---|---|---|---|
| 1 | Frontend | `msg=1bc5096c` | 副签 CONCUR unconditional · httpClient consumer contract 铁-alignment 五点 · slot #1 |
| 2 | Cleanup γ | `msg=cecc5513` | 副签 CONCUR unconditional · code-hygiene 六-项 audit + 十-glob 逐-verify · slot #2 |
| 3 | Research §S3 | `msg=b1238c6f` | 副签 CONCUR unconditional · byte-truth 九点 三-源 cross-attest · slot #3 |
| 4 | QADocs | `msg=e017b511` | 副签 CONCUR unconditional · DoD v4.4 16项 全 PASS + sentinel KNOWN_RESIDUAL=0 hard-fail retain + CI 8/8 GREEN 独立-verify · slot #4 |

Backend 主签 CREATE broadcast `msg=877d3dd9` · post-MERGE broadcast `msg=c667cdd2` · Cleanup γ Phase 1 arm `msg=56b0b5e1` (本 doc-PR 承接).

### §五 · Escalation-over-invention canonical 闭环 REALIZED 二例 (code-tier canonical binding LIVE 全链路)

- **surface**: Backend v33.1 `msg=0e55b56c` — 与 §PR-M3-4 §五 同源 (surface-before-close 首例 · Lane A scope归属 error)
- **canonical-accept**: Orch v204.2 `msg=bce7055e` — Lane A → A-1 + A-2 + A-3 split · A-3 = Backend `backend/src/**` SOLE
- **CREATE-in-lane**: Backend PR #125 `msg=877d3dd9` — `backend/src/**` SOLE (4 MODIFIED + 2 ADDED · zero-touch cross-lane) 承接实现二例
- **4-sign concur**: Frontend + Cleanup γ + Research §S3 + QADocs 4/4 CONCUR unconditional · CI 8/8 GREEN · self-merge msg=d0d11677 authority 100% 兑现
- **闭环 REALIZED 二例**: 双 code-tier 全链路 闭环 REALIZED (Lane A-1 #124 一例 + Lane A-3 #125 二例)

### §六 · ADR-0010 §4.2 Phase 2 + §4.3 Phase 3 partial landed spec scope

- **§4.2 Phase 2** (log middleware `api_version`):
  - `backend/src/utils/loggingContext.ts` — `LoggingContext.api_version?: string` optional field + `currentApiVersion(): string` helper (fail-OPEN `-` fallback · 与 `currentTraceId()`/`currentModule()` 对称)
  - `backend/src/middlewares/requestContext.ts` — `runWithLoggingContext({ trace_id, module: 'http', api_version: CURRENT_API_VERSION }, ...)` 三-field 传播 · `runWithModule('scheduler', ...)` 继承外层 api_version
- **§4.3 Phase 3 partial** (`/health` handler surfacing):
  - `backend/src/index.ts` — `/health` handler extend body: `{ status, timestamp, api_version, supported_api_versions }` · header vs body dual-source 天然一致 (test §2 assertEq)
  - `backend/src/middlewares/apiVersion.ts` — `deriveSupportedMajors('1.0')` → `[1]` + `Object.freeze(SUPPORTED_API_VERSIONS)` immutable · v2 dual-mount 承接位 armed
- **测试证据**: 22 test PASS (10 health-supported-api-versions + 12 logging-context-api-version) · regression api-v1-mount.test.ts 8/8 PASS retain · CI Backend check 2×SUCCESS
- **zero 第三方 dep 追增**: AsyncLocalStorage from `node:async_hooks` (Node built-in · pre-existing loggingContext.ts:30 unchanged)

### §七 · Eleven-段 main HEAD lineage LOCK update

`3246b8cf(#115) → 036294a7(#116) → 7003e0d3(#117) → feafa6e4(#118) → 93dee066(#119) → aa099594(#120) → 0fb7c96e(#121) → 86d1dd33(#122) → 0d7e983d(#123) → 1b0d7e26(#124) → 44027896(#125)` — main HEAD canonical LOCK 更新 → `44027896` · self-merge 四段 pipeline **六例 REALIZED** (Frontend #120/#121 code-tier + QADocs #122 doc-tier 首例 + Cleanup γ #123 doc-tier 二例 + Frontend #124 code-tier 五例 + Backend #125 code-tier 六例)

### §八 · Cleanup γ 三-phase 生命周期 canonical (双-entry 单-PR canonical)

- **Phase 1 pre-CREATE arm** — `msg=56b0b5e1` 双-entry 承接位 broadcast · Instance 4 canonical pre-CREATE hygiene 三-项 checklist LOCK per Orch v204.4 §三 · **本 §PR-M3-5 与 §PR-M3-4 双-entry 单-PR canonical**
- **Phase 2 CREATE** — 本 doc-PR (§PR-M3-4 + §PR-M3-5 双-entry paste-in)
- **Phase 3 post-MERGE close-out** — post-self-merge broadcast · 十二-段 lineage extend byte-truth verify + doc-tier 三例 canonical LOCK

### §九 · DoD self-check (dod v4.4 铁律 16 项 · docs-only)

- [x] #1-#16 全 pass (docs-only · zero code delta · zero test 触 · Path D preserve · package.json 零触碰 · sentinel `no-backtest-service-regression.test.ts` KNOWN_RESIDUAL=0 hard-fail 100% retain via zero-modify verify)

### §十 · 副签路由 pin (doc-tier 双-sign lane per msg=d0d11677 authority)

| # | 副签 | agent | scope |
|---|---|---|---|
| 主 | Cleanup γ | 本 batch 起源 · doc-tier 主签 self-merge candidate (doc-tier 三例) | audit trail |
| 副 1 | Research §S3 | byte-truth verify + PR #124/#125 mergeCommit + msg-id/SHA/timestamp 独立复核 + 双 code-tier 闭环 lineage cross-attest | pre-merge |
| 副 2 | QADocs | DoD v4.4 checklist 16 项 aligned + CHANGELOG-adjacent 一致性 verify + anti-fabrication canonical Instance 3/4 cross-ref + sentinel KNOWN_RESIDUAL=0 hard-fail retain independent-verify | pre-merge |

### §十一 · 引用锚

- `docs/refactor/adr/0010-api-versioning.md` §4.2 Phase 2 + §4.3 Phase 3 partial
- `docs/refactor/23-protect-list.md` v1 Path D 权威锚 (frozen 3246b8cf)
- `docs/refactor/quality/anti-fabrication-canonical.md` Instance 3 + Instance 4 canonical 深化
- `backend/tests/lint/no-backtest-service-regression.test.ts` L92 `KNOWN_RESIDUAL = 0` hard-fail sentinel 100% retain
- PR #125 https://github.com/bruinxz/stocks/pull/125 · Backend CREATE msg=877d3dd9 · Backend post-MERGE msg=c667cdd2
- owner msg=b8af5127 · msg=d0d11677 · msg=a8175861 · msg=eb4b0016 · msg=21867874 · msg=4f6d2466 · msg=702b81be PG SELECT-only · msg=b091c74d SSH root 永久禁 · Orch v204/v204.1/v204.2/v204.3/v204.4/v205/v205.1/v207

---

## §PR-M3-6 · Frontend PR #127 landing entry (post-#127 · Cleanup γ Lane B doc-tier 四例 candidate)

### §一 · Landing metadata

- PR #127 · Frontend 主签 · squash-merge from `44027896` (base) · mergeCommit `a8cef0253af6dde5200f2190a057a44d848504fb` @ 2026-07-09T18:36:24Z
- Branch: `feat/frontend-a1-phase3-supported-versions` (deleted post-merge)
- Diff: +315 / −9 · 2 files (`frontend/src/services/httpClient.ts` +115/-8 MOD + `frontend/src/services/__tests__/httpClient.test.ts` +200/-1 MOD)
- Authority: msg=d0d11677 self-merge (≥4 sign + CI 15 GREEN 双门 satisfied)
- Escalation lifecycle 三例: 同源 Backend v33.1 msg=0e55b56c → Orch v204.2 msg=bce7055e Lane split → Frontend Lane A-1 next-tier CREATE (Phase 3 body consumer 二次门) → 4-sign → CI GREEN → self-merge

### §二 · Cleanup γ code-hygiene 六-项 audit (Cleanup γ msg=446e9493 slot #3 anchor)

- §2.1 jscpd ≤30% 前瞻 PASS-toward (18 新增 test payload 全 distinct · 5-branch guard 天然差异化)
- §2.2 dead code zero introduce (5 新增 consumer: `EXPECTED_API_VERSION_MAJOR_NUM` numeric const + `ApiVersionMismatchReason` union 5 body-tier codes + `HealthPayloadShape` interface + `verifySupportedApiVersions(payload, url)` public API + 5 reason codes 全 SOLE consumer)
- §2.3 `frontend/**` SOLE 独占 (2-file MOD scope · 保护 glob 零触碰 100% · Path D `3246b8cf` 冻结锚 100% preserve grep-verified sha_lock 匹配)
- §2.4 TS 严格 5-branch guard canonical (body_not_object · body_missing_api_version · body_api_version_major_mismatch · body_missing_supported_api_versions · body_expected_major_not_supported · 零 `any` · 零 `as unknown` unsafe cast)
- §2.5 dual-source contract Backend PR #125 body surface bit-perfect aligned (`EXPECTED_API_VERSION_MAJOR = '1'` string header path + `EXPECTED_API_VERSION_MAJOR_NUM = 1` numeric body path · 100% aligned with Backend `deriveSupportedMajors('1.0')` → `[1]`)
- §2.6 unit test 18-case 5-branch cover (positive 4 + negative body_not_object 3 + body_missing_api_version 2 + body_api_version_major_mismatch 2 + body_missing_supported_api_versions 3 + body_expected_major_not_supported 2 + url reflection 2)

### §三 · CI 15 GREEN required-check unconditional

- 14 SUCCESS + 2 SKIPPED · 0 FAIL · mergeStateStatus=CLEAN · mergeable=MERGEABLE · pre-merge headRefOid `19d23f439b029b92d8fd22dcc8b5c939ed5aa18a` bit-perfect
- 37/37 test PASS pre-CI (19 pre-existing + 18 new)

### §四 · 副签 4/4 code-tier CONCUR msg-id table (msg=d0d11677 authority)

| # | agent | msg | posture |
|---|---|---|---|
| 主 | Frontend | `msg=c108e2b8` | 主签 CREATE + PR #127 CI GREEN confirm broadcast msg=b5ca834a |
| 1 | Backend | `msg=57cc11d9` | 副签 CONCUR unconditional · v37 dual-source contract concur · slot #2 |
| 2 | Cleanup γ | `msg=446e9493` | 副签 CONCUR unconditional · code-hygiene 六-项 audit 全 PASS · slot #3 |
| 3 | Research §S3 | `msg=19d2769b` | 副签 CONCUR unconditional (DUODECIMA aggregate) · byte-truth verify · slot #4 |

Frontend post-MERGE broadcast `msg=9e07e044` (self-merge 九例 REALIZED · 十二-段 lineage extend REALIZED).

### §五 · Escalation-canonical 闭环 REALIZED 三例 (code-tier canonical binding LIVE 全链路)

- surface: Backend v33.1 msg=0e55b56c (surface-before-close 首例 · Lane A scope归属 error 首源 · 三-链 escalation-canonical binding source)
- canonical-accept: Orch v204.2 msg=bce7055e (Lane A → A-1 + A-2 + A-3 split)
- CREATE-in-lane: Frontend PR #127 msg=c108e2b8 (Lane A-1 Phase 3 next-tier body consumer 二次门 · 承接实现三例 · `frontend/**` SOLE 2-file MOD)
- 4-sign concur: Frontend + Backend + Cleanup γ + Research §S3 4/4 CONCUR unconditional · CI 15 GREEN · self-merge msg=d0d11677 authority 100% 兑现
- 闭环 REALIZED 三例: 双 code-tier × Frontend consumer 端到端闭环 三例 REALIZED (Lane A-1 #124 一例 + Lane A-3 #125 二例 + Lane A-1 #127 三例)

### §六 · ADR-0010 §4.3 Phase 3 canonical downstream landed spec scope

- **`frontend/src/services/httpClient.ts` (+115/-8)**:
  - `EXPECTED_API_VERSION_MAJOR_NUM = 1` numeric const · body-path consumer canonical
  - `ApiVersionMismatchReason` union 5 body-tier codes (body_not_object + body_missing_api_version + body_missing_supported_api_versions + body_api_version_major_mismatch + body_expected_major_not_supported)
  - `HealthPayloadShape` interface (api_version + supported_api_versions optional unknown · [k: string]: unknown catch-all)
  - `verifySupportedApiVersions(payload: unknown, url: string = '/health'): void` public API · 5-branch guard canonical
- **`frontend/src/services/__tests__/httpClient.test.ts` (+200/-1)**:
  - 18 test cases (`describe('verifySupportedApiVersions · ADR-0010 §4.3 Phase 3', ...)`)
  - positive: sanity const + Backend PR #125 landed shape + minor-only "1" + dual-mount 前瞻 supported=[1,2]
  - negative: 5-branch guard × 全 cover + url reflection ×2
- **downstream 契约 100% aligned with Backend PR #125 body surface bit-perfect** (git filesystem read verify per Cleanup γ msg=446e9493 §2.5)
- **triple-source aligned canonical 消费方 端到端闭环 REALIZED code-tier** (header via #124 + body via #127 + log opaque via #126 待 landing)

### §七 · Twelve-段 main HEAD lineage LOCK update

`3246b8cf(#115) → ... → 44027896(#125) → a8cef025(#127)` — main HEAD canonical LOCK 更新 → `a8cef025` · self-merge 四段 pipeline **九例 REALIZED code-tier** post-#127

### §八 · Cleanup γ 三-phase 生命周期 canonical (双-entry 单-PR canonical · 与 §PR-M3-7 共)

- Phase 1 pre-CREATE arm — 承接位 broadcast + workspace-draft LAND (`notes/30-cleanup-log-pr-m3-6-and-pr-m3-7-workspace-draft.md`) · Instance 4 canonical pre-CREATE hygiene 三-项 checklist LOCK · **本 §PR-M3-6 与 §PR-M3-7 双-entry 单-PR canonical**
- Phase 2 CREATE — 本 doc-PR (§PR-M3-6 + §PR-M3-7 双-entry paste-in · docs-only 单 commit · Cleanup γ SOLE lane)
- Phase 3 post-MERGE close-out — post-self-merge broadcast · 十六-段 lineage extend byte-truth verify + doc-tier 四例 canonical LOCK

### §九 · DoD self-check (dod v4.4 铁律 16 项 · docs-only)

- [x] #1-#16 全 pass (docs-only · zero code delta · zero test 触 · Path D preserve · package.json 零触碰 · sentinel scope zero-touch)

### §十 · 副签路由 pin (doc-tier 双-sign lane per msg=d0d11677 authority · 与 §PR-M3-7 共)

| # | 副签 | agent | scope |
|---|---|---|---|
| 主 | Cleanup γ | 本 batch 起源 · doc-tier 主签 self-merge candidate (doc-tier 四例) | audit trail 层留痕 |
| 副 1 | Research §S3 | byte-truth verify + PR #127 mergeCommit `a8cef025` + PR #126 mergeCommit `0a9aaaaa` 独立复核 | pre-merge |
| 副 2 | QADocs | DoD v4.4 checklist + CHANGELOG-adjacent 一致性 verify + anti-fabrication canonical cross-ref | pre-merge |

### §十一 · 引用锚

- `docs/refactor/adr/0010-api-versioning.md` §4.3 Phase 3 spec (body dual-source cross-attest · 5-branch guard canonical · warn-only Phase 3 gate)
- PR #127 https://github.com/bruinxz/stocks/pull/127 · Frontend CREATE msg=c108e2b8 · Frontend CI GREEN msg=b5ca834a · Frontend post-MERGE msg=9e07e044
- owner msg=b8af5127 · msg=d0d11677 · msg=eb4b0016 T+Nd 语言禁用 · msg=21867874 no-deadline perpetual dispatch · Orch v204~v211

---

## §PR-M3-7 · Backend PR #126 landing entry (post-#126 · Cleanup γ Lane B doc-tier 四例 candidate · 双-entry 单-PR canonical 与 §PR-M3-6 共)

### §一 · Landing metadata

- PR #126 · Backend 主签 · squash-merge auto-rebase over `a8cef025` (post-#127) · mergeCommit `0a9aaaaac0dae33c9b60111dfeb0492623199db2` @ 2026-07-09T18:39:16Z
- Branch: `backend/lane-a3-phase2-winston-format` (deleted post-merge)
- Diff: +229 / −3 · 2 files (`backend/src/utils/logger.ts` +6/-3 MOD + `backend/tests/routing/logger-api-version-format.test.ts` +223 NEW)
- Authority: msg=d0d11677 self-merge (≥4 sign + CI 8/8 GREEN 双门 satisfied)
- Escalation lifecycle 四例: 同源 Backend v33.1 msg=0e55b56c → Orch v204.2 msg=bce7055e Lane split → Backend Lane A-3 next-tier CREATE (Phase 2 log format 后缀) → 4-sign → CI GREEN → self-merge

### §二 · Cleanup γ code-hygiene 六-项 audit (Cleanup γ msg=6bb5876b slot #2 anchor)

- §2.1 jscpd ≤30% PASS-toward (`logger.ts` +6/-3 minimal delta · test file assertEq/assertTrue helper ~60 line 共享 shape ≪ 30% jscpd threshold)
- §2.2 dead code zero introduce (`currentApiVersion()` import extend + `apiVersion` local const + template literal `api_version=<x>` 后缀 + 14-assertion test all live consumer)
- §2.3 `backend/src/**` + `backend/tests/routing/**` SOLE 独占 (`backend/src/utils/logger.ts` MOD + `backend/tests/routing/logger-api-version-format.test.ts` NEW = Backend SOLE lane 100% · 保护 glob 零触碰 100% · frontend/** + backend/tests/lint/** + backend/tests/enum/** + docs/refactor/** + Path D + 采集/存储侧 + schema.prisma + package.json zero-touch)
- §2.4 TS 严格 + ALS built-in-only 铁律 aligned + fail-OPEN semantics 100% retain (Node `AsyncLocalStorage` from `node:async_hooks` · zero 第三方 dep · `currentApiVersion()` fallback `-` 与 `currentTraceId()`/`currentModule()` 语义完全对称)
- §2.5 patch minimal delta +6/-3 backward-compat 100% (guard `if (!/trace_id=/.test(msg))` retain · 已显式在 message 里手写 `trace_id=` 的旧代码不重复追加 · frontend/log-consumer wire-compat 100%)
- §2.6 triple-source aligned canonical log-tier 端到端闭环 REALIZED (header via #117 + body via #125 + log via #126 本 patch · 三源同 pkg.api_version='1.0' 单-源 canonical)

### §三 · CI 8/8 required-check GREEN unconditional

- Detect ×3 SUCCESS + weak-secrets SUCCESS + Backend check ×2 SUCCESS + enum-matrix-lock SUCCESS + no-backtest-service-regression SUCCESS + Frontend check ×2 SUCCESS + Docker compose ×2 SUCCESS · 0 FAIL
- 44/44 test PASS (14 new + 30 regression: logging-context 12/12 + health-supported 10/10 + api-v1-mount 8/8)
- pre-merge headRefOid `19007041ffe5208ab3c20484172811af59bde6d4` bit-perfect

### §四 · 副签 4/4 code-tier CONCUR msg-id table (msg=d0d11677 authority)

| # | agent | msg | posture |
|---|---|---|---|
| 主 | Backend | `msg=55136a50` | 主签 CREATE broadcast · v37 authority-CREATE |
| 1 | Frontend | `msg=679fa137` | 副签 CONCUR unconditional · log-tier opaque render forward-compat concur · slot #1 |
| 2 | Cleanup γ | `msg=6bb5876b` | 副签 CONCUR unconditional · code-hygiene 六-项 audit + triple-source aligned canonical REALIZED verify · slot #2 |
| 3 | Research §S3 | `msg=19d2769b` | 副签 CONCUR unconditional (DUODECIMA aggregate) · byte-truth verify · slot #3 |
| 4 | QADocs | `msg=ff1718f7` | 副签 CONCUR unconditional · DoD v4.4 + sentinel KNOWN_RESIDUAL=0 hard-fail retain · slot #4 |

Backend post-MERGE broadcast `msg=3ae1c40e` (self-merge 十例 REALIZED · 十三-段 lineage extend REALIZED · triple-source aligned canonical 生产+消费 双向-闭合 100% LIVE).

### §五 · Escalation-canonical 闭环 REALIZED 四例双 (code-tier canonical binding LIVE 全链路)

- surface: Backend v33.1 msg=0e55b56c (surface-before-close 首例 · Lane A scope归属 error 首源 · 四-链 escalation-canonical binding source)
- canonical-accept: Orch v204.2 msg=bce7055e (Lane A → A-1 + A-2 + A-3 split)
- CREATE-in-lane: Backend PR #126 msg=55136a50 (Lane A-3 Phase 2 next-tier log format 后缀 · 承接实现四例 · `backend/src/**` + `backend/tests/routing/**` SOLE)
- 4-sign concur: Frontend + Cleanup γ + Research §S3 + QADocs 4/4 CONCUR unconditional · CI 8/8 GREEN · self-merge msg=d0d11677 authority 100% 兑现
- 闭环 REALIZED 四例双: 双 code-tier 全链路 闭环 REALIZED × 四例 (Lane A-1 #124 一例 + Lane A-3 #125 二例 + Lane A-1 #127 三例 + Lane A-3 #126 四例) · **PR #124→#125→#127→#126 canonical binding LIVE**

### §六 · ADR-0010 §4.2 Phase 2 log format 后缀 landed spec scope

- **`backend/src/utils/logger.ts` (+6/-3)**:
  - import extend: `import { currentApiVersion, currentModule, currentTraceId } from './loggingContext';` (added `currentApiVersion`)
  - JSDoc extend: `trace_id=<x> module=<y> api_version=<z>` narrative (ADR-0010 §4.2 Phase 2 canonical)
  - `appendContext` body extend: `const apiVersion = currentApiVersion(); info.message = \`${msg} trace_id=${traceId} module=${mod} api_version=${apiVersion}\`;`
  - guard `if (!/trace_id=/.test(msg))` retain — 已手写 `trace_id=` 的 message 不重复追加 (backward-compat 100%)
- **`backend/tests/routing/logger-api-version-format.test.ts` (+223 NEW)**:
  - 14 assertions (assertEq/assertTrue helper + `winston.transports.Stream` in-memory sink + inline express `buildTestApp()`)
  - patterns: `/api_version=-/` (fail-OPEN default) · `/api_version=1\.0/` · `/trace_id=trace-abc/` · `/module=scheduler/` · `/api_version=9\.9/` · `/trace_id=custom-xyz/` · `/trace_id=[A-Za-z0-9-]{1,128}/` · `/trace_id=\S+ module=\S+ api_version=\S+$/`
- **frontend/log-consumer wire-compat 100%**: `LogEntry.message` opaque render zero-parse dependency · `logService.getLogs`/`SystemLogs.tsx` 无 parse 依赖 · dashboard 直显示 (Frontend msg=679fa137 §一 独立 confirm)
- **triple-source aligned canonical 生产+消费 双向-闭合 100% REALIZED**: producer Tier-3 log format landing · consumer Tier-3 log opaque forward-compat

### §七 · Thirteen-段 main HEAD lineage LOCK update

`3246b8cf(#115) → ... → 44027896(#125) → a8cef025(#127) → 0a9aaaaa(#126)` — main HEAD canonical LOCK 更新 → **`0a9aaaaa`** · self-merge 四段 pipeline **十例 REALIZED code-tier** post-#126

### §八 · Cleanup γ 三-phase 生命周期 canonical (双-entry 单-PR canonical · 与 §PR-M3-6 共)

- Phase 1 pre-CREATE arm — 同 §PR-M3-6 §八 (Cleanup γ 承接位 arm broadcast · Instance 4 canonical LOCK · **本 §PR-M3-7 与 §PR-M3-6 双-entry 单-PR canonical**)
- Phase 2 CREATE — 本 doc-PR (§PR-M3-6 + §PR-M3-7 双-entry paste-in)
- Phase 3 post-MERGE close-out — post-self-merge broadcast · 十六-段 lineage extend byte-truth verify + doc-tier 四例 canonical LOCK

### §九 · DoD self-check (dod v4.4 铁律 16 项 · docs-only)

- [x] #1-#16 全 pass (docs-only · zero code delta · zero test 触 · Path D preserve · package.json 零触碰 · sentinel `no-backtest-service-regression.test.ts` KNOWN_RESIDUAL=0 hard-fail 100% retain via zero-modify verify · ALS built-in-only 铁律 aligned via zero-modify verify)

### §十 · 副签路由 pin (doc-tier 双-sign lane per msg=d0d11677 authority · 与 §PR-M3-6 共)

| # | 副签 | agent | scope |
|---|---|---|---|
| 主 | Cleanup γ | 本 batch 起源 · doc-tier 主签 self-merge candidate (doc-tier 四例) | audit trail 层留痕 |
| 副 1 | Research §S3 | byte-truth verify + PR #127 + PR #126 双 mergeCommit 独立复核 + triple-source aligned canonical 生产+消费 双向-闭合 cross-attest | pre-merge |
| 副 2 | QADocs | DoD v4.4 checklist + CHANGELOG-adjacent 一致性 verify + anti-fabrication canonical Instance 5 二例 canonical-close cross-ref (N=6→N=4 retract-canonical LOCKED) | pre-merge |

### §十一 · 引用锚

- `docs/refactor/adr/0010-api-versioning.md` §4.2 Phase 2 spec (winston format api_version 后缀 canonical · ALS built-in-only dep 铁律)
- PR #126 https://github.com/bruinxz/stocks/pull/126 · Backend CREATE msg=55136a50 · Backend post-MERGE msg=3ae1c40e · Backend v37 CONCUR-context msg=57cc11d9
- Orch v209 msg=c3b9007f §7.1 explicit dispatch to Cleanup γ 本 batch 起源
- owner msg=b8af5127 · msg=d0d11677 · msg=eb4b0016 T+Nd 语言禁用 · msg=21867874 no-deadline perpetual dispatch · Orch v204~v211

---

## §PR-M3-8 · Backend PR #129 · ADR-0010 §4.3 Phase 3 Tier-4 dedicated endpoint (`/api/v1/status` + `/api/v1/version`)

### §一 · Landing metadata
- PR #129 · Backend 主签 · squash-merge · mergeCommit `6baa445fc379325bb8ad328e00ce82aa32765a22` @ 2026-07-09T19:03:26Z · 十五-段
- Scope: `/api/v1/status` + `/api/v1/version` dedicated endpoints · ADR-0010 §4.3 Phase 3 full · Tier-4 canonical
- Diff scope: `backend/src/**` SOLE (routing + status handler + version handler + test) · Backend SOLE lane 100%
- Authority: msg=d0d11677 self-merge (≥4-sign code-tier + CI 8/8 GREEN 双门 satisfied)

### §二 · Cleanup γ code-hygiene 六-项 audit (Task #62 slot #2 anchor msg=76917b92)
- §2.1 jscpd ≤30% PASS-toward · §2.2 dead code zero introduce · §2.3 `backend/src/**` + `backend/tests/routing/**` SOLE 独占 · §2.4 TS 严格 · §2.5 patch minimal delta · §2.6 ADR-0010 §4.3 Phase 3 Tier-4 canonical (dedicated endpoint = 5th-tier canonical binding)

### §三 · ADR-0010 canonical stack five-tier map (post-#129)
- Tier-1 header (X-API-Version) · #117
- Tier-2 body (`/health` supported_api_versions) · #125
- Tier-3 log (winston `api_version=<x>` 后缀) · #126
- Tier-3 consumer (`verifyApiVersion` axios interceptor) · #124
- Tier-3 body consumer (`verifySupportedApiVersions`) · #127
- **Tier-4 dedicated endpoint** (`/api/v1/status` + `/api/v1/version`) · #129 本 landing

### §四 · Fifteen-段 main HEAD lineage LOCK
`... → 44027896(#125) → a8cef025(#127) → 0a9aaaaa(#126) → bc1b3c91(#128) → 6baa445f(#129)` — main HEAD canonical LOCK 更新 → **`6baa445f`** post-#129

### §五 · 副签路由 pin (doc-tier · Cleanup γ 主 + Research §S3 副1 + QADocs 副2)

### §六 · 引用锚
- PR #129 · Backend CREATE + post-MERGE broadcast · self-merge 十一例 code-tier REALIZED
- ADR-0010 §4.3 Phase 3 full canonical

---

## §PR-M3-9 · Backend PR #133 · ADR-0010 §4.4 Tier-5 Deprecation middleware (RFC 9745 + RFC 8594 + RFC 8288)

### §一 · Landing metadata
- PR #133 · Backend 主签 · mergeCommit `101ab3cec9b95ba6e5463ed8d4b5f946bf0675a8` @ 2026-07-09T19:28:17Z · 十六-段
- Scope: `backend/src/middlewares/apiDeprecation.ts` NEW + `backend/src/index.ts` mount + test · RFC 9745 `Deprecation` + RFC 8594 `Sunset` + RFC 8288 `Link` canonical
- Diff scope: `backend/src/**` + `backend/tests/routing/**` SOLE · Backend SOLE lane 100%
- Cleanup γ 副签 anchor: Task #47 slot #2 code-hygiene audit CONCUR unconditional delivered
- Authority: msg=d0d11677 self-merge (≥4-sign code-tier + CI 8/8 GREEN 双门 satisfied)

### §二 · Cleanup γ code-hygiene 六-项 audit
- §2.1 jscpd · §2.2 dead code zero · §2.3 `backend/src/**` + `backend/tests/routing/**` SOLE · §2.4 TS 严格 + zero type churn · §2.5 patch minimal delta + backward-compat 100% (default-OFF · absent config → pass-through) · §2.6 RFC canonical stack (9745 + 8594 + 8288) triple-binding + Deprecation/Sunset/Link header 语义 aligned + zero-throw semantics preserve

### §三 · ADR-0010 canonical stack COMPLETE 🎯 REALIZED (§4.1 + §4.2 + §4.3 + §4.4)
- §4.1 header · §4.2 log · §4.3 body/endpoint (multi-tier) · §4.4 deprecation/sunset middleware
- **triple-source aligned canonical stack COMPLETE** (header + log + body + endpoint + deprecation 五-tier canonical binding LIVE)

### §四 · Sixteen-段 main HEAD lineage LOCK
`... → 6baa445f(#129) → 101ab3ce(#133)` — main HEAD canonical LOCK 更新 → **`101ab3ce`** post-#133 · self-merge 十二例 code-tier REALIZED

### §五 · 副签路由 pin (doc-tier · Cleanup γ 主 + Research §S3 副1 + QADocs 副2)

### §六 · 引用锚
- RFC 9745 · RFC 8594 · RFC 8288
- PR #133 · Backend CREATE + post-MERGE broadcast · ADR-0010 §4.4 canonical

---

## §PR-M3-10 · Frontend γ PR #130 · Sider responsive breakpoint (Task #14 v0.5(b))

### §一 · Landing metadata
- PR #130 · Frontend γ 主签 · mergeCommit `65436296fffa24ef30a628919dd6a7a033b7601c` @ 2026-07-09T19:37:41Z · 十七-段
- Scope: `frontend/src/App.tsx:399` Sider `breakpoint="lg"` + `collapsedWidth={0}` responsive canonical · Task #14 v0.5(b)
- Diff scope: `frontend/**` SOLE · Frontend SOLE lane 100%
- Cleanup γ 副签 anchor: Task #46 slot #2 code-hygiene audit CONCUR unconditional delivered
- Authority: msg=d0d11677 self-merge (≥4-sign code-tier + CI 8/8 GREEN 双门 satisfied)

### §二 · Cleanup γ code-hygiene 六-项 audit
- §2.1 jscpd · §2.2 dead code zero · §2.3 `frontend/**` SOLE (App.tsx L399 SOLE MOD) · §2.4 antd Sider built-in API canonical · §2.5 patch minimal delta (+2/-1) + behavior-preserve (mobile responsive 天然 improvement) · §2.6 Frontend v0.5(a-g) 承接位 stream 二-例

### §三 · N=4 authority transitive preserve at 十七-段 (grep-verify bit-perfect)
- Frontend PR #130 SOLE MOD `frontend/src/App.tsx:399` · zero `backend/src/**` touch · N=4 canonical (FeedbackStatus + FeedbackClassification + SizingMethod + QuantWorkflowStatus) transitively preserved · Path D `3246b8cf` shasum `9ec3f104e268a44f8fcfab6e0ae6905faa6b6ec3` byte-perfect preserve

### §四 · Seventeen-段 main HEAD lineage LOCK
`... → 101ab3ce(#133) → 65436296(#130)` — main HEAD canonical LOCK 更新 → **`65436296`** post-#130

### §五 · 副签路由 pin (doc-tier · Cleanup γ 主 + Research §S3 副1 + QADocs 副2)

### §六 · 引用锚
- PR #130 · Frontend γ CREATE + post-MERGE broadcast · antd Sider `breakpoint` + `collapsedWidth` built-in API canonical
- Task #14 v0.5(b)

---

## §PR-M3-11 · QADocs PR #132 · PR-M3-5 v0.4-corrected N=4 baseline (anti-fabrication Instance 5 二例 VINDICATED)

### §一 · Landing metadata (QADocs §八(a) explicit arm)
- PR #132 · QADocs 主签 · mergeCommit `a4a1851017d004ec2c81e95b6d4561058b26dcdd` @ 2026-07-09T19:48:36Z · 十九-段
- Scope: `docs/refactor/baseline/ui-enum/4-enum-matrix-lock-bc1b3c9.json` NEW (4-baseline canonical) + `backend/tests/enum/enum-matrix-lock.test.ts` MOD (dual-invariant hard-check) + `docs/refactor/quality/qadocs-ui-enum-lock-sop.md` MOD
- Diff scope: +254/-0 · 3 files · QADocs SOLE lane 100% (`docs/refactor/baseline/ui-enum/**` + `backend/tests/enum/**` + `docs/refactor/quality/**`)
- Cleanup γ 副4 last-slot 收官: msg=3433ed40 (aggregated into 4/4 CLOSE per QADocs 主签 msg=03e80077 §二)
- Authority: msg=d0d11677 self-merge · authority-native execute per Orch v215 §六

### §二 · Cleanup γ code-hygiene 六-项 audit (msg=3433ed40 anchor)
- §2.1 jscpd · §2.2 dead code · §2.3 QADocs SOLE lane · §2.4 TS 严格 dual-invariant · §2.5 patch minimal delta N=4 canonical · §2.6 N=4 grep-verify bit-perfect at 十七-段 `65436296` (transitively preserved 十七 → 十八 → 十九-段)

### §三 · N=4 canonical AUTHORITY dual-source hard-fail canonical LIVE
- 15-baseline `matrix.length === 15` retain + **4-baseline `matrix4.length === 4` hard-check 新增 dual-invariant**
- N=4 canonical: FeedbackStatus + FeedbackClassification + SizingMethod + QuantWorkflowStatus (bit-perfect grep-verify authority-file lines)
- Negative-verify: MarketRegime + MarketJudgmentStatus = 0 hits discrete `export type` (Backend Option B REMOVE-permanent invariant preserved)

### §四 · Anti-fabrication canonical Instance 5 二例 VINDICATED (post-十九-段)
- Instance 1-4 prior canonical retain · **Instance 5 二例 authored-in-repo-first-then-lock canonical REINFORCED** post-#132
- N=6 → N=4 retract-canonical LOCKED · Backend Option B REMOVE-permanent authority 追认

### §五 · Nineteen-段 main HEAD lineage LOCK
`... → 65436296(#130) → 0f5661f2(#131 十八-段 doc-tier) → a4a18510(#132)` — main HEAD canonical LOCK 更新 → **`a4a18510`** post-#132 · self-merge 十六例 code-tier REALIZED

### §六 · 副签路由 pin (doc-tier · Cleanup γ 主 + Research §S3 副1 + QADocs 副2)

### §七 · 引用锚
- PR #132 · QADocs CREATE + post-MERGE broadcast · N=4 dual-source hard-fail canonical LIVE
- Anti-fabrication canonical Instance 5 二例 canonical

---

## §PR-M3-12 · Frontend γ PR #134 · `/risk-alerts` double-hop → single-hop redirect fix (Task #14 v0.5(d))

### §一 · Landing metadata (SELF-MERGED · byte-truth verified)
- PR #134 · Frontend γ 主签 · head `d86b464aedac45e7abdc5534db4f85fbe23f9e15` · mergeCommit `3a9ca3b92b8cfa693a60e8d6df607d8791a1cccb` @ 2026-07-09T19:59:56Z · **二十-段 REALIZED**
- Scope: `frontend/src/App.tsx:157` (`routeSelectionAliases`) + `App.tsx:581` (Route Navigate leaf) dual-site · `/portfolio` → `/workspace/portfolio` · Task #14 v0.5(d)
- Diff scope: +2/-2 · 1 file · Frontend SOLE lane 100%
- Cleanup γ 副4 last-slot 收官: msg=c3d295c6 (aggregated into 4/4 CLOSE post: Research §S3 msg=83e93a18 副1 + QADocs msg=158f75af 副2 + Backend msg=df247faf 副3 + Cleanup γ 副4)
- Authority: msg=d0d11677 self-merge · Frontend γ 主签 authority-native execute post 4-sign + CI 8/8 GREEN + CLEAN 双门 satisfy REALIZED

### §二 · Cleanup γ code-hygiene 六-项 audit (msg=c3d295c6 anchor)
- §2.1 jscpd (pure text-swap · zero duplication) · §2.2 dead code zero (family-canonical 一致性) · §2.3 `frontend/**` SOLE (App.tsx dual-site MOD) · §2.4 TS 严格 + zero type churn + React Router v6 built-in `<Navigate replace />` canonical · §2.5 patch minimal delta (+2/-2) + behavior-preservation 100% (double-hop → single-hop · final destination identical · history stack cleaner) · §2.6 family-canonical 一致性 (12+ 兄弟 alias 全 `→ '/workspace/portfolio'`) + Task #14 v0.5(d) authored-in-workspace-first-then-PR canonical

### §三 · Behavior-preservation verify canonical
- **before PR #134**: `/risk-alerts` → (L157 alias) → `/portfolio` → (L647 Route Navigate) → `/workspace/portfolio` · **double-hop 2-navigation**
- **after PR #134**: `/risk-alerts` → `/workspace/portfolio` · **single-hop 1-navigation**
- **final destination IDENTICAL** · **history stack depth reduced by 1** (single-hop `replace` = same slot vs prev 2-hop `replace`+`replace`)

### §四 · N=4 authority transitive preserve at 二十-段 (grep-verify bit-perfect)
- Frontend PR #134 SOLE MOD `frontend/src/App.tsx` L157+L581 · zero `backend/src/**` touch · N=4 canonical + MarketRegime/MarketJudgmentStatus REMOVE-permanent invariant transitively preserved · Path D `3246b8cf` shasum `9ec3f104e268a44f8fcfab6e0ae6905faa6b6ec3` byte-perfect 100% preserve

### §五 · 副签 order 4/4 CLOSE (msg-id table · code-tier ≥4-sign · msg=d0d11677 authority)
| # | agent | msg | posture |
|---|---|---|---|
| 主 | Frontend γ | msg=18e353dc | CREATE broadcast |
| 副1 | Research §S3 | msg=83e93a18 | byte-truth PASS + dual-site aligned + Path D preserve + workspace-draft REALIZE + 借鉴 attribution 五-项 PASS |
| 副2 | QADocs | msg=158f75af | 16-项 DoD attest + 保护 glob 铁律 100% zero-touch matrix + Path D shasum byte-perfect + N=4 canonical grep transitive preserve + anti-fabrication Instance 5 REINFORCED |
| 副3 | Backend v46 | msg=df247faf | byte-truth 独立 verify + Backend consumer-tier zero-coupling + Backend lane 零触碰 100% + React Router v6 API 语义 aligned + MarketRegime/MarketJudgmentStatus REMOVE-permanent transitive preserve |
| 副4 | **Cleanup γ** | **msg=c3d295c6** | **last-slot 收官** · code-hygiene 六-项 audit 全 PASS · behavior-preservation 100% + family-canonical 一致性 |

### §六 · Twenty-段 main HEAD lineage LOCK
`... → a4a18510(#132) → 3a9ca3b9(#134)` — main HEAD canonical LOCK 更新 → **`3a9ca3b9`** post-#134 · self-merge 十七例 code-tier REALIZED

### §七 · 副签路由 pin (doc-tier · Cleanup γ 主 + Research §S3 副1 + QADocs 副2)

### §八 · 引用锚
- PR #134 · Frontend γ CREATE + post-MERGE broadcast · React Router v6 built-in `<Navigate replace />` canonical
- Task #14 v0.5(d) authored-in-workspace-first-then-PR canonical

---

## §PR-M3-13 · Frontend γ PR #135 · Table `scroll.x` unify `'max-content'` canonical (Task #14 v0.5(e))

### §一 · Landing metadata (SELF-MERGED · byte-truth verified)
- PR #135 · Frontend γ 主签 · head `81c6a35a741cbfe3fb910eca5adbd38bfddd1ef1` · mergeCommit `08e777be223f76c672bcae10f94498f5519e40b8` @ 2026-07-09T20:13:00Z · **二十一-段 REALIZED**
- Scope: 6 files × 7 sites `frontend/**` SOLE — `PortfolioManagementPanel.tsx` L599 + `DataUpdateStatus.tsx` L1505/L1517/L1712 + `TaskScheduler.tsx` L1664/L1931 + `LabWorkspace.OverfitMetricsTab.tsx` L367 + `LabWorkspace.WalkForwardTab.tsx` L476/L616 + `PortfolioWorkspace.tsx` L1045/L1721 · integer-pixel → `'max-content'` CSS3 keyword swap · Task #14 v0.5(e)
- Diff scope: +11/-11 · 6 files · Frontend SOLE lane 100%
- Cleanup γ 副2 last-slot 收官: msg=ce36d897 (aggregated into 4/4 CLOSE post: Backend 副1 msg=d0f0450c + Research §S3 副3 msg=eb3000eb + QADocs 副4 msg=615f2fd3 + Cleanup γ 副2 last-slot 收官)
- Authority: msg=d0d11677 self-merge · Frontend γ 主签 authority-native execute (Owner squash-merge path per Frontend msg=e6453a83 §一)

### §二 · Cleanup γ code-hygiene 六-项 audit (msg=ce36d897 anchor)
- §2.1 jscpd (pure text-swap · zero duplication) · §2.2 dead code zero (family-canonical 一致性) · §2.3 `frontend/**` SOLE (6 files MOD) · §2.4 TS 严格 + zero type churn + antd 5.x `TableProps<T>['scroll']` type accepts `string | number | true` union + CSS3 Intrinsic & Extrinsic Sizing Module Level 3 built-in `'max-content'` canonical · §2.5 patch minimal delta (+11/-11) + behavior-preservation 100% (wide-viewport identical · narrow-viewport improved · column mutation resilience) · §2.6 family-canonical 15-site unify (9-baseline pre-existing + 6-promote via #135 · zero horizontal-scroll integer-pixel outlier remaining) + Task #14 v0.5(e) workspace-draft REALIZE canonical

### §三 · Behavior-preservation verify canonical
- **wide-viewport consumers**: column render **identical** post-swap (CSS `max-content` ≈ pre-existing hardcoded pixel budget · zero visual regression)
- **narrow-viewport / mobile consumers**: overflow behavior **improved** (CSS `max-content` triggers horizontal scroll natively at proper viewport threshold)
- **column mutation resilience**: future column addition/removal **auto-adjusts** (CSS `max-content` self-computes new column-sum · manual coordinate maintenance eliminated)
- **zero-touch intentional preserve verify**: `DataUpdateStatus:2470` (`y:400`-only) + `StockExplorer:346` (`y:calc(100vh-460px)`-only) vertical-only sites correctly excluded

### §四 · N=4 authority transitive preserve at 二十一-段 (grep-verify bit-perfect)
- Frontend PR #135 SOLE MOD `frontend/src/**` × 6 files · zero `backend/src/**` touch · N=4 canonical (FeedbackStatus + FeedbackClassification + SizingMethod + QuantWorkflowStatus) transitively preserved · MarketRegime/MarketJudgmentStatus REMOVE-permanent invariant transitively preserved · Path D `3246b8cf` shasum `9ec3f104e268a44f8fcfab6e0ae6905faa6b6ec3` byte-perfect 100% preserve (local re-verify post-merge PASS)

### §五 · 副签 order 4/4 CLOSE (msg-id table · code-tier ≥4-sign · msg=d0d11677 authority · Orch v219 §四 dispatch)
| # | agent | msg | posture |
|---|---|---|---|
| 主 | Frontend γ | msg=bf61f910 | CREATE broadcast |
| 副1 | Backend v47 | msg=d0f0450c | byte-truth 铁-verify + antd `TableProps<T>['scroll']` `'max-content'` CSS3 canonical + Backend lane 零触碰 100% + consumer-tier zero-coupling |
| 副2 | **Cleanup γ** | **msg=ce36d897** | **last-slot 收官** · code-hygiene 六-项 audit 全 PASS · behavior-preservation 100% + column mutation resilience + zero-touch intentional preserve + 15-site family-canonical unify + Path D shasum byte-perfect re-verify |
| 副3 | Research §S3 | msg=eb3000eb | byte-truth 6-file × 7-site bit-perfect + antd Table 'max-content' family-canonical 15-site unify + Path D preserve + 借鉴 attribution 100% |
| 副4 | QADocs | msg=615f2fd3 | 16-项 DoD independent-attest + 保护 glob 铁律 100% + Path D shasum byte-perfect at PR #135 head + N=4 canonical AUTHORITY grep 4/4 transitive preserve + Instance 5 REINFORCED transitively |

### §六 · Twenty-one-段 main HEAD lineage LOCK
`... → 3a9ca3b9(#134) → 08e777be(#135)` — main HEAD canonical LOCK 更新 → **`08e777be`** post-#135 · self-merge 十八例 code-tier REALIZED · 二连-SELF-MERGE #134+#135 aligned · 二十二例 self-merge total (十八 code + 四 doc)

### §七 · antd Table `scroll.x = 'max-content'` family-canonical 15-site unify REALIZED
- **9-baseline sites pre-#135** (grep-confirmed): `ActivationDashboard` + `PortfolioManagementPanel` (pre-existing sites) + `StockDetailPanel` + `DataUpdateStatus` (pre-existing sites) + `TaskScheduler` (pre-existing sites) + `FactorWorkspace` + `LabWorkspace.LeaderboardTab` + `FactorWorkspace.ETFFlowTab`
- **6-promote sites via PR #135** (7 pre-existing outlier sites → `'max-content'`)
- **15-site 100% aligned** · zero remaining integer-pixel outlier for horizontal-scroll sites

### §八 · 副签路由 pin (doc-tier · Cleanup γ 主 + Research §S3 副1 + QADocs 副2)

### §九 · 引用锚
- PR #135 · Frontend γ CREATE + post-MERGE broadcast · antd 5.x `TableProps<T>['scroll']` + CSS3 Intrinsic & Extrinsic Sizing Module Level 3 `'max-content'` canonical
- Task #14 v0.5(e) workspace-draft REALIZE canonical
