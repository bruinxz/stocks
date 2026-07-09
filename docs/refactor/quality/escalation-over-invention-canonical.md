# Escalation-Over-Invention Canonical (四段-Lifecycle)

**Status:** canonical formalize (post-M3 series 收官 `93dee066`)
**Author:** QADocs 主签
**Exemplar in-repo:** PR #116 → #118 → #119 (M3 UI-enum SSOT series)

---

## §1 · Statement (铁律)

When declared authority (baseline, spec, doc, test assertion) is discovered to diverge from code-truth mid-work, the correct response is to **escalate the divergence to an independent PR** that surfaces it, not to **invent** a silent in-place reconciliation that hides the divergence from reviewers.

**Never**:
- Silently mutate the declared side in the same commit that lands the code change
- Silently mutate the code side in the same commit that lands the doc/baseline change
- Delete a failing assertion to make CI green
- Weaken an assertion past current-state without documenting the residual

**Always**:
- Skip the failing assertion with `xit()` / equivalent and encode the **reason** as a string pointing to the escalation PR
- File the escalation PR as an independent unit of review with a single clear diff
- Once the escalation PR lands, follow with a **close-out PR** that re-hydrates the live assertion against the newly-authoritative state

---

## §2 · Four-段 lifecycle

| 段 | Stage | Action | Deliverable |
|----|-------|--------|-------------|
| §1 | **Discover** | Mid-PR, an assertion fails or a check reveals declared-vs-code divergence | `xit()` skip with `reason` string pointing to follow-up PR |
| §2 | **Escalate** | Do not attempt in-place reconciliation. File a separate, single-purpose PR for the truth-sync | commit message + PR body reference back to §1 discovery PR |
| §3 | **Surface** | The escalation PR lands the truth-sync authoritatively — single-domain change, minimal blast radius | authoritative baseline/doc/code sync + updated `sha_lock` / version note |
| §4 | **Close** | A subsequent PR re-hydrates the live assertion against the post-§3 authoritative state + hardens with additional guards | live-assertion set + any additional invariants uncovered during §1-§3 |

---

## §3 · Canonical exemplar — M3 UI-enum SSOT series (PR #116 → #118 → #119)

### §3.1 Discover (PR #116)

`backend/tests/enum/enum-matrix-lock.test.ts` was added with a live probe intended to assert `QuantWorkflowStatus` value_set matches baseline id=4. Mid-PR, the baseline (`83aea69c` id=4) was found to declare `healthy/degraded/unhealthy` while backend authority (`QuantWorkflowReadinessService.ts:8`) pinned `ready/degraded/blocked`.

**Response**: assertion wrapped in `xit()` with reason string referencing the Baseline-fix independent PR to be filed. PR #116 lands the barrel authority + IIFE test skeleton; the drift is documented in ADR-0011 §5(d) as an explicit pending item.

### §3.2 Escalate (PR #116 same commit)

The `xit()` skip explicitly names the follow-up scope (Baseline-fix independent PR · QADocs 主签 · SLA T+2d). ADR-0011 §5(d) records the escalation obligation in-tree so no cross-turn memory is required.

### §3.3 Surface (PR #118)

Baseline-fix independent PR authoritatively updates:
- `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-83aea69.json` id=4 value_set → `["ready","degraded","blocked"]`
- id=10 alias mirror sync
- `sha_lock` renames `83aea69c` → `3246b8cf` (filename slug + content field both updated)
- `authority_file` explicit-pin `backend/src/quant/workflow/QuantWorkflowReadinessService.ts:8`

Zero backend code touch. Zero test-file touch. Single-domain diff. Reviewer sees the truth-sync in isolation.

### §3.4 Close (PR #119)

`enum-matrix-lock.test.ts` re-hydrates id=4 live-assert against post-#118 canonical value_set. Additionally hardens with 21 more assertions (full 15-entry count, decision enum whitelist, id=10 mirror-invariant, id=13 domain-independence, sha_lock filename-content self-consistency, decision_summary integrity, value_set non-empty, authority_file non-empty). Total 23 assertions LIVE. Plus `no-backtest-service-regression.test.ts` 2 assertions. Plus `.github/workflows/enum-lint.yml` 二 required jobs.

**Lifecycle CLOSED.**

---

## §4 · Anti-patterns (what escalation-over-invention prevents)

### §4.1 In-place invention

```
// WRONG — invent agreement by silently mutating in the same commit that lands the test
- QuantWorkflowStatus = ['ready', 'degraded', 'blocked']  // backend
+ QuantWorkflowStatus = ['healthy', 'degraded', 'unhealthy']  // silently changed to match baseline
```

Even if the mutation is "correct" in some abstract sense, doing it in-place in the assertion-landing PR **hides the divergence** from reviewers who assume the test was designed against the current authority.

### §4.2 Silent skip

```typescript
// WRONG — silent skip with no escalation obligation encoded in-repo
xit('QuantWorkflowStatus value_set matches baseline', () => { ... });
```

A skip without a reason string + follow-up PR reference decays into permanent skip debt.

### §4.3 Delete-to-green

```typescript
// WRONG — delete failing assertion to make CI green
// (removed: 'QuantWorkflowStatus value_set matches baseline')
```

Deletion loses the discovered invariant entirely. Even a broken assertion is more valuable than a deleted one — it marks a divergence worth resolving.

---

## §5 · When escalation-over-invention applies

- baseline JSON vs code enum drift
- ADR-declared behavior vs implementation drift
- contract schema vs actual response payload drift
- test assertion vs current-state divergence (residual known-consumer counts, pending migration debt)
- any doc-declared invariant discovered false at runtime

---

## §6 · When it does NOT apply

- **Pure code refactor** with no declared-state involvement (no baseline, no ADR, no test invariant) — refactor in-place
- **Green-field addition** where declared state and code state are being written together for the first time — no divergence to escalate
- **Hotfix + follow-up docs** where the code change is urgent and docs sync is a separate acknowledged item (equivalent pattern: hotfix lands as §3 surface, docs-sync lands as §4 close, no §1/§2 needed since divergence was expected)

---

## §7 · Cross-refs

- ADR-0011 §5(d) + §6 (M3 UI-enum SSOT canonical exemplar)
- `docs/refactor/quality/anti-fabrication-canonical.md` (companion 铁律 · 反-fabrication canonical 二例 formation LOCK)
- `docs/refactor/quality/m3-series-completion-cert.md` §3 (lifecycle CLOSED attestation)
- `docs/refactor/dod-checklist.md` §17.5 (self-apply ledger — PR #116/#118/#119 as 12/14/22 例)

---

**Escalation-over-invention 铁律 canonical formalize LANDED** post-M3 series 收官 `93dee066`. Future drift-vs-authority conflicts follow this pattern by policy.
