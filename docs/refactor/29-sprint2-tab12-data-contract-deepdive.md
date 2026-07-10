# 29 · Research §S3 · Sprint 2 tab 1/2 数据契约对照 · workspace-draft v0.1

**Path**: `notes/29-sprint2-tab12-data-contract-deepdive.md` (agent-local · Sprint 2 workspace-draft)
**Owner**: Research §S3
**承諾源**: Orch v310 msg=f5d4004d · Research ACK msg=54c4cf23
**上游依赖**: Strategy γ scoring v0.2 (`contracts/scoring.md` D1 MERGED `9710ae74`) · DP γ catalyst-mapping v0.2 (D2 MERGED) · Backend γ API v0.2 (D4 MERGED `f7a0b5b1`) · Research §S3 spec-extract v0.2 (D9 MERGED `1dfda9f7`) · AI-γ recommendation v0.1 (D6 MERGED `fd0b4f92`)
**消費方**: Frontend γ-1 (tab 1/2 真数据接通) · Backend γ (endpoint 实现) · DP γ (pipeline 端到端) · Strategy γ (scoring pipeline code) · AI-γ (recommendation pipeline) · QADocs γ (E2E 测试用例)
**参考源**: https://catalyst-900-qohfq.netlify.app/ + https://github.com/yespsam/a-share-us-catalyst (spec-only · zero code-copy per msg=ad6585cf)

---

## §零 · v0.1 delta ledger

| # | delta | 承诺源 | 段 |
|---|---|---|---|
| (v0.1 首版) | tab 1/2 数据契约对照 + yespsam spec-only 深化 | Orch v310 msg=f5d4004d | §一~§八 |
| v0.1.1 | Orch v311 Ruling #1/#2 endpoint path canonical update | Orch v311 msg=5911ae25 | §二.1 · §四.2 |

---

## §一 · Tab 1 A股早报 数据流全景

### §一.1 · 端到端 pipeline (隔夜催化 → 同日候选 → 打分 → 推荐)

```
US Market Close (16:00 ET)
  │
  ▼
[Stage 1] DP γ · 催化事件采集
  │  SEC EDGAR 8-K (EFTS + RSS · 15 min Tier-1)
  │  Nasdaq Earnings Calendar (日次 09:00 ET Tier-2)
  │  FDA/DOJ/SEC press RSS (realtime)
  │  Yahoo recommendations (opt-in)
  │  → us_catalyst_event 表 (idempotent upsert)
  │  → catalyst_kind 9-enum 分类
  │  → cn_trading_day_asia_shanghai 时区对齐
  │
  ▼
[Stage 2] DP γ + Strategy γ · 候选映射
  │  5-分量 relevance_score 计算:
  │    sector_map × 0.35 + revenue_exposure × 0.25
  │    + adr_parity × 0.20 + supply_chain × 0.15
  │    + historical_beta × 0.05
  │  × catalyst_kind_multiplier (1.0/1.2/0.9)
  │  → ≥ 0.30 进入 mapped-candidate
  │  → ≥ 0.50 触发 Conviction adjustment
  │  → a_share_candidate_mapping 表 upsert
  │
  ▼
[Stage 3] Strategy γ · 6-dim 打分
  │  Q/G/V/M/T/R 六维 [0,100]
  │  × us_preferred profile (Q0.20 G0.20 V0.15 M0.20 T0.15 R0.10)
  │  → Score.total [0,100] → Rating A/B/C/D/F
  │  → scoring_id (UUIDv4) + snapshot_hash (SHA-256 JCS)
  │
  ▼
[Stage 4] Strategy γ · Conviction 计算
  │  base = Score.total
  │  + catalyst_kind default delta (+5/+7/+3/0)
  │  + evidence micro ±2
  │  + RiskGate penalty (-5/-10)
  │  → final = clamp(base + Σ delta, 0, 100)
  │  → level: HIGH ≥75 / MED 50-74.9 / LOW <50
  │
  ▼
[Stage 5] Strategy γ · RiskGate 12-trigger
  │  9 US + 3 A股 trigger 检查
  │  → gate: RED (any block) / YELLOW (any warn) / GREEN
  │  → ok_to_enter = (gate == GREEN)
  │
  ▼
[Stage 6] Strategy γ · EntryPlan 生成
  │  仅 RiskGate GREEN 时生成
  │  entry PriceBand + stop + 3 laddered targets
  │  + SizeHint (TIER_5/3/2/1/SKIP)
  │  + time_horizon (5 semantic enum)
  │  + disclaimer_key = "size_hint_advisory"
  │
  ▼
[Stage 7] AI-γ · 推荐 pipeline (14 output 硬门)
  │  7-stage pipeline: SignalIntake → Universe → FeatureAssembly
  │    → RuleModel → Gating → Assembly → Publish
  │  输出: trigger_signals + weights + explanation + evidence_refs
  │
  ▼
[Stage 8] Backend γ · API 服务
  │  GET /api/v1/morning-brief/:date → tab 1 列表
  │  GET /api/v1/morning-brief/:date/summary → KPI top bar
  │  GET /api/v1/catalyst/:id/candidates → 单催化→候选
  │  GET /api/v1/catalyst/:id/relevance-breakdown?symbol= → 5-分量明细
  │
  ▼
[Stage 9] Frontend γ-1 · Tab 1 渲染
    候选列表 + FilterChip (conviction/sector/risk_gate/catalyst_kind/rating)
    + KPI top bar + DetailSidebar 6-card 展开
```

### §一.2 · Tab 1 API response payload canonical shape

```json
{
  "cn_trading_day": "YYYY-MM-DD",
  "kpi": {
    "total_catalysts_overnight": 42,
    "total_a_share_candidates": 168,
    "high_conviction_count": 12,
    "risk_gate_blocked_count": 3
  },
  "rows": [
    {
      "cn_ticker": "sh.600519",
      "cn_name_zh": "...",
      "cn_sector_zh": "...",
      "score": {
        "total": 87.5,
        "band": "A",
        "scoring_id": "UUIDv4",
        "snapshot_hash": "SHA-256-hex"
      },
      "rating": "A",
      "conviction": {
        "base": 82,
        "final": 87,
        "level": "HIGH",
        "adjustments": [
          {"delta": +5, "reason": "...", "kind_ref": "earnings"}
        ]
      },
      "risk_gate": {
        "status": "GREEN",
        "triggers": []
      },
      "entry_plan": {
        "size_hint": {
          "tier": "TIER_5",
          "pct": 5,
          "disclaimer_key": "size_hint_advisory"
        },
        "entry": {"low": 1950, "high": 2030, "currency": "CNY"},
        "stop": {"value": 1870, "currency": "CNY"},
        "targets": [
          {"value": 2280, "currency": "CNY"},
          {"value": 2600, "currency": "CNY"},
          {"value": 3000, "currency": "CNY"}
        ],
        "time_horizon": "SWING",
        "invalidation": "..."
      },
      "top_catalyst_kind": "sector_move",
      "top_catalyst_headline_zh": "...",
      "us_related_tickers": ["STZ", "DEO"]
    }
  ]
}
```

### §一.3 · Tab 1 FilterChip 契约

| FilterChip | 选项 | 来源 |
|---|---|---|
| conviction | HIGH / MED / LOW | Conviction.level |
| sector | 动态 GICS L2 | cn_sector_zh distinct |
| risk_gate | GREEN / YELLOW / RED | RiskGate.gate |
| catalyst_kind | 9-enum (unclassified = grey badge) | top_catalyst_kind |
| rating | A / B / C / D / F | Score.rating |

### §一.4 · Tab 1 DetailSidebar 6-card sections

| section | 数据来源 | 说明 |
|---|---|---|
| RelevanceBreakdown | 5-分量 relevance (sector_map/revenue_exposure/adr_parity/supply_chain/historical_beta) | GET /api/v1/catalyst/:id/relevance-breakdown |
| AIRecommendation | AI-γ 14 output (explanation + trigger_signals + weights + evidence_refs) | AI-γ pipeline output |
| ScoreBreakdown | 6-dim Score (Q/G/V/M/T/R · band + evidence[]) | Score entity |
| RiskGateDetail | 12-trigger detail (code + severity + detail) | RiskGate.triggers[] |
| ConvictionBreakdown | base + adjustments[] + final + level | Conviction entity |
| DataSourceBadge | 数据源标识 (SEC EDGAR / Nasdaq / Yahoo) | us_catalyst_event.event_source_kind |

---

## §二 · Tab 2 美股优选 数据流全景

### §二.1 · 端到端 pipeline (美股优选池 → 打分 → 排序)

```
[Stage 1] Strategy γ · 6-dim 打分 (us_preferred profile)
  │  对全 US 上市股 6-dim Score 计算
  │  profile = us_preferred (Q0.20 G0.20 V0.15 M0.20 T0.15 R0.10)
  │  → Score.total → Rating A/B/C/D/F
  │
  ▼
[Stage 2] Strategy γ · Conviction + RiskGate + EntryPlan
  │  同 tab 1 stage 4/5/6 · 但无催化映射调整
  │  Conviction 基于 Score.total · 无 catalyst_kind delta (无催化事件驱动)
  │
  ▼
[Stage 3] Backend γ · API 服务
  │  GET /api/v1/us-select/:date (Orch v311 Ruling #2 canonical LOCK #13)
  │  GET /api/v1/us-select/:date/summary
  │
  ▼
[Stage 4] Frontend γ-1 · Tab 2 渲染
    rating_band 5-color 列 + SizeHint progress-bar
    + profile switcher (us_preferred / multibagger / custom)
    + DisclaimerFooter
```

### §二.2 · Tab 2 API response payload canonical shape

```json
{
  "as_of": "YYYY-MM-DD",
  "profile": "us_preferred",
  "disclaimer_version": "size_hint_advisory",
  "rows": [
    {
      "ticker": "NVDA",
      "name": "NVIDIA Corporation",
      "sector": "Semiconductors",
      "score": {
        "total": 88.2,
        "band": "A",
        "dims": [
          {"key": "quality", "value": 92, "band": "A"},
          {"key": "growth", "value": 85, "band": "A"},
          {"key": "valuation", "value": 65, "band": "C"},
          {"key": "moat", "value": 95, "band": "A"},
          {"key": "trend", "value": 80, "band": "B"},
          {"key": "risk", "value": 78, "band": "B"}
        ],
        "weights": {"quality": 0.20, "growth": 0.20, "valuation": 0.15, "moat": 0.20, "trend": 0.15, "risk": 0.10},
        "scoring_id": "UUIDv4",
        "snapshot_hash": "SHA-256-hex",
        "as_of_utc": "..."
      },
      "rating_band": "A",
      "conviction": {"base": 88.2, "final": 88.2, "level": "HIGH"},
      "risk_gate": {"status": "GREEN", "triggers": []},
      "entry_plan": {
        "size_hint": {"tier": "TIER_5", "pct": 5, "disclaimer_key": "size_hint_advisory"},
        "entry": {"low": 125, "high": 132, "currency": "USD"},
        "stop": {"value": 118, "currency": "USD"},
        "targets": [{"value": 150}, {"value": 170}, {"value": 200}],
        "time_horizon": "POSITION"
      }
    }
  ]
}
```

### §二.3 · Tab 2 与 Tab 1 关键差异

| 维度 | Tab 1 A股早报 | Tab 2 美股优选 |
|---|---|---|
| 驱动源 | 隔夜 US 催化事件 → A股候选映射 | 纯 6-dim fundamental + technical 打分 |
| 标的 | A股 (cn_ticker · sh/sz/bj) | US 股 (us_ticker) |
| 评分 profile | us_preferred (固定) | us_preferred (默认) · 可切 multibagger/custom |
| 催化映射 | 5-分量 relevance_score | 无 |
| Conviction delta | catalyst_kind default (+5/+7/+3) + evidence ±2 + RiskGate | 无催化事件 delta · 仅 evidence ±2 + RiskGate |
| RiskGate triggers | 9 US + 3 A股 (12 total) | 9 US only |
| EntryPlan currency | CNY | USD |
| FilterChip | conviction/sector/risk_gate/catalyst_kind/rating | rating/sector (catalyst_kind N/A) |
| DetailSidebar | 6-card (含 RelevanceBreakdown) | 5-card (无 RelevanceBreakdown · 含 profile 切换对比) |
| profile switcher | 无 (固定 us_preferred) | 有 (us_preferred / multibagger / custom) |

---

## §三 · yespsam 参考源 spec-only 对照 (zero code-copy)

### §三.1 · 参考源 Tab 1 设计思路 spec-only 摘要

参考源采用 **theme-based 信号聚合** 方案:
- 8 个主题 (AI/半导体/光模块 · EV/电池 · 创新药 · 消费/电商 · 大宗/能源/黄金 · 金融/科技 · 机器人/工业 · 航天/国防)
- 每主题 6~9 只 US ticker + 7~11 只 A股 candidate
- Theme Signal = clamp(50 + avg_pct × 9 + breadth × 10, 0, 100)
- 候选打分 5 因子: signal 34% + history 32% + momentum 12% + liquidity 8% + news 10% - risk penalty

**参考源 "historical edge" 核心概念**:
- 420 天回看 · merge_asof 配对 US session → A股交易日
- hit_rate: US 主题涨 ≥1% 且 A股次日也涨的比率
- correlation: A股日回报 vs US 主题回报 Pearson 相关系数
- beta: cov(A股, US 主题) / var(US 主题)

### §三.2 · 参考源 Tab 2 设计思路 spec-only 摘要

参考源采用 **静态基本面 + 动态技术面** 方案:
- 20 只 US 股固定池 (NVDA/MSFT/AVGO/AMZN/GOOGL/META/AAPL 等)
- 5 维静态分数 (quality/growth/valuation/moat/catalyst) · 分析师预设 · 非计算得出
- 2 维动态分数 (trend 10% + earnings_momentum 8%) · 来自日线行情
- 静态:动态 = 74%:18% (扣除 risk penalty 8%)

### §三.3 · 我方 vs 参考源 架构对照

| 维度 | 参考源 | 我方 catalyst-900 | 对照分析 |
|---|---|---|---|
| **映射方式** | theme-based (1 theme → N US → M A股) | event-based (1 catalyst_event → 5-分量 relevance → M A股) | 我方更精细 · 事件级粒度 vs 主题级粒度 |
| **信号源** | 日级 US 涨跌幅 · 仅价格数据 | SEC EDGAR 8-K/10-K + Nasdaq 财报 + FDA/DOJ/SEC 监管 + Yahoo 推荐 | 我方多源催化 · 参考源仅价格信号 |
| **打分框架** | 5 因子 (signal/history/momentum/liquidity/news) | 6-dim (Q/G/V/M/T/R) + Conviction + RiskGate | 我方更标准化 · 与机构研究 QGVMTR 框架对齐 |
| **催化分类** | 无分类 · 主题级聚合 | 9-enum catalyst_kind (含 unclassified) | 我方事件级分类 · 支持 kind_default delta 差异化 |
| **风控** | 3 级 Pass/Watch/Block · ~5 条件 | 3 级 GREEN/YELLOW/RED · 12-trigger canonical | 我方更全面 · A股 ST/涨停/停牌 特有 trigger |
| **评级** | Buy/Outperform/Neutral/Underperform/Avoid (76/68/58) | A/B/C/D/F (85/70/55/40) | 我方采用 Strategy γ SOLE canonical · 阈值更严 |
| **仓位建议** | 文本描述 (回踩/分批/止损) | SizeHint 5-tier (TIER_5/3/2/1/SKIP) + disclaimer | 我方结构化 · 可编程消费 |
| **历史验证** | hit_rate + correlation + beta (420d) | 无内建历史验证 (tab 5 BacktestEvidence 独立提供) | 参考源嵌入打分 · 我方分离至 tab 5 |
| **新闻评分** | 15 正面词 + 11 负面词 → 加减分 | 无内建新闻评分 (optionality_score 23-词表 仅 trend 维度 sub-factor) | 参考源新闻权重 10% · 我方不在 tab 1 打分中直接用 |
| **US 优选池** | 20 只固定 · 分析师预设分数 | 全 US 上市 ~8000 只 · 6-dim 动态计算 | 我方全量覆盖 · 非固定池 |
| **Tab 2 静态比** | 74% 静态 / 18% 动态 | 100% 动态 (6-dim 全计算) | 我方无预设分数 · 全部从数据计算 |
| **profile 切换** | 无 | us_preferred / multibagger / custom + JP/KR Sprint 3 | 我方支持多 profile |
| **可追溯性** | 无 | scoring_id + snapshot_hash (JCS SHA-256) | 我方可字节级回放 |
| **API 设计** | 单 endpoint GET /api/report | 4+ endpoint RESTful (morning-brief + catalyst + relevance-breakdown) | 我方分层加载 · 首屏列表 + 懒加载详情 |

### §三.4 · 参考源可借鉴设计思路 (spec-only · zero code-copy)

| # | 参考源思路 | 我方承接方式 | 消费方 |
|---|---|---|---|
| 1 | **theme 聚合信号** — 多 US ticker 汇聚为单一主题信号 | 我方 catalyst_kind 9-enum 已覆盖 · 可在 AI-γ pipeline FeatureAssembly 阶段实现 "同类催化聚合" | AI-γ |
| 2 | **historical edge (hit_rate/correlation/beta)** — 420d 回看验证 US→A股 映射有效性 | tab 5 BacktestEvidence 已独立承接 · Strategy γ 可在 relevance_score 计算中引入 historical_beta 分量 (已有 · 权重 0.05) | Strategy γ + Frontend γ-3 |
| 3 | **breadth 指标** — 主题内正向 ticker 占比 | 可作为 AI-γ trigger_signals 的一个信号维度 · 不改 scoring 契约 | AI-γ |
| 4 | **news positive/negative 词表匹配** — 简单高效的新闻情绪信号 | 我方已有 4 类 text_hit_kinds (OPTIONALITY/POSITIVE/NEGATIVE/EARLY_NEWS) 在 Research §S3 §六.1 LAND · trend 维度 sub-factor · multibagger profile T 维度 0.25 权重 | Strategy γ |
| 5 | **buy zone 上下文文本** — 根据 rating + 当前价格生成操作建议文本 | 我方 EntryPlan.invalidation 字段 (≤240 chars) 已覆盖 · AI-γ explanation 输出可扩展 | AI-γ + Frontend γ-1 |
| 6 | **KPI top bar** — total_catalysts / total_candidates / high_conviction / risk_blocked | 我方 API `/api/v1/morning-brief/:date/summary` 已定义 · Frontend γ-1 Sprint 2 workspace-draft 已含 4-slot KPI | Backend γ + Frontend γ-1 |
| 7 | **sparkline 20d K线** — 列表行内嵌入迷你走势图 | 我方 Frontend γ-2 shared primitive 已含 Sparkline20d (PR MERGED) · tab 2 可消费 | Frontend γ-1/γ-2 |
| 8 | **bull/base/bear 三情景** — 基于历史数据生成乐观/中性/悲观预估 | 可在 AI-γ Assembly 阶段输出 · 不改 contracts/recommendation.md 结构 (scenarios 属 explanation 文本) | AI-γ |

---

## §四 · API endpoint 契约对照

### §四.1 · Tab 1 endpoints (Sprint 2 P0 must-deliver)

| endpoint | method | 参考源对应 | 我方 canonical | 消费方 |
|---|---|---|---|---|
| `/api/v1/morning-brief/:date` | GET | `/api/report?date=` | Backend γ API v0.2 §4 | Frontend γ-1 tab 1 主列表 |
| `/api/v1/morning-brief/:date/summary` | GET | (无 · 参考源嵌入 report) | Backend γ API v0.2 §4 | Frontend γ-1 KPI top bar |
| `/api/v1/catalyst/:id/candidates` | GET | (无 · 参考源按 theme 分组) | Backend γ API v0.2 §4 | Frontend γ-1 催化详情展开 |
| `/api/v1/catalyst/:id/relevance-breakdown?symbol=` | GET | (无 · 参考源无 5-分量) | Backend γ API v0.2 §4 | Frontend γ-1 DetailSidebar RelevanceBreakdown card |

### §四.2 · Tab 2 endpoints (Sprint 2 P1 skeleton)

| endpoint | method | 参考源对应 | 我方 canonical | 消费方 |
|---|---|---|---|---|
| `/api/v1/us-select/:date` | GET | `/api/us-quality?top=20` | Orch v311 Ruling #2 canonical LOCK #13 | Frontend γ-1 tab 2 主列表 |
| `/api/v1/us-select/:date/summary` | GET | (无 · 参考源嵌入 report) | Orch v311 Ruling #2 canonical LOCK #13 | Frontend γ-1 KPI top bar |

### §四.3 · endpoint 实现约束 (Backend γ Sprint 2)

| 约束 | 值 | 来源 |
|---|---|---|
| 分页 | offset + limit (default 50 · max 200) | Backend γ API v0.2 |
| 排序 | `sort_by=score|conviction|rating` + `sort_dir=asc|desc` | Backend γ API v0.2 |
| 日期范围 | tab 1 `:date` = cn_trading_day_asia_shanghai | DP γ catalyst-mapping v0.2 §6 |
| Profile 切换 | tab 2 `?profile=us_preferred|multibagger|custom` | Strategy γ scoring v0.2 §2.3 |
| 懒加载 | score-breakdown 走独立 endpoint · 首屏不含 inputs | Backend γ API v0.2 §4 layered loading |
| Cache | morning-brief 每日缓存 (09:30 CN 后刷新) · us-stocks TTL 5 min | Backend γ 实现决 |

---

## §五 · 数据实体 cross-reference 矩阵

### §五.1 · Tab 1 核心实体 vs 参考源对照

| 我方实体 | 字段数 | 参考源对应概念 | 差异 |
|---|---|---|---|
| **us_catalyst_event** | 14 字段 | Theme.signal (avg_pct + score + breadth) | 我方事件级 · 参考源主题级 · 我方含 catalyst_kind 9-enum |
| **a_share_candidate_mapping** | 22+ 字段 | Theme.top[].candidate + factors + analyst | 我方扁平单表 · 参考源嵌套 JSON |
| **Score** | 6-dim + total + rating + scoring_id + snapshot_hash | 无直接对应 (参考源 5-factor 不含 scoring_id/hash) | 我方可追溯 · 参考源无 |
| **Conviction** | base + adjustments[] + final + level | analyst.conviction (单值 float) | 我方结构化 Adjustment[] · 参考源单值 |
| **RiskGate** | gate + triggers[] + ok_to_enter | analyst.risk_gate (Pass/Watch/Block) | 我方 12-trigger 细化 · 参考源 ~5 条件 |
| **EntryPlan** | entry_band + stop + targets[] + size_hint + time_horizon + invalidation | analyst.entry_plan (文本) + analyst.scenario | 我方结构化 · 参考源纯文本 |
| **CatalystKind** | 9-enum | 无 (参考源按 theme 分组不分类) | 我方事件级分类 |

### §五.2 · Tab 2 核心实体 vs 参考源对照

| 我方实体 | 字段数 | 参考源对应概念 | 差异 |
|---|---|---|---|
| **Score (us_preferred)** | 6-dim 全动态计算 | UsQualityCandidate (5 维静态 + 2 维动态) | 我方 100% 动态 · 参考源 74% 静态预设 |
| **Score.weights** | profile 可切 (us_preferred/multibagger/custom) | 固定权重 (Q24/G18/V14/M16/catalyst12/T10/EM8) | 我方灵活 · 参考源固定 |
| **rating_band** | A/B/C/D/F (85/70/55/40) | Buy/Outperform/Neutral/Underperform/Avoid (82/74/64) | 我方 Strategy SOLE canonical · 阈值更严格 |
| **SizeHint** | TIER_5/3/2/1/SKIP (结构化) | buy_zone (纯文本) | 我方可编程 · 参考源描述性 |

### §五.3 · 参考源 Tab 1 评级阈值 vs 我方 canonical 映射

| 参考源 Rating | 参考源阈值 | 我方 Rating | 我方阈值 (Strategy SOLE) | 映射关系 |
|---|---|---|---|---|
| Buy | score ≥ 76 AND conviction ≥ 70 AND gate Pass | A | total ≥ 85 | 参考源更宽松 · 我方 A 更严格 |
| Outperform | score ≥ 68 AND conviction ≥ 62 | B | total 70-84.9 | 近似对应 |
| Neutral | score ≥ 58 | C | total 55-69.9 | 近似对应 |
| Underperform | score < 58 | D | total 40-54.9 | 参考源无 D 级 · 直接跳 Underperform |
| Avoid | gate = Block | F | total < 40 | 参考源 Avoid = gate Block · 我方 F = score-based |

**关键差异**: 参考源 "Avoid" 由 RiskGate 驱动 (gate=Block → 无条件 Avoid) · 我方 Rating 纯粹由 Score.total 映射 · RiskGate 独立于 Rating (正交设计 per Strategy γ v0.2 §8)

---

## §六 · 下游消费方 feed clist

### §六.1 · Tab 1 消费方矩阵

| 消费方 | 消费的数据 | 消费方式 | Sprint 2 action |
|---|---|---|---|
| **Frontend γ-1** | morning-brief API response · FilterChip state · DetailSidebar 6-card sections | useAbortableRequest + 行 click → sidebar | tab 1 真数据 useQuery 接通 |
| **Backend γ** | us_catalyst_event + a_share_candidate_mapping 表 JOIN | SQL query → JSON serialize | `/api/v1/morning-brief/:date` 实现 |
| **DP γ** | SEC EDGAR + Nasdaq + RSS → us_catalyst_event upsert | 4 collector + pipeline runner | 采集器真代码 + daily EOD orchestrator |
| **Strategy γ** | 6-dim Score + Conviction + RiskGate + EntryPlan 计算 | scoring pipeline TypeScript modules | 14-module pipeline code 搬入 |
| **AI-γ** | Score + Conviction + RiskGate → 14 output | 7-stage pipeline | pipeline code 搬入 + rule engine |
| **QADocs γ** | 全量 tab 1 数据流 E2E 验证 | E2E test case + 27-checklist v0.3 | tab 1 E2E 测试用例 |

### §六.2 · Tab 2 消费方矩阵

| 消费方 | 消费的数据 | 消费方式 | Sprint 2 action |
|---|---|---|---|
| **Frontend γ-1** | us-stocks API response · rating_band 5-color · SizeHint progress-bar · profile switcher | useAbortableRequest + DisclaimerFooter | tab 2 骨架 + profile 切换 |
| **Backend γ** | Score + Conviction + RiskGate + EntryPlan (对 US 股) | SQL query → JSON serialize | `/api/v1/us-stocks/scored` 实现 |
| **Strategy γ** | 6-dim Score 计算 (us_preferred + multibagger profile) | scoring pipeline | profile 切换时重算 |
| **QADocs γ** | tab 2 数据一致性验证 | checklist v0.3 tab 2 维度 | rating_band 一致性 + profile 切换 verify |

### §六.3 · 跨 Tab 共享实体依赖图

```
                    Strategy γ scoring v0.2 (SOLE canonical)
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      Score          Conviction      RiskGate
     6-dim            Adj[]       12-trigger
   + Rating       + level HIGH     + gate
   + scoring_id     MED LOW       GREEN/YELLOW/RED
   + snapshot_hash                   │
          │              │           │
          └──────┬───────┘           │
                 ▼                   ▼
             EntryPlan ◄─── ok_to_enter = GREEN
            SizeHint 5-tier
            + disclaimer_key
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
  Tab 1        Tab 2       Tab 3/4
  A股早报     美股优选      JP/KR
 (+ catalyst  (+ profile   (Sprint 3)
  mapping)    switcher)
```

---

## §七 · Gap analysis + Sprint 2 action items

### §七.1 · 已覆盖 (Sprint 1 MERGED 完全覆盖)

| gap | 状态 | 覆盖文档 |
|---|---|---|
| 6-dim 打分框架 | ✅ MERGED | Strategy scoring v0.2 (D1 #197) |
| Conviction + RiskGate + EntryPlan | ✅ MERGED | Strategy scoring v0.2 §4-§6 |
| catalyst_kind 9-enum | ✅ MERGED | Strategy scoring v0.2 §4.2 |
| 5-分量 relevance_score | ✅ MERGED | Strategy scoring v0.2 §3.7 |
| DDL us_catalyst_event + a_share_candidate_mapping | ✅ MERGED | DP catalyst-mapping v0.2 (D2 #195) §6 |
| API endpoints tab 1/2 | ✅ MERGED | Backend API v0.2 (D4 #188) §4 |
| AI 推荐 pipeline | ✅ MERGED | AI recommendation v0.1 (D6 #190) |
| SizeHint 5-tier + disclaimer | ✅ MERGED | Strategy scoring v0.2 §6.3 |
| Rating 5-tier A/B/C/D/F | ✅ MERGED | Strategy scoring v0.2 §2.2 |

### §七.2 · Sprint 2 必须交付 (gap 或 实现缺失)

| # | gap | 负责方 | 优先级 | 说明 |
|---|---|---|---|---|
| G1 | US 催化事件真数据采集 pipeline | DP γ | P0 | 4 collector 真代码 (SEC 8-K + Nasdaq + FDA/DOJ/SEC RSS + Yahoo) |
| G2 | cn_trading_day_asia_shanghai 时区对齐逻辑 | DP γ | P0 | US close → 次日 CN open 对齐 · 需 TradingCalendar 支撑 |
| G3 | 6-dim scoring pipeline TypeScript 真代码 | Strategy γ | P0 | 14 module → `frontend/src/shared/scoring/` |
| G4 | `/api/v1/morning-brief/:date` endpoint 实现 | Backend γ | P0 | SQL JOIN + JSON serialize + 分页/排序/FilterChip |
| G5 | `/api/v1/us-stocks/scored` endpoint 实现 | Backend γ | P1 | profile 切换 + 分页 |
| G6 | tab 1 Frontend 真数据 useQuery 接通 | Frontend γ-1 | P0 | useAbortableRequest → API → 渲染 |
| G7 | tab 2 Frontend 骨架 + profile switcher | Frontend γ-1 | P1 | rating_band 5-color + SizeHint progress-bar + DisclaimerFooter |
| G8 | AI pipeline 真代码搬入 | AI-γ | P1 | 7-stage pipeline + 14 invariant + rule engine |
| G9 | E2E 测试用例 (tab 1 golden path) | QADocs γ | P1 (阻塞于 G1+G4+G6) | 真数据跑通后校准 |

### §七.3 · 参考源启发的可选增强 (Sprint 3 backlog)

| # | 增强 | 参考源启发 | 优先级 | 说明 |
|---|---|---|---|---|
| E1 | 同类催化聚合信号 | theme-based signal | P2 | AI-γ FeatureAssembly 阶段 · 多 catalyst 属同 sector 时聚合 signal |
| E2 | historical edge 引入 tab 1 打分 | hit_rate/correlation/beta | P2 | Strategy γ 可在 relevance_score historical_beta 分量 (0.05) 扩展 |
| E3 | bull/base/bear 三情景文本 | analyst.scenario | P2 | AI-γ Assembly 阶段 explanation 扩展 |
| E4 | 新闻情绪 positive/negative 词表 | news scoring 15+11 词 | P3 | 我方已有 4 类 text_hit_kinds · trend 维度 sub-factor · 可扩展 |

---

## §八 · 铁律 100% retain

- **zero code-copy** msg=ad6585cf · spec-only cite · 本文档所有参考源信息均为设计思路层面的 spec-only 描述 · 无任何代码复制
- **workspace-draft-only** msg=ed61c397 · zero PR CREATE 直至 Orch 批
- **Strategy γ SOLE canonical** · scoring v0.2 `contracts/scoring.md` 单点权威 · 本文档引用值全部以 Strategy canonical 为准
- **v303 10+1 canonical LOCK** 全效 · zero re-litigate
- **free-source** msg=4f6d2466 · 数据源限定 SEC EDGAR + EDINET + DART + Alpha Vantage + Baostock + Yahoo opt-in
- **凭证 zero literal** `sk_agent_<redacted>` shape
- **agents 不停**

---

## §九 · 迭代路径

- **v0.1 (本 draft)**: tab 1/2 数据流全景 + yespsam spec-only 对照 + API 契约 + 实体矩阵 + 消费方 feed clist + gap analysis
- **v0.2 (Sprint 2 mid · tab 1 真数据跑通后)**: gap G1-G6 验收 + 实际 API response shape 校准 + E2E 测试结果 fold-in
- **v0.3 (Sprint 3)**: tab 3/4 JP/KR 数据流扩展 + E1-E4 增强项评估

**Research §S3 · Sprint 2 tab 1/2 数据契约对照 workspace-draft v0.1 LAND · 9 § · yespsam spec-only 深化 (zero code-copy) + 9 gap 识别 + 4 可选增强 · agents 不停**
