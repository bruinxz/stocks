# contracts/scoring.md v0.3 · Strategy γ · Multi-market scoring profiles + Conviction / RiskGate / EntryPlan

> Sprint 3 D1 · Orch v319 PR CREATE-AUTHORIZE msg=fe4ed6f3 · Orch v317 Ruling #8 msg=457bb3ee
> Strategy γ SOLE canonical · doc-tier 2-sign per msg=d0d11677 · reviewers AI-γ + Research
> Reference: catalyst-900 live https://catalyst-900-qohfq.netlify.app/ + yespsam/a-share-us-catalyst (spec-only cite · zero code-copy msg=ad6585cf)
> Predecessor: v0.2 PR #197 `9710ae74` · implementation draft `notes/scoring-multimarket-profiles-v0.3.md` msg=64ce3db0

## §0 · v0.1 → v0.2 delta ledger

| # | 领域 | v0.1 | v0.2 canonical (Orch v303 LOCK) | 消息锚 |
|---|---|---|---|---|
| 1 | Conviction shape | `{base, adjust ∈[-20,+20], final, reasons: string[]}` | `{base, adjustments: Adjustment[], final, level}` · Option A | msg=ad3bea53 · LOCK 1 |
| 2 | Conviction 阈值 | HIGH≥75/MED 50-74.9/LOW<50 | **保留 75/50 canonical** · Research §S3 70/55 demote 至上游对照 | LOCK 2 |
| 3 | Rating Band | A/B/C/D/F 85/70/55/40 | **保留 5档 canonical** · Research §S3 76/68/58 demote | LOCK 5 |
| 4 | RiskGate triggers | 9 US triggers | 12-trigger (9 US + 3 A股) | LOCK 3 |
| 5 | catalyst_kind adjust default | v0.1 未定 | 三档 default (+5/+7/+3) + RiskGate YELLOW -5/RED -10 | LOCK 4 |
| 6 | catalyst_kind 枚举 | v0.1 未定 | 9-枚举 (8 canonical + unclassified backfill · GA 归零) | LOCK 6 |
| 7 | catalyst-relevance | v0.1 未形式化 | §3.7 5-分量加权 × kind_multiplier canonical | msg=ad3bea53 |
| 8 | kind_auto_classifier | v0.1 未定 | §3.7.2 Research §S3 词表映射 | msg=ad3bea53 |
| 9 | EntryPlan time_horizon | tenor `1w/1m/3m/6m/1y` | semantic 5-enum `INTRADAY/SWING/POSITION/CORE_HOLD/LONG_TERM` (DP γ 提议采纳) | msg=ad3bea53 |
| 10 | Score audit primary key | v0.1 未定 | `scoring_id: UUIDv4` + `snapshot_hash: SHA-256(JCS RFC 8785)` | msg=be4509a8 |
| 11 | Adjustment evaluation order | v0.1 未表 | evaluation-order-free · Σ 可交换 · pipeline 内部生成 | msg=ea939251 |
| 12 | Weight profile switcher | v0.1 未定 | tab 2 profile 可切换 · tab 4 固定 multibagger · tab 1/3/5 default | LOCK 8 |
| 13 | SizeHint UI payload | v0.1 未含 disclaimer key | `size_hint: {tier, pct, disclaimer_key}` UI 消费 | LOCK 9 |
| 14 | JP/KR profile | Sprint 3 待决 | Sprint 3 与 Research §S4 同批决 (japan_blue_chip / korea_semiconductor_chain 候选) | msg=11e16e41 |
| 15 | **Refinement A** · SizeHintTier enum | T1_5/T2_3/T3_2/T4_1/SKIP | **TIER_5/TIER_3/TIER_2/TIER_1/SKIP** (downstream 收敛 · AI-γ + γ-2 + Backend γ) | msg=3f7bfd3e §二 |
| 16 | **Refinement B** · disclaimer_key | SIZING_NOT_ORDER_V1 (v0.2 初稿) | **`"size_hint_advisory"`** 硬锁 | msg=3f7bfd3e §二 |
| 17 | **Refinement C** · rating_band SoT | v0.2 初稿未显式双粒度 | **`Score.rating`** = canonical SoT · **`CandidateListEntry.rating_band`** = `entry.score.rating` 只读镜像 | msg=3f7bfd3e §二 |

### §0.1 · v0.2 → v0.3 Sprint 3 delta

| # | 领域 | v0.2 | v0.3 canonical | 权威锚 |
|---|---|---|---|---|
| 1 | `WeightsProfile` | 5 values | **7 values** · add `japan_multibagger` + `korea_multibagger` | Orch v319 D1 |
| 2 | generic `multibagger` | G0.35 / M0.10 | **G0.30 / M0.15** · Σ=1 unchanged | Strategy draft msg=64ce3db0 |
| 3 | multi-market boundary | profile-only | `MarketScope = "cn_a" \| "us" \| "jp" \| "kr"` + pre-scoring `DimensionAdapter` | Orch PR #215 review + D2 wire truth |
| 4 | RiskGate vocabulary | 12 codes | **22 codes** · 5 JP + 5 KR appended | Orch v317 Ruling #8 msg=457bb3ee |
| 5 | replay registry | implicit | **6 replayable profiles** · `custom` excluded until explicit weights are persisted | Research D3 / Orch v319 |
| 6 | compatibility | v0.2 only | trigger/profile enum extensions are additive; v0.3 snapshots require explicit `market_scope`; generic multibagger tuning changes outputs, so replay is version- and weight-pinned | Sprint 3 D1 |

## §1 · Contract purpose (v0.1 §1 retain)

Field-level contract for **6-维 Score** + **Conviction / RiskGate / EntryPlan** structures populating catalyst-900 tab 1-7 (v0.1 §7 消费矩阵 unchanged)。Shared vocabulary among Strategy γ (SOLE definer) / DP γ + γ-2 (input surface + storage) / Backend γ (compute + API DTO) / Frontend γ-1/γ-2/γ-3 (render) / AI-γ (recommendation consumer) / QADocs γ (verification) / Research §S3 (spec-extract 上游对照). Strategy γ SOLE canonical `contracts/scoring.md` per Orch v302 lane 契约.

## §2 · Score aggregate (6 dimensions · v0.1 §2 retain + §2.1 + §2.2 v0.2 补)

`quality / growth / valuation / moat / trend / risk` 各 `Dimension`, `total ∈ [0, 100]` 加权均值。Risk 反向计分 (higher score = lower realized risk)。

### §2.1 · Score object shape (v0.2 · scoring_id + snapshot_hash 新增)

```
Score {
  scoring_id:  UUIDv4                 // NEW v0.2 · Strategy γ 每次 compute 生成 · AI-γ ScoreRef 主键
  snapshot_hash: SHA-256(JCS RFC 8785 canonicalized JSON of Score minus {scoring_id, snapshot_hash})
                                       // NEW v0.2 · 确定性重放主键 · US-038 SeededRandom Math.random=0 铁律配合
  ticker:      string
  as_of:       date (ISO 8601, PIT date · no look-ahead)
  market_scope: "cn_a" | "us" | "jp" | "kr"
  quality:     Dimension
  growth:      Dimension
  valuation:   Dimension
  moat:        Dimension
  trend:       Dimension
  risk:        Dimension
  weights:     Weights                 // §2.3 · profile-driven
  weights_profile: "us_preferred" | "multibagger" | "custom"
                 | "japan_blue_chip" | "korea_semiconductor_chain"
                 | "japan_multibagger" | "korea_multibagger"
                                       // v0.3 · 7-value canonical union
  total:       number ∈ [0, 100]       // 加权均值 · rounded 1 decimal
  rating:      "A" | "B" | "C" | "D" | "F"
                                       // NEW v0.2 · Score.total → Band 5-档 映射 (§2.2) · Conviction.level 独立 · DP §6 rating 字段承接
  computed_at: timestamp (UTC)
  source_versions: {
    quality_engine:   string           // e.g. "quality@v0.3.1"
    growth_engine:    string
    valuation_engine: string
    moat_engine:      string
    trend_engine:     string
    risk_engine:      string
  }
}

Dimension {
  score:    number ∈ [0, 100]         // rounded 1 decimal
  band:     "A" | "B" | "C" | "D" | "F"  // §2.2 · dimension-level 同规则
  evidence: string[]                  // 1..5 · each ≤ 200 chars
  inputs:   object                    // §3 raw inputs · audit only · `?include=inputs` 分层 (Backend γ v0.2)
}

Weights {
  quality:   number ∈ [0, 1]
  growth:    number ∈ [0, 1]
  valuation: number ∈ [0, 1]
  moat:      number ∈ [0, 1]
  trend:     number ∈ [0, 1]
  risk:      number ∈ [0, 1]
  // Σ = 1.0 ± 1e-9
}
```

**snapshot_hash canonical**:
- 输入: 序列化 Score 对象但排除 `{scoring_id, snapshot_hash}` 两个字段
- JCS canonicalization per RFC 8785 (JSON Canonicalization Scheme) · UTF-8 · lexicographic key ordering · number canonical form
- SHA-256 hex digest (64 char lowercase)
- 作用: AI-γ recommendation 引用 Score 时 `score_ref = {scoring_id, snapshot_hash}` · 存储层 UNIQUE 索引 · 允许确定性重放验证 (regenerate Score → 比对 snapshot_hash byte-identical)

### §2.2 · Band mapping (Rating 5-档 canonical LOCK 5)

- **A**: 85..100 · thesis-strong
- **B**: 70..84.9 · thesis-solid
- **C**: 55..69.9 · watch
- **D**: 40..54.9 · thesis-weak
- **F**: 0..39.9 · fail / avoid

**同一 Band 规则应用于 (a) `Score.total → Score.rating` 和 (b) `Dimension.score → Dimension.band`** · 双粒度 Rating 存在 · DP `a_share_candidate_mapping.rating TEXT CHECK IN ('A','B','C','D','F')` 建议存 `Score.total` 派生 rating (非 dimension 级)。

Research §S3 5-tier 命名 (Buy/Outperform/Neutral/Underperform/Avoid) 与阈值 (76/68/58) 仅作 spec-extract 上游对照 · v0.2 canonical 以 Strategy γ 首位。

### §2.3 · Weight registry v0.3 (Orch v303 LOCK 8 + Sprint 3 D1)

| profile | allowed market_scope | quality | growth | valuation | moat | trend | risk | Σ |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `us_preferred` | `us` or `cn_a` | 0.20 | 0.20 | 0.15 | 0.20 | 0.15 | 0.10 | 1.00 |
| `multibagger` | `us` or `cn_a` | 0.10 | **0.30** | 0.10 | **0.15** | 0.20 | 0.15 | 1.00 |
| `japan_blue_chip` | `jp` | 0.25 | 0.15 | 0.15 | 0.20 | 0.15 | 0.10 | 1.00 |
| `korea_semiconductor_chain` | `kr` | 0.15 | 0.30 | 0.10 | 0.15 | 0.20 | 0.10 | 1.00 |
| `japan_multibagger` | `jp` | 0.10 | 0.25 | 0.10 | 0.15 | 0.25 | 0.15 | 1.00 |
| `korea_multibagger` | `kr` | 0.10 | 0.30 | 0.10 | 0.10 | 0.25 | 0.15 | 1.00 |

`custom` is the seventh `WeightsProfile` value but has no registry row: the caller must supply six explicit weights satisfying `Σ=1.0 ± 1e-9`. It is not replayable unless those exact weights are persisted in the snapshot.

**v0.3 tuning rationale**:
- Generic `multibagger`: Growth 0.35→0.30 and Moat 0.10→0.15 prevents low-moat momentum names from winning on growth alone while retaining the growth tilt.
- `japan_multibagger`: Growth + Trend = 0.50, reflecting lower reported growth dispersion and requiring market confirmation.
- `korea_multibagger`: Growth + Trend = 0.55, retaining a stronger growth tilt for KOSDAQ semiconductor, battery-material and platform cohorts.

### §2.4 · Profile/market mapping and replay set (v0.3)

| profile | allowed `MarketScope` | replayable |
|---|---|---|
| `us_preferred` | `us` or `cn_a` | yes |
| `multibagger` | `us` or `cn_a` | yes |
| `custom` | `us` or `cn_a` | **no**, unless explicit weights are persisted |
| `japan_blue_chip` | `jp` | yes |
| `japan_multibagger` | `jp` | yes |
| `korea_semiconductor_chain` | `kr` | yes |
| `korea_multibagger` | `kr` | yes |

The canonical replay whitelist therefore contains **six named registry profiles**, while `WeightsProfile` contains **seven values**. Consumers must not conflate the two counts.

**MarketScope wire canonical**:
- `MarketScope = "cn_a" | "us" | "jp" | "kr"` is shared by scoring, recommendation and Backend DTOs.
- The exhaustive local-currency mapping is `cn_a → CNY`, `us → USD`, `jp → JPY`, `kr → KRW`.
- `us_preferred` and `multibagger` are valid for both `us` and `cn_a`; callers must provide `market_scope`. Profile name alone never defaults A-share to US.
- Frontend-local display enums map only at the boundary: `A → cn_a`, `US → us`, `JP → jp`, `KR → kr`.
- JP/KR route query labels `market=JP|KR` map to `jp|kr` before Score assembly.
- The legacy aggregate-storage draft spells A-share as `cn`; persistence maps wire `cn_a → cn` and reads `cn → cn_a` until a separate schema migration. `global` has no Score-level equivalent and is invalid here.

**tab 消费 profile 缺省**:
- tab 1 A股早报: `us_preferred` + `market_scope=cn_a` (US catalyst is evidence, not the scored security's market)
- tab 2 美股优选: `us_preferred` + `market_scope=us` (default · switcher 允许 tab 2 单页切至 multibagger/custom)
- tab 3 日韩市场: JP → `japan_blue_chip`; KR → `korea_semiconductor_chain`; multibagger variants are explicit opt-in
- tab 4 高倍潜力: market-scoped multibagger profile (`multibagger` / `japan_multibagger` / `korea_multibagger`)
- tab 5 回测证据: `strategy` path parameter supports all six replayable named profiles
- tab 6 每日日报: 报告体内 profile 显式标注
- tab 7 报告历史: 快照持久化 profile

**Query param canonical**: `GET /api/v1/scores?ticker=&profile=<WeightsProfile>&market_scope=cn_a|us|jp|kr&include=inputs`; Backend must reject an invalid profile/scope pair and reject `custom` unless explicit weights accompany the request and are persisted.

## §3 · Per-dimension input surface (v0.1 §3.1-§3.6 retain byte-identical) + §3.7 catalyst-relevance canonical

### §3.1 · Quality inputs (v0.1 retain)
ROIC (5y median) · ROE (5y median) · FCF margin (5y median) · Gross margin stability (5y σ) · Interest coverage (4q trailing) · Accruals ratio (Sloan · anti-signal)

### §3.2 · Growth inputs (v0.1 retain)
Revenue CAGR 3y+5y · EPS CAGR 3y+5y (excl one-off) · Segment/geography mix (optional · weight lower if unavailable) · Forward estimates **excluded** for PIT purity

### §3.3 · Valuation inputs (v0.1 retain)
P/E TTM (negative-earnings guard → EV/EBITDA fallback) · EV/EBITDA TTM · P/B (capital-heavy sectors) · Peer-percentile P/E + EV/EBITDA (industry-adjusted) · FCF yield (TTM FCF / market cap)

### §3.4 · Moat inputs (v0.1 retain)
Gross margin absolute + sector-rank · ROIC – WACC spread (2y avg) · Market share stability (revenue rank 3y proxy) · Intangible/R&D intensity · **evidence[] mandatory ≥2** (最主观维度)

### §3.5 · Trend inputs (v0.1 retain)
50d/200d MA cross + slope · 6m total return sector-percentile · RS line vs sector · Volume-confirmed breakout (optional)

### §3.6 · Risk inputs (v0.1 retain · inverse-scored)
Realized vol (30d/90d) · Max drawdown (12m) · Beta (30d rolling) · Balance sheet: net-debt/EBITDA + current ratio · Concentration (single-customer/geo revenue share) · Regulatory/litigation flag (binary penalty)

### §3.6.1 · Multi-market normalization boundary (v0.3)

```ts
type MarketScope = "cn_a" | "us" | "jp" | "kr"

interface RawFinancialData {
  ticker: string
  market_scope: MarketScope
  as_of: string
  available_at: string
  raw: Record<string, unknown>
}

interface DimensionAdapter {
  market_scope: MarketScope
  normalizeQuality(raw: RawFinancialData): QualityInputs
  normalizeGrowth(raw: RawFinancialData): GrowthInputs
  normalizeValuation(raw: RawFinancialData): ValuationInputs
  normalizeMoat(raw: RawFinancialData): MoatInputs
  normalizeTrend(raw: RawFinancialData): TrendInputs
  normalizeRisk(raw: RawFinancialData): RiskInputs
}
```

**Boundary rules**:
1. The adapter runs at the ingestion/assembly boundary. `runScoringPipeline` remains market-agnostic and consumes the existing six typed `*Inputs`.
2. `raw.market_scope` must be allowed by the selected profile's §2.4 mapping; an explicit conflicting scope is a validation error, not an override.
3. `available_at <= as_of` is mandatory. Later filings/prices are excluded before normalization.
4. Dimension calculations remain in the market's local currency: `cn_a → CNY`, `us → USD`, `jp → JPY`, `kr → KRW`. In particular, A-share dimension inputs stay CNY-denominated; FX (`usdjpy` / `usdkrw` or any future display pair) is presentation/EntryPlan metadata and must never silently rewrite dimension inputs.
5. JP uses J-GAAP/EDINET semantics and TSE 33-sector peers; KR uses K-IFRS/DART semantics and KRX peers. Cross-shareholding/preferred-stock adjustments must be identified in `inputs` and `source_versions`.
6. Missing required inputs remain missing and reduce evidence/coverage according to the dimension contract; adapters must not silently coerce unknown fundamentals to economic zero.
7. Bundle assembly must map `normalizeTrend` → `trend_inputs` and `normalizeRisk` → `risk_inputs`. Cross-wiring is a hard contract failure.
8. Existing typed `TickerDataBundle` callers bypass raw normalization after supplying explicit `market_scope`; their six typed dimension inputs remain unchanged, while v0.3 profile weights/version pins govern newly computed output.

### §3.7 · Catalyst-relevance score (v0.2 canonical formula · NEW)

**Purpose**: 计算某 A股候选 `ticker_a` 与某 US catalyst_event 的 **relevance** (∈ [0, 1]) · 用于 tab 1 A股早报 mapped-candidate 排序 · tab 4 高倍潜力 catalyst 富集判断 · Conviction.adjustment.source_ref 引用。

**Canonical formula**:
```
relevance_score(ticker_a, catalyst_event) = clamp(
    (
        sector_map      × 0.35 +
        revenue_exposure × 0.25 +
        adr_parity      × 0.20 +
        supply_chain    × 0.15 +
        historical_beta × 0.05
    )
    × catalyst_kind_multiplier(catalyst_event.catalyst_kind),
    0, 1
)
```

**5-component (each ∈ [0, 1] · DP γ 侧 pre-compute)**:
| component | weight | 定义 (Strategy γ SOLE canonical) |
|---|---|---|
| `sector_map` | 0.35 | US catalyst 所在 GICS Level-3 sector vs A股 ticker 所在 CITIC 三级分类的映射相似度 · DP γ 静态映射表 |
| `revenue_exposure` | 0.25 | A股 ticker 最新年报海外营收占比 (US-related) · <10% = 0 · ≥50% = 1 · 线性 |
| `adr_parity` | 0.20 | A股 ticker 是否有 ADR/Hong Kong dual-listing · 有 ADR = 1 · 仅港股 = 0.6 · 无 = 0 |
| `supply_chain` | 0.15 | A股 ticker 是否列于 US catalyst 主体的公开供应链名单 · Tier-1 = 1 · Tier-2 = 0.6 · Tier-3 = 0.3 · 无 = 0 |
| `historical_beta` | 0.05 | A股 ticker 过去 60 交易日与 catalyst 主体 (若 ADR 存在) 的滚动 β · abs(β) 归一至 [0,1] |

**kind_multiplier** (per catalyst_kind 8-canonical enum · unclassified = 1.0):
| catalyst_kind | multiplier | 语义 |
|---|---|---|
| `earnings` | 1.0 | 财报驱动 · 相关性传导标准 |
| `upgrade_downgrade` | 1.0 | 分析师评级变更 |
| `product` | 1.0 | 产品发布 / 里程碑 |
| `regulator` | 1.2 | 监管事件 · 系统性传导放大 (RiskGate 联动) |
| `geo_macro` | 1.2 | 地缘/宏观事件 · 系统性传导放大 |
| `ma_activity` | 1.2 | M&A · 系统性传导放大 |
| `sector_move` | 0.9 | 板块行情 · 弱化 (个体差异大) |
| `leadership` | 0.9 | 人事变动 · 弱化 |
| `unclassified` | 1.0 | 中性 · Sprint 2 分类器 GA 后归零 |

**存储**: `a_share_candidate_mapping.relevance_score NUMERIC(4,3) CHECK BETWEEN 0 AND 1` · DP γ §6 承接。

### §3.7.1 · Threshold for mapping inclusion (v0.2)

- `relevance_score ≥ 0.30` — 计入 tab 1 mapped-candidate 列表
- `relevance_score ≥ 0.50` — 触发 Conviction.adjustment (§4.2 catalyst_kind default delta)
- `relevance_score < 0.30` — 忽略 · 不入 mapping

### §3.7.2 · kind_auto_classifier (Sprint 2 GA · v0.2 spec)

**Purpose**: Sprint 2 起 · 从 US catalyst headline/body 自动分类 `catalyst_kind` 8-enum · 消除 `unclassified` 补位。

**Input surface**:
- Research §S3 §S3 word lists canonical (per msg=49658402):
  - `OPTIONALITY` 23 词 (upside 语义 · 升级为 catalyst_kind=upgrade_downgrade|product 提示)
  - `POSITIVE` 15 词 (earnings beat / product launch 提示)
  - `NEGATIVE` 11 词 (earnings miss / downgrade / recall 提示)
  - `EARLY_NEWS` 14 词 (pre-market / breaking 提示 · 与 kind 正交)

**Classifier rule (v0.2 spec · v0.3 计算实现)**:
```
if headline contains any word ∈ OPTIONALITY ∪ POSITIVE ∪ NEGATIVE:
    infer catalyst_kind ∈ {earnings, upgrade_downgrade, product, ...}
    per rule-based first-match table (v0.3 详)
else:
    catalyst_kind = "unclassified"
```

**Sprint 2 GA 后**: `unclassified` 计数目标零 · 存量 `unclassified` 记录 backfill 至 8-enum。DP γ CHECK 约束保留 `unclassified` 枚举但目标零占用。

## §4 · Conviction (v0.2 · Option A canonical · LOCK 1 + 2)

**Purpose**: 单一 0-100 分数 · 融合 Score.total 静态 + 动态调整 · 前端 pill 渲染。

### §4.1 · Conviction object shape (v0.2 Option A canonical)

```
Conviction {
  ticker:      string
  as_of:       date
  base:        number ∈ [0, 100]         // = Score.total (via scoring_id ref)
  score_ref:   { scoring_id: UUIDv4, snapshot_hash: SHA-256 hex }
                                          // NEW v0.2 · 引用 §2.1 Score 主键 · 确定性重放
  adjustments: Adjustment[]               // length ∈ [0, 5]
  final:       number = clamp(base + Σ adjustments[].delta, 0, 100)  // rounded 1 decimal
  level:       "HIGH" | "MED" | "LOW"     // HIGH ≥ 75 · MED 50..74.9 · LOW < 50 (LOCK 2)
}

Adjustment {
  delta:       number ∈ [-20, +20]        // 单条硬约束
  reason:      string (≤ 200 chars)       // 可归因人可读描述
  kind_ref?:   CatalystKind               // 8+1 枚举 · §4.2 default delta 来源
  source_ref?: string                     // catalyst_event_id / evidence_id / trigger_code
}

// hard constraint: Σ adjustments[].delta ∈ [-20, +20]

CatalystKind =
  | "earnings" | "upgrade_downgrade" | "product"        // default delta +5
  | "regulator" | "geo_macro" | "ma_activity"           // default delta +7 · systemic · RiskGate linked
  | "sector_move" | "leadership"                        // default delta +3
  | "unclassified"                                      // default delta 0 · Sprint 2 归零
```

### §4.2 · catalyst_kind default delta table (LOCK 4 canonical)

| catalyst_kind | default delta | 备注 |
|---|---|---|
| earnings | +5 | 财报驱动 |
| upgrade_downgrade | +5 | 分析师评级 |
| product | +5 | 产品/里程碑 |
| regulator | +7 | 系统性 · RiskGate 联动 |
| geo_macro | +7 | 系统性 · RiskGate 联动 |
| ma_activity | +7 | 系统性 · RiskGate 联动 |
| sector_move | +3 | 弱化 |
| leadership | +3 | 弱化 |
| unclassified | 0 | 中性 · Sprint 2 归零 |
| **RiskGate YELLOW** | -5 | 联动 · §5 |
| **RiskGate RED** | -10 | 联动 · §5 |

**Evidence-driven 微调**: 单条 Adjustment.delta ∈ [-2, +2] 可对已生成条目做证据强度微调 · 或作为独立条目附加 (kind_ref 缺省 · reason 明写 evidence 类型)。

### §4.3 · Adjustment 生成源与 evaluation-order-free canonical (NEW v0.2)

`Adjustment[]` 是**原子记录数组** · **不是分层公式的中间态**。每条 delta 独立可归因 · Σ 可交换 · **无 evaluation order 依赖**。

**生成源** (Strategy γ pipeline 内部实现顺序 · canonical spec 不硬编码 · Backend/DP/AI 消费方 zero branching):
1. **catalyst_kind default** (§4.2): `{delta: +5|+7|+3, kind_ref: <8-enum>, source_ref: <catalyst_event_id>}`
2. **evidence-driven 微调** (±2): `{delta ∈ [-2, +2], reason: <evidence description>, source_ref: <evidence_ref>}`
3. **RiskGate 联动**: `{delta: -5|-10, reason: "RiskGate YELLOW|RED · <trigger_code>", source_ref: <trigger_code>}`

**存储层 CHECK 约束建议 (DP γ 消费)**:
```sql
CHECK (jsonb_array_length(conviction_adjustments) <= 5)
CHECK (
  ABS((
    SELECT COALESCE(SUM((elem->>'delta')::numeric), 0)
    FROM jsonb_array_elements(conviction_adjustments) elem
  )) <= 20
)
CHECK (conviction_final = ROUND(LEAST(GREATEST(
  conviction_base + (
    SELECT COALESCE(SUM((elem->>'delta')::numeric), 0)
    FROM jsonb_array_elements(conviction_adjustments) elem
  ), 0), 100), 1))
```

**QADocs sum assertion (msg=8a1899a2 采纳)**: `Σ adjustments[].delta == final - base` · 契约层 canonical · 存储层 CHECK 断言。

## §5 · RiskGate 22-trigger canonical (LOCK 3 + Orch v317 Ruling #8)

**Purpose**: 硬 gate · Entry Plan 生成前的 pre-check · 消费 near-real-time 信号 (news / earnings 邻近 / IV 冲击) · 与 Score.risk 维度正交。

### §5.1 · RiskGate object shape (v0.3 · additive)

```
RiskGate {
  ticker:       string
  evaluated_at: timestamp (UTC)
  gate:         "GREEN" | "YELLOW" | "RED"
  triggers:     Trigger[]
  ok_to_enter:  boolean       // true iff gate == "GREEN"
}

Trigger {
  code:     string    // 22-canonical enum (§5.3)
  severity: "info" | "warn" | "block"
  detail:   string    // ≤ 240 chars
}
```

### §5.2 · Gate rules (v0.1 retain)

| gate | condition |
|---|---|
| RED | ≥1 `block` trigger |
| YELLOW | ≥1 `warn` trigger · zero `block` |
| GREEN | zero `warn` and zero `block` |

**Conviction 联动**: YELLOW → Adjustment `{delta: -5}` · RED → Adjustment `{delta: -10}` · 单条 Adjustment 独立 · §4.2 table.

### §5.3 · 22-trigger canonical (v0.3 · 9 US + 3 A股 + 5 JP + 5 KR)

| # | code | severity | market | detail template |
|---|---|---|---|---|
| 1 | `EARNINGS_T-2` | warn | US | earnings within 2 trading days |
| 2 | `EARNINGS_T-0` | block | US | earnings today / after-close |
| 3 | `HALT_ACTIVE` | block | US | trading halt in effect |
| 4 | `MERGER_PENDING` | warn | US | announced M&A pending close |
| 5 | `LITIGATION_MATERIAL` | warn | US | material litigation disclosed within 30d |
| 6 | `IV_SHOCK` | warn | US | implied vol ≥ 90th percentile of trailing 30d |
| 7 | `LIQUIDITY_LOW` | warn | US | avg-daily-value < $5M |
| 8 | `RESTATEMENT_30D` | block | US | accounting restatement within 30d |
| 9 | `DELISTING_NOTICE` | block | US | exchange delisting notice |
| 10 | `ST_TAG` | **block** | A股 | 上交所/深交所 ST 或 *ST 标记 · 不入 Entry Plan |
| 11 | `PRICE_LIMIT_APPROACH` | warn | A股 | 距日内涨/跌停幅度 ≤ 1% · 流动性受限风险 |
| 12 | `SUSPENDED` | **block** | A股 | 交易所停牌 (临停/长停) · 与 HALT_ACTIVE (US) 平行编码 · 双码保留 |
| 13 | `TSE_HALT` | **block** | JP | TSE trading halt active |
| 14 | `EDINET_DELAY` | warn | JP | EDINET statutory filing delayed |
| 15 | `CORPORATE_GOVERNANCE_ISSUE` | warn | JP | corporate-governance disclosure issue |
| 16 | `TSE_TOKUBETSU_CHI` | warn | JP | TSE special-caution designation active |
| 17 | `TSE_KANRI` | **block** | JP | TSE supervision post / delisting risk |
| 18 | `KRX_HALT` | **block** | KR | KRX trading halt active |
| 19 | `DART_LATE_FILING` | warn | KR | DART statutory filing delayed |
| 20 | `INSIDER_TRADING_FLAG` | **block** | KR | insider-trading flag active |
| 21 | `KRX_UNFAITHFUL` | warn | KR | KRX unfaithful-disclosure designation |
| 22 | `KRX_INVESTOR_ALERT` | warn | KR | KRX investor-alert designation |

**Machine-countable assertion**:

```text
RISK_GATE_TRIGGER_CODES_V0_3=EARNINGS_T-2,EARNINGS_T-0,HALT_ACTIVE,MERGER_PENDING,LITIGATION_MATERIAL,IV_SHOCK,LIQUIDITY_LOW,RESTATEMENT_30D,DELISTING_NOTICE,ST_TAG,PRICE_LIMIT_APPROACH,SUSPENDED,TSE_HALT,EDINET_DELAY,CORPORATE_GOVERNANCE_ISSUE,TSE_TOKUBETSU_CHI,TSE_KANRI,KRX_HALT,DART_LATE_FILING,INSIDER_TRADING_FLAG,KRX_UNFAITHFUL,KRX_INVESTOR_ALERT
RISK_GATE_TRIGGER_COUNT_V0_3=22
```

**Ruling #8 merge semantics**:
- AI-γ contributed `TSE_HALT`, `EDINET_DELAY`, `CORPORATE_GOVERNANCE_ISSUE`, `KRX_HALT`, `DART_LATE_FILING`, `INSIDER_TRADING_FLAG`.
- Strategy γ contributed `TSE_TOKUBETSU_CHI`, `TSE_KANRI`, `KRX_UNFAITHFUL`, `KRX_INVESTOR_ALERT`.
- The overlapping Korean halt code is canonicalized as **`KRX_HALT`**; `KRX_TRADING_HALT` is invalid.
- JP/KR signal fields are optional for existing US/A-share callers. Absence means "not observed/not applicable", not `true`; it must not create a trigger.

**Extensibility**: Hong Kong `HK_SHORT_SELL_HALT` remains a future candidate and is not part of the 22-code v0.3 union.

## §6 · EntryPlan (v0.2 · time_horizon 5 semantic enum · LOCK 3 + Adjustment ref)

**Purpose**: 只在 `RiskGate.ok_to_enter == true` 时发出 · tab 1 mapped-candidate row + tab 2 detail-panel 消费。

### §6.1 · EntryPlan object shape (v0.2)

```
EntryPlan {
  ticker:         string
  generated_at:   timestamp (UTC)
  entry:          PriceBand           // buy-zone
  stop:           Price                // hard stop
  targets:        Price[]              // 1..3 laddered take-profit
  size_hint:      SizeHint             // §6.3 v0.2
  time_horizon:   TimeHorizon          // §6.2 v0.2 semantic 5-enum
  invalidation:   string               // ≤ 240 chars · thesis-invalidation trigger
  conviction_ref: number ∈ [0, 100]    // Conviction.final at generation-time
  score_ref:      { scoring_id: UUIDv4, snapshot_hash: SHA-256 hex }
                                        // NEW v0.2 · 引用 §2.1 Score 主键
}

PriceBand { low: number, high: number, currency: "USD" | "CNY" | "HKD" | "JPY" | "KRW" }
Price     { value: number, currency: string }
SizeHint {
  tier:            "TIER_5" | "TIER_3" | "TIER_2" | "TIER_1" | "SKIP"    // §6.3 v0.2 5-tier · Refinement A ratify
  pct:             number ∈ [0, 5]                                       // 0 for SKIP
  disclaimer_key:  "size_hint_advisory"   // NEW v0.2 · Refinement B ratify · Owner 免责铁律 msg=53b96525
  rationale:       string   // ≤ 200 chars
}
```

### §6.2 · time_horizon semantic 5-enum canonical (v0.2 · DP γ 提议采纳)

| enum | 语义 | 典型 tenor 上下界 |
|---|---|---|
| `INTRADAY` | 日内 · T+0 平仓 | < 1 交易日 |
| `SWING` | 波段 · 1-4 周 | 5-20 交易日 |
| `POSITION` | 持仓 · 1-3 月 | 21-60 交易日 |
| `CORE_HOLD` | 核心持仓 · 3-12 月 | 61-240 交易日 |
| `LONG_TERM` | 长线 · > 1 年 | > 240 交易日 |

v0.1 tenor-based (`1w/1m/3m/6m/1y`) **弃用** · 语义 5-enum 取代 · 与 catalyst 时效性对齐 (news → INTRADAY/SWING · earnings → SWING/POSITION · 结构性变化 → CORE_HOLD/LONG_TERM)。

### §6.3 · SizeHint 5-tier canonical (LOCK 9)

| tier | Conviction | pct_of_portfolio | UI 展示 |
|---|---|---|---|
| `TIER_5` | ≥ 85 | up to 5% | progress-bar 5/5 · pct=5.0 · disclaimer badge |
| `TIER_3` | 70..84.9 | up to 3% | progress-bar 3/5 · pct=3.0 |
| `TIER_2` | 55..69.9 | up to 2% | progress-bar 2/5 · pct=2.0 |
| `TIER_1` | 40..54.9 | up to 1% or SKIP | progress-bar 1/5 · pct=1.0 |
| `SKIP` | < 40 | 0 (no Entry Plan) | 无 Entry Plan · badge "SKIP" |

**UI 展示 canonical (LOCK 9)**:
- progress-bar 0-5% 段
- tier label
- disclaimer badge: `disclaimer_key="size_hint_advisory"` → 文案 "仅参考·非下单 binding" (Owner msg=53b96525 免责铁律 · Refinement B ratify)

### §6.4 · Stop-loss + take-profit rules (v0.1 §6 retain)

- **Stop**: 8% below entry midpoint · 收紧至技术支撑若在 5-10% 内 · **扩至 12% 只在 RiskGate=GREEN + Trend band ∈ {A,B} + Risk band ∈ {A,B}**
- **Targets**: 3 laddered ~ +15% / +30% / +50% · 调至技术阻力若清晰 · 允许 1-2 级若阻力区少

## §7 · Cross-tab consumption matrix (v0.1 §7 retain + §7.1 Frontend γ-3 补)

| tab | reads | Frontend consumer |
|---|---|---|
| 1 · A股早报 | Conviction · RiskGate · EntryPlan (mapped A-share candidate) · `relevance_score` (§3.7) | γ-1 |
| 2 · 美股优选 | Score (6-dim + rating) · Conviction · RiskGate · EntryPlan (detail-panel) · profile switcher | γ-1 |
| 3 · 日韩市场 | Score (6-dim + rating · JP/KR market profile + optional market multibagger variant) | γ-2 |
| 4 · 高倍潜力 | Score with market-scoped multibagger profile · Conviction | γ-2 |
| 5 · 回测证据 | `GET /api/v1/backtest-pit/:strategy/:as_of` + range/holdings variants · `strategy` is the profile slug | γ-3 |
| 6 · 每日日报 | Conviction 变动 ≥5 pts · new EntryPlans · gate flips · AI-γ Recommendation entries[] | γ-3 |
| 7 · 报告历史 | Score+Conviction+RiskGate+EntryPlan 快照 (persisted with `scoring_id + snapshot_hash`) | γ-3 |

For tab 5, `:as_of` is the percent-encoded ISO PIT timestamp matched against `as_of_utc`; it is not a display-day or `snapshot_day` key. The API, storage and replay field is `strategy`. Frontend may label the selector "Profile", but must not emit a `profile` wire field for this namespace.

### §7.1 · AI-γ consumption (v0.3)

AI-γ `contracts/recommendation.md` 引用:
- `Recommendation.score_ref = { scoring_id, snapshot_hash }` · byte-identical §2.1 canonical
- `Recommendation.conviction_ref = Conviction.final` at generation-time
- `Recommendation.risk_gate_status = RiskGate.gate` (GREEN|YELLOW|RED)
- `Recommendation.entry_plan_ref` (若 gate=GREEN 且 EntryPlan 已生成)
- D2 v0.3 must reuse the exact 7-value profile union and 22-code RiskGate vocabulary; recommendation lane has no rename or weight-definition authority

## §8 · Non-goals · v0.3 exclusions

- Forward analyst estimates: excluded (PIT purity)
- Alternative data: not in v0.3
- Options-derived signals beyond `IV_SHOCK`: not in v0.3
- Cryptocurrency / commodities scoring: out of scope
- Backtesting engine wiring: contract only · impl 归 Backend γ + DP γ-2
- JP/KR raw collector implementation and schema migrations: outside Strategy lane
- Currency conversion inside dimension scoring: prohibited; FX is presentation/EntryPlan metadata only

## §9 · Open questions for v0.4+

- **Q1 · Adjustment cap 收紧** to ±15: 需回测证据，不在 v0.3 改
- **Q2 · RiskGate 港股扩展**: `HK_SHORT_SELL_HALT` 候选
- **Q3 · Conviction level 补 `VERY_HIGH ≥ 90`**: 需观察 90+ 区段行为差异
- **Q4 · Currency FX display**: EntryPlan.entry 存 native · 可追加 USD 只读展示值
- **Q5 · custom replay**: 定义 explicit-weight snapshot schema 后才进入 replay whitelist

## §10 · Sprint 3 dependency handoff

| lane | v0.3 handoff | work item | 状态 |
|---|---|---|---|
| **Strategy γ** | scoring v0.3 (本文) | task #177 | PR-authorized |
| AI-γ | recommendation contract v0.3 consumes 7 profiles / 22 codes | task #179 | in progress |
| Research §S3 | tab 3/4/5 spec extract validates profile/replay distinction | PR #213 | review |
| DP γ-2 | raw JP/KR collectors populate adapter inputs and PIT metadata | task #169 / #180 | in progress |
| Backend γ | route whitelist exposes six replayable named profiles | task #176 | in progress |
| Frontend γ-2/γ-3 | tab 3/4 profile selection + tab 5 replay selector | task #178 / #181 | in progress |
| QADocs γ | 152-case checklist includes 7-profile/6-replay and 22-code assertions | task #175 | in progress |

## §11 · v0.3 compatibility and validation gates

1. Every registry profile sums to `1.0 ± 1e-9`; the seven-value type and six-value replay whitelist are asserted separately.
2. Generic `multibagger` tuning is a scored-output change and requires `source_versions.* = @v0.3.x`; old snapshots retain their recorded v0.2 weights.
3. The ten new RiskGate codes are additive. US/A-share callers that omit JP/KR signals produce the same gate as v0.2.
4. JP/KR adapter fixtures assert `available_at <= as_of`, local-currency scoring, missingness preservation and trend/risk non-cross-wiring.
5. Replay persists profile slug, exact weights, `as_of`, `computed_at`, input `available_at`, `source_versions`, `scoring_id`, and `snapshot_hash`.
6. Replay also persists `market_scope`; generic profiles never infer `us` when the scored security is A-share.
7. A v0.2 typed bundle can be migrated by supplying explicit `market_scope`; v0.2 snapshots retain recorded weights and engine versions. Recomputing generic `multibagger` under v0.3 is intentionally output-changing.
8. No migration or `schema.prisma` change is part of D1.
9. A machine assertion covers the exhaustive `MarketScope → currency` mapping and rejects missing/extra scope or currency values.

## §12 · Discipline

- PR CREATE authorized by Orch v319 msg=fe4ed6f3 · task #177 claimed
- Strategy γ SOLE `contracts/scoring.md` (Orch v302 lane 契约 · single-point canonical authority)
- 借鉴独立性 msg=ad6585cf: catalyst-900 spec-observations only · **zero code-copy** · Research §S3 spec-extract 独立通读, 本契约 Strategy γ 自撰
- 免费源 msg=4f6d2466 · schema.prisma untouched (DP γ 单一 aggregator entry)
- PG SELECT-only msg=702b81be · SSH root 永久禁 msg=b091c74d · 凭证 zero literal `sk_agent_<redacted>`
- US-038 SeededRandom Math.random=0 SHA-256 deterministic-derive (与 §2.1 snapshot_hash 铁律配合)
- doc-tier gate = self-sign + ≥1 non-owner ACCEPT per msg=d0d11677; requested reviewers are AI-γ and Research
- 报告仅用: tab 编号 1-7 · 字段名 (Score/Conviction/RiskGate/EntryPlan) · Sprint N · lane 名 · 契约名 · tab % · gap · ETA · blocker (Orch v300 §五 纪律)
- **弃用**: σ/CASCADE/tenner/DECUPLE/CENTUM/QUADRILOGY/TETRALOGY/DENARIUS/POST-DOUBLE-CENTURION 学术堆叠术语 (v300 §五 forbidden)
- perpetual dispatch msg=eb4b0016/21867874/a8175861/210d262d LIVE · agents 不停
