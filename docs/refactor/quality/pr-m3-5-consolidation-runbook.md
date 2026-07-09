# PR-M3-5 Consolidation Runbook · Enum Matrix v0.3 (31 → 33)

**Purpose:** roadmap the v0.3 baseline consolidation absorbing Path AN/AO/AP additions (15 → 31 → 33 canonical entries).
**Origin:** post-#119 M3 series 收官 backlog · workspace `notes/pr-m3-5-v0.3-enum-matrix-consolidation-workspace-draft.md` (Task #60).
**SLA:** no fixed date — fires when Path AN/AO/AP LAND stabilizes; consolidation is opportunistic, not blocking.

---

## §1 · Scope

Grow baseline `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-3246b8c.json` from 15-entry matrix to 33-entry via two absorption waves:

- **Wave 1**: Path AN adds → 15 → 31 (v0.2 patch bump candidate)
- **Wave 2**: Path AO + AP adds → 31 → 33 (v0.3 patch bump)

Filename slug remains `-3246b8c.json` (append-only per SOP §四) OR renames to `<new-sha>` if `decision_summary` totals change (schema-consistency guard fires · handle via same 反-fabrication canonical Instance 1 truth-sync pattern as #118 baseline-fix).

---

## §2 · Absorption checklist per new entry

For each new enum entry to append, verify + record:

1. **enum_name**: canonical name (no alias · no abbreviation)
2. **path_anchor**: Path label (Path AN.x / AO.x / AP.x)
3. **authority_file**: `<repo-path>:<line>` explicit-pin (e.g. `backend/src/models/enums/foo.ts:12`)
4. **value_set**: literal `["a","b","c"]` array · lowercase · no aliases
5. **authority_layer**: string describing authority tier (`Backend enum source`, `PG DDL`, `Zod schema`, etc.)
6. **decision**: one of `AUTHORITY | ELIM | RETAIN`
7. **duplication_with**: array of other enum ids sharing shape or semantic overlap (null if none)
8. **consumer_scope**: array of consumer surfaces (`Frontend read-only`, `PG serde`, etc.)

Update `decision_summary` counts + arrays. Update `total` field. Update filename slug if sha changes.

Append `burndown_history` entry with landing SHA + author + timestamp + one-line summary per SOP §四 canonical pattern.

---

## §3 · CI verify (post-wave)

`enum-matrix-lock.test.ts` currently asserts `matrix.length === 15`. Consolidation waves require **coordinated update**:

- Wave 1 land: bump assertion literal `matrix.length === 15` → `=== 31` in same PR as baseline JSON grows (assertion + baseline moved atomically)
- Wave 2 land: `=== 31` → `=== 33`

`decision_summary.RETAIN_count === 10` and companion asserts also require coordinated bump per new decision distribution. Update assertion literal at land time — do NOT silently pre-emptively over-count (反-fabrication canonical Instance 2 · honest-observe pattern).

---

## §4 · Guardrails

- Zero backend/src/** touch (enum authority files are the entries' authority-pins, they exist already · consolidation only appends baseline JSON entries + assertion count updates)
- Zero frontend/src/** touch (consumer scope grows only if a new consumer surfaces during audit · that's a separate PR)
- Path C 零触碰 · SSH zero · PG SELECT-only · zero package.json touch
- Independence v1.1 · License 红线 SOFTENED retain

---

## §5 · Ordering vs PR-M3-2

PR-M3-2 (Frontend legacy backtestService elim) lands before or after v0.3 consolidation — no ordering constraint. If PR-M3-2 lands first, id=15 marked `elim_landed=true` in v0.3 baseline (documentation only · no assertion change since id=15 decision remains `ELIM`).

If v0.3 lands first, PR-M3-2 lands against the 33-entry baseline · `no-backtest-service-regression.test.ts` untouched (this test is orthogonal to the matrix count).

---

## §6 · 反-fabrication canonical application

New entries per §2 checklist are **entirely observed** from real code — no invention:
- `enum_name` = actual `export type Foo = ...` name in source
- `authority_file` = `grep -rn` verified path + line
- `value_set` = literal array from source, not paraphrased
- `authority_layer` = concrete tier (Backend enum, PG DDL, Zod)
- `decision` = defensible per ADR-0011 §4 policy (AUTHORITY if source-of-truth, ELIM if duplicate slated for removal, RETAIN if legitimate parallel use)

If an entry's declared vs observed diverges during authoring, apply escalation-over-invention: file the truth-sync as an independent PR before consolidation lands (avoiding same-commit invention).

---

## §7 · Cross-refs

- workspace draft: `notes/pr-m3-5-v0.3-enum-matrix-consolidation-workspace-draft.md`
- baseline: `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-3246b8c.json` (schema authority)
- SOP: `docs/refactor/quality/qadocs-ui-enum-lock-sop.md` (§四 versioning + §四a re-hydration precedent)
- ADR-0011 §3 §4 (policy + burden)
- `docs/refactor/quality/escalation-over-invention-canonical.md` (surface-before-close pattern)
- `docs/refactor/quality/anti-fabrication-canonical.md` (truth-sync + honest-observe)

---

**Runbook armed · v0.3 consolidation fires when Path AN/AO/AP stabilize.** No SLA · opportunistic. Ordering vs PR-M3-2 unconstrained.
