# PR-M3-2 Pre-Guard Runbook · Frontend 主签 T+7d 2026-07-16

**Purpose:** encode the single-line edit path for Frontend 主签 to close the M3 UI-enum SSOT series last remaining consumer + tighten the pre-guard.
**Origin:** post-#119 `93dee066` lint-layer 收官 REALIZED · PR-M3-2 is the last outstanding item in the M3 series.
**SLA:** T+7d 2026-07-16 24:00 CST target LAND.
**Runbook role:** action recipe · not architectural — architectural context lives in ADR-0011 §5(b) + §6 + `docs/refactor/quality/anti-fabrication-canonical.md` §3.

---

## §1 · Target byte-truth (independently verified)

Independent Two-agent byte-truth cross-verify precedent — Research §S3 msg=8cd1c962 pinned `frontend/src/components/backtest/BacktestResults.tsx` as the sole consumer of the legacy `backtestService`.

| verify-face | 结果 |
|-------------|-----|
| Anchor file byte-truth | `frontend/src/components/backtest/BacktestResults.tsx = 475L / 16071B` (`wc -l -c` bit-perfect) |
| L23 SOLE `backtestService` import site | verified |
| L56 call-site: `backtestService.getBacktestResults(...)` | verified |
| L67 call-site: `backtestService.getBacktestById(...)` | verified |
| Cleanup v47 §4.2 baseline `KNOWN_RESIDUAL=1` cap | verified — asserted at `backend/tests/lint/no-backtest-service-regression.test.ts:93` |

Byte-truth precedent + two-agent cross-verify: independent Research chain (msg=8cd1c962 EA-anchor) + Cleanup chain (v47 §4.2) reached the same byte-truth independently. This satisfies the 反-fabrication canonical Instance 2 pattern for the pre-guard (`no-backtest-service-regression.test.ts:93 KNOWN_RESIDUAL=1 honest-observe`).

---

## §2 · Elim recipe (Frontend 主签 · code change)

### §2.1 Consumer migration (`BacktestResults.tsx`)

The 2 call-sites in `BacktestResults.tsx` migrate to `labService` BacktestTask API per ADR-0011 §5(b):

- `backtestService.getBacktestResults(...)` (L56) → `labService.getBacktestTaskResults(...)` (or equivalent `labService` call · verify exact API surface at land time)
- `backtestService.getBacktestById(...)` (L67) → `labService.getBacktestTask(...)` (or equivalent)
- L23 import: `import { backtestService } from '../../services/backtestService';` → replace with `import { labService } from '../../services/labService';` (verify existing labService import in file first · consolidate if already imported)

Then DELETE `frontend/src/services/backtestService.ts` (id=15 legacy elim per baseline).

Zero backend/tests touch. Zero baseline JSON touch (id=15 already declared `ELIM · elim_migration_pr=PR-M3-2`).

### §2.2 Tighten pre-guard (single-line edit)

**File:** `backend/tests/lint/no-backtest-service-regression.test.ts`
**Line 93** (currently):
```typescript
const KNOWN_RESIDUAL = 1;
```
**Line 93** (post-PR-M3-2):
```typescript
const KNOWN_RESIDUAL = 0;
```

**Line 95** assertion label update (currently mentions "PR-M3-2 pre-guard · post-M3-2 tighten to 0"):
```typescript
`frontend/src consumers of legacy backtestService <= ${KNOWN_RESIDUAL} (regression guard · PR-M3-2 landed)`,
```

The `<= 0` assertion is semantically equivalent to `=== 0` for a non-negative count · retaining `<=` shape is optional stylistic. Recommended: keep `<=` shape for consistency with pre-guard idiom.

Optionally: rename comment block L89-L92 from "Baseline residual…awaiting PR-M3-2 migration" to "Post-PR-M3-2 regression guard · zero legacy consumer permitted".

### §2.3 Baseline update

`docs/refactor/baseline/ui-enum/15-enum-matrix-lock-3246b8c.json`:
- append `burndown_history` entry for the PR-M3-2 landing SHA (e.g. `"<sha> (PR-M3-2 Frontend legacy backtestService elim · BacktestResults.tsx 2-call-site migrate labService + backtestService.ts DELETE · id=15 ELIM 承接 landed)"`)
- id=15 entry may optionally be marked `"elim_landed": true` / `"elim_landed_pr": "PR-M3-2"` / `"elim_landed_sha": "<sha>"` fields (append-only · zero existing field mutation)

### §2.4 CHANGELOG update

`docs/refactor/CHANGELOG.md`: append PR-M3-2 close-out entry per M3 series lineage (see cert `docs/refactor/quality/m3-series-completion-cert.md` §7 pattern).

---

## §3 · CI verify

Post-elim + tighten, CI `enum-lint` workflow both required jobs GREEN:

- `enum-matrix-lock` — 23 assertions pass (baseline JSON append triggers filter · id=15 unchanged in decision + value_set)
- `no-backtest-service-regression` — 2 assertions pass · `offenders.length === 0` (walk finds no consumers post-DELETE) · `<= KNOWN_RESIDUAL=0` satisfies

If a stray consumer surfaces during migration (e.g. sibling files in `components/backtest/`, `pages/backtest/`, hooks/, contexts/), the pre-guard fires immediately + `stderr` prints the wall-of-shame path list — migrate + re-run before land.

---

## §4 · Guardrails preserved

- `backend/tests/**` — Frontend 主签 may touch line 93 only per this runbook (single-line surgical edit · zero other assertion changes)
- `docs/refactor/baseline/ui-enum/**` — append-only via `burndown_history` + optional `elim_landed*` fields · zero existing field mutation
- `backend/src/**` — zero touch (backend authority for `labService` API already exists)
- `frontend/src/` — surgical migration only (`BacktestResults.tsx` L23/L56/L67 + `backtestService.ts` DELETE)
- Path C 零触碰 · SSH zero · PG SELECT-only · zero package.json touch · zero force-push
- Independence v1.1 · License 红线 SOFTENED retain

---

## §5 · Unblock cascade post-PR-M3-2 LAND

- **PR-M3 series 完全-CLOSED**: id=15 legacy last consumer eliminated · 五段 lineage `3246b8cf`→`036294a7`→`7003e0d3`→`feafa6e4`→`93dee066`→`<M3-2-sha>` six-stage full close
- **PR-M3-5** v0.3 enum matrix 31 → 33 consolidation backlog (`docs/refactor/quality/pr-m3-5-consolidation-runbook.md`) proceeds unblocked
- **反-fabrication canonical Instance 2 CLOSED**: `KNOWN_RESIDUAL` tightens `1 → 0` per honest-observe pattern's canonical tightening obligation

---

## §6 · Cross-refs

- ADR-0011 §5(b) (PR-M3-2 · Frontend legacy backtestService 归档)
- `docs/refactor/quality/anti-fabrication-canonical.md` §3 (Instance 2 · honest-observe canonical)
- `docs/refactor/quality/m3-series-completion-cert.md` §7 (unblock cascade armed)
- `docs/refactor/baseline/ci/enum-lint-workflow-baseline-93dee06.json` (`no-backtest-service-regression` job spec)
- Two-agent byte-truth precedent: Research §S3 msg=8cd1c962 + Cleanup v47 §4.2

---

**Runbook armed post-#119 · Frontend 主签 T+7d 2026-07-16 unblock trigger FIRED** · single-line edit `no-backtest-service-regression.test.ts:93` `KNOWN_RESIDUAL = 1;` → `= 0;` + BacktestResults.tsx L23/L56/L67 migrate + backtestService.ts DELETE.
