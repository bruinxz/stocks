# AI Recommendation Contract v0.3

- **Owner**: AI-γ (`@AI`) · SOLE
- **Task**: #179 · Orch v319 msg=fe4ed6f3
- **Companion**: `notes/ai-recommendation-pipeline-v0.1-workspace-draft.md`
- **Consumes**: `contracts/scoring.md` v0.3 (Strategy γ · task #177 · PR #215); `contracts/catalyst-mapping.md` v0.2 (DP γ · msg=79bfc500)
- **Status**: Sprint 3 D2 · PR CREATE authorized by Orch v319 · merge order D1 PR #215 → D2 PR #214
- **Change control**: v0.x is pre-stable; any corrective breaking alignment MUST be called out with dependency order and downstream migration. After v1.0, schema-breaking change → SemVer major; additive change → minor; doc-only → patch.
- **doc-tier 2-sign**: 主 AI-γ · 副1 Strategy γ · 副2 Research §S3

---

## §1 · SemVer

Contract version: `0.3.1`

Compatibility matrix (v0.3 anchor):
- `scoring.md`: `>=0.3.0, <0.4.0`
- `catalyst-mapping.md`: `>=0.2.0, <0.3.0`

v0.3 adds multi-market profiles and locales, and also removes incompatible
v0.2 restatements of Strategy-owned types. It is therefore not purely
additive: consumers using the stale local RiskTrigger names, the incomplete
Conviction shape, the old band projection, or the old EntryPlan shape MUST
migrate to the Strategy v0.3 shapes. D1 PR #215 MUST merge before D2 PR #214.

---

## §2 · Core types (canonical)

### 2.1 Recommendation

```typescript
type Recommendation = {
  id:                  string;                    // UUID v4
  snapshot_id:         string;                    // FK -> Snapshot.snapshot_id
  ticker:              string;                    // normalized upper; suffixed by market e.g. "600519.SH" | "AAPL" | "7203.T" | "005930.KS"
  as_of:               string;                    // ISO8601 UTC seconds

  // Strategy consumption block (Strategy-owned objects; AI-γ read-only)
  score:               RecommendationScoreSnapshot; // §2.2 · denormalized projection
  conviction:          Conviction;                // scoring.md §4
  risk_gate:           RiskGate;                  // scoring.md §5 · MUST have ok_to_enter=true
  entry_plan:          EntryPlan;                 // scoring.md §6
  catalyst_relevance?: CatalystRelevance;         // catalyst-mapping.md 5-component (nullable)

  // AI-γ additive block
  trigger_signals:     TriggerSignal[];           // length >= 1
  weights:             WeightAttribution;         // signed L1 attribution or zero-mass state (§2.8)
  explanation:         Explanation;               // §2.6
  evidence_refs:       EvidenceRef[];             // length >= 1

  // Metadata
  model_version:       string;                    // SemVer of AI-γ rule bundle / model
  disclaimer_version:  string;                    // SemVer of disclaimer
};
```

### 2.2 RecommendationScoreSnapshot (read-only projection of Strategy Score)

```typescript
type RecommendationProfile =
  | "us_preferred"
  | "multibagger"
  | "japan_blue_chip"
  | "korea_semiconductor_chain"
  | "japan_multibagger"
  | "korea_multibagger";

type RecommendationScoreSnapshot = {
  scoring_id:      string;   // Strategy-issued UUIDv4 stable id (Strategy γ v0.2 §2.1)
  snapshot_hash:   string;   // SHA-256(JCS(Score minus scoring_id, snapshot_hash)) (Strategy γ v0.2 §2.1)
  profile:         RecommendationProfile;  // projection of Strategy Score.weights_profile; custom excluded
  market_scope:    "cn_a" | "us" | "jp" | "kr";  // projection of Strategy Score.market_scope
  total:           number;   // 0..100 (denormalized snapshot for O(1) sort)
  rating:          Band;     // projection of Strategy Score.rating
  dims:            ScoreDim[];  // 6-dim breakdown (Q/G/V/M/T/R) · Strategy §2.1
};

type Band = "A" | "B" | "C" | "D" | "F";

type ScoreDim = {
  key:     "Q" | "G" | "V" | "M" | "T" | "R";
  score:   number;   // 0..100
  band:    Band;     // per-dim band (same thresholds 85/70/55/40)
  weight:  number;   // profile-specific weight (sum == 1.0)
};
```

This projection exists for deterministic explanation and O(1) list rendering.
It is not Strategy's identity-only `ScoreRef`. Its fields MUST be copied from
the referenced Strategy `Score` without recomputation: `profile` projects
`weights_profile`, `market_scope` projects `market_scope`, `rating` projects
`rating`, and `dims` projects the six Strategy dimensions in `Q/G/V/M/T/R`
order.

### 2.3 Conviction (reference to scoring.md §4 · Strategy γ SOLE)

| Recommendation use | Authoritative type |
|---|---|
| `Recommendation.conviction` | `contracts/scoring.md` §4 `Conviction` |
| `Recommendation.conviction.score_ref` | `contracts/scoring.md` §4 `ScoreRef` |
| `Recommendation.conviction.adjustments[]` | `contracts/scoring.md` §4 `Adjustment` |

AI-γ consumes the complete Strategy object, including `ticker`, `as_of`,
mandatory `score_ref`, `adjustments`, `final`, and `level`. Recommendation
defines no shortened Conviction DTO and no local threshold or Adjustment
shape.

Invariant: `final == clamp(base + Σ adjustments[i].delta, 0, 100)` · evaluation-order-free (Σ is commutative · storage layer zero branching per Strategy γ msg=ea939251).

### 2.4 RiskGate (reference to scoring.md §5 · Strategy γ SOLE)

| Recommendation use | Authoritative type |
|---|---|
| `Recommendation.risk_gate` | `contracts/scoring.md` §5 `RiskGate` |
| `Recommendation.risk_gate.triggers[]` | `contracts/scoring.md` §5 `Trigger` |
| `Recommendation.risk_gate.triggers[].code` | `contracts/scoring.md` §5 canonical code set |

AI-γ consumes those types verbatim. Code validity, severity, gate derivation,
and market applicability are all defined only by `contracts/scoring.md` §5.
Recommendation adds one downstream requirement: a persisted recommendation
MUST have `risk_gate.ok_to_enter == true`.

For version compatibility auditing only, the Strategy v0.3 code-name snapshot
contains exactly these 22 names (the existing 12-code baseline followed by the
ten Orch v317 additions):

`EARNINGS_T-2`, `EARNINGS_T-0`, `HALT_ACTIVE`, `MERGER_PENDING`,
`LITIGATION_MATERIAL`, `IV_SHOCK`, `LIQUIDITY_LOW`, `RESTATEMENT_30D`,
`DELISTING_NOTICE`, `ST_TAG`, `PRICE_LIMIT_APPROACH`, `SUSPENDED`,
`TSE_HALT`, `EDINET_DELAY`, `CORPORATE_GOVERNANCE_ISSUE`,
`TSE_TOKUBETSU_CHI`, `TSE_KANRI`, `KRX_HALT`, `DART_LATE_FILING`,
`INSIDER_TRADING_FLAG`, `KRX_UNFAITHFUL`, `KRX_INVESTOR_ALERT`.

This snapshot is not a second enum definition and conveys no severity or
applicability. Stale alternate names such as `SEC_HALT`,
`EARNINGS_BLACKOUT`, and `KRX_TRADING_HALT` are not part of the Strategy v0.3
contract.

### 2.5 EntryPlan (reference to scoring.md §6 · Strategy γ SOLE)

| Recommendation use | Authoritative type |
|---|---|
| `Recommendation.entry_plan` | `contracts/scoring.md` §6 `EntryPlan` |
| `Recommendation.entry_plan.entry` | `contracts/scoring.md` §6 `PriceBand` |
| `Recommendation.entry_plan.stop` / `targets[]` | `contracts/scoring.md` §6 `Price` |
| `Recommendation.entry_plan.size_hint` | `contracts/scoring.md` §6 `SizeHint` |
| `Recommendation.entry_plan.score_ref` | `contracts/scoring.md` §6 `ScoreRef` |

AI-γ consumes the complete Strategy object: `ticker`, `generated_at`, `entry`,
typed `stop`, typed `targets`, `size_hint` (including mandatory `rationale`),
`time_horizon`, `invalidation`, numeric `conviction_ref`, and mandatory
`score_ref`. Recommendation defines no `price_band` alias and no shortened
SizeHint DTO.

### 2.6 Explanation

```typescript
type Explanation = {
  headline:        string;              // <= 80 chars
  body:            string;              // <= 600 chars · reference evidence via [E<n>] markers
  caveats:         string[];            // 0..3, each <= 120 chars
  language:        "zh-CN" | "en-US" | "ja-JP" | "ko-KR";
  template_id:     string;              // e.g. "morning_brief_v1"
  template_hash:   string;              // sha256 for replay determinism
};
```

`[E<n>]` token syntax: body 内 `[E1]`、`[E2]` 等标记 MUST 对应 `evidence_refs` 中 `id` 字段。Frontend γ-3 tab 6 `<EvidenceRefLink>` 组件消费此标记渲染为可点击链接 (Sprint 2)。

### 2.7 TriggerSignal

```typescript
type TriggerSignal = {
  code:            TriggerCode;
  strength:        "STRONG" | "MEDIUM" | "WEAK";
  detail:          string;              // <= 240 chars
  source_ref?:     string;              // -> EvidenceRef.id
};

type TriggerCode =
  | "CATALYST_MATCHED"
  | "CONVICTION_HIGH"
  | "SCORE_TOTAL_TOP"
  | "DIM_BAND_A"
  | "RISK_GATE_CLEAN"
  | "ENTRY_PLAN_TIGHT"
  | "EVENT_FRESH"
  | "SECTOR_MOMENTUM"
  | "RULE_MATCHED"
  | "MODEL_INFERENCE";     // reserved for v0.2+
```

### 2.8 WeightAttribution

```typescript
type WeightAttribution =
  | {
      contributions: [Contribution, ...Contribution[]];
      normalized:    true;
    }
  | {
      contributions: [];
      normalized:    false;
    };

type Contribution = {
  source_kind:     "trigger" | "score_dim" | "catalyst_relevance";
  source_ref:      string;              // TriggerCode | "Q"|"G"|"V"|"M"|"T"|"R" | catalyst_id
  weight:          number;              // [-1.0, 1.0]
  note?:           string;
};

// normalized=true invariant: sum(abs(contributions.weight)) == 1.0 ± 1e-6
// signed_net = sum(contributions.weight) is informational and lies in [-1, 1]
```

v0.3.1 signed-L1 normalization canonical:

1. Assembly derives a signed `raw_contribution_i` for every attribution source.
2. `denominator = Σ abs(raw_contribution_i)`.
3. Every raw contribution and the accumulated denominator MUST be finite
   numbers; booleans, non-finite raw values, and denominator overflow fail
   closed before normalization.
4. When `denominator > 0`, `weight_i = raw_contribution_i / denominator`,
   `normalized=true`, and contributions MUST be non-empty.
5. When `denominator == 0`, the sole canonical representation is
   `contributions=[]` with `normalized=false`; zero-weight placeholder rows are
   forbidden.
6. `signed_net = Σ weight_i` is informational. It may be negative, zero, or
   positive and MUST NOT be validated as equal to 1.

This preserves the direction of negative evidence while making total
attribution magnitude deterministic. The former signed-sum formula was
mathematically contradictory for mixed-sign contributions and is superseded.

### 2.9 EvidenceRef

```typescript
type EvidenceRef = {
  id:              string;              // referenced by [E<n>] markers in Explanation.body
  kind:            EvidenceKind;
  source_uri:      string;              // stable URI, see §3
  as_of:           string;              // ISO8601 UTC
  hash:            string;              // sha256 canonical
  short_text?:     string;              // <= 200 chars
};

type EvidenceKind =
  | "CATALYST_EVENT"
  | "SCORE_INPUT"
  | "PRICE_TICK"
  | "DISCLOSURE"
  | "RULE"
  | "MODEL_OUTPUT"           // v0.2+
  | "NEWS";                  // MUST be free source per msg=4f6d2466
```

### 2.10 CatalystRelevance (from catalyst-mapping.md v0.2)

```typescript
type CatalystRelevance = {
  catalyst_id:     string;                                    // -> us_catalyst_event.id
  kind:            CatalystKind;                              // 9-enum (v0.2)
  relevance_score: number;                                    // 0..1 weighted sum
  components:      {                                          // catalyst-mapping.md 5-component
    sector_map:       number;    // weight 0.35
    revenue_exposure: number;    // weight 0.25
    adr_parity:       number;    // weight 0.20
    supply_chain:     number;    // weight 0.15
    historical_beta:  number;    // weight 0.05
  };
};

type CatalystKind =
  | "earnings"
  | "upgrade_downgrade"
  | "ma_activity"
  | "sector_move"
  | "regulator"
  | "geo_macro"
  | "product"
  | "leadership"
  | "unclassified";    // v0.2 · default_delta=0 · kind_multiplier=1.0 · Sprint 2 分类器 GA 后 backfill 归零
```

### 2.11 Multi-market adapter boundary

Strategy γ owns all six-dimensional weights and the JP/KR input adapters.
AI-γ consumes the resulting Strategy score projection and MUST NOT reproduce J-GAAP,
K-IFRS, peer-group, beta-benchmark, or weight-normalization logic.
`RecommendationScoreSnapshot.scoring_id` and `.snapshot_hash` bind the adapted
score to the Strategy snapshot for replay.

The recommendation profile registry and output locale are:

| profile | allowed market_scope | explanation language |
|---|---|---|
| `us_preferred` | `us` or `cn_a` | `zh-CN` or `en-US` |
| `multibagger` | `us` or `cn_a` | `zh-CN` or `en-US` |
| `japan_blue_chip` | `jp` | `ja-JP` |
| `japan_multibagger` | `jp` | `ja-JP` |
| `korea_semiconductor_chain` | `kr` | `ko-KR` |
| `korea_multibagger` | `kr` | `ko-KR` |

`custom` remains a Strategy-internal profile and is not valid in a persisted
`RecommendationList`. JP/KR recommendations MUST use the corresponding
market-specific profile; falling back to `multibagger` is invalid.

Backend backtest PIT endpoints use the wire/storage field name `strategy`
(for example, `/api/v1/backtest-pit/:strategy...`). That `strategy` value maps
to the same six persisted recommendation profile slugs above. UI may label it
"profile", but the backtest namespace MUST carry the slug through the
`strategy` path/storage field rather than a query alias.

---

## §3 · Stable URI scheme

EvidenceRef `source_uri` MUST match one of the following canonical forms:

| Scheme | Format | Example |
|---|---|---|
| SEC EDGAR | `sec-edgar://<accession-no>[#<item>]` | `sec-edgar://0001193125-25-000123#item-8-01` |
| Nasdaq calendar | `nasdaq://calendar/<yyyy-mm-dd>/<symbol>` | `nasdaq://calendar/2026-07-10/AAPL` |
| FDA RSS | `fda-rss://<press-release-id>` | `fda-rss://20260710-abc` |
| Baostock | `baostock://<ticker>#<yyyymmdd>` | `baostock://600519.SH#20260710` |
| AKShare | `akshare://<dataset>/<key>` | `akshare://stock_zh_a_new_em/20260710` |
| JPX EDINET | `jpx-edinet://<doc-id>` | `jpx-edinet://E12345-20260710` |
| KRX / KIND / DART | `krx://<board>/<id>` \| `dart://<rcept-no>` | `krx://KOSPI/20260710-001` · `krx://KIND/20260710-001` · `dart://20260710-000123` |
| Catalyst event | `catalyst-event://<catalyst_id>#snapshot=<snapshot_id>` | `catalyst-event://evt-abc-123#snapshot=snap-xyz-789` |
| Internal rule | `ai-rule://<bundle-id>/<rule-id>@<version>` | `ai-rule://catalyst-morning-brief/RULE_CATALYST_MATCH@1.0.0` |
| Model output (v0.2+) | `ai-model://<model-id>@<version>/<inference-id>` | — |
| News (free-source only) | `news://<source-slug>/<article-id>` | `news://reuters/2026-07-10-abc` |

Any URI **not** matching a canonical form MUST be rejected at pipeline output validation.

---

## §4 · List envelope

```typescript
type RecommendationList = {
  snapshot_id:       string;
  as_of:             string;            // ISO8601 UTC
  profile:           RecommendationProfile;
  market_scope:      "cn_a" | "us" | "jp" | "kr";
  items:             CandidateListEntry[];  // sorted by conviction.final DESC, then ticker ASC
  output_fingerprint: string;           // semantic-envelope fingerprint (§5)
  disclaimer:        Disclaimer;
  meta: {
    contract_version:  "0.3.1";         // recommendation schema pin
    profile_version:   string;          // SemVer of the AI profile/rule bundle
    input_fingerprint: string;          // SHA-256 of RFC 8785 JCS-canonicalized pipeline input
    strategy_version:  string;          // SemVer
    pipeline_version:  string;          // SemVer
    generated_by:      string;
    generation_ms:     number;
  };
};

type CandidateListEntry = {
  recommendation:    Recommendation;
  rating_band:       Band;              // read-only mirror = recommendation.score.rating (zero duplicate SoT)
};
```

---

## §5 · Snapshot & Replay

See pipeline §5. Contract-level guarantees:

1. An identical `semantic_envelope` as defined in §5.2 MUST produce an
   identical `output_fingerprint`; mutation of any participating field MUST
   change it.
2. `output_fingerprint = SHA-256(UTF8(RFC8785-JCS(semantic_envelope)))`.
   `semantic_envelope` is a deep copy of the complete `RecommendationList`
   with **only** these volatile identity/telemetry fields removed:
   top-level `output_fingerprint`; top-level `snapshot_id`;
   `meta.generated_by`; `meta.generation_ms`; and every
   `items[*].recommendation.{id,snapshot_id}`. Everything else participates,
   including `as_of`, profile/scope, the complete ordered
   `CandidateListEntry[]`, disclaimer, and all nonvolatile meta pins.
   Implementations MUST preserve the existing §6 item order and MUST NOT
   re-sort or project entry/Recommendation fields. UUIDv4 values remain
   separately authenticated storage identities. All numbers MUST be finite
   I-JSON / IEEE-754 values; negative zero canonicalizes to `0`.
3. `input_fingerprint = SHA-256(UTF8(RFC8785-JCS(manifest)))`, where
   `manifest` is a lexicographically sorted, non-empty array of unique
   lowercase 64-hex source fact hashes. Input order is irrelevant; duplicate,
   empty, non-string, boolean, or malformed hashes fail closed.
   For the fixed four-slice replay boundary, `SourceSlice.content_hash` remains
   `SHA-256(UTF8(RFC8785-JCS(records)))`. Each input manifest element is then
   `SHA-256(UTF8(RFC8785-JCS({"content_hash": content_hash, "kind": kind})))`
   for exactly `signals`, `universe`, `scores`, and `evidence`. Binding the
   slice name preserves empty records without treating two legitimate empty
   slices as a duplicated source fact.
4. `items[*].explanation.body` templating MUST be deterministic (no time / random / locale-dependent formatting).
5. LLM (v0.2+) evidence MUST be cached in `MODEL_OUTPUT` evidence; replay reads cache, does not re-invoke LLM.
6. Replay MUST pin `(as_of, market_scope, profile, profile_version, contract_version, input_fingerprint, strategy_version, pipeline_version)`. Missing or mismatched pins fail closed rather than silently using current defaults.

---

## §6 · Ordering & sort stability

- `items` sorted by `(conviction.final DESC, ticker ASC)` · stable · deterministic.
- Ties broken by `ticker` lex ASC.
- Empty `items` allowed (e.g. all candidates fail RiskGate); envelope + disclaimer still required.

---

## §7 · Disclaimer

```typescript
type Disclaimer = {
  version:       string;                // SemVer
  short_text:    string;                // <= 200 chars
  full_text:     string;                // <= 4000 chars
  language:      "zh-CN" | "en-US" | "ja-JP" | "ko-KR";
  effective_at:  string;                // ISO8601 UTC
  hash:          string;                // sha256
};

type DisclaimerKey = "size_hint_advisory";  // v0.2 Refinement B canonical · Strategy γ §6.3

type DisclaimerMap = Record<DisclaimerKey, {
  short_text:    string;
  full_text:     string;
}>;
```

**v0.2 draft (待法务/Owner 副签)**:

- `short_text` (zh-CN): 「本内容基于公开数据与算法自动生成，仅供投资研究参考，不构成任何投资建议或承诺。市场有风险，决策需谨慎。」
- `full_text` (zh-CN):
  > 本内容由 AI 算法根据公开可获取的市场数据、公司披露、财报及公开信息自动生成。所有推荐条目仅用于投资研究学习和辅助决策参考，不构成任何形式的投资建议、买卖要约、承诺或担保。历史表现不代表未来收益。市场存在系统性风险、政策风险、流动性风险及不可预见的突发事件风险，用户须自行判断并承担所有投资决策后果。数据可能存在延迟、错误或不完整。算法与规则存在局限性，可能无法覆盖所有市场情境。使用者应结合自身财务状况、风险承受能力和独立判断作出决策，必要时咨询持牌专业投资顾问。

**`size_hint_advisory` disclaimer (v0.2 新增)**:
- `short_text` (zh-CN): 「仓位比例仅供参考，非下单 binding，实际交易须结合个人风险承受能力自行判断。」
- `full_text` (zh-CN):
  > 仓位比例建议（如 5%、3%、2%、1%）由算法根据评分、信念度及风险门禁自动生成，仅供投资研究参考。该比例不构成交易指令或下单约束，不代表任何收益承诺。用户须结合自身资金规模、风险承受能力及市场流动性自行判断实际仓位，必要时咨询持牌专业投资顾问。

**Wording hard-rules**:
- 严禁: "必涨"、"保底"、"承诺 X% 收益"、"稳赚"、"内幕"、"独家"、任何绝对收益承诺。
- 允许: "有望"、"参考"、"可能"、"倾向"、"符合 X 特征"。

---

## §8 · Validation (pipeline output invariants)

Pipeline MUST enforce (fail closed):
1. `items[*].recommendation.risk_gate.ok_to_enter == true`
2. `items[*].recommendation.trigger_signals.length >= 1`
3. `items[*].recommendation.evidence_refs.length >= 1`
4. WeightAttribution MUST satisfy exactly one state:
   - `normalized=true`: contributions are non-empty and `abs(Σ abs(weight) - 1.0) <= 1e-6`
   - `normalized=false`: contributions are exactly `[]`
   Signed `Σ weight` is informational only and MUST NOT be required to equal 1.
5. `items[*].recommendation.explanation.body` 内所有 `[E<n>]` 标记 MUST 对应存在的 `evidence_refs[i].id`
6. `items[*].recommendation.evidence_refs[*].source_uri` MUST match §3 canonical scheme
7. `disclaimer.hash` MUST equal SHA-256 of canonical `disclaimer.full_text`
8. Every `Recommendation.disclaimer_version` MUST equal `list.disclaimer.version`
9. Sort order per §6
10. `items[*].recommendation.catalyst_relevance.kind != "unclassified"` (unclassified 拒生成硬门 · unclassified events MUST NOT produce recommendations · Sprint 2 分类器 GA 后 backfill 归零)
11. `items[*].rating_band == items[*].recommendation.score.rating` (envelope mirror invariant)
12. `items[*].recommendation.conviction.final == clamp(base + Σ adjustments[i].delta, 0, 100)` (Adjustment sum invariant)
13. `items[*].recommendation.entry_plan.size_hint.pct` MUST byte-map from `size_hint.tier` per `contracts/scoring.md` §6.3
14. `items[*].recommendation.entry_plan.size_hint.disclaimer_key == "size_hint_advisory"` per `contracts/scoring.md` §6.3
15. `(profile, market_scope)` MUST match the §2.11 registry; every `Recommendation.score.{profile,market_scope}` MUST equal the list pair; and `score.{scoring_id,snapshot_hash}` MUST byte-match `conviction.score_ref` and `entry_plan.score_ref`
16. Every `RiskTrigger` MUST validate against `contracts/scoring.md` §5 for code, severity, gate derivation, and market applicability; recommendation defines no local override
17. Every `Recommendation.explanation.language` MUST be allowed by the §2.11 language set for the list profile

Validation failure at output → snapshot NOT persisted · error surfaced to Backend γ.

---

## §9 · API surface (Backend γ 副签 · msg=095dda3a PASS · v0.2 msg=9c0d7b34 LAND)

Endpoints (Backend γ v0.2 副签 PASS):

| Method | Path | Purpose | Status |
|---|---|---|---|
| GET | `/api/v1/ai/recommendations/latest?profile=&market_scope=` | Latest snapshot for a tab | v0.2 locked |
| GET | `/api/v1/ai/recommendations/:snapshot_id` | Fetch specific snapshot | v0.2 locked |
| GET | `/api/v1/ai/recommendations/by-date/:trading_day?profile=&market_scope=` | Historical browse (tab 7) | v0.2 locked |
| POST | `/api/v1/ai/recommendations/replay` | Body `{trading_day, profile, market_scope}` → job_id (async) | v0.2 locked |
| GET | `/api/v1/ai/recommendations/:snapshot_id/diff/:other_snapshot_id` | Byte-level diff for QA | v0.2 locked |

Replay flow (tab 6 REST 轮询 canonical · Orch v303 LOCK #7):
1. `POST /replay` → `{job_id: UUIDv4, status: "running"}` (AI-γ pipeline status · Backend γ UI status = `"generating"`)
2. `GET /status?job_id=<job_id>` → poll with backoff 1s→2s→5s cap 10s · status: `"running"` | `"completed"` | `"failed"`
3. On `"completed"` → `GET /:snapshot_id` for full result

Backend γ daily-report `entries[i]` = `Recommendation` byte-align 直穿 (Backend γ msg=00828340 · zero transform layer).

---

## §10 · Changelog

### v0.3.0 → v0.3.1 · P0 corrective hotfix

| # | delta | section | canonical anchor |
|---|---|---|---|
| 1 | Replace contradictory signed-sum normalization with signed L1 `weight_i=raw_i/Σ\|raw\|` | §2.8 | task #197 · Orch msg=7ee79dd3 |
| 2 | Canonical zero-mass state = `contributions=[]`, `normalized=false` | §2.8, §8 | task #197 |
| 3 | Validator invariant #4 checks L1 magnitude; signed net is informational | §8 | task #197 |
| 4 | Boolean/non-finite raw values and non-finite accumulated denominator fail closed | §2.8 | Strategy review task #201 |

### v0.2 → v0.3

| # | delta | section | canonical anchor |
|---|---|---|---|
| 1 | Recommendation profile registry 4→6 (+japan_multibagger/+korea_multibagger); contract declares all 6 | §2.2, §2.11, §4 | Strategy v0.3 · Orch v317 |
| 2 | RiskTriggerCode compatibility snapshot 12→22; `KRX_HALT` sole spelling; all semantics delegated to Strategy SOT | §2.4, §8 | Orch v317 Ruling #8 |
| 3 | Remove stale recommendation-only US code set and local severity declaration | §2.4 | `scoring.md` v0.3 |
| 4 | JP/KR adapter ownership boundary + profile/market/language matrix | §2.11 | Strategy v0.3 |
| 5 | Japanese/Korean explanation and disclaimer locales + KIND evidence URI example | §2.6, §3, §7 | AI-γ Sprint 3 |
| 6 | Replay pins contract/profile/input versions; multi-market invariants 15-17 | §4, §5, §8 | AI-γ Sprint 3 |
| 7 | Replace local Conviction/RiskGate/EntryPlan restatements with Strategy SOT references; clarify RecommendationScoreSnapshot vs Strategy ScoreRef; use `score.rating` for the rating projection | §2.2-§2.5, §4, §8 | D1 PR #215 · Orch task #179 ruling |

### v0.1 → v0.2

| # | delta | section | canonical anchor |
|---|---|---|---|
| 1 | ScoreRef + scoring_id UUIDv4 + snapshot_hash + Band + dims[] 6-dim | §2.2 | Strategy v0.2 §2.1 |
| 2 | Conviction → Adjustment[] evaluation-order-free (弃 reasons[]+adjust) | §2.3 | Strategy v0.2 §4.1 |
| 3 | WeightAttribution normalization `delta/(|Σ delta|+base_weight)` (superseded by signed L1 in v0.3.1) | §2.8 | AI-γ v0.2 |
| 4 | CatalystRelevance.kind 8→9 enum (+unclassified) + §8 hardgate | §2.10, §8 | Strategy v0.2 §3.7.2 |
| 5 | RiskTrigger 9→12 codes (+ST_TAG/PRICE_LIMIT_APPROACH/SUSPENDED) | §2.4 | Strategy v0.2 §5.3 |
| 6 | URI scheme +JP/KR examples + catalyst-event variant | §3 | DP γ-2 notes/182 |
| 7 | List envelope +rating_band +output_fingerprint +profile open enum | §4 | Strategy v0.2 Refinement C |
| 8 | Explanation.body `[E<n>]` token syntax locked | §2.6 | Frontend γ-3 tab 6 |
| 9 | EntryPlan.size_hint string→structured {tier,pct,disclaimer_key} | §2.5, §7 | Strategy v0.2 Refinement A+B |
| 10 | API 5 endpoints locked + Backend γ 副签 + replay flow | §9 | Backend γ v0.2 msg=9c0d7b34 |

---

## §11 · Iron rules

- Sprint 3 D2 PR CREATE authorization: Orch v319 msg=fe4ed6f3
- zero code-copy msg=ad6585cf (upstream has no LICENSE; strict spec-only)
- free-source only msg=4f6d2466 (evidence `NEWS` kind constrained)
- lane 契约 msg=a5297512 · AI-γ SOLE `ai/**` + `contracts/recommendation.md`
- schema.prisma untouched; Path D `9ec3f104` + 4-baseline `1f2d197a` byte-perfect
- PG SELECT-only msg=702b81be · SSH root forbidden msg=b091c74d · credentials zero literal
- US-038 SHA-256 canonical; RFC 8785 JCS for serialization
- Determinism: Math.random forbidden; time-dependent formatting forbidden in explanation templates
- Owner 免责铁律 msg=53b96525: 严禁 必涨/保底/承诺 · 允许 有望/参考/可能
- Strategy γ SOLE `contracts/scoring.md` single-point authority (AI-γ zero rename rights on SizeHintTier / Adjustment / Band / Conviction thresholds / RiskGate triggers)
- Orch v303 msg=f53c62a0 10 canonical LOCK re-litigate 禁
- Orch v317 msg=457bb3ee Ruling #8: RiskGate 22-trigger canonical · `KRX_HALT`
- doc-tier 2-sign msg=d0d11677 (主 AI-γ · 副1 Strategy γ · 副2 Research §S3)
