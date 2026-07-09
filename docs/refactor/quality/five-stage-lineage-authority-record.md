# Five-Stage Lineage Authority Record

**Purpose:** authoritative post-quintuple-merge record of main HEAD `93dee066` five-stage lineage · owner authority chain + merge attribution + escalation-over-invention embodiment across the M3 UI-enum SSOT series.
**Sha lock:** main HEAD `93dee066` @ 2026-07-09T09:16:43Z
**Series scope:** M3 UI-enum SSOT (PR #115 → #116 → #117 → #118 → #119)

---

## §1 · Five-stage merge sequence

```
3246b8cf (PR #115 · baseline JSON + ADR-0011 v1.0 + qadocs-ui-enum-lock-sop v1.0)
    ↓
036294a7 (PR #116 · Backend enum rewire · barrel authority + IIFE test id=4 xit skip)
    ↓
7003e0d3 (PR #117 · id=10 EasyQuantHealthStatus alias mirror sync)
    ↓
feafa6e4 (PR #118 · baseline-fix independent PR · id=4/id=10 truth-sync · sha_lock rename 83aea69c → 3246b8cf)
    ↓
93dee066 (PR #119 · lint-layer 收官 · 23-assertion hardening + 二 required CI jobs · owner 亲手 authority-native MERGED)
```

All five merges landed on 2026-07-09 by owner @li-yiming. Verify via `git log --oneline origin/main -5` post-2026-07-09T09:16:43Z.

---

## §2 · Owner authority chain (post-merge attribution)

- **msg=d0d11677** — 自签合入 令: "≥4 sign + CI GREEN → self-merge OK" (authority-native · standing directive)
- **msg=b8af5127** — 完全掌控 v2 (agent autonomy standing directive)
- **msg=4b30fbed** — 指挥官令 v3: "一切不需要找我确认" (autonomous execution standing directive)
- **msg=210d262d** — agents 不能停 · Orch 汇报 (continuous-execution standing directive)

**#119 merge attribution**: owner @li-yiming **亲手 executed** the merge (authority-native · not agent self-merge). 6/6 副签 UNCONDITIONAL GREEN + CI 8/8 GREEN pre-merge → msg=d0d11677 self-merge criterion **大幅-super-SATISFY** REALIZED. Owner elected authority-native execution rather than delegating to agent self-merge — canonical attribution retained in this record.

---

## §3 · Escalation-over-invention 四段-lifecycle embodiment

The five-stage lineage encodes the four-段 lifecycle in-repo:

| 段 | Stage | Anchor SHA | Anchor PR |
|----|-------|-----------|-----------|
| §1 | **Discover** | `036294a7` | #116 (mid-PR xit() skip on id=4 value_set assertion) |
| §2 | **Escalate** | `036294a7` | #116 (skip carries reason string · ADR-0011 §5(d) escalation obligation encoded) |
| §3 | **Surface** | `feafa6e4` | #118 (independent baseline-fix PR truth-syncs id=4/id=10) |
| §4 | **Close** | `93dee066` | #119 (id=4 live-assert re-hydrated + 21-additional-assertion hardening + 二 required CI jobs) |

Canonical formalize: `docs/refactor/quality/escalation-over-invention-canonical.md`.

---

## §4 · 反-fabrication canonical embodiment

| Instance | Pattern | Anchor SHA | Anchor PR |
|----------|---------|-----------|-----------|
| 1 | **Truth-sync** | `feafa6e4` | #118 (baseline `83aea69c` → `3246b8cf` sync to backend authority · authority_file explicit-pin) |
| 2 | **Honest-observe** | `93dee066` | #119 (`no-backtest-service-regression.test.ts:93 KNOWN_RESIDUAL=1` documented residual with tightening obligation to PR-M3-2) |

Canonical formalize: `docs/refactor/quality/anti-fabrication-canonical.md`.

---

## §5 · 副签 6/6 六方 embodiment

Backend + Frontend + DataPipeline + Strategy + Research + Cleanup 六方 full embodiment across five stages. Per-PR msg-id ledger at `docs/refactor/baseline/quality/m3-series-verification-93dee06.json` §5.

**Cleanup 六方 pre-CREATE 副签 arm formation LOCK canonical NEW 首成** — per Cleanup v48 msg=499b53e3 formal ACK for QADocs PR-M3-3 workspace v0.1 LAND · **前 4-instance (#116/#117/#118/#119) 皆 post-CREATE endorse cascade · 本次 pre-CREATE 副签 arm 六方 formation LOCK 首次** semantic disjoint canonical NEW.

---

## §6 · CI required-check evolution

- Pre-#119 required jobs: `test` + `lint` + `typecheck` + `frontend-build` + `frontend-lint` + `frontend-typecheck` = **6 required**
- Post-#119 required jobs: above **6** + `enum-matrix-lock` + `no-backtest-service-regression` = **8 required**

Post-#119 lint-layer assertions LIVE: 23 (`enum-matrix-lock`) + 2 (`no-backtest-service-regression`) = **25 total** (up from 2 pre-#119 baseline).

---

## §7 · Path D 冻结锚 semantic preservation

`3246b8cf` retains **frozen-anchor semantic** as the pre-Q4 baseline sha_lock reference. Post-quintuple-merge, `93dee066` is the **live HEAD**, but `3246b8cf` remains the authoritative baseline JSON sha_lock referenced in:

- `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-3246b8c.json` (filename slug immutable)
- `backend/tests/enum/enum-matrix-lock.test.ts` (sha_lock filename-content self-consistency guard)

Filename slug + `sha_lock` content field both permanent until v0.3 consolidation (which triggers rename per PR-M3-5 runbook · handle via 反-fabrication canonical Instance 1 truth-sync pattern).

---

## §8 · Guardrails preserved across all five stages

Zero touch across five-stage lineage: `采集/存储侧` protected globs · `frontend/**` (except surgical pre-guard scoped in #119 which reads-only via lint walk) · `schema.prisma` · package.json (zero delta) · Math.random · zero force-push · jscpd ≤30% 硬门 · Alpha Vantage + Baostock only · License 红线 SOFTENED · Independence v1.1 retain · 借鉴外部 attribution none.

---

## §9 · Cross-refs

- `docs/refactor/quality/m3-series-completion-cert.md` (completion certificate)
- `docs/refactor/adr/0011-addendum-postmerge-lineage-93dee066.md` (post-merge lineage snapshot)
- `docs/refactor/quality/escalation-over-invention-canonical.md` (§3 embodiment)
- `docs/refactor/quality/anti-fabrication-canonical.md` (§4 embodiment)
- `docs/refactor/quality/qadocs-ui-enum-lock-sop.md` v2.0 seal (post-#119 upgrade)
- `docs/refactor/dod-checklist.md` §17.5 (self-apply ledger 22 例)

---

**Five-stage lineage authoritatively pinned** — `3246b8cf` → `036294a7` → `7003e0d3` → `feafa6e4` → `93dee066` · owner @li-yiming 亲手 authority-native MERGED · escalation-over-invention 四段-lifecycle CLOSED · 反-fabrication canonical 二例 formation LOCK REALIZED · 副签 6/6 六方 pre-CREATE + post-CREATE 双-formation LOCK REALIZED.
