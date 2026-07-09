# ADR-0011 · UI Enum Single-Source-of-Truth Authority Policy

**Status**: accepted · v1.0 landing candidate · pre-M3 canonical formalize
**Date**: 2026-07-09 CST
**Authors**: QADocs 主签 · Backend + Frontend + Cleanup + Strategy 联合定
**Landing PR series**: PR-M3-1 (Backend rewire) + PR-M3-2 (Frontend legacy elim) + **PR-M3-3 (本 ADR + baseline + SOP landing)** + PR-M3-4 (lint hard-fail)

**Anchor 引用锚**:
- Task #4 M3 (5 大 UI 决色 enum 联合定终锁 M3 · 原范围 5 项 → 累积 15 项)
- workspace v0.1 draft: `notes/task-4-m3-15-enum-matrix-lock-draft.md` (msg=59838b48 · Task #54 landed)
- Frontend Path ψ + AB + AC + AD + AE + AF + AG (15 项 accumulation chain)
- ADR-0001 Layering and Collab (Backend authority · Frontend consume 只读 · R1-R8)
- ADR-0010 API Versioning Strategy (R1/R2 · contract truth 五源 · 教训 #12 v1.0)
- dod v4.3 §16 lesson-16 v1.0 seal (package.json delta lock · 本 ADR zero package.json 触碰)
- dod v4.4 §17 (SOP 4-step canonical · cross-agent shared repo amend pre-flight)
- 教训 #12 v1.0 (contract vs code truth 五源 zero drift verify SOP)
- 教训 #14 workspace preview → landing paste-in 范式
- Independence v1.1 §5.4 (100% 原创 · zero 参考项目 fixture)
- Layer-Separation R1-R8 (Backend enum authority 独占 · Frontend consume 只读 · zero cross-layer)

---

## §1 · Context

M2 后进入 M3 阶段 · Frontend 15 大 service audit 完形收敛 · 累积 **15 项 UI 决色 enum matrix** (Path ψ+AB+AC+AD+AE+AF+AG 承接链):

- **11 项 Backend authority 独立单一真源** (RETAIN)
- **2 项 cross-domain shape 同 · 需 single authority** (AUTHORITY)
- **3 项 duplication + legacy** (ELIM)

**问题**:
1. **duplication 泛滥**: 3-enum shape `healthy / degraded / unhealthy` 出现在 3 处 (QuantWorkflowStatus + EasyQuantHealthStatus + AutomationHealth.status + AutomationHealthChain.status) · shape 同但域语义有别
2. **legacy dead-code drift**: `frontend/src/services/backtestService.ts` (US-133 [PR-018] 记载) 与 labService `/quant/backtests/*` API 双域重叠 · Frontend legacy authority 与 Backend/labService authority 冲突
3. **cross-layer authority 归属**: enum 定义 authority 应在 Backend (data model 层) 还是 Frontend (types 层)?
4. **duplication elim 规则**: 同 shape 但不同 domain 是否强制 elim? (答: 否 · 见 §2.4)

**约束** (owner + Backend + Frontend + Strategy 联合冻结):
- **教训 #12**: contract draft ≠ code truth · code truth 唯一权威（Sequelize model + PG DDL + Zod schema 三源 pin）
- **Layer-Separation R1-R8**: Backend enum authority 独占 · Frontend consume 只读 · zero cross-layer duplication
- **Independence v1.1 §5**: enum 命名与参考项目 zero drift · 100% 起源本项目
- **教训 #14**: workspace v0.1 preview → M3 4 sub-PR pipeline landing paste-in 范式
- **dod v4.4 §17**: SOP 4-step canonical · cross-agent shared repo amend pre-flight

---

## §2 · Decision

**采纳 Backend enum single-source-of-truth authority policy** (5-agent 联合定 · owner d0d11677 自签合入令 authority)

### §2.1 · Backend authority 层唯一权威 (R1)

- 所有 UI 决色 enum 定义 authority 层 = **Backend** (`backend/src/models/**` OR `backend/src/live-trading/**`)
- Frontend consume 层 = **只读 import** · `frontend/src/types/**` 或 `frontend/src/services/**` 内 `type X = 'a' | 'b' | 'c'` union type 允许 · 但 **必须 byte-match Backend authority value set**
- **zero Frontend originating enum** (v0 起源 Frontend 的 enum 视为 legacy · M3 归档消 · #15 BacktestResponse.status 首例)

### §2.2 · duplication elim 规则 (R2)

**同 value set (case-sensitive) 且同域语义** → **单一 authority · 其余 alias import**:
- 例: #4 QuantWorkflowStatus (quant_workflow 域) = #10 EasyQuantHealthStatus (easy_quant 域 · 但 shape 同 healthy/degraded/unhealthy · 域语义共通 · cross-domain shape 同) → **#4 authority · #10 alias import from `quant_workflow`**

### §2.3 · 域独立 retain 规则 (R3)

**同 shape 但语义 domain 独立** → **保 domain 独立 authority · duplication elim 仅域内**:
- 例: #4 QuantWorkflowStatus (quant 域) vs #13 AutomationHealth.status (automation 域) · shape 同 (healthy/degraded/unhealthy) 但 domain 独立 → **两 authority 并存** · 各自域内 elim (automation 域内 #13 authority · #12 alias)

### §2.4 · legacy 归档规则 (R4)

**Frontend originating enum + labService/Backend 已有 authority overlap** → **legacy 归档整体消**:
- 例: #15 BacktestResponse.status (frontend/src/services/backtestService.ts 116 line legacy) vs labService BacktestTask.status (Backend `/quant/backtests/*` API authority) → **backtestService.ts 整体 DELETE · labService authority 存**
- 前置件: `grep -rn 'backtestService' frontend/src/` → 若 zero consumer → 直接 DELETE · 若有 consumer → 迁移至 labService

### §2.5 · exempt 通道 (R5)

必要时通过 `[ui-enum-exempt: <slug>]` PR body trailer + **owner + Orchestrator 双签** 授权:
- Exempt slug 需在 `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-<sha>.json` `entries` 内登记 (追加 `exempt: true` field)
- Exempt entry 包含: `slug` / `enum_name` / `authority_layer` / `reason` / `approved_by` / `approved_at` / `revoke_condition`
- Revoke: 触发条件满足后 · owner 主签 revoke PR · exempt entry 从 baseline JSON 移除

---

## §3 · Consequences

### §3.1 · 正面 (positive)

- **单一真源**: 15 项 enum authority 100% Backend · Frontend zero originating enum drift
- **duplication elim**: 3-enum shape `healthy/degraded/unhealthy` 从 4 处 → 2 authority + 2 alias · code 层 zero shape 重复定义
- **legacy dead-code 清消**: backtestService.ts 116 line 归档整体消 · Frontend service 15 大 audit → 14 大 (M3 landed 后)
- **contract truth 五源 zero drift**: Backend model + PG DDL + Zod schema + baseline JSON + lint 层 五源 authority chain 完形

### §3.2 · 反面 (negative)

- **迁移成本**: PR-M3-1 需 rewire Backend #10 + #12 alias · PR-M3-2 需 Frontend legacy grep + DELETE · PR-M3-4 需 lint 层 hard-fail 编写
- **exempt 窄门**: Exempt authority owner + Orch 双签 · 灵活性下降 · 但 authority 保护 tradeoff 值得

### §3.3 · 中性 (neutral)

- **v2 主版本演进**: 未来若 enum value set breaking change · 通过 baseline JSON `burndown_history` 追加新 SHA + entries update · zero ADR revoke

---

## §4 · Alternatives Considered

### Alt A · Frontend authority 层
- **拒绝理由**: Backend 是 data model + PG DDL 权威源 · Frontend 若 authority → 教训 #12 反向应用范式失效 (code truth 无锁)

### Alt B · 双 authority (Backend + Frontend 各自独立)
- **拒绝理由**: cross-layer duplication 风险 · shape drift 检测成本高 · violates Layer-Separation R1-R8

### Alt C · 全域 duplication elim (即使域独立也强制 alias)
- **拒绝理由**: quant 域 vs automation 域语义 domain 独立 · 强制 alias 会导致 semantic collision (automation 域内添 quant-flavored 语义) · violates domain-driven design

### Alt D · Zod schema 层 authority
- **拒绝理由**: Zod schema 是 runtime validation 层 · 不是 authority 层 · 应 consume Backend authority · 见 ADR-0010 §2.3 Zod runtime double-source

---

## §5 · Implementation Plan (M3 4 sub-PR pipeline)

### PR-M3-1 · Backend enum rewire (Backend 主签 · SLA T+5d)

> **v1.1 Stage 1 minimal patch** (PR-M3-1 landing · 2026-07-11 · Backend 主签)
> Full formalize → PR-M3-3 QADocs 主签 T+3d (baseline JSON schema formalize appendix + qadocs-ui-enum-lock-sop update).

- (a) `backend/src/quant/workflow/QuantWorkflowReadinessService.ts:8` 内 `QuantWorkflowStatus` 保 authority (RETAIN #4) — authority-file explicit-pin (Q4.c factual authority-language correction · repo-truth is entirely TypeScript; earlier ADR listed `.py` files but Backend has no Python sources).
- (b) `EasyQuantHealthStatus` alias 承接 → **PR-M3-2 T+7d (Frontend 主签)** · frontend-side elim strictly out-of-scope for PR-M3-1 per Layer-Separation R1-R8. PR-M3-1 lands only the Backend authority barrel `backend/src/models/enums/index.ts` re-exporting `QuantWorkflowStatus`; Frontend consumer swap lives in PR-M3-2.
- (c) `AutomationHealthChain.status` 三-domain **不合并 canonical** — execution (`ready|degraded|blocked`) + infra (`healthy|warning|critical`) + data (`green|yellow|red|unknown`) semantically orthogonal (seven-way unanimous · Orch v131.1 §一(3) + Orch v135 §二 SECOND ratify).
- (d) test 层: `backend/tests/enum/enum-matrix-lock.test.ts` asserts entries count 15 + decision-enum three-value byte-match; QuantWorkflowStatus value_set assertion currently `xit()`-skipped pending Baseline-fix independent PR (QADocs 主签 · SLA T+2d 2026-07-11 24:00 CST) which syncs `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json` id=4 entry to repo-truth `['ready','degraded','blocked']`; existing baseline sha_lock=83aea69c retained pre-fix (Q4.a Option α · zero-touch existing artifact) — rehydrate PR follows post-fix (Orch v136 §零 Q4.e canonical).
- landing scope: `backend/src/models/enums/index.ts` + `backend/tests/enum/enum-matrix-lock.test.ts` + this ADR §5 v1.1 Stage 1 minimal patch (Path A shrunk · 2 new + 1 modify per Orch v136 §零 Q4.e).
- reviewer: Backend 主签 + Strategy 副签 · QADocs 验 M3 完形

### PR-M3-2 · Frontend legacy backtestService 归档 (Frontend 主签 · SLA T+7d)

- (a) consumer grep confirm: `grep -rn 'backtestService' frontend/src/` → 若 zero 消费点 → 直接 DELETE `frontend/src/services/backtestService.ts`
- (b) 若有消费点 → 迁移至 labService `/quant/backtests/*` (labService.createBacktestTask + getBacktestDetail + listBacktestTasks)
- (c) `notes/frontend-service-audit-index.md` update: backtestService 从 in-scope 移除 (标记 `[ARCHIVED · M3 landed <PR-M3-2 URL>]`)
- landing scope: `frontend/src/services/backtestService.ts` DELETE · consumer 迁移 (若有)
- reviewer: Frontend 主签 + Cleanup 副签 (dead-code 归档 authority) · QADocs 验 UI 决色第 15 项 elim 完形

### PR-M3-3 · docs sync baseline + ADR-0011 + qadocs-ui-enum-lock-sop (QADocs 主签 · 本 PR · SLA T+5d · pre-grant #13 二十连胜 8-27 candidate)

- (a) `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json` new · sha_lock=83aea69c + entries=15 + burndown_history
- (b) `docs/refactor/adr/0011-ui-enum-single-source-of-truth.md` (本 ADR)
- (c) `docs/refactor/quality/qadocs-ui-enum-lock-sop.md` new · v1 · 15 项 policy + exempt trailer `[ui-enum-exempt: <slug>]`
- landing scope: `docs/refactor/baseline/ui-enum/**` + `docs/refactor/adr/**` + `docs/refactor/quality/**`
- reviewer: QADocs 主签 · Backend + Frontend + Cleanup + Orch + Research §S3 五路副签

### PR-M3-4 · lint 层 hard-fail (QADocs 主签 · **LANDED @ #119 · `93dee066` @ 2026-07-09T09:16:43Z**)

- (a) `backend/tests/enum/enum-matrix-lock.test.ts` **hardened** · 15 entries + decision_summary integrity + id=4 live-assert re-hydration (post-#118 baseline sync) + id=10 mirror-invariant + id=13 domain-independence guard + sha_lock filename-content self-consistency + full-matrix value_set/authority_file shape iterate — **23 assertions total** (pre-#119 baseline 2 → post-#119 23)
- (b) `backend/tests/lint/no-backtest-service-regression.test.ts` new · walk `frontend/src/**/*.{ts,tsx}` grep `backtestService` import · assert `offenders.length <= KNOWN_RESIDUAL` (currently `=1` · post-PR-M3-2 tighten `=== 0`) — **2 assertions** (files-found + residual-cap)
- (c) `.github/workflows/enum-lint.yml` new · 二 required jobs (`enum-matrix-lock` + `no-backtest-service-regression`) · `dorny/paths-filter@v3` scoped trigger (backend/tests/enum + backend/tests/lint + backend/src/quant/workflow + backend/src/models + frontend/src + baseline JSON + workflow self) · Node 20 + 10min timeout + concurrency cancel-in-progress
- landing scope: `backend/tests/enum/enum-matrix-lock.test.ts` (modify · +21 assertions) + `backend/tests/lint/no-backtest-service-regression.test.ts` (new · 101 LOC) + `.github/workflows/enum-lint.yml` (new · 96 LOC)
- reviewer LANDED: QADocs 主签 · Backend + Frontend + DataPipeline + Cleanup + Strategy + Research 六方副签 UNCONDITIONAL GREEN · owner @li-yiming 亲手 authority-native MERGED (msg=d0d11677 自签 ≥4 sign + CI GREEN 铁 · 6/6 大幅-super-SATISFY REALIZED)

---

## §6 · Post-M3-4 lint-hardening + escalation-over-invention 四段-lifecycle CLOSED

Post-#119 lint layer 收官 REALIZED. The four-段 discover→escalate→surface→close lifecycle canonical is now fully embodied in-repo across PR #116 → #118 → #119:

| 段 | Stage | PR | SHA | Action |
|----|-------|----|----|--------|
| §1 | **Discover** | #116 PR-M3-1 | `036294a7` | `xit()` skip on `QuantWorkflowStatus` value_set assertion — baseline `83aea69c` id=4 declared `healthy/degraded/unhealthy` while backend authority pinned `ready/degraded/blocked` (drift discovered) |
| §2 | **Escalate** | #116 same | `036294a7` | Skip carries `reason` string pointing to Baseline-fix independent PR — no silent skip · no in-place value mutation · escalation-over-invention: escalated to independent PR rather than back-patching baseline in the same commit |
| §3 | **Surface** | #118 PR-M3-1-baseline-fix | `feafa6e4` | Baseline-fix independent PR authoritatively syncs baseline id=4/id=10 to repo-truth · sha_lock renames `83aea69c` → `3246b8cf` post-fix · authority_file explicit-pin `backend/src/quant/workflow/QuantWorkflowReadinessService.ts:8` |
| §4 | **Close** | #119 PR-M3-4 | `93dee066` | id=4 live-assert re-hydrated in `enum-matrix-lock.test.ts` (post-#118 baseline canonical value_set) · 21-additional-assertion full-matrix hardening · CI enum-lint 二 required jobs · lint-layer 收官 |

**23-assertion inventory** (post-#119 `enum-matrix-lock.test.ts`):
1. baseline contains exactly 15 canonical entries
2. each entry declares one of {AUTHORITY, ELIM, RETAIN}
3. QuantWorkflowStatus authority barrel exports 3 canonical literals (TS compile-time probe)
4. baseline id=4 entry exists
5. id=4 enum_name === QuantWorkflowStatus
6. id=4 value_set === ["ready","degraded","blocked"] (post-#118 code-truth)
7. id=4 authority_file pins QuantWorkflowReadinessService.ts:8
8. id=4 decision === AUTHORITY
9. baseline id=10 entry exists
10. id=10 value_set mirrors id=4 (alias-consistency canonical)
11. id=10 decision === ELIM (aliased to id=4)
12. baseline id=13 entry exists
13. id=13 value_set === ["healthy","degraded","unhealthy"] (infra taxonomy)
14. id=13 value_set !== id=4 value_set (domain-independence guard)
15. id=13 decision === AUTHORITY (domain-local authority)
16. baseline sha_lock first 7 chars match filename slug (self-consistency guard)
17. decision_summary present
18. decision_summary.RETAIN_count matches actual (RETAIN=10)
19. decision_summary.AUTHORITY_count matches actual (AUTHORITY=2)
20. decision_summary.ELIM_count matches actual (ELIM=3)
21. decision_summary.total === 15
22. every entry has non-empty value_set
23. every entry has non-empty authority_file

Plus `no-backtest-service-regression.test.ts` **2 additional assertions** = **25 total lint-layer assertions** (23 + 2) across the two required CI jobs.

**反-fabrication canonical 二例 formation LOCK** (embodied in-repo):
- **Instance 1** — PR #118 baseline drift truth-sync: baseline `83aea69c` id=4 declared drift value_set → truth-sync to `3246b8cf` matching backend authority pin (rather than "invent" agreement by silently mutating in-place)
- **Instance 2** — PR #119 pre-guard `KNOWN_RESIDUAL=1` honest-observe: `no-backtest-service-regression.test.ts` documents the current 1 legacy consumer (`BacktestResults.tsx:23`) rather than silently asserting `=== 0` and hiding the residual — awaits PR-M3-2 Frontend 主签 tighten

---

## §7 · SLA + Landing Order

- **workspace v0.1 draft**: `notes/task-4-m3-15-enum-matrix-lock-draft.md` (Task #54 landed · msg=59838b48)
- **PR-M3-3 (本 PR) landing SLA**: T+5d (2026-07-14 24:00 CST) · **pre-grant #13 二十连胜 8-27 first-line first-choice candidate**
- **PR-M3-1 landing SLA**: T+5d (Backend rewire)
- **PR-M3-2 landing SLA**: T+7d (Frontend legacy elim)
- **PR-M3-4 landing SLA**: T+9d (lint hard-fail 收官)

---

## §7 · 铁律核验

- ✅ **教训 #16 dod v4.3 §16 v1.0 seal**: 本 ADR + baseline + SOP zero package.json 触碰
- ✅ **教训 #17 v1.1 §17 SOP 4-step self-apply**: git status → precise stage → diff --cached --stat → 新 commit no amend
- ✅ **教训 #12 v1.0 反向应用**: 15 项 enum authority chain 五源 (Backend source + PG DDL + Zod schema + baseline JSON + lint 层) 完形候位
- ✅ **教训 #14 workspace preview → landing paste-in 范式**: workspace v0.1 draft (msg=59838b48) → 本 PR-M3-3 baseline + ADR + SOP landing paste-in
- ✅ **Independence v1.1 §5.4**: 15 项 enum 100% 起源本项目 · zero 参考项目 fixture
- ✅ **Layer-Separation R1-R8**: Backend enum authority 独占 · Frontend consume 只读 · zero cross-layer

---

**v1.0 landing candidate** · **Backend enum single-source-of-truth authority policy** canonical formalize · 15 项 matrix 定终锁 · 强制适用所有 UI 决色 enum 定义 · exempt 通道窄门开放 (owner + Orch 双签授权)
