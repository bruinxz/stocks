# AI Recommendation Contract v0.2 · workspace-draft

- **Owner**: AI-γ (`@AI`) · SOLE
- **Task**: #170 · Orch v302 msg=f81297a5
- **Companion**: `notes/ai-recommendation-pipeline-v0.1-workspace-draft.md`
- **Consumes**: `contracts/scoring.md` v0.2 (Strategy γ · msg=3f7bfd3e); `contracts/catalyst-mapping.md` v0.2 (DP γ · msg=79bfc500)
- **Status**: workspace-draft-only · zero repo write · pending Orch PR-CREATE-AUTHORIZE
- **Change control**: Any schema-breaking change → SemVer major bump + Backend γ + Frontend γ-3 副签 · Additive change → minor bump · Doc-only → patch bump
- **doc-tier 2-sign**: 主 AI-γ · 副1 Strategy γ · 副2 Research §S3

---

## §1 · SemVer

Contract version: `0.2.0`

Compatibility matrix (v0.2 anchor):
- `scoring.md`: `>=0.2.0, <0.3.0`
- `catalyst-mapping.md`: `>=0.2.0, <0.3.0`

---

## §2 · Core types (canonical)

### 2.1 Recommendation

```typescript
type Recommendation = {
  id:                  string;                    // UUID v4
  snapshot_id:         string;                    // FK -> Snapshot.snapshot_id
  ticker:              string;                    // normalized upper; suffixed by market e.g. "600519.SH" | "AAPL" | "7203.T" | "005930.KS"
  as_of:               string;                    // ISO8601 UTC seconds

  // Strategy consumption block (verbatim from scoring.md; AI-γ read-only)
  score:               ScoreRef;                  // §2.2
  conviction:          Conviction;                // scoring.md §4
  risk_gate:           RiskGate;                  // scoring.md §5 · MUST have ok_to_enter=true
  entry_plan:          EntryPlan;                 // scoring.md §6
  catalyst_relevance?: CatalystRelevance;         // catalyst-mapping.md 5-component (nullable)

  // AI-γ additive block
  trigger_signals:     TriggerSignal[];           // length >= 1
  weights:             WeightAttribution;         // normalized to 1.0
  explanation:         Explanation;               // §2.6
  evidence_refs:       EvidenceRef[];             // length >= 1

  // Metadata
  model_version:       string;                    // SemVer of AI-γ rule bundle / model
  disclaimer_version:  string;                    // SemVer of disclaimer
};
```

### 2.2 ScoreRef (reference to Strategy Score)

```typescript
type ScoreRef = {
  scoring_id:      string;   // Strategy-issued UUIDv4 stable id (Strategy γ v0.2 §2.1)
  snapshot_hash:   string;   // SHA-256(JCS(Score minus scoring_id, snapshot_hash)) (Strategy γ v0.2 §2.1)
  profile:         "us_preferred" | "multibagger";
  total:           number;   // 0..100 (denormalized snapshot for O(1) sort)
  band:            Band;     // Strategy §2.2 canonical (A≥85 / B 70-84.9 / C 55-69.9 / D 40-54.9 / F<40)
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

### 2.3 Conviction (verbatim from scoring.md §4 · Strategy γ SOLE)

```typescript
type Conviction = {
  base:            number;              // Score.total
  adjustments:     Adjustment[];        // length ∈ [0,5] · Σ delta ∈ [-20,+20] · evaluation-order-free
  final:           number;              // clamp(base + Σ adjustments[i].delta, 0, 100)
  level:           "HIGH" | "MED" | "LOW";  // HIGH ≥ 75 · MED 50-74.9 · LOW < 50
};

type Adjustment = {
  delta:           number;              // single adjustment ∈ [-20,+20]
  reason:          string;              // ≤ 200 chars
  kind_ref?:       string;              // optional catalyst_kind reference
  source_ref?:     string;              // optional evidence reference
};
```

Invariant: `final == clamp(base + Σ adjustments[i].delta, 0, 100)` · evaluation-order-free (Σ is commutative · storage layer zero branching per Strategy γ msg=ea939251).

### 2.4 RiskGate (verbatim from scoring.md §5 · Strategy γ SOLE)

```typescript
type RiskGate = {
  gate:            "GREEN" | "YELLOW" | "RED";
  ok_to_enter:     boolean;             // MUST be true in Recommendation.risk_gate
  triggers:        RiskTrigger[];       // may be empty when GREEN
};

type RiskTrigger = {
  code:            RiskTriggerCode;
  severity:        "INFO" | "WARN" | "BLOCK";
  detail:          string;              // <= 240 chars
};

type RiskTriggerCode =
  // 9 US triggers
  | "SEC_HALT"
  | "EARNINGS_BLACKOUT"
  | "FDA_ADCOM"
  | "LITIGATION_MATERIAL"
  | "SHORT_SQUEEZE_RISK"
  | "LIQUIDITY_THIN"
  | "INSIDER_LOCKUP"
  | "DEBT_COVENANT"
  | "REGULATORY_REVIEW"
  // 3 A-share extensions
  | "ST_TAG"                // severity = BLOCK
  | "PRICE_LIMIT_APPROACH"  // severity = WARN
  | "SUSPENDED";            // severity = BLOCK
```

RiskGate Adjustment 联动 (Strategy §5.3): YELLOW gate → catalyst_kind default delta -5 · RED gate → -10.

### 2.5 EntryPlan (verbatim from scoring.md §6 · Strategy γ SOLE)

```typescript
type EntryPlan = {
  price_band:      { low: number; high: number; currency: string };   // ISO 4217
  stop:            number;
  targets:         [number] | [number, number] | [number, number, number];  // 1..3
  size_hint:       SizeHint;
  time_horizon:    "INTRADAY" | "SWING" | "POSITION" | "CORE_HOLD" | "LONG_TERM";
  invalidation:    string;              // <= 240 chars
  conviction_ref:  string;              // -> Conviction identity for audit
};

type SizeHint = {
  tier:            SizeHintTier;
  pct:             number;              // ∈ [0, 5] · byte-map from tier
  disclaimer_key:  "size_hint_advisory";
};

type SizeHintTier = "TIER_5" | "TIER_3" | "TIER_2" | "TIER_1" | "SKIP";
// Strategy γ v0.2 §6.3 Refinement A canonical · tier→pct mapping:
// TIER_5 → 5.0 · TIER_3 → 3.0 · TIER_2 → 2.0 · TIER_1 → 1.0 · SKIP → 0.0
```

### 2.6 Explanation

```typescript
type Explanation = {
  headline:        string;              // <= 80 chars
  body:            string;              // <= 600 chars · reference evidence via [E<n>] markers
  caveats:         string[];            // 0..3, each <= 120 chars
  language:        "zh-CN" | "en-US";   // v0.2: zh-CN only
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
type WeightAttribution = {
  contributions:   Contribution[];
  normalized:      true;                // v0.2 hard-locked
};

type Contribution = {
  source_kind:     "trigger" | "score_dim" | "catalyst_relevance";
  source_ref:      string;              // TriggerCode | "Q"|"G"|"V"|"M"|"T"|"R" | catalyst_id
  weight:          number;              // [-1.0, 1.0]
  note?:           string;
};

// Invariant: sum(contributions.weight) == 1.0 ± 1e-6
// Optional invariant: sum(|weight|) <= 1.5  (for hedged displays)
```

v0.2 normalization canonical: `weight_i = delta_i / (|Σ delta| + base_weight)` where `base_weight` is the profile-specific base contribution. This ensures contributions sum to 1.0 even with negative (hedging) weights.

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
| KRX / DART | `krx://<board>/<id>` \| `dart://<rcept-no>` | `krx://KOSPI/20260710-001` · `dart://20260710-000123` |
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
  profile:           string;            // open enum · v0.2 known: "us_preferred" | "multibagger"
  market_scope:      "cn_a" | "us" | "jp" | "kr";
  items:             CandidateListEntry[];  // sorted by conviction.final DESC, then ticker ASC
  output_fingerprint: string;           // SHA-256 of JCS-canonicalized items (§5)
  disclaimer:        Disclaimer;
  meta: {
    strategy_version:  string;          // SemVer
    pipeline_version:  string;          // SemVer
    generated_by:      string;
    generation_ms:     number;
  };
};

type CandidateListEntry = {
  recommendation:    Recommendation;
  rating_band:       Band;              // read-only mirror = recommendation.score.band (zero duplicate SoT)
};
```

---

## §5 · Snapshot & Replay

See pipeline §5. Contract-level guarantees:

1. Given identical `(input_fingerprint, pipeline_version, model_version, strategy_version, rule_bundle_hash, template_hash, disclaimer_hash)`, the pipeline MUST produce identical `output_fingerprint`.
2. `output_fingerprint` = SHA-256 of RFC 8785 JCS-canonicalized `RecommendationList` with `meta.generation_ms` and `meta.generated_by` removed.
3. `items[*].explanation.body` templating MUST be deterministic (no time / random / locale-dependent formatting).
4. LLM (v0.2+) evidence MUST be cached in `MODEL_OUTPUT` evidence; replay reads cache, does not re-invoke LLM.

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
  language:      "zh-CN" | "en-US";
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
4. `abs(sum(items[*].recommendation.weights.contributions.weight) - 1.0) <= 1e-6`
5. `items[*].recommendation.explanation.body` 内所有 `[E<n>]` 标记 MUST 对应存在的 `evidence_refs[i].id`
6. `items[*].recommendation.evidence_refs[*].source_uri` MUST match §3 canonical scheme
7. `disclaimer.hash` MUST equal SHA-256 of canonical `disclaimer.full_text`
8. Every `Recommendation.disclaimer_version` MUST equal `list.disclaimer.version`
9. Sort order per §6
10. `items[*].recommendation.catalyst_relevance.kind != "unclassified"` (unclassified 拒生成硬门 · unclassified events MUST NOT produce recommendations · Sprint 2 分类器 GA 后 backfill 归零)
11. `items[*].rating_band == items[*].recommendation.score.band` (envelope mirror invariant)
12. `items[*].recommendation.conviction.final == clamp(base + Σ adjustments[i].delta, 0, 100)` (Adjustment sum invariant)
13. `items[*].recommendation.entry_plan.size_hint.pct` MUST byte-map from `size_hint.tier` per SIZE_HINT_TIER_PCT constant
14. `items[*].recommendation.entry_plan.size_hint.disclaimer_key == "size_hint_advisory"` (disclaimer_key hard-lock)

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

## §10 · v0.1 → v0.2 changelog

| # | delta | section | canonical anchor |
|---|---|---|---|
| 1 | ScoreRef + scoring_id UUIDv4 + snapshot_hash + Band + dims[] 6-dim | §2.2 | Strategy v0.2 §2.1 |
| 2 | Conviction → Adjustment[] evaluation-order-free (弃 reasons[]+adjust) | §2.3 | Strategy v0.2 §4.1 |
| 3 | WeightAttribution normalization `delta/(|Σ delta|+base_weight)` | §2.8 | AI-γ v0.2 |
| 4 | CatalystRelevance.kind 8→9 enum (+unclassified) + §8 hardgate | §2.10, §8 | Strategy v0.2 §3.7.2 |
| 5 | RiskTrigger 9→12 codes (+ST_TAG/PRICE_LIMIT_APPROACH/SUSPENDED) | §2.4 | Strategy v0.2 §5.3 |
| 6 | URI scheme +JP/KR examples + catalyst-event variant | §3 | DP γ-2 notes/182 |
| 7 | List envelope +rating_band +output_fingerprint +profile open enum | §4 | Strategy v0.2 Refinement C |
| 8 | Explanation.body `[E<n>]` token syntax locked | §2.6 | Frontend γ-3 tab 6 |
| 9 | EntryPlan.size_hint string→structured {tier,pct,disclaimer_key} | §2.5, §7 | Strategy v0.2 Refinement A+B |
| 10 | API 5 endpoints locked + Backend γ 副签 + replay flow | §9 | Backend γ v0.2 msg=9c0d7b34 |

---

## §11 · Iron rules

- workspace-draft-only msg=ed61c397 · zero repo write until PR CREATE authorization
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
- doc-tier 2-sign msg=d0d11677 (主 AI-γ · 副1 Strategy γ · 副2 Research §S3)
