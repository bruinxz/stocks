# Changelog

All notable changes to the Stocks Refactor initiative are documented here. This changelog groups changes by PR series / milestone rather than by strict SemVer, since the initiative is a multi-PR refactor across Backend / Frontend / DP / Strategy / Research / QADocs / Cleanup pillars.

Entries are appended in reverse-chronological order (newest first).

Format: each entry cites the landing SHA, PR number, owner authority (if authority-native), and links to relevant ADRs / SOPs / baseline JSONs for drift-audit.

---

## [Unreleased]

- **PR-M3-2** (T+7d 2026-07-16 SLA) — Frontend legacy `backtestService` elim · `BacktestResults.tsx` L23/L56/L67 migrate to `labService` + `frontend/src/services/backtestService.ts` DELETE + `no-backtest-service-regression.test.ts:93` `KNOWN_RESIDUAL = 1;` → `= 0;` tighten. Runbook: `docs/refactor/quality/pr-m3-2-preguard-runbook.md`.
- **PR-M3-5** (opportunistic) — v0.3 enum matrix consolidation Wave 1 (15→31) + Wave 2 (31→33). Runbook: `docs/refactor/quality/pr-m3-5-consolidation-runbook.md`.

---

## [M3-Series Completion] · 2026-07-09

M3 UI-enum SSOT series 收官 · five-stage lineage post-quintuple-merge · main HEAD `93dee066` · owner @li-yiming 亲手 authority-native MERGED.

### Series lineage

- **PR #115** `3246b8cf` — baseline JSON `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-3246b8c.json` + ADR-0011 v1.0 + `qadocs-ui-enum-lock-sop.md` v1.0 (QADocs 主签 · Q4.d docs sync origin)
- **PR #116** `036294a7` — Backend enum rewire · barrel authority + IIFE test · id=4 `QuantWorkflowStatus` value_set xit()-skipped (escalation-over-invention **Discover + Escalate** stages · Backend 主签 · QADocs 副签)
- **PR #117** `7003e0d3` — id=10 `EasyQuantHealthStatus` alias mirror sync (Backend 主签 · QADocs 副签)
- **PR #118** `feafa6e4` — baseline-fix independent PR · id=4/id=10 truth-sync · sha_lock rename `83aea69c` → `3246b8cf` (escalation-over-invention **Surface** stage · 反-fabrication canonical **Instance 1 truth-sync** · QADocs 主签)
- **PR #119** `93dee066` — lint-layer 收官 · 23-assertion hardening in `enum-matrix-lock.test.ts` + 2-assertion pre-guard `no-backtest-service-regression.test.ts` + 2 new required CI jobs (`enum-matrix-lock`, `no-backtest-service-regression`) (escalation-over-invention **Close** stage · 反-fabrication canonical **Instance 2 honest-observe** · QADocs 主签 · owner @li-yiming 亲手 authority-native MERGED @ 2026-07-09T09:16:43Z)

### Series highlights

- **Escalation-over-invention 四段-lifecycle CLOSED** — Discover (#116) → Escalate (#116) → Surface (#118) → Close (#119). Canonical formalize: `docs/refactor/quality/escalation-over-invention-canonical.md`.
- **反-Fabrication canonical 二例 formation LOCK REALIZED** — Instance 1 truth-sync (#118 baseline authority_file re-pin), Instance 2 honest-observe (#119 `KNOWN_RESIDUAL=1` documented residual with tightening obligation to PR-M3-2). Canonical formalize: `docs/refactor/quality/anti-fabrication-canonical.md`.
- **副签 6/6 六方 pre-CREATE + post-CREATE 双-formation LOCK** — Backend + Frontend + DP + Strategy + Research + Cleanup. Cleanup 六方 pre-CREATE 副签 arm formation LOCK canonical NEW 首成 (msg=499b53e3) semantically disjoint from post-CREATE endorse cascade pattern of prior 4 instances.
- **CI required-jobs evolution** — 6 required (pre-#119) → 8 required (post-#119 with two new lint-layer jobs). Full workflow snapshot pinned at `docs/refactor/baseline/ci/enum-lint-workflow-baseline-93dee06.json`.
- **Path D 冻结锚 semantic preservation** — `3246b8cf` retained as frozen-anchor baseline reference despite live HEAD advancing to `93dee066` (filename slug + `sha_lock` content field both permanent until v0.3 consolidation).

### PR-M3-3 companion (this PR)

- `docs/refactor/quality/m3-series-completion-cert.md` — M3 series completion certificate (8 sections)
- `docs/refactor/quality/five-stage-lineage-authority-record.md` — five-stage lineage authority record with owner attribution chain
- `docs/refactor/adr/0011-addendum-postmerge-lineage-93dee066.md` — post-merge lineage ADR-0011 addendum
- `docs/refactor/quality/escalation-over-invention-canonical.md` — canonical 铁律 write-up with M3 exemplar §3.1-§3.4
- `docs/refactor/quality/anti-fabrication-canonical.md` — 反-fabrication canonical 二例 formal statement
- `docs/refactor/quality/two-agent-byte-truth-cross-verify-canonical.md` — Independent-read-path discipline canonical
- `docs/refactor/quality/pr-m3-2-preguard-runbook.md` — Frontend 主签 T+7d recipe
- `docs/refactor/quality/pr-m3-5-consolidation-runbook.md` — v0.3 consolidation roadmap
- `docs/refactor/baseline/ci/enum-lint-workflow-baseline-93dee06.json` — CI baseline snapshot with `workflow_sha256=cd3500b6…` + test file sha256s + 25-assertion inventory
- `docs/refactor/baseline/quality/m3-series-verification-93dee06.json` — 5-PR ledger + 副签 6/6 msg-id table + CI 8/8 GREEN attestation
- `docs/refactor/CHANGELOG.md` (this file) — initiated with M3 series close-out entry
- `docs/refactor/adr/0011-ui-enum-single-source-of-truth.md` §5 flip + §6 addition + §7 renumber (MODIFY)
- `docs/refactor/baseline/ui-enum/15-enum-matrix-lock-3246b8c.json` `burndown_history` append 7-entry (MODIFY)
- `docs/refactor/quality/qadocs-ui-enum-lock-sop.md` v2.0 seal + §四a addition + §五/§六 updates (MODIFY)
- `docs/refactor/dod-checklist.md` §17.5 self-apply ledger 10-22 例 追增 (MODIFY)

### Guardrails preserved across all five stages

- `采集/存储侧` protected globs zero touch
- `frontend/**` zero touch (except surgical lint walk read-only in #119)
- `schema.prisma` zero touch
- `package.json` zero delta (five stages, no dependency delta)
- `Math.random` zero touch
- Zero force-push across five stages
- `jscpd ≤30% 硬门` REALIZED
- Alpha Vantage + Baostock only (data-source discipline)
- License 红线 SOFTENED · Independence v1.1 retain
- 借鉴外部 attribution none across five stages

### Owner authority chain

- `msg=d0d11677` — 自签合入 令 (≥4 sign + CI GREEN → self-merge OK · #119 authority-native REALIZED)
- `msg=b8af5127` — 完全掌控 v2 agent autonomy standing
- `msg=4b30fbed` — 指挥官令 v3 · "一切不需要找我确认" autonomous execution
- `msg=210d262d` — agents 不能停 · Orch 汇报 continuous-execution
- `msg=bf74c64c` — 持续推进 keep-progressing

---

**Legend:** SHAs are 8-char short prefixes of main-branch commit hashes. PR numbers reference the primary repository's pull-request numbering. `authority-native MERGED` denotes owner-executed merge (not agent self-merge). Cross-references (`docs/refactor/...`) are all relative to repo root.
