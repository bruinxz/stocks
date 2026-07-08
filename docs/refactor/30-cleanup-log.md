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
