# DP γ · schema.prisma aggregate v0.2 · workspace-draft

**status**: workspace-draft-only · msg=ed61c397 · zero repo write · Sprint 1 末待 Orch aggregate PR CREATE-AUTHORIZE
**purpose**: catalyst-900 IA 全 7-tab 数据侧 8-table 全景 canonical single-entry · schema.prisma 单一入口 msg=a5297512 · DP γ 主 · DP γ-2 draft 提交後 DP γ 汇总 · AI-γ 双表 fold-in
**author**: DP γ (@DataPipeline)
**created**: 2026-07-10
**updated**: 2026-07-10 (v0.2 · AI-γ msg=b972279f 双表 fold-in · 6→8 table)
**scope**: 8 表 canonical (2 DP γ SOLE + 3 DP γ-2 SOLE + 1 ALTER DP γ-2 SOLE + 2 AI-γ SOLE write / DP γ aggregate)
**owner-iron-rules retained**: msg=53b96525 catalyst-900 · msg=a5297512 lane 契约 · msg=d0d11677 doc-tier 2-sign · msg=ed61c397 workspace-draft-only · schema.prisma untouched (physical file · 本文件仅 spec)

---

## §1 · 表全景 canonical

| # | 表名 | Owner | 承接 tab | 来源 spec | v |
|---|---|---|---|---|---|
| 1 | `us_catalyst_event` | DP γ SOLE | tab 1 | notes/180 v0.2 §6.1 | v0.2 |
| 2 | `a_share_candidate_mapping` | DP γ SOLE | tab 1 | notes/180 v0.2 §6.2 | v0.2 |
| 3 | `multibagger_universe` | DP γ-2 SOLE | tab 4 | DP γ-2 notes/182 §6 | v0.1 (γ-2 v0.2 待 LAND) |
| 4 | `backtest_pit_snapshot` | DP γ-2 SOLE | tab 5 | DP γ-2 notes/182 §4 | v0.1 |
| 5 | `jpkr_financial_snapshot` | DP γ-2 SOLE | tab 3 | DP γ-2 notes/182 §5 + notes/181 v0.1 承接 | v0.1 |
| 6 | ALTER `jpkr_daily_kline` | DP γ-2 SOLE | tab 3 | notes/181 v0.1 §5 + JP/KR 6-维扩展 | v0.1 |
| 7 | `ai_recommendation_snapshot` | AI-γ SOLE write · DP γ aggregate | tab 6/7 | AI-γ msg=b972279f notes/ai-snapshot-code-v0.1 | v0.2 new |
| 8 | `ai_recommendation_item` | AI-γ SOLE write · DP γ aggregate | tab 6/7 | AI-γ msg=b972279f notes/ai-snapshot-code-v0.1 | v0.2 new |

**tab 覆盖**:
- **tab 1 A股早报**: 表 1 + 表 2 (DP γ SOLE)
- **tab 2 美股优选**: 表 2 复用 `score_profile='us_preferred'` · 消费方 Strategy γ + Backend γ · DP zero delta
- **tab 3 日韩市场**: 表 5 + 表 6 ALTER (DP γ-2 SOLE)
- **tab 4 高倍潜力**: 表 3 (DP γ-2 SOLE)
- **tab 5 回测证据**: 表 4 (DP γ-2 SOLE) · 消费方 Backend γ `/api/v1/backtest-pit/*` canonical 端点
- **tab 6 每日日报**: 表 7 + 表 8 (AI-γ SOLE write · DP γ aggregate) · Backend γ `/api/v1/daily-report/*` 消费
- **tab 7 报告历史**: 表 7 + 表 8 复用 (AI-γ snapshot append-only · Backend γ `/api/v1/reports/*` 消费)

## §2 · 依赖链 verify

```
Strategy γ contracts/scoring.md v0.2
    ├── scoring_id UUIDv4 (Strategy 生成)
    ├── snapshot_hash SHA-256(JCS(Score minus 2))
    ├── Conviction Option A (Adjustment[])
    ├── RiskGate 12-trigger + severity
    ├── Rating 5-tier (A/B/C/D/F)
    └── catalyst_kind 9-枚举 (含 unclassified)
        │
        ▼
DP γ notes/180 v0.2 §6 DDL (us_catalyst_event + a_share_candidate_mapping)
        │
        ▼
AI-γ contracts/recommendation.md v0.2 + notes/ai-snapshot-code-v0.1
    ├── ai_recommendation_snapshot (版本锁 + fingerprint)
    └── ai_recommendation_item (per-ticker JCS canonical)
        │
        ▼
DP γ-2 notes/182 v0.1 §4-6 (multibagger_universe + backtest_pit_snapshot + jpkr_financial_snapshot + ALTER jpkr_daily_kline)
        │
        ▼
本文件 (notes/183 aggregate v0.2) · schema.prisma 单一入口 canonical single-entry
        │
        ▼
Sprint 1 末 Orch aggregate PR CREATE-AUTHORIZE (doc-tier 2-sign msg=d0d11677)
```

## §3 · 表 1 · `us_catalyst_event` (DP γ SOLE)

引用 notes/180 v0.2 §6.1 完整 DDL · zero delta。

**关键约束**:
- `catalyst_kind` CHECK IN (9-enum · Orch v303 LOCK 6)
- UNIQUE `(event_source_kind, ingest_source_hash)` — 幂等键
- INDEX `(cn_trading_day_asia_shanghai)` — tab 1 早报日索引
- INDEX `(catalyst_kind, event_time_utc DESC)` — kind FilterChip 消费

## §4 · 表 2 · `a_share_candidate_mapping` (DP γ SOLE)

引用 notes/180 v0.2 §6.2 完整 DDL · zero delta。

**关键约束**:
- CHECK `jsonb_array_length(conviction_adjustments) <= 5` (Adjustment[] length 硬约束 · Strategy §4 canonical)
- CHECK `conviction_final = ROUND(LEAST(GREATEST(base + Σ delta, 0), 100), 1)` — evaluation-order-free 硬约束 (Orch v303 LOCK 1)
- CHECK `conviction_level IN ('HIGH','MED','LOW')` (Orch v303 LOCK 2 · 阈值 75/50 in pipeline)
- CHECK `rating IN ('A','B','C','D','F')` — 独立 5-tier (Orch v303 LOCK 5)
- CHECK `risk_gate_status IN ('GREEN','YELLOW','RED')` (Orch v303 LOCK 3)
- CHECK `score_profile IN ('us_preferred','multibagger','japan_korea')` (Orch v303 LOCK 8)
- UNIQUE `(us_catalyst_event_id, cn_ticker)` — 幂等键
- REFERENCES `us_catalyst_event(us_catalyst_event_id)` — FK cross-table

## §5 · 表 3 · `multibagger_universe` (DP γ-2 SOLE · pending γ-2 v0.2 shape lock)

**来源**: DP γ-2 notes/182 §6 v0.1 (workspace-draft) · γ-2 v0.2 承诺 §3.2 阈值精修

**承接位** (v0.1 aggregate skeleton · γ-2 v0.2 LAND 后 fold-in 完整字段):
```sql
-- Sprint 1 末 aggregate v0.1 · draft skeleton
-- 完整字段以 DP γ-2 notes/182 v0.2 LAND 为准 · doc-tier 2-sign (主 DP γ-2 · 副 DP γ + QADocs γ)
CREATE TABLE multibagger_universe (
    multibagger_universe_id UUID PRIMARY KEY,
    universe_source_kind TEXT NOT NULL CHECK (universe_source_kind IN (
        'akshare_cn', 'baostock_cn', 'russell3000_crsp_alt'
    )),
    ticker TEXT NOT NULL,
    exchange TEXT NOT NULL,                                   -- 'sh'|'sz'|'bj'|'nyse'|'nasdaq'|'lse'|'tse'|'ose'|'krx'|'kosdaq'
    market_cap_cny_100m NUMERIC(10,2),                        -- 亿元 CNY · 双峰 sweet spot 80/300 亿
    text_hit_kinds JSONB NOT NULL DEFAULT '[]'::jsonb,        -- ['negative','early_news',...] · Research §S3 §二.2 词表消费
    fundamental_snapshot JSONB NOT NULL,                      -- Q0.25/G0.15 etc profile 输入
    filter_pass_bitmap INTEGER NOT NULL,                      -- 3-筛源 pass bitmap
    fact_hash TEXT NOT NULL,
    as_of_utc TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (universe_source_kind, ticker, as_of_utc)
);
CREATE INDEX ix_multibagger__as_of ON multibagger_universe (as_of_utc DESC);
CREATE INDEX ix_multibagger__ticker ON multibagger_universe (ticker);
```

**γ-2 v0.2 待 fold-in delta** (承 DP γ-2 msg=8dfe0f79 v0.2 消化清单):
- §3.2 破发/低机构筛阈值精修
- §6.1 text_hit_kinds 扩展 (含 negative/early_news 分层)
- §4.3 CRSP-alt License 核查 (若 License 不兼容 · universe_source_kind 剔除 'russell3000_crsp_alt' 值)

## §6 · 表 4 · `backtest_pit_snapshot` (DP γ-2 SOLE)

**来源**: DP γ-2 notes/182 v0.1 §4 · Backend γ msg=07b34ce5 payload canonical + Frontend γ-3 msg=a382e343 5-slot lock

```sql
-- Sprint 1 末 aggregate v0.1 · byte-align Backend γ /api/v1/backtest-pit/*  canonical
CREATE TABLE backtest_pit_snapshot (
    snapshot_id UUID PRIMARY KEY,
    strategy TEXT NOT NULL,                                   -- 'us_preferred'|'multibagger'|'japan_blue_chip'|'korea_semiconductor_chain'
    as_of_utc TIMESTAMPTZ NOT NULL,                           -- PIT 时间锚 · ISO-8601
    snapshot_day DATE NOT NULL,
    is_survivorship_biased BOOLEAN NOT NULL DEFAULT FALSE,    -- Frontend γ-3 <Warning> 消费 · 3 SLA 幸存者偏差
    is_delisted_at_as_of BOOLEAN NOT NULL DEFAULT FALSE,      -- Frontend γ-3 侧栏 stale tag 消费
    source_versions JSONB NOT NULL,                           -- PIT replay key · {"us_price":"yahoo-2026-07-10","fundamentals":"av-2026-Q2",...}
    metrics JSONB NOT NULL,                                   -- {net_value, drawdown, cumulative_return, sharpe_ratio_6m, win_rate_6m}
    holdings JSONB NOT NULL DEFAULT '[]'::jsonb,              -- [{ticker, weight, return_since_entry, is_stale}] top-level 4 字段 (三方 lock msg=a382e343)
    fact_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (strategy, snapshot_day, as_of_utc)                -- 幂等键
);
CREATE INDEX ix_pit__strategy_as_of ON backtest_pit_snapshot (strategy, as_of_utc DESC);
CREATE INDEX ix_pit__snapshot_day ON backtest_pit_snapshot (snapshot_day DESC);
```

**3 SLA 承接位** (QADocs msg=1802cc6f):
1. 幂等 → UNIQUE `(strategy, snapshot_day, as_of_utc)`
2. 防未来函数 → DP γ-2 §9.5 v0.2 SQL 断言 `payload.source_ts > as_of_utc` REJECT
3. 防幸存者偏差 → `is_survivorship_biased` + `is_delisted_at_as_of` 双 BOOLEAN

## §7 · 表 5 · `jpkr_financial_snapshot` (DP γ-2 SOLE · pending γ-2 v0.2)

**来源**: DP γ-2 notes/182 §5 v0.1 + DP γ notes/181 v0.1 承接 (JP/KR 6-维覆盖 89%/88%)

```sql
-- Sprint 1 末 aggregate v0.1 · draft skeleton · 完整字段以 DP γ-2 v0.2 为准
CREATE TABLE jpkr_financial_snapshot (
    jpkr_financial_snapshot_id UUID PRIMARY KEY,
    market TEXT NOT NULL CHECK (market IN ('jp', 'kr')),
    ticker TEXT NOT NULL,
    fiscal_year INTEGER NOT NULL,
    fiscal_quarter INTEGER,                                   -- 1-4 · NULL for annual
    dim_quality JSONB,                                        -- Q dimension inputs
    dim_growth JSONB,                                         -- G
    dim_valuation JSONB,                                      -- V
    dim_moat JSONB,                                           -- M
    dim_trend JSONB,                                          -- T
    dim_risk JSONB,                                           -- R
    coverage_pct NUMERIC(5,2),                                -- 该记录 6-维实际覆盖百分比 · JP 目标 89% · KR 目标 88%
    source_kind TEXT NOT NULL CHECK (source_kind IN (
        'jpx-edinet', 'yahoo-jp', 'stooq-jp',
        'krx-marketdata', 'kind', 'dart', 'pykrx'
    )),
    source_document_id TEXT,
    fx_rate_to_usd NUMERIC(18,8),                             -- Sprint 3 fx pipeline (DP γ-2 §6.3 v0.2 承接)
    fact_hash TEXT NOT NULL,
    as_of_utc TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (market, ticker, fiscal_year, fiscal_quarter, source_kind)
);
CREATE INDEX ix_jpkr_fin__ticker_time ON jpkr_financial_snapshot (market, ticker, fiscal_year DESC, fiscal_quarter DESC);
```

## §8 · 表 6 · ALTER `jpkr_daily_kline` (DP γ-2 SOLE)

**来源**: DP γ notes/181 v0.1 §5 (基础表结构) + DP γ-2 JP/KR 6-维字段扩展

```sql
-- Sprint 1 末 aggregate v0.1 · notes/181 v0.1 §5 已定基础表 · ALTER 补 6-维锚点 + is_halted 强化
ALTER TABLE jpkr_daily_kline
    ADD COLUMN adjusted_close NUMERIC(18,4),                   -- 除权后 close · 6-维 T (trend) 输入
    ADD COLUMN dividend_amount NUMERIC(18,4),                  -- 派息金额本币
    ADD COLUMN split_ratio NUMERIC(10,4),                      -- 拆股比例
    ADD COLUMN market_cap_local BIGINT,                        -- 收盘时市值本币
    ADD COLUMN turnover_rate NUMERIC(8,6),                     -- 换手率
    ADD COLUMN halt_reason_code TEXT;                          -- 停牌原因代码

-- 新索引 (基于 notes/181 v0.1 §5 已有 UNIQUE key)
CREATE INDEX ix_jpkr_kline__exchange_day ON jpkr_daily_kline (exchange, trading_day DESC);
```

**注意**: notes/181 v0.1 §5 已含基础表 CREATE + UNIQUE `(exchange, ticker, trading_day, source_kind)` 幂等键 + 基础 INDEX。本 §8 只做 ALTER 增量 · v0.1 aggregate 阶段 · Sprint 2 采集器实装前 fold-in schema.prisma。

## §8a · 表 7 · `ai_recommendation_snapshot` (AI-γ SOLE write · DP γ aggregate) [v0.2 new]

**来源**: AI-γ msg=b972279f notes/ai-snapshot-code-v0.1 双表 DDL draft · contracts/recommendation.md v0.2 §9

```sql
-- v0.2 aggregate · AI-γ 双表 fold-in · pipeline snapshot 版本锁 + fingerprint
CREATE TABLE ai_recommendation_snapshot (
    snapshot_id UUID PRIMARY KEY,
    trading_day DATE NOT NULL,
    profile TEXT NOT NULL CHECK (profile IN (
        'us_preferred', 'multibagger', 'japan_korea'
    )),
    market_scope TEXT NOT NULL CHECK (market_scope IN (
        'us', 'cn', 'jp', 'kr', 'global'
    )),
    pipeline_version TEXT NOT NULL,                              -- e.g. 'v0.1.0'
    model_version TEXT NOT NULL,                                 -- e.g. 'rule-v0.1' (v0.1 rule-based only)
    strategy_version TEXT NOT NULL,                              -- scoring v0.2 ref
    rule_bundle_hash TEXT NOT NULL,                              -- SHA-256 of rules YAML bundle
    template_hash TEXT,                                          -- Sprint 2 mid: explanation template hash
    disclaimer_hash TEXT,                                        -- SHA-256 of disclaimer text
    input_fingerprint TEXT NOT NULL,                             -- SHA-256 of all input data
    output_fingerprint TEXT NOT NULL,                            -- SHA-256(JCS(all items)) · RFC 8785 canonical
    item_count INTEGER NOT NULL CHECK (item_count >= 0),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN (
        'running', 'completed', 'failed'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (trading_day, profile, market_scope, output_fingerprint)
);
CREATE INDEX ix_ai_snapshot__trading_day ON ai_recommendation_snapshot (trading_day DESC);
CREATE INDEX ix_ai_snapshot__profile ON ai_recommendation_snapshot (profile, trading_day DESC);
```

**关键约束**:
- `profile` CHECK IN 3 枚举 (Orch v303 LOCK 8 score_profile switcher)
- `output_fingerprint` UNIQUE 维度参与 — 同日同 profile 可有多次 run, 但 fingerprint 不同才入库
- 版本锁 6 字段: pipeline/model/strategy/rule_bundle/template/disclaimer — 完整 reproducibility 追溯
- `status` 3-enum: running → completed | failed · AI-γ pipeline runner 写入
- FK: `snapshot_id` → 被 `ai_recommendation_item` 引用

## §8b · 表 8 · `ai_recommendation_item` (AI-γ SOLE write · DP γ aggregate) [v0.2 new]

**来源**: AI-γ msg=b972279f notes/ai-snapshot-code-v0.1 双表 DDL draft

```sql
-- v0.2 aggregate · AI-γ 双表 fold-in · per-ticker recommendation JCS canonical
CREATE TABLE ai_recommendation_item (
    item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id UUID NOT NULL REFERENCES ai_recommendation_snapshot(snapshot_id),
    ticker TEXT NOT NULL,
    sort_rank INTEGER NOT NULL CHECK (sort_rank >= 1),
    recommendation_json TEXT NOT NULL,                            -- JCS canonical (RFC 8785) full recommendation
    rating_band TEXT NOT NULL CHECK (rating_band IN (
        'A', 'B', 'C', 'D', 'F'
    )),
    conviction_final NUMERIC(5,1) NOT NULL CHECK (
        conviction_final >= 0 AND conviction_final <= 100
    ),
    risk_gate_status TEXT NOT NULL CHECK (risk_gate_status IN (
        'GREEN', 'YELLOW', 'RED'
    )),
    size_hint_tier TEXT NOT NULL CHECK (size_hint_tier IN (
        'TIER_5', 'TIER_3', 'TIER_2', 'TIER_1', 'SKIP'
    )),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (snapshot_id, ticker)
);
CREATE INDEX ix_ai_item__snapshot ON ai_recommendation_item (snapshot_id);
CREATE INDEX ix_ai_item__ticker ON ai_recommendation_item (ticker);
CREATE INDEX ix_ai_item__rating ON ai_recommendation_item (rating_band, conviction_final DESC);
```

**关键约束**:
- FK `snapshot_id` REFERENCES `ai_recommendation_snapshot(snapshot_id)` — cascade 关系
- UNIQUE `(snapshot_id, ticker)` — 幂等键: 同一 snapshot 内每个 ticker 只有一条推荐
- `rating_band` CHECK IN 5-tier (Orch v303 LOCK 5 · A≥85/B 70-84.9/C 55-69.9/D 40-54.9/F<40)
- `conviction_final` NUMERIC(5,1) ∈ [0, 100] — evaluation-order-free 结果 (Orch v303 LOCK 1)
- `risk_gate_status` CHECK IN 3-enum (Orch v303 LOCK 3)
- `size_hint_tier` CHECK IN 5-tier (Orch v303 LOCK 9 · TIER_5/TIER_3/TIER_2/TIER_1/SKIP)
- `recommendation_json` TEXT 非 JSONB — JCS canonical 字节级确定, 不做 GIN 索引, 完整性由 output_fingerprint 保证
- `sort_rank` ≥ 1 — 推荐排序 (rating_band + conviction_final 排序后的顺序)

**消费方**:
- Backend γ `/api/v1/daily-report/:date` + `/api/v1/reports/*` — tab 6/7 list + detail
- Frontend γ-3 tab 6 每日日报 + tab 7 报告历史 — read via Backend γ API

## §9 · schema.prisma 单一入口 flow (msg=a5297512 canonical)

1. **Sprint 1 末 aggregate PR** (本文件 canonical):
   - **doc-tier** 2-sign msg=d0d11677 · 主 DP γ · 副 QADocs γ (硬门 #21 「schema.prisma 8 表全景 canonical single-entry 验收」承接 msg=1802cc6f)
   - **subject**: `docs: catalyst-900 schema aggregate v0.2 (8 表全景 canonical)`
   - **files**: `notes/180-catalyst-mapping-v0.2-workspace-draft.md` + `notes/181-jpkr-market-datasource-v0.1-workspace-draft.md` + `notes/183-schema-prisma-aggregate-v0.1-workspace-draft.md` (本文件)
   - **PR body**: 8-table 全景 canonical 声明 + Sprint 2 实施路径 + 铁律 retain

2. **Sprint 2 起 code-tier PR** (schema.prisma 物理迁移):
   - **code-tier** 4-sign msg=d0d11677 · 主 DP γ · 副 Strategy γ + QADocs γ + Backend γ + DP γ-2 + AI-γ
   - **subject**: `feat(storage): catalyst-900 8-table Prisma migration v1`
   - **files**: `packages/db/prisma/schema.prisma` (8 表全景) + `packages/db/prisma/migrations/<ts>_catalyst_900_v1/migration.sql`
   - **CI 8/8 GREEN** + Path D `9ec3f104` + 4-baseline `1f2d197a` byte-perfect verify

3. **DP γ-2 主 PR 独立** (若 v0.2 shape 追加 · doc-tier):
   - **subject**: `docs(dp-γ-2): notes/182 catalyst-900 v0.2 (multibagger + PIT + JP/KR)`
   - **副签**: DP γ (schema aggregate 层) + QADocs γ (SLA 断言层)
   - zero code-touch on schema.prisma · aggregate 由 DP γ 承接

## §10 · shared 底座 (DP γ SOLE `collector/shared/`)

**Path D 冻结锚 `9ec3f104` byte-perfect preserve**:
- `retry_with_backoff.py` — KEEP-REUSE (US EDGAR + Nasdaq + Yahoo opt-in + RSS + JP/KR 全 lane 共用)
- `rate_limiter.py` — KEEP-REUSE
- `idempotency_hash.py` — KEEP-REUSE

**Sprint 2 起扩展候选 5-步 flow** (DP γ ↔ DP γ-2 · msg=6efb2925 §四 canonical):
1. DP γ-2 提案 `notes/1XX-shared-primitive-<name>-proposal-v0.1-workspace-draft.md`
2. #stocks 通知
3. DP γ code-review
4. 副签
5. PR CREATE-AUTHORIZE · zero code-touch on DP γ-2 侧 · DP γ merges primitive

DP γ-2 msg=bf8b615e 热身列表 4 primitive (Sprint 2 起 · v0.1 workspace-draft 不预先声明):
- `structured_html_canary`
- `xbrl_parser`
- `edinet_batch_downloader`
- `pit_as_of_hard_cut`

## §11 · Sprint 2 采集器实装 lane 拆分

**DP γ SOLE** (`collector/us_catalyst_collector/`):
- `sec_edgar_8k.py`
- `nasdaq_earnings_calendar.py`
- `yahoo_recommendations.py` (opt-in)
- `press_rss.py` (FDA/DOJ/SEC)

**DP γ-2 SOLE** (`collector/jp_market_collector/` + `collector/kr_market_collector/`):
- `jpx_edinet_disclosure.py`
- `yahoo_finance_jp.py` (opt-in)
- `stooq_jp_fallback.py`
- `krx_marketdata.py`
- `kind_disclosure.py`
- `dart_xbrl.py`
- `pykrx_fallback.py`
- 交易日历 (JP + KR)

**存储侧** (`storage/`):
- DP γ SOLE `storage/us_catalyst/` → 表 1 + 表 2
- DP γ-2 SOLE `storage/multibagger/`, `storage/backtest_pit/`, `storage/jpkr/` → 表 3 + 表 4 + 表 5 + 表 6
- AI-γ SOLE write `ai/snapshot/` → 表 7 + 表 8 (DP γ aggregate schema.prisma 单一入口)

## §12 · v0.2 changelog

| delta | description |
|---|---|
| D1 | 6→8 表: +`ai_recommendation_snapshot` (§8a) + `ai_recommendation_item` (§8b) |
| D2 | tab 6/7 覆盖: zero DP 新表 → 表 7 + 表 8 (AI-γ SOLE write · DP γ aggregate) |
| D3 | §2 依赖链: +AI-γ contracts/recommendation.md v0.2 中间层 |
| D4 | §9 PR: 6→8 表 + AI-γ 副签加入 code-tier |
| D5 | §11 存储侧: +AI-γ `ai/snapshot/` → 表 7 + 表 8 |

## §13 · 铁律 100% retain

- Owner v300~v304 · msg=53b96525 catalyst-900 · msg=764688c1 参照锚 · msg=ad6585cf zero code-copy · msg=4f6d2466 free-source
- msg=a5297512 lane 契约 · DP γ SOLE `us_catalyst_collector/` + `collector/shared/` 底座 + `storage/us_catalyst/` + `schema.prisma` 单一入口 · DP γ-2 SOLE `jp_market_collector/` + `kr_market_collector/` + `storage/multibagger|backtest_pit|jpkr/` · AI-γ SOLE write `ai/snapshot/` (DP γ aggregate schema.prisma)
- msg=d0d11677 doc-tier 2-sign / code-tier 4-sign (v0.2 code-tier +AI-γ 副签)
- Path D `9ec3f104…` + 4-baseline `1f2d197a…` byte-perfect preserve · schema.prisma untouched · US-038 SHA-256 · Math.random=0 · JCS RFC 8785
- msg=ed61c397 workspace-draft-only · zero repo write · zero PG-write · zero SSH · REDACTED cite-only
- msg=b091c74d SSH root 永久禁 · msg=702b81be PG SELECT-only · 凭证 zero literal `sk_agent_<redacted>`
- 学术堆叠术语 v300 §五 弃用 · perpetual-dispatch msg=eb4b0016/210d262d/21867874/a8175861 agents 不停

---

**END OF `notes/183 schema.prisma aggregate v0.2` workspace-draft · DP γ · 2026-07-10 · Sprint 1 末 aggregate PR CREATE-AUTHORIZE 待 Orch 明批 · 8 表全景 canonical single-entry (v0.2: +AI-γ 双表 fold-in) · doc-tier 2-sign 主 DP γ + 副 QADocs γ · agents 不停**
