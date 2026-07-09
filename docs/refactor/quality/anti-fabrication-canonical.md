# 反-Fabrication Canonical (二例 Formation LOCK)

**Status:** canonical formalize (post-M3 series 收官 `93dee066`)
**Author:** QADocs 主签
**Exemplar in-repo:** PR #118 (Instance 1 · truth-sync) + PR #119 (Instance 2 · honest-observe)

---

## §1 · Statement (铁律)

**Do not invent** agreement between declared state and observed state by silently mutating declared state or by silently over-strengthening assertions past observed reality. When declared ≠ observed:

- **Truth-sync (Instance 1 pattern)**: align declared to observed via an authoritative surfacing PR (never silently mutate observed to match declared unless the observed side is provably wrong per an independent spec)
- **Honest-observe (Instance 2 pattern)**: encode the current-state exactly in the assertion (residual counts, known-consumer caps, migration debt) with a named threshold constant + clear tightening obligation — never silently assert an over-strengthened target that hides the gap

---

## §2 · Instance 1 — Truth-sync (PR #118)

### §2.1 Situation

Baseline `83aea69c` id=4 declared:
```json
{ "id": 4, "enum_name": "QuantWorkflowStatus",
  "value_set": ["healthy", "degraded", "unhealthy"] }
```

Backend authority pin `backend/src/quant/workflow/QuantWorkflowReadinessService.ts:8`:
```typescript
export type QuantWorkflowStatus = 'ready' | 'degraded' | 'blocked';
```

Divergence discovered mid-PR #116 (see `escalation-over-invention-canonical.md` §3.1).

### §2.2 Two available responses (only one is honest)

**Fabrication (WRONG)** — silently mutate observed side to match declared:
```typescript
// backend/src/quant/workflow/QuantWorkflowReadinessService.ts:8
- export type QuantWorkflowStatus = 'ready' | 'degraded' | 'blocked';
+ export type QuantWorkflowStatus = 'healthy' | 'degraded' | 'unhealthy';  // silently match baseline
```

This is fabrication because (a) it changes runtime behavior of `QuantWorkflowReadinessService` to serve an untested baseline claim, (b) reviewers of the assertion-landing PR see agreement without knowing it was manufactured, (c) the baseline claim was unverified — silently trusting it inverts the authority relationship.

**Truth-sync (CORRECT · Instance 1 canonical)** — align declared to observed via authoritative surfacing PR:

PR #118 (Baseline-fix independent PR):
```json
// docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json → renamed 3246b8c.json
- { "value_set": ["healthy", "degraded", "unhealthy"] }
+ { "value_set": ["ready", "degraded", "blocked"],
+   "authority_file": "backend/src/quant/workflow/QuantWorkflowReadinessService.ts:8" }
```

- Baseline is the declared state → authoritatively sync to observed code-truth
- Backend authority is the observed state → **untouched** (code-truth remains code-truth)
- `sha_lock` renamed `83aea69c` → `3246b8cf` (filename slug + content field both updated · schema-consistency guard fires)
- `authority_file` explicit-pin added — future audits trace the authority claim without repository archaeology

### §2.3 Why truth-sync is the canonical direction

The authority-of-truth flows **code → baseline** when the code implements a runtime contract. The baseline is a **frozen reference** for review + drift detection, not a spec that can override code. If code + baseline disagree and the code is running in production against a schema that matches its own type, the baseline is drifted — truth-sync to code.

If instead the code is drifted from an independently-authored spec (e.g. a customer-facing API contract), the direction reverses: code truth-syncs to spec. In either case, **surface the divergence in an independent PR** rather than silently reconciling.

---

## §3 · Instance 2 — Honest-observe (PR #119)

### §3.1 Situation

PR-M3-4 lint-layer 收官 introduces `backend/tests/lint/no-backtest-service-regression.test.ts` as a **pre-guard** for the eventual PR-M3-2 Frontend legacy `backtestService` elim (T+7d 2026-07-16). At the moment of #119 landing, `grep -rn 'backtestService' frontend/src/` finds **1 consumer**: `frontend/src/components/backtest/BacktestResults.tsx:23`.

### §3.2 Two available responses (only one is honest)

**Fabrication (WRONG)** — silently assert `=== 0`:
```typescript
assert(
  'frontend/src consumers of legacy backtestService === 0',
  offenders.length === 0,
  `offenders=${offenders.length}`
);
```

This is fabrication because (a) it will fail immediately on #119 land (baseline currently has 1 consumer), OR (b) if the offender is quietly deleted first to make the assertion pass, the deletion becomes untracked migration work smuggled into the lint PR, OR (c) if the assertion is wired to only run in some future state, it becomes a silent no-op today. All three variants hide the current-state gap from reviewers.

**Honest-observe (CORRECT · Instance 2 canonical)** — encode current-state exactly with named threshold + tightening obligation:

```typescript
// backend/tests/lint/no-backtest-service-regression.test.ts:89-98

// Baseline residual: BacktestResults.tsx is the last known consumer, awaiting
// PR-M3-2 (Frontend 主签 · T+7d 2026-07-16) migration to `labService`
// BacktestTask.status (id=15 legacy elim). Assertion locks the count from
// growing; PR-M3-2 must tighten this to `=== 0` at land time.
const KNOWN_RESIDUAL = 1;
assert(
  `frontend/src consumers of legacy backtestService <= ${KNOWN_RESIDUAL} (PR-M3-2 pre-guard · post-M3-2 tighten to 0)`,
  offenders.length <= KNOWN_RESIDUAL,
  `offenders=${offenders.length} known-residual=${KNOWN_RESIDUAL}`
);
```

- **Named constant** `KNOWN_RESIDUAL = 1` — the current-state gap is a first-class value, not a magic number
- **Comment block** explicitly names the tightening obligation (PR-M3-2 · Frontend 主签 · T+7d) with the exact edit target (line 93 · single-line change)
- **Assertion is real** — `<= KNOWN_RESIDUAL` fires immediately if a new consumer is added anywhere in `frontend/src/**` (regression protection is real today, not deferred)
- **Wall-of-shame output** — offender list logged to stderr so reviewers can see exactly which file is the residual

### §3.3 Why honest-observe is the canonical direction

Migration debt exists — pretending it doesn't by silently over-asserting either fails CI (breaks the landing) or requires quiet in-place cleanup (smuggles work into an unrelated PR). Neither is acceptable. Encoding the debt as a named constant with a tightening obligation is auditable, testable, and honest.

The threshold constant is the **carrying vessel** for the migration debt: PR-M3-2 lands the elim + tightens the constant to `0` in the same PR. The `KNOWN_RESIDUAL` line becomes zero + comment updates + the pre-guard becomes a regression guard. Single-line edit path.

### §3.4 Lifecycle CLOSE-OUT REALIZED (post-PR #121 · 2026-07-09)

**Instance 2 lifecycle CLOSE-OUT is realized** on 2026-07-09 with the merge of PR #121 (PR-M3-2) at main HEAD `0fb7c96e` (squash-merge from base `aa099594`, mergedAt 2026-07-09T15:38:08Z).

The tightening obligation named in §3.2 was discharged in the exact single-line edit path predicted: at head SHA `0a7f5672`, `backend/tests/lint/no-backtest-service-regression.test.ts:92` transitions

```typescript
- const KNOWN_RESIDUAL = 1;
+ const KNOWN_RESIDUAL = 0;
```

with the accompanying comment block rewritten from *"awaiting PR-M3-2 · must tighten this to `=== 0` at land time"* to *"PR-M3-2 landed · regressions (re-introducing a legacy consumer) now hard-fail CI."* The assertion `offenders.length <= KNOWN_RESIDUAL` is preserved — its semantic transitions from soft-cap (baseline residual) to hard-fail regression guard (post-M3-2) purely by threshold constant flip. Single-line edit path predicted; single-line edit path realized.

Companion consumer elim in the same PR: `frontend/src/services/backtestService.ts` DELETED (271 lines · last consumer), `frontend/src/components/backtest/BacktestResults.tsx` L23 import + L56/L67 call-sites migrated to `labService.getBacktestDetail`. Zero-residual `git grep backtestService pr-121-verify -- 'frontend/src/**'` returns empty at head SHA — the sentinel test is the sole remaining reference, by design (lint-layer hard-gate for regression).

**Byte-truth 独立-verify from 五方**: Cleanup γ msg=1d26dce0, Strategy msg=b33354c1, DP γ msg=19b904b0, Research §S3 msg=7c1bfa57, QADocs msg=e65f0a81 — all five independently ran `gh pr view 121` / `gh pr diff 121` / `git grep` / `gh api contents` and CONCUR'd byte-perfect diff match with Frontend broadcast msg=5fc56cd6. Six-方 副签 阵型 CONCUR unconditional per msg=d0d11677 self-merge authority.

CI 8/8 required-check attestation at merge: Detect changes ✓, Docker compose validate ✓, Frontend check (typecheck + lint) ✓, Backend check (typecheck + lint + test) ✓, enum-matrix-lock (ADR-0011 §5) ✓, no-backtest-service-regression (PR-M3-2 pre-guard · KNOWN_RESIDUAL=0 sentinel hard-fail LIVE) ✓, weak-secrets ✓, paths_filter ✓ (mergeStateStatus=CLEAN, mergeable=MERGEABLE).

Instance 2 is now a **retrospectively-completed** canonical exemplar — the pattern is proved end-to-end (documented residual → tightening obligation → follow-up PR → constant flip + companion elim + assertion semantic transition). Future honest-observe instances that reference §3 now have both the pre-tighten posture (§3.2) and the post-tighten close-out (§3.4) as the full lifecycle template.

---

## §4 · Instance-pattern comparison

| aspect | Instance 1 (truth-sync) | Instance 2 (honest-observe) |
|--------|-------------------------|----------------------------|
| Trigger | Declared ≠ observed, one is authoritative | Migration in progress · current-state ≠ target-state |
| Direction of change | Declared → observed (or code → spec) | Neither side changes — assertion encodes gap with tightening obligation |
| Deliverable | Independent surfacing PR (§3 close-out later) | Named threshold constant + comment + follow-up PR tightens |
| Failure mode fabricated | Silent mutation in same commit | Silent over-assertion |
| Detection | Reviewers of unrelated PR see manufactured agreement | Assertion either fails on land or is a no-op silently |
| Canonical exemplar | PR #118 baseline `83aea69c` → `3246b8cf` sync | PR #119 `KNOWN_RESIDUAL=1` at `no-backtest-service-regression.test.ts:93` (baseline) → PR #121 `KNOWN_RESIDUAL=0` at `.test.ts:92` (tighten realized §3.4) |

---

## §5 · Formation LOCK

Two canonical instances now exist in-repo. Future occurrences of either pattern reference this doc + one of the exemplars. If a novel pattern emerges (e.g. multi-way divergence, three-instance formation), that pattern is added as Instance 3+ here — never as a silent innovation.

---

## §6 · Cross-refs

- `docs/refactor/quality/escalation-over-invention-canonical.md` (companion 铁律 · 四段-lifecycle)
- `docs/refactor/quality/qadocs-ui-enum-lock-sop.md` §六 (v2.0 seal · 反-fabrication canonical anchor)
- `docs/refactor/quality/m3-series-completion-cert.md` §4 (二例 formation LOCK attestation)
- `docs/refactor/adr/0011-ui-enum-single-source-of-truth.md` §6 (post-M3-4 lint-hardening)
- `docs/refactor/dod-checklist.md` §17.5 (self-apply ledger)

---

**反-Fabrication canonical 二例 formation LOCK REALIZED** post-M3 series 收官 `93dee066`. Instance 2 **lifecycle CLOSE-OUT REALIZED** post-PR #121 land at main HEAD `0fb7c96e` (see §3.4). Future truth-sync + honest-observe occurrences follow these patterns by policy.
