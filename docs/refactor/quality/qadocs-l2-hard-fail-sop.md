# QADocs · L2 verb hard-fail SOP · v1.0 seal

**版本**: v1.0 seal · 2026-07-09 CST · PR-P1-1 landing
**owner**: QADocs (独立主签) · Orch 副签
**seal 触发件**: PR #112 (PR-DOD-4-4-1) MERGED `b83f51d9` @ 02:29:44 CST · 十七连胜 8-24 first-line first-choice landed · dod v4.4 §17 铁律 100% 生效 (`docs/refactor/dod-checklist.md` 302 line landed)
**引用锚**:
- Task #6 §API-Contract L2 (PR #101 landed `81bc018b` · warning-only 骨架)
- Task #52 landing (PR #111 landed `c9680478` · L2 hard-fail 5-file test pack)
- Strategy Path AD (verb 收窄 SOP verbatim)
- Strategy Path AE (test 层 protect-list soft-gate)
- Strategy Path AF (baseline JSON pattern hardening)
- 教训 #17 v1 formalize (`notes/lesson-17-cross-agent-amend-preflight.md`)
- **dod v4.4 §17 landed** (`docs/refactor/dod-checklist.md` · PR #112 · 302 line · 17 项 canonical)
- ADR-0010 API Versioning Strategy (PR #105 landed `44fff935`)

---

## §一 · 规则 (v1.0 seal · unchanged)

任何 `.routes.ts` 内 `router.(head|options|all)` 使用均视为 L2 违反 · CI hard-fail 阻塞 merge。

- **Allowed verbs**: `get / post / put / delete / patch`
- **Forbidden verbs**: `head / options / all`
- **Scope**: `backend/src/api/routes/**/*.routes.ts` + `backend/src/live-trading/routes/**/*.routes.ts`
- **Enforcement**: `backend/tests/quality/test_l2_verb_hard_fail.test.ts` (IIFE + node:assert/strict · exit 1 on any violation)

---

## §二 · SOP 4-step canonical (v1.0 seal ⭐ · Task #51 §二 承接)

**触发**: PR-P1-1 landing 后 · L2 从 warning-only → hard-fail 已 landed (PR #111 `c9680478`) · **升级 SOP 是 landed 后的 self-verify + baseline refresh SOP** (SOP 定型)

### Step 1 · baseline SHA-lock verify

```bash
# baseline JSON 已存
cat docs/refactor/baseline/quality/l2-verb-baseline-f8ae20b.json | jq '.sha_lock'
# → "f8ae20b296927a7f7ccf647209de429588775f34"

# 当前 main HEAD
git -C /Users/bytedance/go/src/github.com/bruinxz/stocks rev-parse HEAD
# → "b83f51d9..." (post PR #112)

# 断言: baseline sha_lock 允许落后 main (baseline 是 snapshot lock · burndown_history 累积)
```

### Step 2 · L2 zero-hit scan verify (29 route files)

```bash
cd /Users/bytedance/go/src/github.com/bruinxz/stocks
# scan all route files for forbidden verbs
grep -rn -E "\.(head|options|all)\s*\(" \
  backend/src/api/routes/*.routes.ts \
  backend/src/live-trading/routes/*.routes.ts \
  | wc -l
# 期望: 0 (baseline entries=[] · zero hit 全域承诺)
```

### Step 3 · warning_grace_end_sha 冻结确认

```bash
cat docs/refactor/baseline/quality/l2-verb-baseline-f8ae20b.json \
  | jq '.policy.warning_grace_end_sha'
# → "6d3d831d" (warning-only 阶段结束 SHA)

# 断言: warning_grace_end_sha < sha_lock (时序 warning-only 早于 hard-fail)
```

### Step 4 · CI 4-gate wire verify

```bash
# .github/workflows/*.yml 内 L2 test 挂载点
grep -rn "test.*l2\|l2.*test" .github/workflows/
# 期望: PR #111 5-file wire 已 landed
```

**exempt 通道**: PR body trailer `[l2-exempt: <slug>]` · owner + Orch 双签 · entries 追增至 baseline JSON

---

## §三 · 例外流程

必要时通过 `[l2-exempt: <slug>]` PR body trailer + owner + Orchestrator 双签授权。

- Exempt slug 需在 `docs/refactor/baseline/quality/l2-verb-baseline-<sha>.json` `entries` 内登记
- Exempt entry 包含: `slug` / `file` / `verb` / `reason` / `approved_by` / `approved_at` / `revoke_condition`
- Revoke: 触发条件满足后 · owner 主签 revoke PR · exempt entry 从 baseline JSON 移除

---

## §四 · 演进路线

- **v0** (Task #52 · PR #111 landed `c9680478`): baseline 0 entry · 全域 zero hit · SHA-lock `f8ae20b` · warning-only → hard-fail landing
- **v1.0 seal (本 PR-P1-1 landing)**: SOP 4-step canonical formalize · burndown_history 追加 `b83f51d9` (post PR #112) · baseline JSON 结构无 delta · zero exempt entry retain
- **v1.1 (Phase 2 T+1w · Path η #1 承接)**: 加入 Playwright E2E header assertion 联批 (X-API-Version header · Path η #1 evolution)
- **v2 (Phase 3 T+2w · Task #6 L11 承接)**: Zod runtime schema hash pin lint (Task #50 L11 v0-v1-v2 演进承接)

---

## §五 · 联批姊妹

| test file | 目的 | policy |
|---|---|---|
| `backend/tests/quality/test_l2_verb_hard_fail.test.ts` | L2 verb hard-fail | hard-fail |
| `backend/tests/quality/test_api_version_header_assertion.test.ts` | ADR-0010 §R2 header assertion baseline | warning (v0) → hard (v1) |
| `backend/tests/quality/test_baseline_json_schema_lint.test.ts` | baseline JSON schema 一致性 lint | hard-fail |

---

## §六 · 铁律锚 (v1.0 seal update)

- 教训 #16 dod v4.3 §16 (package.json delta lock · 本 PR zero package.json 触碰 · lesson-16 v1.0 seal 承接第 11 例 apply candidate)
- **教训 #17 v1 landed** (跨 agent shared repo amend pre-flight SOP · `docs/refactor/dod-checklist.md` §17 302 line canonical · 17 项 铁律 100% 生效 · PR-P1-1 self-apply 第 18 例)
- 教训 #12 v1.0 (contract vs code truth 四源 zero drift verify SOP)
- Independence v1.1 §5.4 (100% 原创 · zero 参考项目 fixture)
- Layer-Separation R1-R8 (`docs/refactor/quality/**` + `docs/refactor/baseline/quality/**` QADocs 独占 · zero cross-layer)

---

**v1.0 seal landed** · L2 verb hard-fail SOP canonical 4-step verify · 强制适用所有 L2-scope route file · exempt 通道窄门开放 (owner + Orch 双签授权)
