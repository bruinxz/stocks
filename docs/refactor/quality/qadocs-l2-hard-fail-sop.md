# QADocs · L2 verb hard-fail SOP

**版本**: v1 · 2026-07-09 CST · Task #52 landing
**owner**: QADocs (独立主签)
**引用锚**:
- Task #6 §API-Contract L2 (PR #101 landed `81bc018b` · warning-only 骨架)
- Strategy Path AD (verb 收窄 SOP verbatim)
- Strategy Path AE (test 层 protect-list soft-gate)
- Strategy Path AF (baseline JSON pattern hardening)
- 教训 #17 v1 formalize (`notes/lesson-17-cross-agent-amend-preflight.md`)
- ADR-0010 API Versioning Strategy (PR #105 landed `44fff935`)

---

## §一 · 规则

任何 `.routes.ts` 内 `router.(head|options|all)` 使用均视为 L2 违反 · CI hard-fail 阻塞 merge。

- **Allowed verbs**: `get / post / put / delete / patch`
- **Forbidden verbs**: `head / options / all`
- **Scope**: `backend/src/api/routes/**/*.routes.ts` + `backend/src/live-trading/routes/**/*.routes.ts`
- **Enforcement**: `backend/tests/quality/test_l2_verb_hard_fail.test.ts` (IIFE + node:assert/strict · exit 1 on any violation)

## §二 · 例外流程

必要时通过 `[l2-exempt: <slug>]` PR body trailer + owner + Orchestrator 双签授权。

- Exempt slug 需在 `docs/refactor/baseline/quality/l2-verb-baseline-<sha>.json` `entries` 内登记
- Exempt entry 包含: `slug` / `file` / `verb` / `reason` / `approved_by` / `approved_at` / `revoke_condition`
- Revoke: 触发条件满足后 · owner 主签 revoke PR · exempt entry 从 baseline JSON 移除

## §三 · 演进路线

- **v0 (本次 landing)**: baseline 0 entry · 全域 zero hit · SHA-lock `f8ae20b`
- **v1 (Phase 2 T+1w)**: 加入 Playwright E2E header assertion 联批 (X-API-Version header · Path η #1 承接)
- **v2 (Phase 3 T+2w)**: Zod runtime schema hash pin lint (Task #6 L11 candidate 承接)

## §四 · 联批姊妹

| test file | 目的 | policy |
|---|---|---|
| `backend/tests/quality/test_l2_verb_hard_fail.test.ts` | L2 verb hard-fail | hard-fail |
| `backend/tests/quality/test_api_version_header_assertion.test.ts` | ADR-0010 §R2 header assertion baseline | warning (v0) → hard (v1) |
| `backend/tests/quality/test_baseline_json_schema_lint.test.ts` | baseline JSON schema 一致性 lint | hard-fail |

## §五 · 铁律锚

- 教训 #16 dod v4.3 §16 (package.json delta lock · 本 PR zero package.json 触碰 · lesson-16 v1.0 seal 承接第 9 例 apply candidate)
- 教训 #17 v1 (跨 agent shared repo amend pre-flight SOP · `git status --short` → 精确 unstage → `git diff --cached --stat` → 优先新 commit)
- 教训 #12 v1.0 (contract vs code truth 四源 zero drift verify SOP)
- Independence v1.1 §5.4 (100% 原创 · zero 参考项目 fixture)
- Layer-Separation R1-R8 (`backend/tests/quality/**` 独占 · zero cross-layer)
