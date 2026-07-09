# Two-Agent Byte-Truth Cross-Verify Canonical

**Status:** canonical formalize (post-M3 series 收官 `93dee066`)
**Author:** QADocs 主签 (in-repo reference · Research §S3 external artifact primary)
**External primary:** Research §S3 二十四例 VICESIMA-QUATTUOR formation LOCK (msg-id chain preserved in Research thread)

---

## §1 · Statement

**Two-agent byte-truth cross-verify** is a discipline where two independent agents (typically different agent roles — e.g. Research + Cleanup + QADocs) each derive the same byte-level truth about a file (`wc -l -c` size + line count + specific line contents at pinned line numbers) via **independent read paths**, then compare. Bit-perfect match across independent chains is stronger evidence than either single chain alone.

This runs orthogonal to any single-agent claim about a file. Two independent chains reaching the same byte-truth eliminates:

- **Read hallucination**: one agent misreads · the other agent independently reads → mismatch surfaces
- **Silent drift**: file changes between chain 1's read and chain 2's read → mismatch surfaces
- **Fabrication**: agent invents plausible file contents → independent chain shows real contents · mismatch surfaces

---

## §2 · Canonical exemplar — PR-M3-2 pre-guard target file

`frontend/src/components/backtest/BacktestResults.tsx` was pinned by two independent chains:

- **Research §S3 msg=8cd1c962 (EA-anchor)** — byte-truth `475L / 16071B` via `wc -l -c` · L23 SOLE `backtestService` import + L56/L67 2 call-site verified independently
- **Cleanup v47 §4.2** — walk-derived `KNOWN_RESIDUAL=1` cap · same file identified as sole consumer via independent walk

Both chains matched bit-perfect on the byte-truth claim. This is the two-agent byte-truth cross-verify pattern in-repo. `no-backtest-service-regression.test.ts:93` `KNOWN_RESIDUAL=1` was set post-verify with the confidence that the residual count is real (not fabricated).

---

## §3 · Application scope

Use two-agent byte-truth cross-verify when:

- A pre-guard assertion depends on a specific residual count / line number / consumer inventory
- A migration recipe pins a specific file at a specific line as the sole (or specific-count) migration target
- A baseline JSON entry claims specific `authority_file:line` — cross-verify before committing
- A ledger entry attributes a specific SHA / message ID / timestamp — cross-verify from independent chain

Skip when:

- A single-agent read is trivially verifiable by the next reviewer via `git log` / `git blame` / `wc` at trivial cost (byte-truth is cheap to re-check · no need for pre-commit two-agent burden)
- The claim is architectural / semantic rather than byte-truth (two-agent cross-verify addresses byte-truth · semantic agreement is a different disciplineencoded via ADR / SOP)

---

## §4 · Anti-patterns

### §4.1 Self-verify masquerading as cross-verify

```
Agent A reads file → declares byte-truth
Agent A reads file again 10 minutes later → declares byte-truth matches
```

This is single-agent double-check, not two-agent cross-verify. No independence.

### §4.2 Chain-of-trust laundering

```
Agent A reads file → tells Agent B "the file is X"
Agent B echoes "yes, the file is X"
```

Agent B did not independently read — this is echo laundering. Must be independent read paths.

### §4.3 Sample-set self-fulfillment

```
Agent A greps for pattern P → finds 3 files
Agent B greps for pattern P → finds 3 files (running the same grep)
```

Same grep is same read path — pattern P might be wrong / incomplete. Cross-verify requires **different read paths** (e.g. one via grep, one via file walker + AST · or one via `git log --stat`, one via `wc`).

---

## §5 · Formation LOCK reference

Research §S3 external artifact tracks the running tally of two-agent byte-truth cross-verify instances (currently at 二十四例 VICESIMA-QUATTUOR per Research §S3 msg=a4dcccd8). This QADocs in-repo doc **references** that external tally · does not attempt to replicate it. Future in-repo consumers cite the external artifact + this canonical write-up together.

---

## §6 · Cross-refs

- Research §S3 msg=a4dcccd8 (VICESIMA-QUATTUOR 24-instance formation LOCK)
- `docs/refactor/quality/pr-m3-2-preguard-runbook.md` §1 (exemplar application · BacktestResults.tsx byte-truth)
- `docs/refactor/quality/anti-fabrication-canonical.md` §3 (Instance 2 honest-observe · relies on this discipline for `KNOWN_RESIDUAL=1` confidence)
- `docs/refactor/quality/m3-series-completion-cert.md` (M3 series 收官 attestation)

---

**Two-agent byte-truth cross-verify canonical formalize LANDED** in-repo · references external Research §S3 running tally · applies opportunistically to pre-guard / migration / baseline / ledger byte-truth claims.
