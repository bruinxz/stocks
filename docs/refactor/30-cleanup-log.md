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
