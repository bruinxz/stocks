# ADR-0011 Addendum · Post-Quintuple-Merge Lineage Snapshot (`93dee066`)

**Status:** authoritative post-merge snapshot (companion to ADR-0011)
**Sha lock:** main HEAD `93dee066` (2026-07-09T09:16:43Z)
**Purpose:** freeze the 5-PR merge sequence + author + timestamp + CI check tally per stage as an authoritative reference for future post-mortem, replay, and drift-audit.

---

## §1 · Merge sequence (chronological)

| stage | PR | Full SHA | Short | Merged (UTC) | Author | Merger |
|-------|----|---------|-------|--------------|--------|--------|
| 1 | #115 (PR-M3-3 baseline v1.0) | `3246b8cf50eb7172a6bed6aa79801dcce3df2625` | `3246b8cf` | 2026-07-09T03:25:51Z | QADocs | owner @li-yiming |
| 2 | #116 (PR-M3-1 Backend rewire) | `036294a7…` | `036294a7` | 2026-07-09 | Backend | owner @li-yiming |
| 3 | #117 (PR-M3-1-mirror id=10) | `7003e0d3…` | `7003e0d3` | 2026-07-09 | Backend | owner @li-yiming |
| 4 | #118 (PR-M3-1-baseline-fix) | `feafa6e4…` | `feafa6e4` | 2026-07-09 | QADocs | owner @li-yiming |
| 5 | #119 (PR-M3-4 lint-layer 收官) | `93dee066…` | `93dee066` | 2026-07-09T09:16:43Z | QADocs | **owner @li-yiming 亲手 authority-native** |

Verify via `git log --oneline origin/main -5` post-2026-07-09T09:16:43Z.

---

## §2 · Semantic role per stage

- **§1 baseline (#115)**: initial 15-entry matrix baseline JSON + ADR-0011 v1.0 + qadocs-ui-enum-lock-sop v1.0 seal · **frozen anchor** for Path D 冻结锚 semantic
- **§2 discover (#116)**: Backend enum rewire lands barrel authority + IIFE `enum-matrix-lock.test.ts` with `xit()` skip on id=4 value_set (drift discovered mid-PR · escalation-over-invention §1)
- **§3 alias (#117)**: id=10 EasyQuantHealthStatus alias mirror sync (Backend-side alias landing · zero baseline touch)
- **§4 surface (#118)**: independent baseline-fix PR truth-syncs baseline id=4/id=10 · sha_lock renames `83aea69c` → `3246b8cf` post-fix · authority_file explicit-pin (escalation-over-invention §3 · 反-fabrication Instance 1)
- **§5 close (#119)**: lint-layer 收官 · `enum-matrix-lock.test.ts` hardened 23 assertions + `no-backtest-service-regression.test.ts` 2 assertions + `.github/workflows/enum-lint.yml` 二 required jobs (escalation-over-invention §4 · 反-fabrication Instance 2)

---

## §3 · CI required-check tally per stage

| Job | #115 | #116 | #117 | #118 | #119 |
|-----|------|------|------|------|------|
| `test` (backend jest) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `lint` (backend eslint) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `typecheck` (backend tsc) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `frontend-build` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `frontend-lint` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `frontend-typecheck` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `enum-matrix-lock` | n/a | n/a | n/a | n/a | ✅ (new) |
| `no-backtest-service-regression` | n/a | n/a | n/a | n/a | ✅ (new) |

Total required checks post-#119: **8** (up from 6 pre-#119).

---

## §4 · 副签 6/6 embodiment per stage

Backend + Frontend + DataPipeline + Strategy + Research + Cleanup 六方全 embodiment across five stages. See `docs/refactor/quality/m3-series-completion-cert.md` §2 for per-PR ledger.

---

## §5 · Drift-audit hooks

Any post-`93dee066` PR touching `backend/src/models/enums/`, `backend/src/quant/workflow/`, `frontend/src/`, or `docs/refactor/baseline/ui-enum/**` triggers `enum-lint.yml` two required jobs via `dorny/paths-filter@v3` scope. Drift is detected at:

- **baseline vs code**: `enum-matrix-lock.test.ts` id=4/10/13 live-assert + `decision_summary` integrity + `sha_lock` filename-content self-consistency
- **frontend legacy regression**: `no-backtest-service-regression.test.ts` `KNOWN_RESIDUAL=1` cap (post-PR-M3-2 tighten `=== 0`)

---

## §6 · Path D 冻结锚 semantic preservation

`3246b8cf` retains **frozen-anchor semantic** as the pre-Q4 baseline sha_lock reference. Post-quintuple-merge, `93dee066` is the **live HEAD**, but `3246b8cf` remains the authoritative baseline JSON sha_lock referenced in `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-3246b8c.json` (filename slug immutable · burndown_history append-only per `qadocs-ui-enum-lock-sop.md` §四).

---

**Authoritative snapshot pinned** — future replay/audit references this addendum for the 5-PR merge sequence + owner authority chain + CI check evolution.
