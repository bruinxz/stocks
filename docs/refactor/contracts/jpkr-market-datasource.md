# DP γ · 日韩市场数据源接入方案 v0.1 · workspace-draft

**status**: workspace-draft-only · msg=ed61c397 · zero repo write · Sprint 1 末待 Orch 批 PR CREATE
**purpose**: catalyst-900 IA tab 3「日韩市场」数据源方案，配合 tab 1 A股早报 + tab 2 美股优选 · Sprint 1 交付·2/2
**author**: DP γ (@DataPipeline)
**created**: 2026-07-10
**owner-iron-rules retained**: msg=53b96525 catalyst-900 · msg=764688c1 参照锚 · msg=6dc1b5f3 v300 PIVOT · msg=ad6585cf 借鉴独立性 zero code-copy · msg=4f6d2466 free-source only · msg=a5297512 lane 契约 · msg=b091c74d SSH root永久禁 · msg=702b81be PG SELECT-only · 凭证 zero literal · Path D `9ec3f104` + 4-baseline `1f2d197a` byte-perfect preserve · schema.prisma 不动 · workspace-draft-only

---

## §1 · 目标 scope

**tab 3「日韩市场」** 目标（对齐 catalyst-900 IA + Owner msg=53b96525）：
- 覆盖：日本 TSE (Tokyo Stock Exchange 东京) + OSE (Osaka 大阪) + Nikkei 225 + TOPIX + JPX-Nikkei 400
- 覆盖：韩国 KRX (KOSPI 主板) + KOSDAQ + KRX 300
- 数据类：日K + 停牌 + 分红除权 + 财报日历 + 主要指数成分
- 用途：独立市场看盘 + 与美股/A股联动分析（sector rotation 视角）

**不覆盖**（延后）：期权/期货/衍生品 + 台股 + 港股 + 越南/印尼等东南亚市场

## §2 · 时区与交易日历

| 市场 | 时区 | 交易时段（本地） | ISO-8601 UTC 归一 |
|---|---|---|---|
| TSE / OSE | Asia/Tokyo (UTC+9) | 09:00-11:30 + 12:30-15:00 (JST) | 00:00-02:30 + 03:30-06:00 UTC |
| KRX / KOSDAQ | Asia/Seoul (UTC+9) | 09:00-15:30 (KST) | 00:00-06:30 UTC |

**交易日历源**：
- JP：JPX 官网年度日历 HTML/CSV — 免费 · 每年 12 月发布次年
- KR：KRX 官网 「휴장일 안내」 HTML — 免费 · 每年 12 月发布次年

**停牌规则**：
- JP：TSE 停牌公告 XBRL EDINET — 免费
- KR：KIND (Korea Investors Network for Disclosure) 停牌公告 — 免费

## §3 · 免费源候选评估

### §3.1 日本市场

| 源 | 类型 | 免费 | 覆盖 | License | 稳定性 | 推荐 |
|---|---|---|---|---|---|---|
| **JPX 官网 XBRL EDINET** | 官方 disclosure | ✅ 完全 | 财报/停牌/重大事项 | JPX ToS 允许 non-commercial | 高 · 官方 | 🥇 首选 |
| **Yahoo Finance JP (通过 `yahoo-finance2` 库)** | 二级聚合 | ✅ opt-in per msg=4f6d2466 | 日K + 财报日历 + 分析师 | Yahoo ToS · non-commercial + attribution | 中 · 偶尔 API 变动 | 🥈 opt-in 白名单 |
| **Investpy** | Python 库聚合 investing.com | ✅ 目前免费 | 日K + 指数 | GPL-3.0 · 但 investing.com ToS 限制爬取 | 低 · ToS 风险 | ❌ 排除 |
| **Stooq** | 波兰 free financial data | ✅ 完全 | 日K + 部分财报 | free-for-personal · 商业模糊 | 中 · 数据延迟 15min | 🥉 备选 |
| **JPX Data Cloud / JPX Market Data** | JPX 商业化 | ❌ 付费 | 全 tick + orderbook | commercial | 高 | ❌ 排除 msg=4f6d2466 |
| **Nikkei API / Bloomberg / Refinitiv** | 商业 | ❌ 付费 | 全 | commercial | 高 | ❌ 排除 |

**推荐 stack (JP)**：JPX EDINET (disclosure canonical) + Yahoo Finance JP opt-in (日K) + Stooq 备选（当 Yahoo 断线时兜底）

### §3.2 韩国市场

| 源 | 类型 | 免费 | 覆盖 | License | 稳定性 | 推荐 |
|---|---|---|---|---|---|---|
| **KRX 官网 KIND** | 官方 disclosure | ✅ 完全 | 财报/停牌/重大事项 | KRX ToS non-commercial | 高 · 官方 | 🥇 首选 |
| **KRX 官网 marketdata** | 官方日K | ✅ 完全 | 日K + 指数 + 成分 | KRX ToS non-commercial + attribution | 高 · 官方 | 🥇 首选 |
| **Yahoo Finance KR** | 二级聚合 | ✅ opt-in | 日K + 财报 | Yahoo ToS · non-commercial | 中 | 🥈 opt-in |
| **PyKRX (Python 库)** | 二级 KRX 官网爬虫 | ✅ MIT | 日K + 停牌 + 分红 | MIT | 中 · 依赖 KRX 官网结构不变 | 🥈 fallback |
| **DART (금융감독원 전자공시)** | 韩国 SEC 等价 disclosure | ✅ 完全 | 财报 XBRL | 政府开放数据 | 高 | 🥇 首选（财报） |
| **Bloomberg / FnGuide / WISEreport** | 商业 | ❌ 付费 | 全 | commercial | 高 | ❌ 排除 msg=4f6d2466 |

**推荐 stack (KR)**：KRX marketdata (日K canonical) + KIND (停牌 canonical) + DART (财报 XBRL canonical) + PyKRX fallback

### §3.3 CAUTION 排除清单

Bloomberg + Refinitiv Eikon + FactSet + Wind + Nikkei API 商业 + JPX Data Cloud 付费 + KRX Market Data 商业 API + FnGuide + WISEreport + QuantIQ + iCharts commercial + 通联数据 · 全部按 msg=4f6d2466 铁律排除。

## §4 · 采集器分工（`collector/` lane 契约 msg=a5297512）

**Sprint 1 只出 spec · 不 touch code · schema.prisma 不动**：

```
collector/
├── jp_market_collector/          # 新增（Sprint 2 起）
│   ├── jpx_edinet_disclosure.py  # 官方 disclosure (财报/停牌/公告)
│   ├── yahoo_finance_jp.py       # opt-in 日K + 财报日历
│   ├── stooq_jp_fallback.py      # 兜底
│   └── jp_trading_calendar.py    # 年度交易日历
├── kr_market_collector/          # 新增（Sprint 2 起）
│   ├── krx_marketdata.py         # 官方日K + 指数成分
│   ├── kind_disclosure.py        # 停牌/公告
│   ├── dart_xbrl.py              # 财报 XBRL
│   ├── pykrx_fallback.py         # 兜底
│   └── kr_trading_calendar.py
└── shared/                       # 复用现有（Path D 冻结锚 `9ec3f104`）
    ├── retry_with_backoff.py     # KEEP-REUSE
    ├── rate_limiter.py           # KEEP-REUSE (Yahoo Finance 需限速)
    └── idempotency_hash.py       # KEEP-REUSE
```

**限速策略**：
- JPX EDINET：无官方限速文档 · 保守 1 req/sec + backoff
- Yahoo Finance JP/KR：非官方源 · 2 req/sec + jitter + 遇 429 exponential backoff
- KRX marketdata：无官方 API · HTML 爬取 · 1 req/2sec + jitter + `User-Agent` 声明
- DART：官方开放数据 API · 每日 1万次配额（免费）· 记录本日消耗

**幂等键**：
- disclosure 事件：`(source_kind, source_document_id)` UNIQUE — 官方文档 ID 保证唯一
- 日K：`(exchange, ticker, trading_day)` UNIQUE

## §5 · 存储表结构 v0.1 (workspace-draft · NOT deployed)

```sql
-- workspace-draft · NOT applied · pending Orch approval Sprint 1 末
CREATE TABLE jpkr_daily_kline (
    jpkr_daily_kline_id UUID PRIMARY KEY,
    exchange TEXT NOT NULL,               -- 'tse' | 'ose' | 'krx' | 'kosdaq'
    ticker TEXT NOT NULL,                 -- JP: 4-digit code · KR: 6-digit code
    ticker_name_local TEXT NOT NULL,      -- 日/韩语原名
    ticker_name_en TEXT,                  -- 英译（当官方提供时）
    trading_day DATE NOT NULL,            -- 本地交易日（不带时区，语义 = 交易所本地）
    open NUMERIC(18,4) NOT NULL,
    high NUMERIC(18,4) NOT NULL,
    low NUMERIC(18,4) NOT NULL,
    close NUMERIC(18,4) NOT NULL,
    volume BIGINT NOT NULL,
    turnover NUMERIC(24,4),               -- 成交额 · 当地货币
    currency TEXT NOT NULL,               -- 'JPY' | 'KRW'
    is_halted BOOLEAN NOT NULL DEFAULT FALSE,
    source_kind TEXT NOT NULL,            -- 'krx-marketdata' | 'yahoo-jp' | 'stooq-jp' | 'pykrx' | ...
    fact_hash TEXT NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (exchange, ticker, trading_day, source_kind)
);

CREATE TABLE jpkr_disclosure_event (
    jpkr_disclosure_event_id UUID PRIMARY KEY,
    market TEXT NOT NULL,                 -- 'jp' | 'kr'
    ticker TEXT NOT NULL,
    disclosure_kind TEXT NOT NULL,        -- 'earnings' | 'halt' | 'ma' | 'dividend' | 'split' | 'delisting' | 'material_event'
    event_headline_local TEXT NOT NULL,
    event_body_url TEXT,
    event_time_utc TIMESTAMPTZ NOT NULL,
    source_kind TEXT NOT NULL,            -- 'jpx-edinet' | 'kind' | 'dart' | 'yahoo-jp' | ...
    source_document_id TEXT NOT NULL,     -- 官方 disclosure ID
    fact_hash TEXT NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source_kind, source_document_id)
);

CREATE INDEX ix_jpkr_daily_kline__day ON jpkr_daily_kline (trading_day);
CREATE INDEX ix_jpkr_disclosure__ticker_time ON jpkr_disclosure_event (ticker, event_time_utc DESC);
```

## §6 · Tab 3「日韩市场」渲染契约（喂 Frontend γ CatDesk-shell）

Frontend `JPKRMarket.tsx` 消费 `/api/v1/jpkr-market/:date?market=jp|kr` 期望：

```jsonc
{
  "market": "jp",
  "trading_day": "2026-07-10",
  "kpi": {
    "index_nikkei225": {"close": 39250.12, "change_pct": 0.87},
    "index_topix": {"close": 2814.55, "change_pct": 0.62},
    "total_advancers": 1832,
    "total_decliners": 421,
    "top_gainer": {"ticker": "9984", "name_en": "SoftBank Group", "change_pct": 4.21}
  },
  "rows": [
    {
      "ticker": "9984",
      "name_local": "ソフトバンクグループ",
      "name_en": "SoftBank Group",
      "sector": "Communication Services",
      "close": 8215.0,
      "change_pct": 4.21,
      "volume": 12500000,
      "turnover_jpy": 102687500000,
      "is_halted": false,
      "top_disclosure": {
        "kind": "earnings",
        "headline_local": "2026年3月期 通期決算予想の修正",
        "time_utc": "2026-07-10T06:00:00Z"
      }
    }
  ]
}
```

**FilterChip 支持**：`market=jp|kr` · `index=nikkei225|topix|jpx-nikkei-400|kospi|kosdaq|krx-300` · `sector=<GICS L2>`
**DetailSidebar 支持**：点击行 → GET `/api/v1/jpkr-market/:ticker` 返回 30d K线 + 最新 disclosure 列表 + 同板块联动

## §7 · 与 tab 1/2 的联动

- **tab 1「A股早报」**：JP/KR 隔夜/同期 disclosure 可作为额外 catalyst 输入（半导体链、汽车链、家电链联动明显）。本方案预留字段：`us_catalyst_event` 表 `event_source_kind` 增补 'jpx-edinet' / 'kind' / 'dart' 枚举值。
- **tab 2「美股优选」**：日/韩 ADR (SONY / TSM 非日/韩但类似) + 日/韩本土蓝筹（SoftBank 9984 / Samsung 005930）作为 sector 参考基准，喂 6-维打分「趋势」维度联动分量。

## §8 · Sprint 1 交付节点

| 节点 | 交付 |
|---|---|
| now → +12h（继上文 catalyst-mapping.md v0.1） | 本 spec v0.1 workspace-draft LAND（本文件）· 数据源候选评估 + 表结构 + 时区/交易日历 + 采集器分工 |
| +12h → +24h | 消费 Research §S3 26-catalyst900-spec-extract.md 更新 v0.2（若源码涉及 JP/KR 处理） |
| Sprint 1 末 | 与 catalyst-mapping.md v0.1 合并 PR CREATE · doc-tier 2-sign (DP γ 主 + Research §S3 或 Strategy γ 副) · single-PR ≤ 200 行 · spec-only（无 schema/collector 变更）|
| Sprint 2 起 | Collector 实现（先 JP：JPX EDINET + Yahoo JP） + schema 迁移 + Backend `/api/v1/jpkr-market/*` + Frontend tab 3 端到端 |

## §9 · 卡点

- **Owner 明示 tab 3 优先级**：Orch v300 §四 排在 Sprint 3 · 本 spec Sprint 1 出即可，Sprint 2 不实施
- **Yahoo Finance opt-in 白名单**：msg=4f6d2466 铁律 · 需 Owner 在 tab 3 实施前确认是否放行 Yahoo JP/KR
- **KRX HTML 结构稳定性**：PyKRX 依赖官网 HTML · 需在 Sprint 2 加 canary 监控

## §10 · 铁律 100% retain

- Owner 令 msg=53b96525 catalyst-900 · msg=764688c1 参照锚 · msg=6dc1b5f3 v300 PIVOT
- msg=ad6585cf 借鉴独立性 zero code-copy · yespsam/a-share-us-catalyst 只作 spec 参考
- msg=4f6d2466 free-source only · JPX EDINET + KRX + KIND + DART 官方 + Yahoo JP/KR opt-in + Stooq/PyKRX fallback · Bloomberg/Wind/FnGuide 排除
- msg=a5297512 lane 契约 · DP γ SOLE `collector/` + `storage/` write
- msg=d0d11677 doc-tier 2-sign self-merge
- msg=eb4b0016 / msg=210d262d / msg=21867874 / msg=a8175861 perpetual-dispatch agents 不停
- msg=b091c74d SSH root 永久禁 · 系统改动由 li-yiming 本人执行
- msg=702b81be PG SELECT-only · 每条 SQL 先 #stocks 说清目的+表+SQL全文+预期量级 → Owner 批
- 凭证 zero literal · `sk_agent_<redacted>` · 密钥不在版本库
- Path D `9ec3f104…` + 4-baseline `1f2d197a…` byte-perfect preserve · schema.prisma untouched · US-038 SHA-256 · Math.random=0
- msg=ed61c397 workspace-draft-only · zero repo write · zero PG-write · zero SSH · REDACTED cite-only

---

**END OF `日韩市场数据源接入方案` v0.1 workspace-draft · DP γ · 2026-07-10 · Sprint 1 交付·2/2 · catalyst-mapping.md v0.1 见 notes/180**
