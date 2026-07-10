# DP γ · `contracts/catalyst-mapping.md` v0.2 · workspace-draft

**status**: workspace-draft-only · msg=ed61c397 · zero repo write · Sprint 1 末待 Orch aggregate PR CREATE-AUTHORIZE
**purpose**: 美股隔夜催化 → A 股同日候选映射契约 v0.2 · fold Orch v303 msg=f53c62a0 10 canonical LOCK + Strategy γ msg=ad3bea53/be4509a8/ea939251 + Research §S3 msg=645fc2a1/49658402/2ce51e9b + Backend γ v0.2 delta + AI-γ v0.1 + Frontend γ-1/γ-2/γ-3 shell + QADocs 63 触点 8 契约 + DP γ-2 notes/182 v0.1 (LAND 提前 24h) + Cleanup γ v0.5 audit + Frontend γ-2 types.ts 归并 (γ-2 SOLE)
**author**: DP γ (@DataPipeline)
**created**: 2026-07-10
**owner-iron-rules retained**: msg=53b96525 catalyst-900 · msg=764688c1 参照锚 · msg=6dc1b5f3 v300 PIVOT · msg=ad6585cf 借鉴独立性 zero code-copy · msg=4f6d2466 free-source only · msg=a5297512 lane 契约 · msg=b091c74d SSH root永久禁 · msg=702b81be PG SELECT-only · 凭证 zero literal · Path D `9ec3f104` + 4-baseline `1f2d197a` byte-perfect preserve · schema.prisma untouched · workspace-draft-only

**v0.2 与 v0.1 delta**: Adjustment[] JSONB (evaluation-order-free · Σ 可交换) · Rating 5-档 CHECK enum · RiskGate 12-trigger enum + severity 分档 · catalyst_kind 9-枚举 (+`unclassified` Sprint 1 契约过渡) · Score.scoring_id + snapshot_hash 承接位 · score_profile 3-档 · 采集频率 3-tier · QADocs 3 SLA 断言承接位 · JP/KR 6-维覆盖率表 as-of pointer

---

## §1 · 概念定义 (v0.1 retain · zero delta)

**catalyst**（催化事件）：一段时间窗内可能显著改变股票估值预期的美股市场事件。窗口默认按 US Eastern Time 交易日划分：
- 隔夜催化窗口 = 前一 US 交易日 16:00 ET (regular close) → 次日 09:30 ET (open) 之间发生的事件。
- A 股同日候选 = 同一 UTC 日 (Asia/Shanghai) 开盘的 A 股相关个股（沪深两市 + 北交所 · 港股 v0.3 后补）。

**mapping**：一个 catalyst → 0..N 个 A 股候选，附相关性理由 + Conviction + RiskGate + EntryPlan。

## §2 · 时区与交易日历对齐 (v0.1 retain · zero delta)

| 事件源 | 采集时区 | 归一化 | 与 A 股撮合 |
|---|---|---|---|
| US NYSE / NASDAQ regular | America/New_York | ISO-8601 UTC | 前一 ET 交易日 close → 次 Asia/Shanghai 交易日 open 之间 |
| US pre-market | America/New_York | ISO-8601 UTC | 同上 |
| US after-hours | America/New_York | ISO-8601 UTC | 同上 |
| A 股沪深两市 | Asia/Shanghai | ISO-8601 UTC | 09:30-11:30 + 13:00-15:00 |

**交易日历源**：US NYSE holiday feed (public HTML/ICS) 免费 · CN 上交所/深交所官网 免费 · CN 停牌复用 Path D `9ec3f104` Baostock + AKShare 停牌接口。

## §3 · Catalyst 分类与 conviction_adjust default

### §3.1 catalyst_kind → conviction_adjust_default 三档 canonical
byte-identical Strategy γ scoring v0.2 §4.2 (Orch v303 LOCK 4):

| 档 | catalyst_kind | default delta |
|---|---|---|
| 常规档 (+5) | `earnings` / `upgrade_downgrade` / `product` | `+5` |
| 强档 (+7) | `regulator` / `geo_macro` / `ma_activity` | `+7` |
| 弱档 (+3) | `sector_move` / `leadership` | `+3` |
| 中性档 (0) | `unclassified` (Sprint 1 契约过渡) | `0` |

**evidence 微调**: 每次 evidence 微调独立 Adjustment · `delta ∈ [-2, +2]` · reason ≤200 chars。

**RiskGate 联动**: RiskGate YELLOW → 追加 Adjustment `{delta: -5, reason: "RiskGate YELLOW", source_ref: <trigger_code>}`; RED → `{delta: -10, ...}`。

**Adjustment[] 硬约束** (Orch v303 LOCK 1):
- 单条 `delta ∈ [-20, +20]`
- `Σ delta ∈ [-20, +20]`
- length `∈ [0, 5]`
- `Conviction.final = clamp(base + Σ adjustments[].delta, 0, 100)` · Σ 可交换 · 无 evaluation order 依赖 (Strategy γ msg=ea939251 §四.3 canonical)

### §3.2 catalyst_kind 9-枚举 canonical (Orch v303 LOCK 6)

| kind | 含义 | Sprint 生命周期 |
|---|---|---|
| `earnings` | 财报 | 长驻 |
| `upgrade_downgrade` | 分析师评级变动 | 长驻 |
| `ma_activity` | 并购 | 长驻 |
| `sector_move` | 板块联动 | 长驻 |
| `regulator` | 监管 (FDA/DOJ/SEC/FTC) | 长驻 |
| `geo_macro` | 地缘/宏观 (tariff/rate/election) | 长驻 |
| `product` | 产品事件 (launch/recall/patent) | 长驻 |
| `leadership` | 高管/激进投资者 | 长驻 |
| `unclassified` | Sprint 1 契约过渡 · 采集期获得原始 headline 但 kind 未定 | Sprint 2 Strategy γ `kind_auto_classifier` GA 后 backfill 归零占用 |

**语义** (Strategy γ msg=ea939251 §二.2 accept):
- `unclassified` 对应 `default_delta = 0` (无 conviction adjust)
- `relevance_score kind_multiplier = 1.0` (中性)
- Sprint 2 分类器 GA 后所有 unclassified 记录 backfill 至 8 canonical enum 之一
- UI 端 (Frontend γ-1 tab 1 FilterChip) 显示灰色徽章 · tooltip "Sprint 1 契约 · Sprint 2 归零"

## §4 · 相关性打分 correlation_score (v0.1 retain · sum=1.0 权重锁定)

对每个 (US_catalyst, A_share_candidate) 二元组，输出 `correlation_score ∈ [0.0, 1.0]`：

| 分量 | 语义 | 权重 canonical | 数据源 |
|---|---|---|---|
| `sector_map_score` | GICS 二级 / 中信一级 行业映射 | 0.35 | GICS + 中信行业分类 (Sina/EastMoney + Baostock 内置) |
| `revenue_exposure_score` | A 股候选对美/相关地区营收占比 | 0.25 | 年报「收入按地区」(Baostock + 巨潮 XBRL) |
| `adr_parity_score` | ADR 或直接产业链锚定 | 0.20 | Yahoo Finance ADR list + 自维护 ADR 映射表 |
| `supply_chain_score` | 供应链上下游关联 | 0.15 | 年报「主要客户/供应商」+ 5-strategy 输出 |
| `historical_beta_score` | 6-month 历史联动 β | 0.05 | Baostock 日K + numpy |

**权重 sum=1.0 严格** · Strategy γ v0.2 §3.7 `catalyst_kind_multiplier` (earnings/upgrade_downgrade/product ×1.0 · regulator/geo_macro/ma_activity ×1.2 · sector_move/leadership ×0.9) 后合成 · `clamp(Σ × multiplier, 0, 1)`。

`unclassified` 时 `kind_multiplier = 1.0` (中性 · §3.2)。

## §5 · 采集频率 3-tier canonical

| tier | 数据源 | 频率 | 用途 |
|---|---|---|---|
| **real-time RSS ≤5min** | FDA / DOJ / SEC press RSS · Nasdaq halts feed | 5min poll + backoff | 监管催化 + 停牌 · tab 1 A股早报主链 |
| **daily EOD** | SEC EDGAR 8-K filings · Nasdaq earnings calendar · Yahoo recommendations (opt-in) | 每个交易日 close + 60min | 财报/评级/8-K item 5.02 高管变动 |
| **weekly bulk** | GICS 行业映射 · 中信行业分类 · 巨潮 XBRL 年报 · ADR 映射表刷新 | 每周日 00:00 UTC | 参考数据 · 相关性 5-分量输入 |

**限速策略** (`collector/shared/` 底座 SOLE 由 DP γ 维护):
- SEC EDGAR: 官方文档 10 req/sec · 保守 5 req/sec + backoff
- Nasdaq calendar: 无官方限速 · 保守 1 req/sec
- Yahoo Finance opt-in: 2 req/sec + jitter + 429 exponential backoff
- FDA/DOJ/SEC press RSS: 5min poll + ETag/Last-Modified 差异化拉取

## §6 · 表结构 v0.2 完整 DDL (workspace-draft · NOT deployed · schema.prisma untouched)

```sql
-- workspace-draft only · NOT applied · Sprint 1 末 Orch aggregate PR CREATE-AUTHORIZE 待批
-- v0.2 fold Orch v303 10 canonical LOCK + Strategy scoring v0.2 canonical + Backend γ v0.2 delta

-- §6.1 us_catalyst_event
CREATE TABLE us_catalyst_event (
    us_catalyst_event_id UUID PRIMARY KEY,
    catalyst_kind TEXT NOT NULL CHECK (catalyst_kind IN (
        'earnings', 'upgrade_downgrade', 'ma_activity', 'sector_move',
        'regulator', 'geo_macro', 'product', 'leadership', 'unclassified'
    )),                                                       -- §3.2 9-enum canonical
    us_ticker TEXT NOT NULL,                                  -- e.g. AAPL, NVDA
    us_isin TEXT,                                             -- optional
    event_headline TEXT NOT NULL CHECK (char_length(event_headline) <= 200),
    event_body_url TEXT,                                      -- 原始事件 URL (SEC filing / press RSS)
    event_source_kind TEXT NOT NULL,                          -- 'sec-edgar' | 'nasdaq-calendar' | 'yahoo-recommendation' | 'fda-press' | 'doj-press' | 'sec-press' | 'other'
    event_time_utc TIMESTAMPTZ NOT NULL,                      -- ISO-8601 UTC
    us_trading_day_et DATE NOT NULL,                          -- ET 交易日归属
    cn_trading_day_asia_shanghai DATE NOT NULL,               -- 撮合的 A 股同日交易日
    ingest_lag_seconds INTEGER NOT NULL CHECK (ingest_lag_seconds >= 0),
    ingest_source_hash TEXT NOT NULL,                         -- SHA-256(source-url + body 首 1KB) · 去重
    is_regular_hours BOOLEAN NOT NULL,
    fact_hash TEXT NOT NULL,                                  -- SHA-256(canonical fields)
    source_versions JSONB NOT NULL,                           -- PIT replay key · {"sec-edgar": "v2026-01", ...}
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (event_source_kind, ingest_source_hash)            -- 幂等键 · 同一原始事件不重复
);

CREATE INDEX ix_us_catalyst_event__cn_day
    ON us_catalyst_event (cn_trading_day_asia_shanghai);
CREATE INDEX ix_us_catalyst_event__kind_time
    ON us_catalyst_event (catalyst_kind, event_time_utc DESC);


-- §6.2 a_share_candidate_mapping
CREATE TABLE a_share_candidate_mapping (
    a_share_candidate_mapping_id UUID PRIMARY KEY,
    us_catalyst_event_id UUID NOT NULL REFERENCES us_catalyst_event (us_catalyst_event_id),
    cn_ticker TEXT NOT NULL,                                  -- e.g. sh.600519, sz.000858, bj.430047
    cn_ticker_exchange TEXT NOT NULL CHECK (cn_ticker_exchange IN ('sh', 'sz', 'bj')),

    -- §4 相关性 5-分量 (sum=1.0 canonical)
    sector_map_score NUMERIC(4,3) NOT NULL CHECK (sector_map_score BETWEEN 0 AND 1),
    revenue_exposure_score NUMERIC(4,3) NOT NULL CHECK (revenue_exposure_score BETWEEN 0 AND 1),
    adr_parity_score NUMERIC(4,3) NOT NULL CHECK (adr_parity_score BETWEEN 0 AND 1),
    supply_chain_score NUMERIC(4,3) NOT NULL CHECK (supply_chain_score BETWEEN 0 AND 1),
    historical_beta_score NUMERIC(4,3) NOT NULL CHECK (historical_beta_score BETWEEN 0 AND 1),
    correlation_score NUMERIC(4,3) NOT NULL CHECK (correlation_score BETWEEN 0 AND 1),

    -- Score (Strategy γ v0.2 §2 · Orch v303 LOCK 5+8)
    score_total NUMERIC(4,1) NOT NULL CHECK (score_total BETWEEN 0 AND 100),
    score_profile TEXT NOT NULL CHECK (score_profile IN (
        'us_preferred', 'multibagger', 'japan_korea'
    )),                                                       -- LOCK 8 Q1 profile 三档
    score_source_versions JSONB NOT NULL,                     -- PIT replay key
    score_as_of TIMESTAMPTZ NOT NULL,                         -- PIT 时间锚
    scoring_id UUID NOT NULL,                                 -- Strategy γ msg=be4509a8 · UUIDv4
    score_snapshot_hash TEXT NOT NULL,                        -- SHA-256(JCS(Score minus scoring_id + snapshot_hash))

    -- Rating (Strategy γ v0.2 §2.2 · Orch v303 LOCK 5 · 独立于 Conviction.level)
    rating TEXT NOT NULL CHECK (rating IN ('A', 'B', 'C', 'D', 'F')),

    -- Conviction (Strategy γ v0.2 §4 · Orch v303 LOCK 1+2 · Adjustment[] canonical · 75/50 阈值 pipeline 出)
    conviction_base NUMERIC(4,1) NOT NULL CHECK (conviction_base BETWEEN 0 AND 100),
    conviction_adjustments JSONB NOT NULL DEFAULT '[]'::jsonb, -- Adjustment[] · 每条 {delta ∈ [-20,+20], reason ≤200, kind_ref?, source_ref?}
    conviction_final NUMERIC(4,1) NOT NULL CHECK (conviction_final BETWEEN 0 AND 100),
    conviction_level TEXT NOT NULL CHECK (conviction_level IN ('HIGH', 'MED', 'LOW')),
    CHECK (jsonb_array_length(conviction_adjustments) <= 5),
    CHECK (
        conviction_final = ROUND(LEAST(GREATEST(conviction_base + (
            SELECT COALESCE(SUM((elem->>'delta')::numeric), 0)
            FROM jsonb_array_elements(conviction_adjustments) elem
        ), 0), 100), 1)
    ),                                                        -- Strategy γ msg=ea939251 §Σ 可交换 · evaluation-order-free canonical

    -- RiskGate (Strategy γ v0.2 §5 · Orch v303 LOCK 3 · 12-trigger canonical + severity 分档)
    risk_gate_status TEXT NOT NULL CHECK (risk_gate_status IN ('GREEN', 'YELLOW', 'RED')),
    risk_gate_triggers JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [{code: 12-enum, severity: 'block'|'warn'|'info', detail: text}]
    risk_gate_evaluated_at TIMESTAMPTZ NOT NULL,

    -- EntryPlan (Strategy γ v0.2 §6 · Backend γ msg=eee7bc71 v0.2 canonical)
    entry_plan JSONB NOT NULL,
    -- entry_plan shape:
    --   {
    --     price_band: {low: number, high: number, currency: 'CNY'|'USD'|'JPY'|'KRW'},
    --     stop: number,
    --     targets: [t1, t2, t3],
    --     size_hint: {tier: 'TIER_5'|'TIER_3'|'TIER_2'|'TIER_1'|'SKIP', pct: 0..5, disclaimer_key: 'size_hint_advisory', bridge_reason: text},
    --     time_horizon: 'INTRADAY'|'SWING'|'POSITION'|'CORE_HOLD'|'LONG_TERM',
    --     invalidation: text ≤240 chars,
    --     conviction_ref: uuid
    --   }

    fact_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (us_catalyst_event_id, cn_ticker)                  -- 幂等键 · 单一 catalyst 单只 A 股候选唯一
);

CREATE INDEX ix_a_share_candidate__cn_ticker_day
    ON a_share_candidate_mapping (cn_ticker, us_catalyst_event_id);
CREATE INDEX ix_a_share_candidate__scoring_id
    ON a_share_candidate_mapping (scoring_id);
CREATE INDEX ix_a_share_candidate__snapshot_hash
    ON a_share_candidate_mapping (score_snapshot_hash);
```

## §7 · QADocs 3 SLA 断言承接位置 (msg=cebf105a · msg=3024d5bd §八 承接)

1. **幂等 SLA**: `us_catalyst_event.UNIQUE (event_source_kind, ingest_source_hash)` + `a_share_candidate_mapping.UNIQUE (us_catalyst_event_id, cn_ticker)` 保障 · QADocs SQL 断言 `COUNT(*) = COUNT(DISTINCT (event_source_kind, ingest_source_hash))` on `us_catalyst_event`
2. **防未来函数 SLA (PIT as-of hard-cut)**: `score_as_of TIMESTAMPTZ` + `score_source_versions JSONB` 双字段 · Backend γ endpoint 严格按 `score_as_of ≤ requested_as_of` 过滤 · JP/KR 6-维覆盖率表 as-of pointer 至 DP γ-2 notes/182 §5
3. **防幸存者偏差 SLA**: `us_catalyst_event.us_ticker` 保留退市 ticker · DP γ-2 `backtest_pit_snapshot.is_survivorship_biased BOOLEAN` + `is_delisted_at_as_of BOOLEAN` (notes/182 §四 canonical) · QADocs SQL 断言 `is_survivorship_biased=true` 记录 pipeline 层显式标注
4. **Conviction sum assertion** (QADocs msg=3024d5bd §一): `sum(adjustments.delta) == final - base` — 由 §6.2 CHECK `conviction_final = ROUND(...)` 硬约束保障

## §8 · Tab 1「A 股早报」渲染契约 (Frontend γ-1 CatDesk-shell)

Frontend `AShareMorningBrief.tsx` 消费 `GET /api/v1/morning-brief/:date` (Backend γ v0.2 canonical):

```jsonc
{
  "cn_trading_day": "2026-07-10",
  "kpi": {
    "total_catalysts_overnight": 42,
    "total_a_share_candidates": 168,
    "high_conviction_count": 12,             // conviction.final ≥ 75 (Orch v303 LOCK 2)
    "risk_gate_blocked_count": 3             // risk_gate_status = 'RED' 或 severity=block
  },
  "rows": [
    {
      "cn_ticker": "sh.600519",
      "cn_name_zh": "贵州茅台",
      "cn_sector_zh": "食品饮料",
      "score": { "total": 87.5, "band": "A", "scoring_id": "...", "snapshot_hash": "..." },
      "rating": "A",                         // Orch v303 LOCK 5
      "conviction": { "base": 82, "final": 87, "level": "HIGH", "adjustments": [/* 3 items max */] },
      "risk_gate": { "status": "GREEN", "triggers": [] },
      "entry_plan": { "size_hint": { "tier": "TIER_5", "pct": 5, "disclaimer_key": "size_hint_advisory", "bridge_reason": "HIGH→5%" }, ... },
      "top_catalyst_kind": "sector_move",
      "top_catalyst_headline_zh": "隔夜白酒相关 ETF 大涨 4.2% ...",
      "us_related_tickers": ["STZ", "DEO"]
    }
  ]
}
```

**FilterChip** (Frontend γ-1 tab 1): `conviction=high|med|low` · `sector=<GICS L2>` · `risk_gate=green|yellow|red` · `catalyst_kind=<9-enum · unclassified 灰色徽章>` · `rating=A|B|C|D|F`

## §9 · 采集/存储侧改造范围 (Sprint 2 起 · Sprint 1 只出 spec)

**lane 契约 msg=a5297512 · Orch v302 lane 拆分**:
- **DP γ SOLE**: `us_catalyst_collector/` + `collector/shared/` 底座 + `storage/us_catalyst/` + `schema.prisma` 单一入口 (aggregate DP γ + DP γ-2 输出)
- **DP γ-2 SOLE**: `jpkr_deep/` + `multibagger_universe/` + `backtest_pit_snapshot/`

**采集新增** (Sprint 2 起):
- `us_catalyst_collector/sec_edgar_8k.py` — SEC EDGAR 8-K
- `us_catalyst_collector/nasdaq_earnings_calendar.py` — Nasdaq earnings
- `us_catalyst_collector/yahoo_recommendations.py` — Yahoo opt-in
- `us_catalyst_collector/press_rss.py` — FDA/DOJ/SEC press RSS

**shared 底座 SOLE 由 DP γ 维护** (Path D 冻结锚 `9ec3f104` byte-perfect preserve):
- `collector/shared/retry_with_backoff.py` KEEP-REUSE
- `collector/shared/rate_limiter.py` KEEP-REUSE
- `collector/shared/idempotency_hash.py` KEEP-REUSE

**shared 底座扩展 5-步 flow** (DP γ ↔ DP γ-2 · msg=6efb2925 §四 canonical):
1. DP γ-2 提案: `notes/1XX-shared-primitive-<name>-proposal-v0.1-workspace-draft.md`
2. #stocks 通知
3. DP γ code-review
4. 副签
5. PR CREATE-AUTHORIZE · zero code-touch on DP γ-2 侧 · DP γ merges primitive

DP γ-2 msg=bf8b615e §四 热身列表 4 primitive: `structured_html_canary` / `xbrl_parser` / `edinet_batch_downloader` / `pit_as_of_hard_cut` — Sprint 2 起若实际命中则按 5-步 flow 提案 · v0.1 workspace-draft 不预先声明

## §10 · schema.prisma aggregate 汇总 flow (notes/183 Sprint 1 末)

DP γ 主 · DP γ-2 提交 draft 表结构 · DP γ 汇总 6 表全景:
1. `us_catalyst_event` (DP γ · §6.1)
2. `a_share_candidate_mapping` (DP γ · §6.2)
3. `multibagger_universe` (DP γ-2 notes/182 §六)
4. `backtest_pit_snapshot` (DP γ-2 notes/182 §四)
5. `jpkr_financial_snapshot` (DP γ-2 notes/181 → DP γ-2 v0.2 承接)
6. `ALTER jpkr_daily_kline` (DP γ-2 · JP/KR 6-维字段扩展)

**PR 分批策略** (msg=6efb2925 §五):
- 主 PR: DP γ notes/180 v0.2 + notes/183 aggregate
- 副 PR: DP γ-2 notes/182 v0.2 (独立提交 · DP γ 副签 schema layer)
- doc-tier 2-sign per msg=d0d11677 · 单 PR ≤200 行 · CI 8/8 GREEN

## §11 · 依赖与消费方 (v0.2 全绿)

| 依赖方 | 状态 | msg |
|---|---|---|
| Strategy γ scoring v0.2 (Adjustment[] Option A + 75/50 + 12-trigger + Rating 5档 + scoring_id/snapshot_hash) | ✅ canonical | msg=ad3bea53 / msg=be4509a8 / msg=ea939251 |
| Research §S3 spec-extract v0.1 LAND + v0.2 5 段 demote 承诺 | ✅ demote | msg=645fc2a1 / msg=49658402 / msg=2ce51e9b |
| Backend γ v0.2 delta 11 项 canonical | ✅ align | msg=eee7bc71 / msg=93e2ed55 |
| Frontend γ-1 shell v0.1 + types.ts 归并 (γ-2 SOLE `shared/types/catdesk.ts`) | ✅ LAND | msg=0e03ddf4 / msg=32777203 / msg=2f71f400 |
| Frontend γ-2 primitive Props + types 单源 + 5 项 delta | ✅ LAND | msg=0bbbcf4f / msg=13bdcc3e |
| Frontend γ-3 tab 5-7 shell v0.1 | ✅ LAND | msg=4935ac45 |
| AI-γ recommendation v0.1 + `contracts/recommendation.md` | ✅ LAND | msg=605c8b1e / msg=e6c9f7f3 |
| DP γ-2 notes/182 v0.1 (提前 24h · JP/KR 6-维覆盖 89%/88%) | ✅ LAND | msg=11e16e41 / msg=1410ba56 |
| QADocs 27-checklist v0.2 intake 63 触点 8 契约 | ✅ align | msg=3024d5bd |
| Cleanup γ audit v0.5 (Conviction retype + SSE 硬 DISCARD) | ✅ align | msg=8675050e |

## §12 · JP/KR as-of pointer (Orch v302 lane 拆分承接)

JP/KR 6-维字段可用性表由 **DP γ-2 SOLE** 维护 (notes/182 §5):
- **JP 覆盖 89%** (JPX EDINET + Yahoo Finance JP opt-in + Stooq)
- **KR 覆盖 88%** (KRX marketdata + KIND + DART + PyKRX fallback)
- Sprint 3 起 `score_profile = 'japan_korea'` (japan_blue_chip / korea_semiconductor_chain) 由 DP γ-2 承接 · Strategy γ 副签

DP γ 侧只做 fx_rate_to_usd 主链承接备位 (Sprint 3 决 · DP γ-2 §6.3 canonical)。

## §13 · Sprint 1 交付节点 (v300 §五 新纪律)

| 节点 | 交付 |
|---|---|
| ✅ v0.1 LAND (notes/180) | 字段名 + 数据源清单 + 时区对齐 + 相关性 5-分量 shape |
| ✅ v0.1 LAND (notes/181) | JP/KR datasource spec (DP γ-2 已承接 notes/182 深化) |
| ✅ v0.2 LAND (本文件) | Orch v303 10 LOCK fold · Adjustment[] + Rating + 12-trigger + 9-enum + scoring_id/snapshot_hash + 完整 DDL |
| Sprint 1 末 | notes/183 schema.prisma aggregate v0.1 + Orch aggregate PR CREATE-AUTHORIZE 待批 · doc-tier 2-sign per msg=d0d11677 · 副签 Strategy γ + QADocs γ + Cleanup γ + Research §S3 |
| Sprint 2 起 | 采集器实现 (SEC EDGAR + Nasdaq + Yahoo opt-in + press RSS) + Backend `/api/v1/morning-brief/*` + Frontend γ-1 tab 1 端到端 |

## §14 · 铁律 100% retain (owner-iron-rules)

- Owner v300~v303 令 100% 兑现 · msg=53b96525 catalyst-900 · msg=764688c1 参照锚 · msg=f81297a5 Orch v302 lane 拆分 · msg=f53c62a0 Orch v303 10 canonical LOCK
- msg=ad6585cf 借鉴独立性 zero code-copy · yespsam/a-share-us-catalyst 只作 spec-only 参照 (Research §S3 verify 上游无 LICENSE · 严格 spec-only 词表属公开产业术语)
- msg=4f6d2466 free-source only · SEC EDGAR + Nasdaq HTML + Yahoo opt-in + FDA/DOJ/SEC press RSS + Baostock Path D `9ec3f104` + AKShare + 巨潮 XBRL · Bloomberg/Wind/Refinitiv/FactSet/Tushare-pro 排除
- msg=a5297512 lane 契约 · DP γ SOLE `us_catalyst_collector/` + `collector/shared/` 底座 + `storage/us_catalyst/` + schema.prisma 单一入口 · DP γ-2 SOLE `jpkr_deep/` + `multibagger_universe/` + `backtest_pit_snapshot/`
- msg=d0d11677 doc-tier 2-sign self-merge / code-tier 4-sign self-merge
- msg=eb4b0016 / msg=210d262d / msg=21867874 / msg=a8175861 perpetual-dispatch agents 不停
- msg=b091c74d SSH root 永久禁 · 系统改动由 li-yiming 本人执行
- msg=702b81be PG SELECT-only · 每条 SQL 先 #stocks 说清目的+表+SQL全文+预期量级 → Owner 批
- 凭证 zero literal · `sk_agent_<redacted>` · 密钥不在版本库
- Path D `9ec3f104…` + 4-baseline `1f2d197a…` byte-perfect preserve · schema.prisma untouched · US-038 SHA-256 · Math.random=0 · JCS RFC 8785 canonical
- msg=ed61c397 workspace-draft-only · zero repo write · zero PG-write · zero SSH · REDACTED cite-only
- 学术堆叠术语 (σ/CASCADE/CENTUM/VIGINTUPLE) v300 §五 100% 弃用

---

**END OF `contracts/catalyst-mapping.md` v0.2 workspace-draft · DP γ · 2026-07-10 · Sprint 1 末 aggregate PR CREATE-AUTHORIZE 待批 · notes/181 JP/KR datasource v0.1 spec + notes/183 schema.prisma aggregate v0.1 (Sprint 1 末) 姐妹文件 · agents 不停**
