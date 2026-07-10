# Sprint 3 Test Framework v0.3

**Author**: QADocs γ
**Dispatch**: Orch v319 Sprint 3 D4 · task #175
**Base**: `docs/refactor/quality/sprint2-test-framework.md` (104 cases · #1-#104)
**Scope**: Tab 3/4/5 contracts + multi-market scoring + RiskGate 22-trigger + login-removal release gate

## Composition rule

Sprint 3 does not duplicate the 104 Sprint 2 cases. The canonical suite is the
ordered union of the Sprint 2 base (#1-#104) and the 48 cases below
(#105-#152). IDs are contiguous and immutable within v0.3.

---

## §1 New endpoint contract tests (Orch v316 LOCK #14/#15/#16)

### Tab 3 日韩市场 (LOCK #14)

| # | Test | Endpoint | Assert |
|---|------|----------|--------|
| 105 | GET jpkr-market/:date 200 | `/api/v1/jpkr-market/:date?market=JP` | body has `kpi` + `rows` + requested date; JP rows have nullable `score`/`risk_gate` keys and required `risk_triggers[]`; `kpi.usdjpy`/`usdkrw` are null or `{rate,change_pct}` |
| 106 | GET jpkr-market/:date 200 KR | `/api/v1/jpkr-market/:date?market=KR` | `rows[].market === 'KR'`; every row has `score` and `risk_gate` keys (object or null) plus required `risk_triggers[]` |
| 107 | GET jpkr-market/:date market=invalid 400 | `/api/v1/jpkr-market/:date?market=XX` | 400 · market must be JP or KR |
| 108 | GET jpkr-market/:date missing market 400 | `/api/v1/jpkr-market/:date` | 400 · required market query is not silently inferred |
| 109 | GET jpkr-market/:symbol/detail 200 | `/api/v1/jpkr-market/:symbol/detail?date=` | core row has symbol + market + close + change_pct + disclosure_events + data_sources; `score`/`risk_gate` keys exist (object or null); `risk_triggers` is an array |
| 110 | GET jpkr-market/:symbol/detail currency | `/api/v1/jpkr-market/:symbol/detail?date=` | currency ∈ {JPY, KRW} |
| 111 | GET jpkr-market empty date | `/api/v1/jpkr-market/:date?market=JP` | 200 with `rows=[]`; no fabricated market rows |

### Tab 4 高倍潜力 (LOCK #15)

| # | Test | Endpoint | Assert |
|---|------|----------|--------|
| 112 | GET multibagger/candidates 200 | `/api/v1/multibagger/candidates` | body has `kpi` + `rows`; `rows[].market` ∈ {A, US, JP, KR} |
| 113 | GET multibagger/candidates?market=JP | `/api/v1/multibagger/candidates?market=JP` | all `rows[].market === 'JP'` |
| 114 | GET multibagger/candidates?stage filter | `/api/v1/multibagger/candidates?stage=seed` | all `rows[].stage === 'seed'` |
| 115 | GET multibagger/:symbol/detail 200 | `/api/v1/multibagger/:symbol/detail` | includes symbol + market + stage + conclusion + Score |
| 116 | GET multibagger/candidates invalid market 400 | `/api/v1/multibagger/candidates?market=XX` | 400 · invalid market is rejected, not ignored |

### Tab 5 回测证据 (LOCK #16)

| # | Test | Endpoint | Assert |
|---|------|----------|--------|
| 117 | GET backtest-pit holdings 200 | `/api/v1/backtest-pit/:strategy/:as_of/holdings` | URL-encoded ISO `:as_of` matches full `as_of_utc`; `holdings[].ticker`, weight, return_since_entry present |
| 118 | GET backtest-pit list wire contract | `/api/v1/backtest-pit/:strategy` | response and snapshots use wire field `strategy` (not `profile`); win_rate_6m + drawdown + sharpe_ratio_6m are top-level |
| 119 | GET backtest-pit holdings stale tag | `/api/v1/backtest-pit/:strategy/:as_of/holdings` | `is_stale` boolean present; lookup does not substitute `snapshot_day` for `as_of_utc` |

---

## §2 RiskGate 22-trigger tests (Orch v317 Ruling #8)

| # | Test | Assert |
|---|------|--------|
| 120 | RiskGate trigger count US = 9 | existing 9 US triggers unchanged |
| 121 | RiskGate trigger count A股 = 3 | existing 3 A股 triggers unchanged |
| 122 | RiskGate JP trigger codes = 5 | exact set: TSE_HALT, EDINET_DELAY, CORPORATE_GOVERNANCE_ISSUE, TSE_TOKUBETSU_CHI, TSE_KANRI |
| 123 | RiskGate KR trigger codes = 5 | exact set: KRX_HALT, DART_LATE_FILING, INSIDER_TRADING_FLAG, KRX_UNFAITHFUL, KRX_INVESTOR_ALERT |
| 124 | RiskGate total trigger count = 22 | 9 US + 3 A股 + 5 JP + 5 KR |
| 125 | RiskGate gate/severity enums stay distinct | gate ∈ {GREEN, YELLOW, RED}; trigger severity ∈ {info, warn, block} |
| 126 | RiskGate YELLOW penalty = -5 | one gate-linked Adjustment has delta -5 for the evaluation; no per-trigger repetition |
| 127 | RiskGate RED penalty = -10 | one gate-linked Adjustment has delta -10 for the evaluation; no per-trigger repetition |
| 128 | RiskGate block-trigger severity | TSE_HALT, TSE_KANRI, KRX_HALT, INSIDER_TRADING_FLAG → severity `block`; aggregate gate RED |
| 129 | RiskGate warn-trigger severity | remaining JP/KR triggers → severity `warn`; aggregate gate YELLOW when no block exists |

---

## §3 Multi-market scoring profile tests (Strategy γ v0.3)

| # | Test | Assert |
|---|------|--------|
| 130 | WeightsProfile union = 7 | us_preferred + multibagger + custom + japan_blue_chip + korea_semiconductor_chain + japan_multibagger + korea_multibagger |
| 131 | japan_multibagger weights | exact Q/G/V/M/T/R = 0.10/0.25/0.10/0.15/0.25/0.15 and sum = 1.0 |
| 132 | korea_multibagger weights | exact Q/G/V/M/T/R = 0.10/0.30/0.10/0.10/0.25/0.15 and sum = 1.0 |
| 133 | JP adapter J-GAAP normalization | `jp.ts` normalizes 経常利益 ROIC basis |
| 134 | KR adapter K-IFRS normalization | `kr.ts` normalizes chaebol cross-guarantee IC |
| 135 | US adapter + generic multibagger tune | `us.ts` is identity pass-through; multibagger Q/G/V/M/T/R = 0.10/0.30/0.10/0.15/0.20/0.15 |

---

## §4 AI multi-market pipeline tests (AI-γ v0.2)

| # | Test | Assert |
|---|------|--------|
| 136 | OutputValidator invariant #15 market_scope | market_scope ∈ {us, cn_a, jp, kr} per profile |
| 137 | OutputValidator invariant #16 risk trigger market-set | JP trigger only on JP market · KR trigger only on KR market |
| 138 | OutputValidator invariant #17 language/profile match | japan_blue_chip → ja-JP · korea_semiconductor_chain → ko-KR |
| 139 | ProfileRegistry six profiles | us_preferred + japan_blue_chip + korea_semiconductor_chain + multibagger + japan_multibagger + korea_multibagger |
| 140 | market_router JP/KR signal routing | JP signals → JP universe · KR signals → KR universe |

---

## §5 免责声明 tests

| # | Test | Assert |
|---|------|--------|
| 141 | DisclaimerPage route exists | `/catdesk/disclaimer` resolves |
| 142 | 禁用词汇 grep = 0 | "必涨", "保底", "承诺", "guaranteed", "assured" have zero hits in `frontend/**` |
| 143 | size_hint_advisory disclaimer present | `disclaimer_key='size_hint_advisory'` renders visible text |
| 144 | EntryPlan disclaimer present | "仅供参考，非投资建议" or equivalent renders |

---

## §6 Cleanup PR-A2/A3 regression tests

| # | Test | Assert |
|---|------|--------|
| 145 | Post PR-A2: HomeWorkspace.tsx deleted | `fs.existsSync()` → false |
| 146 | Post PR-A2: App.tsx route removed | no `/home` route in `App.tsx` |
| 147 | Post PR-A3: PortfolioWorkspace.tsx deleted | `fs.existsSync()` → false |
| 148 | Post PR-A3: backend path assertions updated | no ENOENT from stale `path.resolve()` targets in backend tests |

---

## §7 Login removal release-gate tests (Orch v318 + v319)

Cases #149-#152 are a coordinated release gate. Frontend route/interceptor,
Backend middleware and these QA assertions must land together or in a
dependency-safe order.

| # | Test | Assert | Required executable evidence |
|---|------|--------|------------------------------|
| 149 | Login page/component removed or bypassed | no `/login` route renders a login form | Frontend C1 router/interceptor test or equivalent executable route test |
| 150 | Missing/invalid Authorization default-admin behavior | both auth entry points inject canonical admin and reach the protected handler for missing and invalid headers | Backend C4 `backend/tests/routing/auth-default-admin.test.ts` with four cases |
| 151 | Default admin identity | app initializes admin role without login flow | Frontend C1 executable identity/bootstrap test |
| 152 | All 7 tabs accessible without login | each tab resolves without redirect to `/login` | Frontend C1 executable route matrix covering all seven tabs |

Source grep, prose, implementation-only references and screenshots do not satisfy
cases #149-#152. If C1 or C4 lacks the required executable test, the release gate
is BLOCK even when the implementation exists.

---

## Summary

| Section | Cases | Range |
|---------|------:|-------|
| Sprint 2 base | 104 | #1-#104 |
| §1 New endpoint contracts | 15 | #105-#119 |
| §2 RiskGate 22-trigger | 10 | #120-#129 |
| §3 Multi-market scoring | 6 | #130-#135 |
| §4 AI multi-market pipeline | 5 | #136-#140 |
| §5 免责声明 | 4 | #141-#144 |
| §6 Cleanup regression | 4 | #145-#148 |
| §7 Login removal | 4 | #149-#152 |
| **Total** | **152** | **#1-#152** |

## Release criteria

- IDs #105-#152 are present exactly once and remain contiguous.
- The inherited Sprint 2 base remains 104 cases; this file does not redefine it.
- LOCK #14, #15 and #16 each have endpoint contract coverage.
- Tab 3 row keys `score` and `risk_gate` always exist (nullable); `risk_triggers` always exists as an array.
- Tab 3 KPI exposes nullable `usdjpy`/`usdkrw` pairs with `{rate, change_pct}` when present.
- Tab 5 wire/storage naming remains `strategy`; UI may use Profile only as a local display type.
- Tab 5 `:as_of` is an encoded ISO timestamp matched to `as_of_utc`, never `snapshot_day`.
- RiskGate exact-set tests enforce 9 US + 3 A股 + 5 JP + 5 KR = 22.
- Login-removal cases #149-#152 have executable evidence before the release gate is declared green.
- #150 proves both missing and invalid Authorization behavior through Backend C4 tests.
- #149/#151/#152 resolve to Frontend C1 router/interceptor tests or equivalent executable route tests.
- Source grep and prose never substitute for executable evidence; a missing test is BLOCK.
- This document is a test contract; executable tests land with the owning code lanes.
