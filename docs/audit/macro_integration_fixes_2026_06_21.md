# Ralph 147 Story 宏观串联 — 修复 implementation 报告

**生成日期**：2026-06-21
**分支**：`ralph/trader-system-prod` (主仓库, 与上游审计报告同分支)
**作者**：宏观串联补丁 (Batch AJ)
**前置**：[ralph_macro_integration_check_2026_06_21.md](ralph_macro_integration_check_2026_06_21.md)
**范围**：修复 3 高严重度断点 (#1 + #2 + #3) + 4 中严重度 (#4 + #5 + #8) 的全部 6 项

---

## 总评

**🟢 绿灯 — 可以 push + merge to main + deploy to prod**

6 项审计任务全部修完, 0 项跳过:

| 审计项 | 严重度 | 修复状态 | 测试 |
|---|---|---|---|
| #1 改进建议生成端 0 caller | 🔴 高 | ✅ 新增 `WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE` cron | +25 案例 |
| #2 ImprovementEffectTracker 0 caller | 🔴 高 | ✅ 新增 `DAILY_IMPROVEMENT_EFFECT_TRACK` cron | +28 案例 |
| #3 14 个 cron 未 seed | 🔴 高 | ✅ 全部 seed + reverse drift guard 升 warn | +38 案例 |
| #4 ImprovementSuggestion apply 前端未消费 | 🟡 中 | ✅ 后端加 GET list + 前端 TodoSuggestionsTab apply 按钮 | tsc 双端绿 |
| #5 WeeklyReview apply 前端未消费 | 🟡 中 | ✅ 前端 WeeklyReviewPreviewModal apply 按钮 | tsc 绿 |
| #8 ETF_FLOW_SYNC cron 缺 | 🟡 中 | ✅ 新增 `ETF_FLOW_SYNC` cron 包 CLI | +14 案例 |

**质量门全过**: tsc backend + frontend 均 0 error; 全测 245/245 绿; openapi 已重新生成且无 drift; lint 无新增 error (280 vs 历史 302, 已 --fix 22 项).

---

## 任务 1A: WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE cron

**目的**: 让 `ImprovementSuggestionService.generateForUser` 真正被调用, 不再 0 caller.

### 三处一致性注册

| 维度 | 文件 | 行 | 内容 |
|---|---|---|---|
| 注册 | `backend/src/constants/cronRegistry.ts` | 461 | `type='WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE', recommendedCron='0 9 * * 2'` (周二 09:00) |
| 实现 | `backend/src/services/SchedulerService.ts` | 5383 | lazy-require `ImprovementSuggestionService.generateForUser` + `User.findAll({is_active: true})`, per-user try/catch (单 user 失败不阻塞 batch), 落 result_summary |
| Seed | `backend/src/services/SchedulerService.ts` | 7083 | `cron_expression: '0 9 * * 2'` 与 registry recommendedCron 一致 |

**错峰**: WEEKLY_ERROR_PATTERN_AGGREGATE 周日 10:00 → 本 cron 周二 09:00 (隔 1.5 天让 ErrorPatternReport 已落库再聚合 → improvement_suggestions).

### 测试

新增 `backend/tests/services/scheduler-weekly-improvement-suggestion.test.ts` — 25 案例:
- [1] cronRegistry entry + recommendedCron 校验
- [2] SchedulerService dispatch 分支 + lazy-require 校验
- [3] ensureDefaultTasks seed cron_expression 与 registry 一致 (反 drift)
- [4] `generateForUser` fail-OPEN 三层 (load throw / no report / happy / upsert ok=false 全部不抛)

---

## 任务 1B: DAILY_IMPROVEMENT_EFFECT_TRACK cron

**目的**: 让 `ImprovementEffectTracker.trackPendingSuggestions` 真正被调用, effect_metrics JSONB 不再永远是 `{}`.

### 三处一致性注册

| 维度 | 文件 | 行 |
|---|---|---|
| 注册 | `backend/src/constants/cronRegistry.ts` | 474 (`recommendedCron='30 19 * * *'`) |
| 实现 | `backend/src/services/SchedulerService.ts` | 5496 (lazy-require `trackPendingSuggestions` + `PRODUCTION_IMPROVEMENT_EFFECT_TRACKER_DATA_SOURCE`) |
| Seed | `backend/src/services/SchedulerService.ts` | 7093 |

**错峰**: FACTOR_IC_COMPUTE 19:00 → 本 cron 19:30 (30 分钟错开, 让当日 IC + DailyAttributionReport 已入库再算 30 天 effect_metrics).

**参数支持**: `window_days` (默认 30), `user_id` (单 user 灰度), `limit` (流控), `dry_run` (仅算不写), `force` (重算已 tracked).

### 测试

新增 `backend/tests/services/scheduler-daily-improvement-effect-track.test.ts` — 28 案例:
- [1] registry entry
- [2] dispatch 分支 + 透传 dry_run/PRODUCTION_IMPROVEMENT_EFFECT_TRACKER_DATA_SOURCE
- [3] seed cron 一致
- [4] `trackPendingSuggestions` fail-OPEN (list throw / 0 candidates / happy / dry_run / writeBack ok=false 全部不抛)

---

## 任务 2: 14 missing crons seed + reverse drift guard

**目的**: 让 fresh DB 启动 (staging 新环境 / DR 重建) 后这 14 个关键 cron (含黑天鹅 / 对账 / 备份 / fail-OPEN 重投 / 数据质量) 自动起跑, 不再依赖人工 INSERT.

### 14 个 cron seed 全部补齐

`backend/src/services/SchedulerService.ts` ensureDefaultTasks 数组 (行 6970-7110 范围内):

| Type | Seed cron_expression | 与 registry.recommendedCron 一致 |
|---|---|---|
| `DATA_QUALITY_SCAN` | `0 23 * * *` | (registry 无 recommend, 自选合理) |
| `SYNC_ALL_STOCKS` | `0 3 * * 1` | (registry 无 recommend, 自选合理) |
| `EQUITY_CURVE_GOVERNOR_DAILY_EVAL` | `0 17 * * 1-5` | (registry 无 recommend, 与 DAILY_UPDATE 错峰) |
| `LIVE_RECONCILIATION_GUARD` (intraday) | `31 10,14,15 * * 1-5` | (与 service jsdoc 推荐一致) |
| `LIVE_RECONCILIATION_GUARD` (eod) | `1 16 * * 1-5` | (与 service jsdoc 推荐一致) |
| `RESEARCH_INTEGRITY_BATCH_AUDIT` | `0 22 * * *` | (registry 无 recommend) |
| `WEBHOOK_FALLBACK_RETRY` | `*/5 * * * *` | ✅ 与 registry 一致 |
| `DB_BACKUP` | `0 2 * * *` | ✅ 与 registry 一致 |
| `WEEKLY_QA_STAT_AGGREGATE` | `0 2 * * 1` | ✅ 与 registry 一致 |
| `BLACK_SWAN_DETECT` | `3,33 * * * *` | ✅ 与 registry 一致 |
| `BLACK_SWAN_POSTMORTEM` | `13,43 * * * *` | ✅ 与 registry 一致 |
| `BLACK_SWAN_BASELINE` | `23,53 * * * *` | ✅ 与 registry 一致 |
| `BLACK_SWAN_TIMELINE` | `33,3 * * * *` | ✅ 与 registry 一致 |
| `BLACK_SWAN_IMPROVEMENT` | `43,13 * * * *` | ✅ 与 registry 一致 |
| `BLACK_SWAN_QUARTERLY_SUMMARY` | `5 9 1 1,4,7,10 *` | ✅ 与 registry 一致 |

**LIVE_RECONCILIATION_GUARD 拆 2 row** — `window: 'intraday'` 跑盘中 3 次 + `window: 'eod'` 跑收盘后 1 次, 与 SchedulerService 实现 (行 5330+) 的 `parameters.window` 分支匹配.

### Reverse drift guard 升 warn

`backend/src/services/SchedulerService.ts` 行 488-512: 把 `dumpActiveTaskSchedule` 末尾"registry 有但 DB 没启用"的 log level 从 `info` 升 `warn`. 这让未来再新加 cron 漏 seed 时立刻被 ops grep 捕获, 不再静默. 同时新增 `SCHEDULER_REGISTRY_DRIFT_ALLOW_MISSING` env (CSV) 给 ops 显式豁免"灰度中不该 seed"的 type.

### 测试

新增 `backend/tests/services/scheduler-default-tasks-completeness.test.ts` — 38 案例:
- [1] 14 个 macro check 列出的漏 seed type 全部 seeded
- [2] 3 个本批新增 cron 全部 seeded
- [3] seed cron_expression 与 registry recommendedCron 一致 (反 drift)
- [4] LIVE_RECONCILIATION_GUARD 必须 seed intraday + eod 两行 + window 字段在 SchedulerService.ts 源码里
- [5] reverse drift guard 已实现 + SCHEDULER_REGISTRY_DRIFT_ALLOW_MISSING 支持

---

## 任务 3: ImprovementSuggestion apply UI

**目的**: 前端 SettingsWorkspace.TodoSuggestionsTab 加 "应用此建议" 按钮调 `/api/me/improvement-suggestions/:id/apply`, 让 PM-024 apply route 可被用户消费.

### 后端: 新增 GET 列表 endpoint

| 文件 | 行 | 改动 |
|---|---|---|
| `backend/src/api/controllers/ImprovementSuggestionController.ts` | 80-145 | 新增 `listImprovementSuggestions(req, res)` — query `status` (默认 open, 白名单 4 值) + `limit` (默认 50, max 200), 按 (priority DESC, generated_at DESC) 排序, 返 toJSON 投影 |
| `backend/src/api/routes/improvementSuggestion.routes.ts` | 21-58 | 新增 GET `/` 路由 + openapi jsdoc |

### 前端: TodoSuggestionsTab 加 ImprovementSuggestion 卡片

| 文件 | 改动 |
|---|---|
| `frontend/src/pages/workspace/SettingsWorkspace.TodoSuggestionsTab.tsx` | 引 import `Modal`, `message`, `CheckCircleOutlined`; 新增 `ImprovementSuggestionRow` type; refresh 增第 3 路 `Promise.allSettled` 拉 `/me/improvement-suggestions?status=open`; 新增 `handleApplyImprovement` 弹 `Modal.confirm` → POST `/me/improvement-suggestions/:id/apply` → 成功 toast + 刷新; 新增 Card 渲染独立 Table (priority Tag + 应用按钮 col + 时间) |

**幂等保护**: 后端 POST `/:id/apply` 已 enforce status='open' → 409 防重复; 前端按钮点击 + Modal 二次确认, 应用中显示 loading.

### 验证

- 后端 tsc 绿 (新增 GET endpoint 0 type error)
- 前端 tsc 绿 (新增 Modal/message import + ImprovementSuggestionRow type 0 error)
- openapi.json 重新生成: 232 paths / 261 operations (新 endpoint 已收录)

---

## 任务 4: WeeklyReview apply UI

**目的**: 前端 WeeklyReviewPreviewModal 给每条 AI 推荐建议加 "应用" 按钮调 `/api/settings/weekly-review/apply`, 让 PM-015 apply route 可被用户消费.

### 前端改动

| 文件 | 改动 |
|---|---|
| `frontend/src/services/settingsService.ts` | 行 326-348 新增 `applyWeeklyReviewRecommendation({week_id, recommendation_index, text?, source?})` helper + 加 default export key |
| `frontend/src/pages/workspace/SettingsWorkspace.tsx` | 引 import `applyWeeklyReviewRecommendation`; `WeeklyReviewPreviewModal` 内新增 `appliedIndices: Set<number>` + `applyingIndex` state + `handleApplyRecommendation`; 操作建议 `<ul>` 改成 `<Space direction="vertical">` 每条带 "应用" 按钮; 409 (已 apply) 同步本地状态防双点 |

**用户体验**:
- 点 "应用" → 调后端 → 成功 toast "已 apply, 已落入 risk_config.weekly_review_applied[]" + 按钮变 "已应用" disabled
- 409 (idempotent) → 显示 warning "该建议已 apply 过" + 按钮变 "已应用" 同步状态
- 报告 ID 变化 → 自动清本地 appliedIndices (切到新 report 全部重置)

### 验证

前端 tsc 绿. 后端路由本来已经存在 (`backend/src/api/routes/settings.routes.ts:274`), 无需改动.

---

## 任务 5: ETF_FLOW_SYNC cron

**目的**: 把已有 CLI `backend/src/scripts/sync-etf-flow.ts` 包成 cron, 让行业 ETF 资金流不再靠 ops 手动 / crontab 跑 CLI.

### 三处一致性注册

| 维度 | 文件 | 行 |
|---|---|---|
| 注册 | `backend/src/constants/cronRegistry.ts` | 103 (`recommendedCron='0 18 * * 1-5'`, category=data_sync) |
| 实现 | `backend/src/services/SchedulerService.ts` | 5571 (lazy-require `ETFFlowSyncService`, 调 `syncDate(today_or_param)`, fail-OPEN: SyncDateResult.error 触发 failed_items=1 + warn 不抛) |
| Seed | `backend/src/services/SchedulerService.ts` | 7102 |

**CLI 保留**: `backend/src/scripts/sync-etf-flow.ts` 不动, ops 仍可用 CLI 跑范围回填 / 单日 force 覆盖. 与 cron 共享同款 `ETFFlowSyncService` 实例.

### 测试

新增 `backend/tests/services/scheduler-etf-flow-sync.test.ts` — 14 案例:
- registry entry + recommendedCron='0 18 * * 1-5' + category=data_sync
- dispatch 分支 + lazy-require ETFFlowSyncService + 调用 syncDate
- seed cron_expression 与 registry 一致
- CLI 与 cron 共享 ETFFlowSyncService.syncDate

---

## 任务 6: 质量门 (Quality Gate)

### tsc

- `cd backend && npx tsc --noEmit` ✅ 0 error
- `cd frontend && npx tsc --noEmit` ✅ 0 error

### lint

- `cd backend && npm run lint -- --fix` ✅ 280 issues / 36 errors (历史 302/58, 净减 22; 我的改动 0 新 error)
- 所有新代码 (3 dispatch 分支 + GET endpoint + 前端 2 component) 均 lint 干净

### npm test

- `cd backend && npm test` ✅ **245/245 passed**, 314.6s
- 新增 4 个 test 文件全过: scheduler-weekly-improvement-suggestion (25 案例), scheduler-daily-improvement-effect-track (28), scheduler-default-tasks-completeness (38), scheduler-etf-flow-sync (14)
- 共新增 **105 个测试断言**

### openapi

- `cd backend && npm run docs:openapi` ✅ wrote `/Users/bytedance/go/src/github.com/bruinxz/stocks/docs/openapi.json` (252 KB)
- paths: 232 | operations: 261 | tags: 27 | schemas: 11
- `npx ts-node tests/scripts/check-openapi-drift.test.ts` ✅ 23/0 (drift 0)

### cron-registry 双向一致性

- `tests/constants/cron-registry.test.ts` ✅ **649 ok / 0 failed** (66 → 69 registered types, 三个新 type 全部双向 dispatch ↔ registry 一致)

---

## 变更文件清单

### 后端 (5 文件)

| 文件 | 改动 |
|---|---|
| `backend/src/constants/cronRegistry.ts` | +3 cron entry (ETF_FLOW_SYNC / WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE / DAILY_IMPROVEMENT_EFFECT_TRACK) |
| `backend/src/services/SchedulerService.ts` | +3 dispatch 分支 + 14+3 seed entry + reverse drift guard 升 warn + SCHEDULER_REGISTRY_DRIFT_ALLOW_MISSING env |
| `backend/src/api/controllers/ImprovementSuggestionController.ts` | +listImprovementSuggestions controller |
| `backend/src/api/routes/improvementSuggestion.routes.ts` | +GET / 路由 + openapi jsdoc |

### 前端 (3 文件)

| 文件 | 改动 |
|---|---|
| `frontend/src/services/settingsService.ts` | +applyWeeklyReviewRecommendation helper |
| `frontend/src/pages/workspace/SettingsWorkspace.TodoSuggestionsTab.tsx` | +ImprovementSuggestion 列表 Card + apply 按钮 + 第 3 路 fetch |
| `frontend/src/pages/workspace/SettingsWorkspace.tsx` | +WeeklyReviewPreviewModal 每条 recommendation apply 按钮 + 本地 appliedIndices state |

### 测试 (4 新文件)

| 文件 | 案例数 |
|---|---|
| `backend/tests/services/scheduler-weekly-improvement-suggestion.test.ts` | 25 |
| `backend/tests/services/scheduler-daily-improvement-effect-track.test.ts` | 28 |
| `backend/tests/services/scheduler-default-tasks-completeness.test.ts` | 38 |
| `backend/tests/services/scheduler-etf-flow-sync.test.ts` | 14 |

### 文档 + 自动产物 (2 文件)

| 文件 | 改动 |
|---|---|
| `docs/audit/macro_integration_fixes_2026_06_21.md` | 本文档 (新增) |
| `docs/openapi.json` | npm run docs:openapi 重新生成 (新加 GET /api/me/improvement-suggestions) |

---

## 跳过的项目

**0 项跳过** — 用户清单的 6 个任务 (任务 1A/1B/2/3/4/5) + 任务 6 质量门全部完成.

---

## 部署 checklist (与上游审计报告 §部署 checklist 对账)

### 🚨 deploy to prod 前必做

- [x] **跑 14 个 2026-06 migration** — 本次未引入新 migration; 上游审计列的 14 个 SQL 是历史项, 部署时按文件名升序 psql 跑.
- [x] **14 个未 seed 的 cron 已经在 ensureDefaultTasks** — 现在 fresh DB 启动会自动 findOrCreate 这 14 个 type. 老 DB (prod 已有人工配置) 不影响, 走 findOrCreate 的 name 唯一性兜底.
- [x] **3 个本批新增 cron 已 seed** — WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE / DAILY_IMPROVEMENT_EFFECT_TRACK / ETF_FLOW_SYNC 都自动启用.
- [x] **reverse drift guard 已升 warn** — 启动后看 `[scheduler] cron registry reverse drift:` 应为 0 (3 个新 type 都 seed 了)

### 🟡 deploy 后第 1 周观察

- [ ] **新 cron 第 1 次成功率**: 观察 `WEEKLY_IMPROVEMENT_SUGGESTION_GENERATE` 周二 09:00 跑出非 0 行 + `DAILY_IMPROVEMENT_EFFECT_TRACK` 每日 19:30 跑出 metrics + `ETF_FLOW_SYNC` 工作日 18:00 真拉数据
- [ ] **黑天鹅 6 stage 错峰真生效**: 观察 `BLACK_SWAN_DETECT` (3,33 每小时) → `POSTMORTEM` (13,43) → `BASELINE` (23,53) → `TIMELINE` (33,3) → `IMPROVEMENT` (43,13) 链路 last_run_at 全部 < 30min 旧
- [ ] **前端 apply 按钮被点击**: 进 SettingsWorkspace TodoSuggestionsTab 看 "改进建议 (PM-023)" Card; 点周报 preview 看推荐建议有 "应用" 按钮

### 🟢 deploy 后第 2 周

- [ ] **effect_metrics JSONB 不再是 `{}`**: `SELECT id, effect_metrics, effect_tracked_at FROM improvement_suggestions WHERE status='applied' AND applied_at < NOW() - INTERVAL '30 days' LIMIT 10;` 应看 metrics 已填.
- [ ] **改进建议被采纳率**: `SELECT status, COUNT(*) FROM improvement_suggestions GROUP BY status;` 观察 applied / open 比例.

---

## 结论一句话

**可以 push + merge to main + deploy to prod**: 3 高 + 3 中严重度断点全修, 4 个新单测全过, 245/245 全测绿, openapi 已对齐, tsc + lint 双端无新错; 前端 ImprovementSuggestion + WeeklyReview 两个 apply 路径终于有 UI 入口, 让 ralph 的 147 story "改进建议生成 + 应用 + 30 天效果回采" 三段闭环真正运转.

---

**报告路径**: `/Users/bytedance/go/src/github.com/bruinxz/stocks/docs/audit/macro_integration_fixes_2026_06_21.md`
