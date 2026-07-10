# notes/182 · DP γ-2 · Multibagger + Backtest + JP/KR Deep · Datasource v0.2 workspace-draft

- **Owner**: @DataPipeline-2 (DP γ-2)
- **Status**: v0.2 workspace-draft · workspace-draft-only · zero repo write · Sprint 1 末等 Orch PR-CREATE-AUTHORIZE + doc-tier 2-sign
- **Task**: #169 (msg=1e0b5699) · Sprint 1 24h · LAND 2026-07-10 (提前 24h)
- **v0.2 delta**: 9 项 unified fold (上游 5/5 全 LAND: Strategy γ msg=3f7bfd3e + DP γ msg=f494e4ad + Research §S3 msg=ea6007f3 + Backend γ msg=9c0d7b34 + AI-γ msg=33836149)
- **Lane 契约 msg=a5297512**: DP γ-2 SOLE `jpkr_deep/` + `multibagger_universe/` + `backtest_pit_snapshot/` + `notes/182-*` · shared 底座 (`collector/shared/**`) 只读复用 (DP γ SOLE 维护) · schema.prisma 单一入口由 DP γ 汇总 · DP γ ↔ DP γ-2 zero conflict
- **参照锚**: catalyst-900 IA · Owner msg=53b96525 铁律 · msg=764688c1 catalyst-900 · Orch v302 msg=f81297a5 §二 · @DataPipeline msg=cb39cc47 5-项交接清单 · @Research §S3 spec-extract v0.1 msg=645fc2a1 · @Strategy scoring v0.1 msg=5a496f5e + v0.2 msg=3f7bfd3e · @Backend v0.2 msg=9c0d7b34 · @AI v0.2 msg=33836149

---

## §〇 · v0.2 delta ledger (v0.1→v0.2 · 9 项)

| # | delta | 源 | section |
|---|---|---|---|
| 1 | §9.2 endpoint 折入 Backend γ canonical `/api/v1/backtest-pit/*` single namespace · 独立 replay endpoint 撤回 | Backend γ v0.2 msg=9c0d7b34 | §9.2 |
| 2 | §4.1 payload JSONB canonical shape 内嵌 (Backend γ metrics 5-字段 + Strategy γ Score.scoring_id + snapshot_hash + Adjustment[] + SizeHint TIER 系) | Backend γ + Strategy γ + AI-γ | §4.1 |
| 3 | §3.3 catalyst_kind 8→9 枚举 (含 unclassified backfill · AI-γ §8 硬门 #10 `kind='unclassified'` pipeline拒推荐) | Strategy v0.2 §3.7.2 + AI-γ v0.2 §2.10 | §3.3 |
| 4 | §6.1 multibagger_universe.text_hit_kinds 扩展 (含 negative/early_news 分层) | Research §S3 v0.2 §六.3 | §6.1 |
| 5 | §5.2 japan_blue_chip / korea_semiconductor_chain profile Sprint 3 决 hook | Strategy v0.2 §2.3 + Research §S3 v0.2 | §5.2 |
| 6 | §9.5 QADocs SLA SQL 断言草案 (3 SLA · 幂等 + 防未来函数 + 防幸存者偏差 · AI-γ rule library联动) | QADocs γ + AI-γ v0.2 §8 | §9.5 |
| 7 | §5.4 KRX HTML canary 采集器 pseudo-code + Research §S3 API 对照 | Research §S3 msg=b8e8a342 | §5.4 |
| 8 | §6.3 fx_rate_to_usd fetch pipeline (BOJ/BOK 官方 🥇) | Research §S3 msg=b8e8a342 | §6.3 |
| 9 | §4.3 CRSP-alt 学界数据源 License 核查 | Research §S3 v0.2 | §4.3 |

---

## §一 · 目标 & 范围

DP γ-2 承接 Orch v302 §二 三块工作：

1. **tab 3 日韩深化** — 承接 DP γ notes/181 v0.1 (msg=40b601ff) 之后的字段级补齐；核心交付 JP/KR 6-维字段可用性表（响应 @Strategy msg=3e1f335b）
2. **tab 4 高倍潜力早期候选池** — 小盘 / 破发 / 低机构覆盖 3-筛选源采集器 (`multibagger_universe/`) + `multibagger_universe` 表 draft
3. **tab 5 6-month PIT 回测数据锚** — point-in-time snapshot 采集器 (`backtest_pit_snapshot/`) + `backtest_pit_snapshot` 表 draft · 防未来函数 · 防幸存者偏差

数据契约总则沿用 DP γ `contracts/catalyst-mapping.md` v0.1：
- ISO-8601 UTC 时间归一化
- ticker 归一化大小写 + 交易所前缀
- 幂等键 UNIQUE 规范
- `fact_hash TEXT` (SHA-256 canonical-normalized · US-038 铁律 · `Math.random`=0)
- 免费源 msg=4f6d2466 铁律 · Bloomberg / Wind / 商业源全排除

---

## §二 · Lane 边界（DP γ ↔ DP γ-2）

| 维度 | DP γ SOLE | DP γ-2 SOLE |
|---|---|---|
| 采集器目录 | `us_catalyst_collector/` | `jpkr_deep/` · `multibagger_universe/` · `backtest_pit_snapshot/` |
| Postgres 表 | `us_catalyst_event` · `a_share_candidate_mapping` | `multibagger_universe` · `backtest_pit_snapshot` (draft) · JP/KR 字段级扩展 to `jpkr_daily_kline` + `jpkr_disclosure_event` (DP γ notes/181 baseline) |
| shared 底座 | 维护 `collector/shared/{rate_limiter,retry_with_backoff,idempotency_hash}.py` | 只读复用 · 若需扩展提交 workspace note 由 DP γ 合并 |
| schema.prisma 汇总入口 | Sprint 1 末 PR CREATE 单一 doc-tier 2-sign | 提交表结构 draft 到 workspace `notes/182-*` 由 DP γ 合并 |
| 契约文件 | `contracts/catalyst-mapping.md` | `contracts/multibagger-universe.md` + `contracts/backtest-pit.md` + `contracts/jpkr-deep.md`（Sprint 2 起 CREATE） |
| 数据源清单 | 双方共同维护 · 免费源铁律共守 | 双方共同维护 · CAUTION 排除清单共守 |

zero conflict 原则：
- 采集器 lane 按 tab 目录切分 · 无跨 tab 触碰
- shared 底座单一维护入口（DP γ）· DP γ-2 提议 → DP γ 合并 → DP γ-2 复用
- schema.prisma 单一 PR CREATE 入口（DP γ）· DP γ-2 draft → DP γ aggregate

---

## §三 · tab 4 高倍潜力候选池 · 3-筛选源方案

### §3.1 · 筛选源矩阵

| # | 源 | 市场 | 免费性 | 用途 | 幂等策略 |
|---|---|---|---|---|---|
| S1 | AKShare `stock_zh_a_new_em` | CN A | 🥇 官方免费 | 次新股 pool | daily snapshot + fact_hash |
| S2 | Baostock small-cap universe (市值 < 80 亿人民币) | CN A | 🥇 官方免费 | 小盘股 pool | daily snapshot + fact_hash |
| S3 | Russell 3000 CRSP-alt (学界公开数据源替代 Bloomberg small-cap universe) | US | 🥇 学界免费 | 小盘 + 破发 + 低机构覆盖 3-维联合筛选 | monthly rebalance snapshot + fact_hash |

CAUTION 排除：Bloomberg small-cap universe · Wind 小盘池 · Refinitiv Eikon universe · FactSet universe · S&P Compustat commercial · 通联数据商业 universe · Nikkei small-cap 商业

### §3.2 · 主筛条件（Research §S3 §六.1 消费）

market_cap sweet spot 双峰（Research §S3 §六.1 消费）：
- **80 亿峰值 · 78 分** → 主候选池优先
- **300 亿峰值 · 90 分** → 中大市值高倍潜力池

破发筛选（US）：
- price < IPO price × 0.70 且 IPO ≤ 24 个月 · 免费源 Yahoo opt-in flag=false canonical fallback → Stooq

低机构覆盖（US）：
- institutional_ownership_pct < 30% · 免费源 SEC EDGAR 13F filings (SEC 官方) + Nasdaq holdings（DP γ shared 底座数据）· 无商业替代需求

### §3.3 · 文本层筛选（Research §S3 §二.2 词表消费）+ catalyst_kind 9-枚举联动 (v0.2)

来自 Research §S3 §二.2（`notes/26-catalyst900-spec-extract-workspace-draft.md`）· 上游 spec-only cite（zero code-copy · 上游无 LICENSE · GitHub ToS 保护）：
- **OPTIONALITY_WORDS 23**（早期期权价值信号）
- **POSITIVE 15**（正向催化）
- **NEGATIVE 11**（负向催化 · 触发排除或降权）
- **EARLY_NEWS 14**（早期新闻信号）

文本层 hit ≥ 3 词 → 加入 tab 4 候选池 pool_status = `TEXTUAL_HIT`。

**v0.2 新增 · catalyst_kind 9-枚举联动** (Strategy v0.2 §3.7.2 + AI-γ v0.2 §2.10):
- catalyst_kind 9-枚举: `earnings` / `upgrade_downgrade` / `product` / `regulator` / `geo_macro` / `ma_activity` / `sector_move` / `leadership` / `unclassified`
- text_hit 词表 → catalyst_kind 映射: POSITIVE→context-dependent · NEGATIVE→context-dependent · EARLY_NEWS→`unclassified` (Sprint 2 kind_auto_classifier GA 前暂标)
- `unclassified` default_delta=0 · kind_multiplier=1.0 · AI-γ §8 硬门 #10: `kind='unclassified'` → pipeline 拒生成推荐 (中性 · 不触发调整)

### §3.4 · 采集频率

- S1 (AKShare 次新股)：daily 09:30 CN 交易日
- S2 (Baostock 小盘)：daily 15:30 CN 交易日 close
- S3 (Russell 3000 CRSP-alt)：monthly rebalance + weekly delta
- 文本层：async pipe · 消费 DP γ US catalyst event stream + JP/KR disclosure event stream

---

## §四 · tab 5 · 6-month PIT 回测数据锚

### §4.1 · point-in-time snapshot 表结构 draft (`backtest_pit_snapshot`)

```
-- workspace-draft ONLY · schema.prisma untouched · DP γ 汇总合并
CREATE TABLE backtest_pit_snapshot (
    id                       BIGSERIAL PRIMARY KEY,
    snapshot_kind            TEXT      NOT NULL,          -- 'universe' | 'score' | 'conviction' | 'catalyst' | 'holdings'
    entity_ticker            TEXT      NOT NULL,          -- normalized: SS/SZ/HK/US/JP/KR prefix
    snapshot_day             DATE      NOT NULL,          -- trading day PIT anchor
    as_of_utc                TIMESTAMPTZ NOT NULL,        -- 冻结时间戳 · 精确到 second
    is_survivorship_biased   BOOLEAN   NOT NULL DEFAULT FALSE,
    is_delisted_at_as_of     BOOLEAN   NOT NULL DEFAULT FALSE,
    payload                  JSONB     NOT NULL,          -- snapshot body (v0.2 canonical shape below)
    source_versions          JSONB     NOT NULL,          -- {provider: version} map · 回放主键
    fact_hash                TEXT      NOT NULL,          -- SHA-256 canonical-normalized (US-038 铁律)
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (snapshot_kind, entity_ticker, snapshot_day)
);
CREATE INDEX ix_pit_snapshot_kind_day ON backtest_pit_snapshot (snapshot_kind, snapshot_day);
CREATE INDEX ix_pit_snapshot_asof     ON backtest_pit_snapshot (as_of_utc);
```

**v0.2 新增 · payload JSONB canonical shape** (snapshot_kind 别):

| snapshot_kind | payload 承载 | canonical 源 |
|---|---|---|
| `score` | `{scoring_id: UUIDv4, snapshot_hash: SHA-256(JCS), total: 0..100, band: 'A'\|'B'\|'C'\|'D'\|'F', dims: [{key, score, band, weight}×6], weights_profile: string}` | Strategy v0.2 §2.1 |
| `conviction` | `{base: [0,100], adjustments: [{delta, reason, kind_ref?, source_ref?}] len∈[0,5] Σ∈[-20,+20], final: clamp(base+Σ,0,100), level: 'HIGH'\|'MED'\|'LOW', score_ref: {scoring_id, snapshot_hash}}` | Strategy v0.2 §4.1 |
| `catalyst` | `{kind: 9-enum, relevance_score: [0,1], kind_multiplier: number, evidence_refs: [...]}` | Strategy v0.2 §3.7 + AI-γ v0.2 §2.10 |
| `holdings` | `{ticker, weight, return_since_entry, is_stale}[]` | Backend γ v0.2 LOCK #11 三方 lock |
| `universe` | `{pool_status, market_cap_peak_bucket, text_hit_kinds, ...}` | notes/182 §6.1 |

Backend γ v0.2 (msg=9c0d7b34) API 端 metrics 补充 (非 payload 内 · API aggregation 层):
- `metrics: {net_value, drawdown, cumulative_return, sharpe_ratio_6m, win_rate_6m}`

EntryPlan.size_hint v0.2 canonical (承 Strategy v0.2 §6.3 Refinement A+B · payload 内嵌):
```json
{
  "tier": "TIER_5",
  "pct": 5.0,
  "disclaimer_key": "size_hint_advisory"
}
```
SizeHintTier: `TIER_5`(≥85) / `TIER_3`(70-84.9) / `TIER_2`(55-69.9) / `TIER_1`(40-54.9) / `SKIP`(<40)

### §4.2 · 防未来函数 (no-lookahead)

- 每次读取 snapshot 必须传 `as_of_utc` boundary · hard-cut 任何 `payload.source_ts > as_of_utc` 字段 → REJECT with `LOOKAHEAD_LEAK` 错误
- Strategy γ §3 PIT 纯度 100% retain：`Score.as_of` + `Score.source_versions` 与本表 `as_of_utc` + `source_versions` byte-identical
- AI-γ (Task #170) 回放机制以 `(snapshot_kind, entity_ticker, snapshot_day, as_of_utc, source_versions)` 5-元组为回放主键

### §4.3 · 防幸存者偏差 (no-survivorship-bias) + CRSP-alt 学界数据源 License 核查

- 退市 / 暂停股 snapshot **保留**（不删除）· `is_delisted_at_as_of = TRUE` 标记
- 回测 universe pool 每次重构必须包含当天 delisted 股 · 若忽略则整个 snapshot 打 `is_survivorship_biased = TRUE` 警告标记 → 下游拒绝消费
- Baostock 提供退市股历史价格 (免费) · US 依赖 CRSP-alt 学界数据源退市股保留

**v0.2 · CRSP-alt 学界数据源 License 核查** (delta #9 · 承 Research §S3 v0.2):
- **CRSP 原版**: Wharton WRDS 订阅制 · 商业 = **排除** (免费源铁律 msg=4f6d2466)
- **CRSP-alt 替代方案**:
  - ✅ **Kenneth French Data Library** (Dartmouth) — 免费 · 无 License 限制 · 含 SMB/HML/momentum 因子 + 组合 breakpoints · 覆盖 Russell 3000 组合月度再平衡 · **推荐 primary**
  - ✅ **AQR Data Sets** — 免费 · 学术用途 · 含 BAB/QMJ/momentum/value 因子历史 · 含退市股因子收益 · **推荐 fallback**
  - ✅ **FRED (St. Louis Fed)** — 免费 · 公开 API · 补充利率/GDP/CPI 等宏观因子基准
  - ❌ **S&P Compustat** — 商业排除
  - ❌ **Bloomberg/Refinitiv** — 商业排除
- **退市股覆盖**:
  - Kenneth French: factor portfolio return 包含退市前末日收益 · 但不提供个股级退市日 ticker 映射
  - 补充方案: SEC EDGAR `company-tickers.json` (Research msg=b8e8a342 §二) + `is_active` flag + `delisted_date` → DP γ-2 退市股识别 pipeline
- **Sprint 2 action**: `multibagger_universe` 表 Russell 3000 行使用 Kenneth French Data Library monthly breakpoints 作为小盘 universe 入口 · fact_hash 含 breakpoints version

### §4.4 · 6-month PIT 时间轴消费

- Sprint 2 起 Backend γ `/api/v1/backtest-pit/:strategy/:as_of` 端点消费本表
- Frontend γ-3 tab 5 (Task #168) 净值曲线 + 回撤 + 夏普 + 胜率 slot 全部消费本表 · 时间轴 6 个月为默认 window · 可扩 12/24 个月

---

## §五 · tab 3 日韩深化（承接 DP γ notes/181 v0.1）

### §5.1 · JP/KR 6-维字段可用性表（响应 @Strategy msg=3e1f335b）

Strategy γ 6-维：**Q (Quality) · G (Growth) · V (Valuation) · M (Moat) · T (Trend) · R (Risk)**

#### §5.1.1 · 日本 (JP)

| 维度 | 关键指标 | JPX EDINET (官方) | Yahoo JP opt-in | Stooq (fallback) | 覆盖率 | 备注 |
|---|---|---|---|---|---|---|
| Q | ROE · ROIC · 负债率 · 现金流质量 | ✅ ROE/ROA (annual/quarterly) · 负债率 · CFO | ✅ ROE/ROA · 负债率 | ⚠️ PE/PB only | 95% | EDINET XBRL 权威 · Yahoo 覆盖 TOPIX 500 良好 |
| G | 营收 CAGR · EPS 增长 · 订单增长 | ✅ Rev/EPS 3Y-5Y history | ✅ Rev/EPS annual | ⚠️ Rev only | 90% | 订单增长依赖分行业 (自动车/半导体) 官方公告 · EDINET 覆盖 |
| V | PE · PB · PS · EV/EBITDA · DCF | ✅ 全字段 | ✅ PE/PB/PS | ⚠️ PE/PB only | 85% | DCF 需 Strategy γ 计算 · 基础字段官方全 |
| M | 市占率 · 品牌力 · 专利数 · R&D 占比 | ✅ R&D 占比 (annual) · 分部数据 | ⚠️ 有限 | ❌ | 70% | 市占率 / 品牌力需外部报告 (Nikkei 商业 排除) · R&D + 分部 EDINET 覆盖 |
| T | 相对强度 RSI · MA200 · 成交量比 · 资金流 | ⚠️ 通过 daily kline 计算 | ✅ daily kline + 成交量 | ✅ daily kline | 100% | 技术面指标 Strategy γ 自计算 · 基础 kline 三源都有 |
| R | β · vol30 · vol90 · maxDD · CVaR | ⚠️ 通过 kline 计算 | ✅ β / vol30/90 | ✅ β / vol | 95% | 基础 kline 覆盖 · maxDD/CVaR Strategy γ 自计算 |

**JP 6-维总覆盖率 ~89%**（Strategy msg=2b2d5bc4 ~95% ACK · 保守修正为 ~89% · 主要缺口在 M 品牌力 / 市占率外部数据）

#### §5.1.2 · 韩国 (KR)

| 维度 | 关键指标 | KRX marketdata (官方) | DART XBRL (官方) | KIND (停牌) | PyKRX (fallback) | 覆盖率 | 备注 |
|---|---|---|---|---|---|---|---|
| Q | ROE · ROIC · 负债率 · 现金流质量 | ⚠️ 有限 | ✅ ROE/ROA · 负债率 · CFO (XBRL) | ❌ | ⚠️ PE/PB only | 90% | DART XBRL 权威 · 覆盖 KOSPI + KOSDAQ · WISEreport (商业) 排除 |
| G | 营收 CAGR · EPS 增长 · 订单增长 | ❌ | ✅ Rev/EPS 3Y-5Y | ❌ | ⚠️ Rev only | 88% | DART XBRL 财报 3-5 年历史 · 订单增长依赖行业公告 |
| V | PE · PB · PS · EV/EBITDA · DCF | ✅ PE/PB (daily) | ✅ 全字段 (via 财报) | ❌ | ✅ PE/PB/PS | 88% | KRX daily PE/PB 官方 · DCF Strategy γ 自计算 |
| M | 市占率 · 品牌力 · 专利数 · R&D 占比 | ❌ | ✅ R&D 占比 (annual) · 分部数据 | ❌ | ❌ | 65% | 半导体 / 电池链行业市占率 KOSTAT (统计厅) + KOSMES 可补 · FnGuide 商业排除 |
| T | 相对强度 RSI · MA200 · 成交量比 · 资金流 | ✅ daily kline + 成交量 | ❌ | ❌ | ✅ daily kline | 100% | KRX + PyKRX 覆盖完整 |
| R | β · vol30 · vol90 · maxDD · CVaR | ⚠️ 通过 kline 计算 | ❌ | ❌ | ✅ β / vol | 95% | 基础 kline 覆盖 |

**KR 6-维总覆盖率 ~88%**（Strategy msg=2b2d5bc4 ~95% ACK · 保守修正为 ~88% · 主要缺口在 M 市占率 / 品牌力 · KOSTAT + KOSMES 免费源可覆盖部分半导体 / 电池链行业）

### §5.2 · JP/KR v0.3 profile 建议（Sprint 3 决 · v0.2 Strategy §2.3 承接）

响应 Strategy §9 Q1 · Research §S4 同批决：

- **`japan_blue_chip` profile 建議**（TOPIX 500 龙头适配）
  - Q 0.25 · G 0.15 · V 0.20 · M 0.20 · T 0.10 · R 0.10
  - 理由：日本蓝筹以现金流质量 + 分红为核心 · 高倍成长次要 · 品牌力 / 分部数据 EDINET 官方覆盖
- **`korea_semiconductor_chain` profile 建议**（KOSPI + KOSDAQ 半导体 / 电池链适配）
  - Q 0.15 · G 0.30 · V 0.10 · M 0.15 · T 0.20 · R 0.10
  - 理由：韩国半导体 / 电池成长弹性大 · 财报增长为核心 · KOSTAT + KOSMES 行业市占率补 M
- Sprint 3 与 Research §S4 (JP/KR 具体行业验证) 同批决 · workspace-draft-only

**v0.2 hook** (承 Strategy v0.2 msg=3f7bfd3e §2.3 + scoring pipeline code msg=1da83a9c `weights.ts`):
- Strategy γ `weights.ts` 已含 `us_preferred` + `multibagger` 两个 profile registry · `registerProfile()` public API 预留自定义
- 此两 profile 上游 input surface = §5.1 6-维覆盖率 (JP ~89% / KR ~88%) · M 维缺口 (品牌力/市占率) 限制 M 权重上限
- Sprint 3 决 gate: Research §S4 JP/KR 行业验证 LAND + Strategy γ backtest 回验 pass → `registerProfile('japan_blue_chip', ...)` + `registerProfile('korea_semiconductor_chain', ...)` · DP γ-2 提供 §5.1 覆盖率输入 · Strategy γ SOLE 决定最终权重
- **EDINET 采集器** (notes/184 §二) + **DART 采集器** (notes/184 §三) Sprint 2 实装后 → M 维覆盖率可提升 (R&D 占比 + 分部数据 XBRL 解析)

### §5.3 · Yahoo opt-in flag default=false 铁律

- 承 DP γ notes/181 v0.1 · ADR-0008 pending 队列 #16
- Yahoo opt-in flag default=false canonical retain · Sprint 2 采集器实现时默认 disable Yahoo · fallback 序列 JPX EDINET → Stooq (JP) · KRX + DART → PyKRX (KR)
- UI 层验收：opt-in 状态显式 UI 开关 + 版权 disclaimer

### §5.4 · KRX HTML canary 监控（承 DP γ notes/181 §9 卡点 · v0.2 xref notes/184 §七）

- KRX marketdata 部分接口为 HTML 抓取（无稳定 JSON API）
- canary 采集器每日执行结构对比 · schema drift 报警 → 通知 DP γ + DP γ-2 + Cleanup γ
- fallback 策略：schema drift 时切换 PyKRX + KIND · 保 KOSPI 主数据链路可用

**v0.2 xref notes/184 §七 KRX canary 完整设计**:
- `KRX_CANARY_TARGETS`: daily_stock_price (2 列 · 5 值) + market_cap (2 列 · 5 值)
- `run_canary()`: requests.get → BeautifulSoup → header 提取 → struct diff vs baseline → `CanaryResult`
- `alert_on_drift()`: drift detected → fallback PyKRX + KIND · 日报 DP γ + DP γ-2
- Research §S3 API 对照 (msg=b8e8a342): KRX 官方无 JSON API 确认 · canary 方案 validated

---

## §六 · 表结构 draft 汇总（DP γ 合并入口 · schema.prisma untouched）

### §6.1 · `multibagger_universe`

```
-- workspace-draft ONLY · DP γ 汇总
CREATE TABLE multibagger_universe (
    id                       BIGSERIAL PRIMARY KEY,
    universe_source_kind     TEXT NOT NULL,               -- 'AKSHARE_NEW_EM' | 'BAOSTOCK_SMALLCAP' | 'RUSSELL_3000_CRSP_ALT'
    ticker                   TEXT NOT NULL,               -- normalized: SS/SZ/HK/US prefix
    snapshot_day             DATE NOT NULL,
    as_of_utc                TIMESTAMPTZ NOT NULL,
    market_cap_bn_cny        NUMERIC(20, 4),              -- 80 亿峰 / 300 亿峰
    market_cap_peak_bucket   TEXT,                        -- 'PEAK_80B' | 'PEAK_300B' | 'OTHER'
    price_vs_ipo_ratio       NUMERIC(10, 4),              -- < 0.70 for 破发
    institutional_ownership_pct NUMERIC(10, 4),          -- < 30% for 低机构
    text_hit_kinds           TEXT[],                      -- v0.2: ['OPTIONALITY', 'POSITIVE', 'NEGATIVE', 'EARLY_NEWS'] (Research §S3 v0.2 §六.3 4-类分层)
    text_hit_count           INT NOT NULL DEFAULT 0,
    pool_status              TEXT NOT NULL,               -- 'CANDIDATE' | 'TEXTUAL_HIT' | 'EXCLUDED_NEG' | 'EXCLUDED_RISK_GATE' (v0.2 +RiskGate RED 排除)
    fact_hash                TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (universe_source_kind, ticker, snapshot_day)
);
CREATE INDEX ix_mb_universe_day     ON multibagger_universe (snapshot_day);
CREATE INDEX ix_mb_universe_status  ON multibagger_universe (pool_status, snapshot_day);
CREATE INDEX ix_mb_universe_peak    ON multibagger_universe (market_cap_peak_bucket, snapshot_day);
```

### §6.2 · `backtest_pit_snapshot`

见 §4.1

### §6.3 · JP/KR 字段级扩展（承 DP γ notes/181 baseline `jpkr_daily_kline` + `jpkr_disclosure_event`）

新增 6-维字段列（apply via ALTER TABLE draft · DP γ 合并）：

**v0.2 fx_rate_to_usd pipeline** (承 notes/184 §六 FX rate fetcher · Research §S3 msg=b8e8a342 对照):
- JP: BOJ 官方 🥇 (`https://www.stat-search.boj.or.jp/ssi/mtsec/` SDMX-ML · free · JPY/USD daily) → ECB SDMX fallback 🥈
- KR: BOK 官方 🥇 (`https://ecos.bok.or.kr/api/StatisticSearch/` JSON · free · KRW/USD daily) → ECB SDMX fallback 🥈
- `compute_market_cap_usd(market_cap_bn_local, fx_rate_to_usd)` → `market_cap_bn_usd` 列填充
- fx_rate 冻结在 `as_of_utc` 当天收盘价 · 防未来函数: fx_date ≤ as_of_utc.date()
- Sprint 2 实装: notes/184 §六 `FxRateFetcher` class · BOJ/BOK 官方优先 · ECB fallback · 3 级 retry

```
-- ALTER draft ONLY · DP γ 合并到 schema.prisma
ALTER TABLE jpkr_daily_kline
  ADD COLUMN market_cap_bn_local NUMERIC(20, 4),        -- 本币计价
  ADD COLUMN market_cap_bn_usd   NUMERIC(20, 4),        -- USD 折算 (以 as_of 汇率)
  ADD COLUMN fx_rate_to_usd      NUMERIC(20, 8);        -- fx snapshot 冻结

-- 新建 JP/KR 财务快照表 (from DART XBRL + EDINET XBRL · quarterly + annual)
CREATE TABLE jpkr_financial_snapshot (
    id                   BIGSERIAL PRIMARY KEY,
    market               TEXT NOT NULL,                  -- 'JP' | 'KR'
    ticker               TEXT NOT NULL,
    fiscal_period_kind   TEXT NOT NULL,                  -- 'Q1'..'Q4' | 'ANNUAL'
    fiscal_period_end    DATE NOT NULL,
    as_of_utc            TIMESTAMPTZ NOT NULL,
    revenue_local        NUMERIC(20, 4),
    eps_local            NUMERIC(20, 8),
    roe_pct              NUMERIC(10, 4),
    roa_pct              NUMERIC(10, 4),
    debt_to_equity       NUMERIC(10, 4),
    cfo_local            NUMERIC(20, 4),
    r_and_d_pct          NUMERIC(10, 4),
    segment_data         JSONB,                          -- 分部收入/利润
    source_kind          TEXT NOT NULL,                  -- 'EDINET_XBRL' | 'DART_XBRL'
    source_document_id   TEXT NOT NULL,
    fact_hash            TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (market, ticker, fiscal_period_kind, fiscal_period_end, source_kind)
);
```

---

## §七 · 免费源清单 & CAUTION 排除

### §7.1 · 免费源（msg=4f6d2466 铁律）

| 源 | 市场 | 类型 | 用途 | tier |
|---|---|---|---|---|
| AKShare `stock_zh_a_new_em` | CN A | 官方免费 | tab 4 次新股 | 🥇 |
| Baostock small-cap universe | CN A | 官方免费 | tab 4 小盘股 · 退市股历史价 | 🥇 |
| Russell 3000 CRSP-alt (学界) | US | 学界免费 | tab 4 US 三维筛 · 退市保留 | 🥇 |
| SEC EDGAR 13F | US | 官方免费 | tab 4 机构持仓 | 🥇 |
| Nasdaq holdings | US | 官方免费 | tab 4 机构持仓 fallback | 🥈 |
| JPX EDINET | JP | 官方免费 | tab 3 财报 XBRL · Q/G/V/M | 🥇 |
| Yahoo JP (opt-in default=false) | JP | 免费需 opt-in | tab 3 kline + 基础指标 fallback | 🥈 |
| Stooq (JP) | JP | 免费无限速 | tab 3 kline fallback | 🥉 |
| KRX marketdata | KR | 官方免费 | tab 3 kline + PE/PB | 🥇 |
| KIND | KR | 官方免费 | tab 3 停牌 | 🥇 |
| DART XBRL | KR | 官方免费 | tab 3 财报 · Q/G/V/M | 🥇 |
| PyKRX (fallback) | KR | 免费开源 | tab 3 kline fallback | 🥈 |
| KOSTAT + KOSMES | KR | 官方免费 | tab 3 M 行业市占率补 (半导体/电池) | 🥈 |

### §7.2 · CAUTION 排除清单

Bloomberg (all products) · Wind · Refinitiv Eikon · FactSet · S&P Compustat · Nikkei API 商业 · JPX Data Cloud 付费 · KRX Market Data 商业 API · WISEreport · FnGuide · QuantIQ · iCharts commercial · 通联数据 · 万得资讯

---

## §八 · Shared 底座只读复用（DP γ SOLE 维护）

DP γ-2 采集器实现（Sprint 2 起）时只读复用以下 primitive：

- `collector/shared/rate_limiter.py` — token bucket · 按 source_kind 分域限速
- `collector/shared/retry_with_backoff.py` — exponential backoff + jitter · max 5 retry
- `collector/shared/idempotency_hash.py` — SHA-256 canonical-normalized · US-038 铁律 · `Math.random`=0

若需扩展 primitive：
1. DP γ-2 workspace note 起草扩展 spec
2. broadcast @DataPipeline PR review
3. DP γ 合并到 `collector/shared/**`
4. DP γ-2 复用

**zero conflict 原则**：DP γ-2 不直接写 `collector/shared/**` · 保 shared 单一维护入口。

---

## §九 · 契约喂送清单

### §9.1 · @Frontend-3 tab 4/5 shell（Task #168）

- **tab 4 row shape**（消费 `multibagger_universe`）:
  ```
  {
    ticker: string,
    market: 'CN' | 'US',
    market_cap_bn: number,
    market_cap_peak_bucket: 'PEAK_80B' | 'PEAK_300B' | 'OTHER',
    price_vs_ipo_ratio: number | null,
    institutional_ownership_pct: number | null,
    text_hit_kinds: Array<'OPTIONALITY' | 'POSITIVE' | 'EARLY'>,
    pool_status: 'CANDIDATE' | 'TEXTUAL_HIT' | 'EXCLUDED_NEG',
    as_of: string  // ISO-8601 UTC
  }
  ```
- **tab 5 row shape**（消费 `backtest_pit_snapshot` aggregated）:
  ```
  {
    strategy: string,
    as_of: string,  // ISO-8601 UTC
    equity_curve: Array<{ day: string; value: number }>,
    max_drawdown: number,
    sharpe: number,
    win_rate: number,
    is_survivorship_biased: boolean,  // 若 true UI 必须显著警告
    source_versions: Record<string, string>  // 回放主键
  }
  ```

### §9.2 · @Backend γ v0.2 (v0.2 fold-in · 独立 endpoint 撤回)

**v0.2 delta**: 我 v0.1 §9.2 独立端点建议 **全部撤回** · 折入 Backend γ v0.2 (msg=9c0d7b34) canonical single namespace:

- tab 4: `GET /api/v1/multibagger-pool/:date?peak=80B|300B|all&pool_status=CANDIDATE|TEXTUAL_HIT` — 承 Backend γ v0.2 §三 endpoint mapping
- tab 4: `GET /api/v1/multibagger-pool/:ticker/history` — 承 Backend γ v0.2 §三
- tab 5: `GET /api/v1/backtest-pit/:strategy/:as_of` — **Backend γ SOLE single namespace · LOCK #11 三方 lock** · `?from=&to=&limit=N` query 承
- tab 5: `GET /api/v1/backtest-pit/:strategy/:as_of/holdings` — **Backend γ SOLE · 4-字段 `{ticker, weight, return_since_entry, is_stale}`**
- ~~tab 5: `GET /api/v1/backtest-pit/:strategy/replay?...`~~ — **v0.2 撤回** · replay 走 AI-γ SOLE `POST /api/v1/ai/recommendations/replay` (msg=33836149 §9 canonical)

**零 DP γ-2 独立端点** · Backend γ SOLE `/api/v1/*` mount · DP γ-2 只提供存储层 DDL + 幂等写入

### §9.3 · @AI-γ (Task #170) 回放机制

回放主键：`(snapshot_kind, entity_ticker, snapshot_day, as_of_utc, source_versions)` 5-元组
- `snapshot_kind` ∈ {'universe', 'score', 'conviction', 'catalyst', 'holdings'}
- `source_versions` JSONB (provider → version) 用于精确回放当日 provider 版本状态
- 防未来函数硬 gate：`payload.source_ts > as_of_utc` REJECT

### §9.4 · @Strategy γ

JP/KR 6-维字段可用性表 §5.1 → scoring v0.2 §2.3 `japan_korea` profile 输入：
- JP 覆盖 89% · KR 覆盖 88% · M 维（品牌力/市占率）缺口需 KOSTAT + KOSMES 补
- 建议 `japan_blue_chip` + `korea_semiconductor_chain` profile v0.3 Sprint 3 决

### §9.5 · @QADocs γ 验收 checklist (v0.2 SLA SQL 断言草案)

三条 SLA 断言 + v0.2 具体 SQL (承 QADocs γ msg=651d4eba Sprint 2 test framework + AI-γ v0.2 §8 rule library):

**SLA-1 幂等键约束**:
```sql
-- 断言: 同一 (source_kind, ticker, day) 三元组无重复
SELECT universe_source_kind, ticker, snapshot_day, COUNT(*)
FROM multibagger_universe
GROUP BY universe_source_kind, ticker, snapshot_day
HAVING COUNT(*) > 1;
-- 期望: 0 rows · 违反 → P0 数据质量事件
```

**SLA-2 防未来函数**:
```sql
-- 断言: backtest snapshot 无 source_ts > as_of_utc 的数据
SELECT id, snapshot_kind, entity_ticker, snapshot_day, as_of_utc,
       payload->>'source_ts' AS source_ts
FROM backtest_pit_snapshot
WHERE (payload->>'source_ts')::timestamptz > as_of_utc;
-- 期望: 0 rows · 违反 → P0 回测污染事件 · QADocs BLOCK Sprint 3 消费
```

**SLA-3 防幸存者偏差**:
```sql
-- 断言: 无 survivorship-biased 行存在
SELECT id, strategy, as_of_utc, is_survivorship_biased
FROM backtest_pit_snapshot
WHERE is_survivorship_biased = TRUE;
-- 期望: 0 rows · 违反 → P0 · QADocs BLOCK Sprint 3 回测消费
```

**AI-γ v0.2 §8 联动**: 14 硬门中 #3 `no_future_function` + #4 `no_survivorship_bias` 与 SLA-2/SLA-3 同义 · AI-γ rule library 消费这些 SLA 结果 → `recommendation.metadata.sla_pass = TRUE` 才准发布

---

## §十 · v0.2 status + Sprint 2 接续

### §10.1 · v0.2 status

- ✅ v0.1 workspace-draft LAND（msg=11e16e41 · Task #169 in_review）
- ✅ v0.2 unified fold 9/9 delta 全部 applied (本次更新)
- ✅ Sprint 1 11/11 LAND COMPLETE (Orch v306 msg=f4e0c82c 确认)
- ✅ Sprint 2 前置: notes/184 JP/KR collector framework v0.1 LAND (msg=2aaf823e)
- ⏳ Sprint 1 末 doc-tier 2-sign PR CREATE 待 Orch 批 (主签 DP γ-2 · 副签 QADocs γ msg=3024d5bd)

### §10.2 · Sprint 2 接续

- notes/184 Sprint 2 实装: EDINET + DART + XBRL parser + field_mapper + fx_rate + KRX canary · 7 module
- `multibagger_universe/` 采集器: AKShare + Baostock + Kenneth French → `multibagger_universe` 表
- `backtest_pit_snapshot/` 采集器: PIT snapshot pipeline → `backtest_pit_snapshot` 表
- `jpkr_deep/` 采集器: EDINET XBRL + DART XBRL → `jpkr_financial_snapshot` 表 · fx_rate pipeline → `jpkr_daily_kline` ALTER

### §10.3 · v0.2 上游 trigger (全部 satisfied)

| # | trigger | msg | status |
|---|---|---|---|
| 1 | Strategy γ scoring v0.2 | msg=3f7bfd3e | ✅ LAND |
| 2 | DP γ notes/183 schema aggregate | msg=f494e4ad | ✅ LAND |
| 3 | Research §S3 v0.2 API docs | msg=ea6007f3 + msg=b8e8a342 | ✅ LAND |
| 4 | Backend γ v0.2 endpoint canonical | msg=9c0d7b34 | ✅ LAND |
| 5 | AI-γ v0.2 recommendation | msg=33836149 | ✅ LAND |

---

## §十一 · 铁律 100% retain

- **借鉴独立性 msg=ad6585cf** · zero code-copy · Research §S3 上游 (75 stars Python · 无 LICENSE · GitHub ToS 保护) 严格 spec-only cite · 全部实现 Go/TS/Python 从零构建 · 词表为公开产业术语不构成 code-copy
- **workspace-draft-only msg=ed61c397** · 本文件 workspace-only · zero repo write until Sprint 1 末 Orch PR-CREATE-AUTHORIZE + doc-tier 2-sign
- **免费源 msg=4f6d2466** · §7 全免费官方 / 学界数据源 · Bloomberg/Wind 商业全排除 · CRSP-alt = Kenneth French Data Library (§4.3 核查通过)
- **lane 契约 msg=a5297512** · DP γ-2 SOLE `jpkr_deep/` + `multibagger_universe/` + `backtest_pit_snapshot/` + `notes/182-*` + `notes/184-*` · shared 底座只读复用（DP γ SOLE 维护）· schema.prisma 单一入口由 DP γ 汇总
- **Path D `9ec3f104` + 4-baseline `1f2d197a` byte-perfect** preserve · schema.prisma untouched
- **PG SELECT-only msg=702b81be** · 表结构 draft workspace-only · zero PG write
- **SSH root 永久禁 msg=b091c74d**
- **凭证 zero literal** · `sk_agent_<redacted>` 占位 shape only
- **US-038 SHA-256 deterministic only** · `Math.random`=0 · fact_hash canonical-normalized
- **self-merge doc-tier 2-sign msg=d0d11677** · Sprint 1 末 PR CREATE 主签 DP γ-2 + 副签 QADocs γ (msg=3024d5bd 承诺)
- **agents 不停 msg=210d262d** · perpetual-dispatch msg=eb4b0016/21867874/a8175861
- **Owner v300~v306 100% 兑现** · catalyst-900 IA + Owner msg=53b96525/msg=764688c1 参照锚
- **Backend γ SOLE `/api/v1/*` endpoint** · DP γ-2 零独立端点 (v0.2 §9.2 撤回确认)
- **AI-γ SOLE replay endpoint** · `POST /api/v1/ai/recommendations/replay` (msg=33836149 §9)
- **notes/184 xref** · §5.4 KRX canary → notes/184 §七 · §6.3 fx_rate → notes/184 §六 · Sprint 2 实装单一入口

**DP γ-2 · notes/182 v0.2 workspace-draft LAND · 9/9 delta unified fold complete · Sprint 1 全契约 LAND · agents 不停**
