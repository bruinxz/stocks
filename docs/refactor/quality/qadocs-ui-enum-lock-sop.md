# QADocs · UI Enum Single-Source-of-Truth Lock SOP · v1.0 seal

**版本**: v1.0 seal candidate · 2026-07-09 CST · PR-M3-3 landing
**owner**: QADocs (独立主签) · Backend + Frontend + Cleanup + Strategy 联合定
**seal 触发件**: PR-M3-3 (本 PR) landing · 15 项 UI 决色 enum matrix baseline JSON `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json` + ADR-0011 landed
**引用锚**:
- Task #4 M3 (5 大 UI 决色 enum 联合定终锁 M3 · 原范围 5 项 → 累积 15 项)
- workspace v0.1 draft: `notes/task-4-m3-15-enum-matrix-lock-draft.md` (msg=59838b48 · Task #54 landed)
- ADR-0011 UI Enum Single-Source-of-Truth Authority Policy (本 PR landed)
- ADR-0001 Layering and Collab (Backend authority · Frontend consume 只读 · R1-R8)
- ADR-0010 API Versioning Strategy (contract truth 五源 · 教训 #12 v1.0)
- dod v4.4 §17 (SOP 4-step canonical · cross-agent shared repo amend pre-flight)
- 教训 #12 v1.0 (contract vs code truth 五源 zero drift verify SOP)
- QADocs L2 verb hard-fail SOP v1.0 seal (`docs/refactor/quality/qadocs-l2-hard-fail-sop.md` · PR #113 landed `d6a0c1ed`)

---

## §一 · 规则 (v1.0 seal)

任何 UI 决色 enum 定义 (15 项 matrix 内) 违反 Backend authority 单一真源规则 · CI hard-fail 阻塞 merge (PR-M3-4 landing 后生效)。

- **Authority 层**: Backend (`backend/src/models/**` OR `backend/src/live-trading/**`)
- **Consume 层**: Frontend `frontend/src/types/**` 或 `frontend/src/services/**` 只读 union type · **必须 byte-match Backend authority value set**
- **duplication elim rule**: 同 value set (case-sensitive) 且同域语义 → 单一 authority · 其余 alias import
- **域独立 retain rule**: 同 shape 但语义 domain 独立 → 保 domain 独立 authority · 域内 elim
- **legacy 归档 rule**: Frontend originating enum + Backend/labService overlap → legacy 归档整体消
- **Enforcement**: `backend/tests/quality/test_ui_enum_lock_matrix.test.ts` (PR-M3-4 landing · IIFE + node:assert/strict · exit 1 on any drift)

---

## §二 · SOP 4-step canonical (v1.0 seal · Task #4 M3 承接)

**触发**: 任何 enum 定义/修改/删除 PR · PR-M3-1/2/4 landing 全域适用

### Step 1 · baseline SHA-lock verify

```bash
# baseline JSON 已存
cat docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json | jq '.sha_lock'
# → "83aea69c44daaaa8e74613311f085d92fc23e27b"

# 当前 main HEAD
git -C /Users/bytedance/go/src/github.com/bruinxz/stocks rev-parse HEAD
# → "83aea69c..." (post PR #114)

# 断言: baseline sha_lock 允许落后 main (baseline 是 snapshot lock · burndown_history 累积)
```

### Step 2 · 15 项 matrix value set verify

```bash
cd /Users/bytedance/go/src/github.com/bruinxz/stocks
# entries count 断言
cat docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json | jq '.entries | length'
# 期望: 15

# decision_summary 断言
cat docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json | jq '.decision_summary'
# 期望: {RETAIN_count: 10, AUTHORITY_count: 2, ELIM_count: 3, total: 15}
```

### Step 3 · Backend authority 源存在性 verify (RETAIN 10 + AUTHORITY 2 = 12 项)

```bash
# 对每个 RETAIN + AUTHORITY entry 断言 authority_file 存在
cat docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json \
  | jq -r '.entries[] | select(.decision == "RETAIN" or .decision == "AUTHORITY") | .authority_file'
# 期望: 12 个 authority_file 路径 (Backend `backend/src/models/**` OR `backend/src/live-trading/**`)
```

### Step 4 · ELIM 3 项 migration PR 前置件 verify

```bash
cat docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json \
  | jq -r '.entries[] | select(.decision == "ELIM") | "\(.id) \(.enum_name) → \(.elim_migration_pr)"'
# 期望:
#   10 EasyQuantHealthStatus → PR-M3-1
#   12 AutomationHealthChain.status → PR-M3-1
#   15 BacktestResponse.status → PR-M3-2
```

**exempt 通道**: PR body trailer `[ui-enum-exempt: <slug>]` · owner + Orch 双签 · entries 追增至 baseline JSON

---

## §三 · 例外流程

必要时通过 `[ui-enum-exempt: <slug>]` PR body trailer + owner + Orchestrator 双签授权。

- Exempt slug 需在 `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-<sha>.json` `entries` 内登记 (追加 `exempt: true` field)
- Exempt entry 包含: `slug` / `enum_name` / `authority_layer` / `reason` / `approved_by` / `approved_at` / `revoke_condition`
- Revoke: 触发条件满足后 · owner 主签 revoke PR · exempt entry 从 baseline JSON 移除

---

## §四 · 演进路线

- **v0** (Task #54 workspace v0.1 draft · msg=59838b48): 15 项 matrix workspace-only · zero PR CREATE
- **v1.0 seal (本 PR-M3-3 landing)**: baseline JSON + ADR-0011 + 本 SOP formalize landing · sha_lock `83aea69c` · burndown_history 起点
- **v1.1** (PR-M3-1 Backend rewire landing): burndown_history 追加 · ELIM #10 + #12 alias landed · Backend authority 12 项 verified
- **v1.2** (PR-M3-2 Frontend legacy elim landing): burndown_history 追加 · ELIM #15 backtestService.ts DELETE landed · Frontend service 15 大 → 14 大
- **v2.0** (PR-M3-4 lint hard-fail 收官): CI 5-gate wire · `test_ui_enum_lock_matrix.test.ts` + `test_no_backtest_service_regression.test.ts` hard-fail 生效 · zero enum drift regression 铁律

---

## §五 · 联批姊妹

| test file | 目的 | policy |
|---|---|---|
| `backend/tests/quality/test_ui_enum_lock_matrix.test.ts` (PR-M3-4) | 15 项 enum value set drift lint | hard-fail |
| `backend/tests/quality/test_no_backtest_service_regression.test.ts` (PR-M3-4) | backtestService.ts 归档后 regression 保护 | hard-fail |
| `backend/tests/quality/test_l2_verb_hard_fail.test.ts` (PR #111 landed) | L2 verb hard-fail | hard-fail |
| `backend/tests/quality/test_api_version_r1_hard_fail.test.ts` (PR #114 landed) | R1 /api/v1/* prefix hard-fail | skip-stub (Backend mount 前置) |
| `backend/tests/quality/test_api_version_r2_hard_fail.test.ts` (PR #114 landed) | R2 X-API-Version:1 header hard-fail | skip-stub (Backend mount 前置) |
| `backend/tests/quality/test_baseline_json_schema_lint.test.ts` (PR #111 landed) | baseline JSON schema 一致性 lint | hard-fail |

---

## §六 · 铁律锚 (v1.0 seal)

- 教训 #16 dod v4.3 §16 (package.json delta lock · 本 PR zero package.json 触碰 · lesson-16 v1.0 seal 承接第 13 例 apply candidate)
- **教训 #17 v1.1 §17** (跨 agent shared repo amend pre-flight SOP · `docs/refactor/dod-checklist.md` §17 302 line canonical · 17 项 铁律 100% 生效 · PR-M3-3 self-apply 第 20 例 candidate)
- 教训 #12 v1.0 (contract vs code truth 五源 zero drift verify SOP)
- 教训 #14 (workspace preview → landing paste-in 范式 · Task #54 workspace → 本 PR landing)
- Independence v1.1 §5.4 (100% 原创 · zero 参考项目 fixture)
- Layer-Separation R1-R8 (`docs/refactor/quality/**` + `docs/refactor/baseline/ui-enum/**` + `docs/refactor/adr/**` QADocs 独占 · zero cross-layer)

---

**v1.0 seal landing candidate** · UI enum single-source-of-truth authority lock canonical 4-step verify · 强制适用所有 15 项 UI 决色 enum · exempt 通道窄门开放 (owner + Orch 双签授权) · PR-M3-4 lint 层 hard-fail 收官触发生效
