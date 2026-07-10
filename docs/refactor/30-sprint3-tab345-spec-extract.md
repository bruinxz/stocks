# 30 · Sprint 3 Tab 3/4/5 Reference Spec Extraction v0.2

**Owner**: Research §S3
**Decision status**: Sprint 3 D3 doc-tier input
**Scope**: Tab 3 日韓市場 · Tab 4 高倍潛力 · Tab 5 回測證據
**Reference boundary**: yespsam `a-share-us-catalyst` is used only for semantic and interaction analysis. The upstream repository has no `LICENSE`; this document contains no copied source, templates, prose, or word lists.
**Canonical inputs**: Strategy scoring v0.3 · RiskGate Ruling #8 · API LOCK #14/#15/#16 · existing data-source contracts

---

## 0. Delta And Authority

This document promotes the Sprint 3 workspace draft and reconciles it with the
latest canonical decisions. When historical observations from the reference
project conflict with our contracts, our contracts win.

| Delta | Canonical result |
|---|---|
| RiskGate | 22 trigger codes total: 9 US + 3 A-share + 5 JP + 5 KR |
| Weight profiles | `WeightsProfile` expands from 5 to 7 by adding `japan_multibagger` and `korea_multibagger` |
| Replay profiles | Six executable profiles; `custom` is a configuration value, not a backtest strategy |
| Generic multibagger | Growth 0.35 → 0.30; Moat 0.10 → 0.15 |
| Tab 3 API | LOCK #14: JP/KR list and detail endpoints |
| Tab 4 API | LOCK #15: multibagger list and detail endpoints |
| Tab 5 API | LOCK #16 adds holdings; Sprint 3 expands the strategy whitelist to six profiles |

The seven `WeightsProfile` values are:

```text
us_preferred
multibagger
custom
japan_blue_chip
korea_semiconductor_chain
japan_multibagger
korea_multibagger
```

The six replayable profiles exclude `custom`.

---

## 1. Tab 3 · JP/KR Market

### 1.1 Reference-project observations

The upstream `asia` view uses a small static JP/KR universe, manual fundamental
scores, shared quote/history access, and a single list/detail interaction. Its
useful product ideas are:

- an explicit Japan/Korea market filter;
- native JPY/KRW formatting and market-session context;
- a compact market-profile card;
- bull/base/bear scenarios;
- factor contribution visualization;
- stale-data disclosure.

These are design observations only. The upstream seven-factor formula, static
universe, field names, prose, and implementation are not adopted.

### 1.2 Our pipeline

```text
EDINET/DART disclosures + JP/KR prices + FX context
  -> point-in-time normalization
  -> six-dimension scoring with a market profile
  -> US-to-JP/KR relevance mapping
  -> Conviction + RiskGate + EntryPlan
  -> AI multi-market explanation
  -> Backend LOCK #14 endpoints
  -> Tab 3 list + DetailSidebar
```

Default profiles:

| Market | Default profile | Optional growth profile |
|---|---|---|
| JP | `japan_blue_chip` | `japan_multibagger` |
| KR | `korea_semiconductor_chain` | `korea_multibagger` |

Profile selection must be explicit in persisted score metadata. Consumers must
not infer a profile from a ticker after scoring.

### 1.3 Six-dimension weights

| Profile | Q | G | V | M | T | R |
|---|---:|---:|---:|---:|---:|---:|
| `japan_blue_chip` | 0.25 | 0.15 | 0.15 | 0.20 | 0.15 | 0.10 |
| `korea_semiconductor_chain` | 0.15 | 0.30 | 0.10 | 0.15 | 0.20 | 0.10 |
| `japan_multibagger` | 0.10 | 0.25 | 0.10 | 0.15 | 0.25 | 0.15 |
| `korea_multibagger` | 0.10 | 0.30 | 0.10 | 0.10 | 0.25 | 0.15 |

All rows sum to 1.00. Scoring remains market-agnostic after the ingestion
adapter normalizes J-GAAP/K-IFRS and local-currency inputs.

### 1.4 Data-source contract

| Market | Filing/fundamental source | Price/session source | Fallback or guard |
|---|---|---|---|
| JP | EDINET v2 XBRL | JPX/Yahoo JP opt-in/Stooq according to the frozen data contract | EDINET availability timestamp and stale-data flag |
| KR | Open DART XBRL | KRX/KIND with PyKRX fallback | KRX schema canary, DART filing timestamp, stale-data flag |

Dimension scoring uses local-currency values. FX rates provide display and
EntryPlan context; they must not silently rewrite fundamental ratios.

### 1.5 LOCK #14 endpoint surface

```http
GET /api/v1/jpkr-market/:date?market=JP|KR
GET /api/v1/jpkr-market/:symbol/detail?date=YYYY-MM-DD
```

Authorized Backend C4 response envelopes are:

```json
{
  "kpi": {
    "nikkei225": { "value": 38000, "change_pct": 0.5, "as_of": "2026-07-10" },
    "topix": { "value": 2700, "change_pct": 0.3, "as_of": "2026-07-10" },
    "usdjpy": { "rate": 160.25, "change_pct": 0.2 },
    "usdkrw": null
  },
  "rows": [
    {
      "symbol": "6758.T",
      "name_local": "Sony Group",
      "market": "JP",
      "sector": "technology",
      "close": 15000,
      "change_pct": 1.2,
      "currency": "JPY",
      "disclosure_events": [],
      "revenue_by_region": [],
      "fx_beta": 0.75,
      "is_halted": false,
      "data_sources": ["EDINET", "JPX"],
      "score": null,
      "risk_gate": null,
      "risk_triggers": []
    }
  ],
  "date": "2026-07-10"
}
```

The KPI object always contains both `usdjpy` and `usdkrw`; each value is either
`{ rate, change_pct }` or `null`. Every list/detail row always contains
`score: Score | null`, `risk_gate: RiskGate | null`, and
`risk_triggers: RiskTrigger[]`. Producers use `null` or an empty array when
scoring/risk data is unavailable; they must not omit these keys. The detail
endpoint returns the same required core shape.

### 1.6 Tab 3 presentation guidance

- Filter by `ALL | JP | KR`; do not encode country through color alone.
- Format currency from the row's `currency`, never from browser locale.
- Show market-open/closed and data-as-of separately.
- Render the selected `weights_profile` and six-dimension waterfall.
- Surface `is_halted`, stale data, and disclosure-source evidence before entry
  guidance.

---

## 2. Tab 4 · Multibagger Candidates

### 2.1 Reference-project observations

The upstream view combines A-share and US candidates, then exposes a screening
method strip, stage, triggers, invalidation conditions, longer-horizon returns,
and a detail panel. Its two tracks use different hand-built formulas and a
separate `Focus/Watch/Track/Avoid` vocabulary.

Our implementation reuses the useful information architecture but not the
formula, labels, word lists, or source code. Rating remains the canonical
`A/B/C/D/F` scale in every tab.

### 2.2 Our pipeline

```text
Free-source A/US/JP/KR candidate collection
  -> deterministic eligibility filters
  -> market-aware multibagger profile
  -> six-dimension scoring
  -> Conviction + RiskGate + EntryPlan
  -> Backend LOCK #15 endpoints
  -> combined table + market/stage/conclusion filters + detail
```

Profile selection:

| Market | Profile |
|---|---|
| A / US | `multibagger` |
| JP | `japan_multibagger` |
| KR | `korea_multibagger` |

The generic v0.3 `multibagger` weights are:

| Q | G | V | M | T | R |
|---:|---:|---:|---:|---:|---:|
| 0.10 | 0.30 | 0.10 | 0.15 | 0.20 | 0.15 |

The Growth-to-Moat rebalance prevents weak-moat, short-lived growth from
dominating the total while preserving a growth-oriented profile.

### 2.3 Sub-factor guidance

- Quality may include the market-cap sweet spot, ROIC trend, FCF quality, and
  accrual quality.
- Trend may include moving-average state, medium-horizon return, volume
  breakout, and optionality evidence.
- Stage and conclusion are screening metadata, not replacements for Rating,
  Conviction, or RiskGate.
- Trigger and invalidation conditions belong in EntryPlan/evidence structures,
  not free-form UI-only state.

### 2.4 LOCK #15 endpoint surface

```http
GET /api/v1/multibagger/candidates?stage=&conclusion=&market=A|US|JP|KR
GET /api/v1/multibagger/:symbol/detail
```

Authorized Backend C4 uses a `kpi` + `rows` envelope:

```json
{
  "kpi": {
    "total_candidates": 42,
    "stage_distribution": {
      "seed": 10,
      "early": 15,
      "growth": 12,
      "break_below": 3,
      "deep": 2
    },
    "conclusion_coverage": {
      "MULTIBAGGER_2X": 20,
      "MULTIBAGGER_5X": 15,
      "MULTIBAGGER_10X": 5,
      "SKIP": 2
    }
  },
  "rows": [
    {
      "symbol": "6758.T",
      "name": "Sony Group",
      "market": "JP",
      "stage": "growth",
      "conclusion": "MULTIBAGGER_2X",
      "rating_band": "A",
      "score": {
        "scoring_id": "uuid",
        "snapshot_hash": "sha256",
        "weights_profile": "japan_multibagger"
      },
      "conviction": {},
      "risk_gate": {},
      "entry_plan": {},
      "latest_catalyst": {}
    }
  ]
}
```

### 2.5 Tab 4 presentation guidance

- Use one combined list with an explicit market column and filter.
- Explain the screening method and profile without exposing mutable internals as
  promises of future returns.
- Keep stage, Rating, Conviction, and RiskGate visually distinct.
- Show triggers and invalidation conditions together.
- Include a non-advisory disclaimer next to size hints and EntryPlan output.

---

## 3. Tab 5 · Backtest Evidence

### 3.1 Reference-project observations

The upstream backtest's strongest transferable idea is point-in-time discipline:
each decision date uses only prior market data and the latest completed upstream
session. It reports forward 1d/3d/5d returns, hit rates, baseline/excess returns,
worst outcomes, and recent realized signals.

Historical news is treated as neutral when a point-in-time archive is
unavailable. Our pipeline must use the same fail-closed principle: missing PIT
evidence cannot be replaced with current knowledge.

### 3.2 Our pipeline

```text
Versioned inputs + as_of cutoff
  -> precomputed PIT snapshot per replayable profile
  -> immutable snapshot/fact hash + source versions
  -> Backend LOCK #16 list/detail/holdings endpoints
  -> metrics cards + profile comparison + PIT timeline
  -> survivorship-bias and stale-data disclosure
```

Replayable profiles:

```text
us_preferred
multibagger
japan_blue_chip
korea_semiconductor_chain
japan_multibagger
korea_multibagger
```

`custom` is deliberately excluded because an unversioned arbitrary weight set is
not replay-safe. A future custom replay must persist a versioned weight vector
and fingerprint before joining the whitelist.

### 3.3 PIT invariants

- Feature windows exclude the decision timestamp.
- Cross-market signals use the latest session completed before the decision
  cutoff.
- Membership and delisting state are resolved as of the snapshot date.
- `snapshot_id`, `fact_hash`, `source_versions`, strategy, and as-of time are
  immutable replay keys.
- Forward returns are evaluation outputs and never scoring inputs.
- Missing PIT news or fundamentals are marked unavailable; current data is not
  backfilled into the past.

### 3.4 LOCK #16 endpoint surface

```http
GET /api/v1/backtest-pit/:strategy?from=&to=&limit=
GET /api/v1/backtest-pit/:strategy/:as_of
GET /api/v1/backtest-pit/:strategy/:as_of/holdings
```

`:as_of` is the snapshot's ISO timestamp and is matched against `as_of_utc`, not
the calendar-only `snapshot_day`. URL consumers must percent-encode the
timestamp, for example `2026-07-10T06%3A00%3A00.000Z`. `snapshot_day` remains
display/grouping metadata and must not be used as the detail/holdings lookup key.

The list response exposes snapshot metadata and selected metrics:

```json
{
  "strategy": "japan_multibagger",
  "snapshots": [
    {
      "snapshot_id": "uuid",
      "strategy": "japan_multibagger",
      "snapshot_day": "2026-07-10",
      "as_of_utc": "2026-07-10T06:00:00Z",
      "is_survivorship_biased": false,
      "is_delisted_at_as_of": false,
      "fact_hash": "sha256",
      "net_value": 1.12,
      "drawdown": -0.08,
      "cumulative_return": 0.12,
      "sharpe_ratio_6m": 1.25,
      "win_rate_6m": 0.57
    }
  ]
}
```

Holdings remain a separate lazy-loaded surface:

```json
{
  "holdings": [
    {
      "ticker": "6758.T",
      "weight": 0.15,
      "return_since_entry": 0.12,
      "is_stale": false
    }
  ]
}
```

### 3.5 Tab 5 presentation guidance

- Show the data window, lookback, cutoff convention, and PIT limitations.
- Compare the six replayable profiles; do not label the comparison as six
  independent strategies if they share the same engine.
- Pair hit rate with sample count, excess return, and worst outcome.
- Make `is_survivorship_biased` and stale holdings visible, not tooltip-only.
- Provide a recent-signals table with realized 1d/3d/5d outcomes.

---

## 4. Cross-Tab Canonical Matrix

| Surface | Tab 3 JP/KR | Tab 4 multibagger | Tab 5 backtest |
|---|---|---|---|
| Candidate scope | JP + KR | A + US + JP + KR | Six replay profiles |
| Rating | A/B/C/D/F | A/B/C/D/F | Historical A/B/C/D/F |
| Conviction | HIGH/MED/LOW at 75/50 | HIGH/MED/LOW at 75/50 | Historical replay |
| RiskGate | GREEN/YELLOW/RED | GREEN/YELLOW/RED | Historical replay |
| Profile | JP/KR blue-chip or multibagger | Market-aware multibagger | Persisted profile |
| Evidence | Filing + price + relevance | Screening + catalysts + invalidation | PIT inputs + realized returns |
| Main lock | #14 | #15 | #16 |

### 4.1 RiskGate applicability

The canonical vocabulary has 22 trigger codes:

| Scope | Count | Codes |
|---|---:|---|
| US | 9 | `EARNINGS_T-2`, `EARNINGS_T-0`, `HALT_ACTIVE`, `MERGER_PENDING`, `LITIGATION_MATERIAL`, `IV_SHOCK`, `LIQUIDITY_LOW`, `RESTATEMENT_30D`, `DELISTING_NOTICE` |
| A-share | 3 | `ST_TAG`, `PRICE_LIMIT_APPROACH`, `SUSPENDED` |
| JP | 5 | `TSE_HALT`, `EDINET_DELAY`, `CORPORATE_GOVERNANCE_ISSUE`, `TSE_TOKUBETSU_CHI`, `TSE_KANRI` |
| KR | 5 | `KRX_HALT`, `DART_LATE_FILING`, `INSIDER_TRADING_FLAG`, `KRX_UNFAITHFUL`, `KRX_INVESTOR_ALERT` |

The vocabulary is globally 22; evaluation is market-aware. A JP candidate does
not run KR-only triggers, and vice versa. Shared US catalyst exposure does not
change a JP/KR security's native-market trigger set.

### 4.2 Rating vocabulary

Upstream labels are retained only as reference observations:

| Reference surface | Upstream label | Our canonical label |
|---|---|---|
| Asia | Buy/Outperform/Neutral/Underperform/Avoid | A/B/C/D/F |
| Multibagger | Focus/Watch/Track/Avoid | A/B/C/D/F |
| Backtest | Replayed source labels | Replayed A/B/C/D/F |

No tab may introduce a second canonical Rating vocabulary.

---

## 5. Delivery Requirements And Consumer Handoff

### 5.1 Stable delivery requirements

| Requirement | Owner | Priority | Acceptance condition |
|---|---|---:|---|
| LOCK #14 endpoints | Backend γ | P0 | Exact paths, required nullable score/risk keys, required `risk_triggers`, nullable FX KPI pairs |
| LOCK #15 endpoints | Backend γ | P0 | Exact paths, `kpi` + `rows`, A/US/JP/KR filters, market-aware profile metadata |
| LOCK #16 endpoints | Backend γ | P0 | Exact paths, six-profile whitelist, wire field `strategy`, encoded ISO `:as_of` matched to `as_of_utc` |
| JP/KR collectors | DP γ / DP γ-2 | P0 | Idempotent PIT rows with availability timestamps, source and stale/fallback metadata |
| Multibagger candidate pipeline | DP γ / DP γ-2 | P0 | Deterministic eligible universe for A/US/JP/KR with fact hash |
| Backtest PIT precomputation | DP γ | P1 | Immutable snapshots keyed by strategy + `as_of_utc`; no current-data backfill |
| Multi-market scoring v0.3 | Strategy γ | P0 | Seven profile values, six replay profiles, frozen weights and adapters |
| Multi-market recommendation | AI-γ | P1 | Consumes Strategy values without duplication; replay metadata complete |
| Tab 3/4 UI | Frontend γ-2 | P0 | Consumes canonical envelopes and renders required risk/FX/source state |
| Tab 5 UI | Frontend γ-3 | P0 | Encodes ISO `:as_of`, consumes wire `strategy`, displays PIT/bias limitations |
| Quality contract | QADocs γ | P0 | Executable coverage for locks, negative PIT cases, trigger/profile cardinality |

Implementation status belongs in tasks and PRs, not this canonical document.

### 5.2 Consumer feed checklist

**Frontend γ-2**

- Consume `kpi` + `rows`, not a legacy `candidates` + `summary` envelope.
- Preserve JPY/KRW, source, stale, halt, selected profile, and risk evidence.
- Support A/US/JP/KR on Tab 4 and the JP/KR growth profiles.

**Frontend γ-3**

- Support all six replay profiles.
- Fetch holdings lazily through LOCK #16.
- Percent-encode the ISO `as_of_utc` value for detail/holdings requests and
  consume the wire field as `strategy`; a local UI `Profile` alias must not
  change the payload.
- Display PIT methodology, survivorship-bias state, sample count, and downside.

**Backend γ**

- Keep all user input parameterized.
- Use the exact LOCK #14/#15/#16 paths.
- Return stable JSON envelopes and a six-profile backtest whitelist.
- Query detail/holdings by `strategy` + `as_of_utc`; do not resolve an encoded
  timestamp through `snapshot_day`.
- Keep `custom` out of replay until its weight vector is versioned.

**DP γ / DP γ-2**

- Preserve filing availability timestamps and market-local identifiers.
- Provide idempotent, point-in-time normalized rows.
- Mark source fallback and staleness; do not fabricate missing fields.

**Strategy γ / AI-γ**

- Strategy owns weights, bands, thresholds, and adapters.
- AI consumes those values and must not duplicate or mutate them.
- Recommendation replay records profile/schema/source versions and tie-break
  inputs.

**QADocs γ**

- Test all three locks, the 22-code vocabulary and market applicability, seven
  profile values, six replay profiles, and PIT negative cases.

---

## 6. Independence And Verification Rules

- Zero source-code, prose-template, or word-list copying from the unlicensed
  reference repository.
- Reference observations must remain clearly separated from our canonical
  contracts.
- All numeric weights and enums in this document come from our Strategy and
  Orchestrator decisions.
- Free-source and opt-in rules in the frozen data-source contracts remain in
  force.
- PostgreSQL access for the described read APIs is SELECT-only.
- Missing point-in-time data fails closed and is disclosed.
- This D3 document changes no application code, schemas, migrations, or
  production configuration.

## 7. Review Checklist

- [ ] Exactly 22 RiskGate codes are listed in canonical order as the existing
  Strategy baseline 12 (US9 + A-share3), followed by JP5 and KR5.
- [ ] `WeightsProfile` has seven values; replay has six and excludes `custom`.
- [ ] Generic multibagger weights equal 0.10/0.30/0.10/0.15/0.20/0.15.
- [ ] JP/KR multibagger weights match Strategy v0.3 and each sum to 1.00.
- [ ] LOCK #14/#15/#16 paths are exact.
- [ ] Response envelopes match the authorized Backend C4 implementation.
- [ ] Tab 3 rows always contain nullable `score`/`risk_gate` and required
  `risk_triggers`; FX KPI pairs are present and nullable.
- [ ] Tab 5 wire format uses `strategy`, and encoded ISO `:as_of` resolves
  against `as_of_utc`.
- [ ] The canonical document contains requirements rather than volatile
  implementation status.
- [ ] Upstream material remains spec-only with zero code copy.
