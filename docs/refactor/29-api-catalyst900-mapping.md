# Backend γ · catalyst-900 API mapping (workspace-draft v0.2)

**Intended repo path on Sprint 1 末 PR CREATE**: `docs/refactor/29-api-catalyst900-mapping.md`

**Status**: workspace-draft-only per msg=ed61c397 · zero PR CREATE · pending Orch Sprint 1 末 batch approve (v304 §四 收敛窗口 +12h).

**Anchor**: main HEAD `9065eed112317b875b3c15d3e3833bc56167da41` (@ 2026-07-10T07:19:49Z).

**Owner directive**: Orch v300 msg=6dc1b5f3 · §八 row-7 Backend γ 24h deliverable · Orch v303 msg=f53c62a0 10 canonical LOCK · Orch v304 msg=a3a50919 Sprint 1 gate 收敛.

**v0.1 → v0.2 delta 消化 (15 项 · v303 §六 六契约同批窗口锁定)**:
1. Conviction shape Option A `adjustments: Adjustment[]` (length ∈[0,5] · Σ delta ∈[-20,+20])
2. Conviction 阈值 canonical **75/50** (HIGH≥75 · MED 50-74.9 · LOW<50) · Strategy γ SOLE canonical · Research §S3 70/55 demoted
3. RiskGate 12-trigger canonical `{code, severity, detail}` (9 US + 3 A股: ST_TAG / PRICE_LIMIT_APPROACH / SUSPENDED)
4. EntryPlan enrichment (currency + time_horizon 5-枚举 + invalidation + conviction_ref)
5. EntryPlan.sizeHint 5-级 + bridge_reason (HIGH→5% · MED→3% · LOW→2% · YELLOW→1% · RED→SKIP · disclaimer_key="size_hint_advisory")
6. Score.inputs audit-only + `?include=inputs` 分层 + `rating: 'A'|'B'|'C'|'D'|'F'` 独立字段 (A≥85 · B 70-84.9 · C 55-69.9 · D 40-54.9 · F<40 · 独立于 conviction_level) + scoring_id + snapshot_hash SHA-256(JCS RFC 8785) 消费
7. 端点命名 reconciliation `/api/v1/morning-brief/:date` + `/api/v1/jpkr-market/:date` + `/api/v1/catalyst/:id/*`
8. tab 6 REST 轮询 canonical · §4.7.2.6 SSE backoff L3.6 永久归档 (v304 §一-6 Cleanup 硬 DISCARD 确认)
9. `GET /api/v1/multibagger-pool/:date?limit=N&universe=us|cn` (DP γ-2 P2)
10. `GET /api/v1/backtest-pit/:strategy/:as_of` (DP γ-2 P2) · source_versions JSONB · 3-variant 单命名空间 (:as_of · :strategy?from=&to=&limit=N · :strategy/:as_of/holdings)
11. CatalystEvent 补 `snapshot_id` · `type` 9-枚举 (8 canonical + `unclassified` backfill · Strategy §3.7.2 分类器 GA 后归零)
12. tab 5 payload shape canonical (snapshot_id/is_survivorship_biased/is_delisted_at_as_of/source_versions/metrics/holdings)
13. tab 6 endpoint 单一入口 canonical `/api/v1/daily-report/{generate|status|:date}` · entries[i]=Recommendation byte-align · disclaimer_version · [E<n>] evidence hover · Backend γ aggregator · AI-γ `/api/v1/ai/recommendations/*` retained zero Frontend consumer
14. AI-γ POST `/api/v1/ai/recommendations/replay` job_id canonical byte-identical with tab 6 REST 轮询 (UUIDv4 · backoff 1s→2s→5s cap 10s · timeout 60s → status=error + retry-after)
15. `/api/v1/*` mount canonical (v0.1 `/api/*` demoted · Phase 1 唯一挂载前缀)

**Reference (spec-only zero code-copy per msg=ad6585cf)**:
- Live: https://catalyst-900-qohfq.netlify.app/
- Source: https://github.com/yespsam/a-share-us-catalyst (reference-only)
- Owner 铁律 msg=53b96525 catalyst-900 · msg=764688c1 anchors · msg=aa4a755c 3 core blocks

---

## §一 · Backend API 现状盘点

Base mount prefix: `/api/*` (Express router-per-domain). 29 route files under `backend/src/api/routes/`. Middleware stack (canonical, `app.use` order): version → deprecation → rate-limit → retry-after → server-timing → CORS/timing-allow-origin → trace-context → web-linking → reporting-endpoints → alt-svc.

### 已挂载 route groups (from `backend/src/app.ts`)

| # | mount | routes file | controller | 主要能力概述 |
|---|---|---|---|---|
| 1 | `/api/auth` | auth.routes.ts | AuthController | 登录、注册、token刷新、登出、profile、修改密码 |
| 2 | `/api/stocks` | stock.routes.ts | StockController | 股票基础信息、行情、K线、扩展维度 (原 A 股域) |
| 3 | `/api/backtests` | backtest.routes.ts | BacktestController | 回测任务 CRUD、明细、结果、成本敏感度 |
| 4 | `/api/strategies` | strategy.routes.ts | StrategyController | 策略 CRUD、启停、参数、执行 |
| 5 | `/api/portfolio` | portfolio.routes.ts | PortfolioController | 组合、持仓、下单、风险守卫 (paper trading 桥) |
| 6 | `/api/market` | market.routes.ts | MarketController | 指数、大盘概览、search、favorites、数据源健康、数据完整性 |
| 7 | `/api/ai` | ai.routes.ts | AIAdvisorController | AI 分析、single-stock analysis、SSE stream、报告 |
| 8 | `/api/tasks` | task.routes.ts | TaskController | 后台任务队列 |
| 9 | `/api/paper-trading` | paperTrading.routes.ts | PaperTradingController | 模拟交易组合、订单、成交 |
| 10 | `/api/risk-alerts` | riskAlert.routes.ts | RiskAlertController | 风险告警列表、状态流转 |
| 11 | `/api/risk` | risk.routes.ts | RiskController | 风险指标、drawdown、position limit |
| 12 | `/api/black-swan` | blackSwan.routes.ts | BlackSwanEventController | 黑天鹅事件列表 |
| 13 | `/api/journals` | journal.routes.ts | JournalController | 复盘日记 CRUD、备注 |
| 14 | `/api/users` | user.routes.ts | UserController | 用户管理 (admin) |
| 15 | `/api/logs` | log.routes.ts | LogController | 日志查询、统计 (admin) |
| 16 | `/api/internal` | internal.routes.ts | InternalDataController | 内部数据 API (TradingAgents 预留) |
| 17 | `/api/quant` | quant.routes.ts | QuantController | 量化研究、strategies、research experiments、backtest audit |
| 18 | `/api/today` | today.routes.ts | TodayController | 「今日」榜单聚合 |
| 19 | `/api/review` | review.routes.ts | ReviewController | 复盘辅助 |
| 20 | `/api/live-trading/bridge`, `/api/live-trading` | bridge/liveTrading | (bridge module) | 实盘桥接 |
| 21 | `/api/factors` | factor.routes.ts | FactorController | 因子库、IC、correlation |
| 22 | `/api/announcements` | announcement.routes.ts | AnnouncementController | 公告 |
| 23 | `/api/settings` | settings.routes.ts | SettingsController | 用户/系统设置 |
| 24 | `/api/data` | data.routes.ts | DataController | 数据健康、龙虎榜、ETF flow、市场新闻、sync 触发 |
| 25 | `/api/macro` | macro.routes.ts | MacroController | 宏观指标、QVIX、regime snapshot |
| 26 | `/api/me/improvement-suggestions` | improvementSuggestion.routes.ts | ImprovementSuggestionController | 改进建议 |
| 27 | `/api/docs` | docs.routes.ts | DocsController | 文档树、评论 (admin) |
| 28 | `/api/me/feedbacks` | userFeedback.routes.ts | UserFeedbackController | 用户反馈 |
| 29 | `/api/explain-card` | explainCard.routes.ts | (inline) | 解释卡片 (per stock_code) |

**观察**：现有 API 结构以 stock/backtest/portfolio/quant 为核心，AI 分析 + market 数据 + paper trading 完整。缺失面：**catalyst mapping (美股隔夜→A股同日) + 6-维打分 + Conviction/RiskGate/Entry Plan + 日韩市场数据 + 每日日报生成**。

---

## §二 · 7-tab 数据需求逐 tab 拆解

per Orch v300 §一 IA. 每 tab 需求以「表格列」+「详情侧栏字段」+「KPI 顶栏字段」分层拆解。

### tab 1 · A 股早报（核心 · 美股隔夜催化→A 股同日候选）

**核心工作流**: 美股隔夜 (盘后+盘前) → 事件抽取 (财报/降息/监管/供应链/裁员/并购) → A 股同日交易时段候选映射 (同产业链/同题材/同供应链) → 打分排序 → Entry Plan 出条件。

**表格列**:
- 时间 (美东)
- 美股催化标的 (symbol + name)
- 催化类型 (chip: earnings/policy/M&A/supply-chain/lawsuit/downgrade)
- 催化摘要 (≤ 60 字)
- A 股同日候选 (≤ 3 · symbol + name)
- 关联度分 (0-100)
- Conviction (High/Medium/Low chip)
- RiskGate (Pass/Watch/Block chip)
- Entry Plan (触发价 + 止损 + 目标 · condensed)
- Score (0-100)

**详情侧栏字段**:
- 催化全文 + source URL + 时间戳
- 关联度拆解 (行业/供应链/题材/资金/技术 5-维)
- 每个 A 股候选：Score 拆解 6 维 + Conviction rationale + RiskGate 触发条件 + Entry Plan 完整 (触发/止损/目标 + 仓位/时限) + 历史类似催化样本
- 免责声明

**顶栏 KPI**:
- 今日候选总数
- 昨夜美股催化数
- 平均关联度
- Conviction 分布 (High/Medium/Low 计数)

**后端数据源**: 美股新闻/公告 (Yahoo Finance) + A 股公司同业/产业链关系 (需 DP 提供 catalyst-mapping.md v0.1 契约) + 6-维打分 (需 Strategy 提供 scoring.md v0.1)。

### tab 2 · 美股优选（6-维打分）

**核心**: 美股全市场按 6 维打分 (质量/成长/估值/护城河/趋势/风险) 排序，输出高分标的清单。

**表格列**: symbol · name · sector · 6-维分 (质量/成长/估值/护城河/趋势/风险 各 0-100) · 综合 Score · Conviction · RiskGate · 最近更新

**详情侧栏**: 每维分数背后的因子 (如：质量 = ROE/ROIC/gross margin trend；成长 = revenue CAGR/EPS growth；估值 = PE/PEG/EV/EBITDA 分位；护城河 = network effect/switching cost/brand/scale/patent；趋势 = 200-day MA + RSI + MACD；风险 = beta/max drawdown/debt/AR)

**顶栏 KPI**: 覆盖标的数 · 平均综合分 · Top 10 平均分 · 上周变化

### tab 3 · 日韩市场

**核心**: 东证 (日本) + KOSPI (韩国) 双市场并列。表格结构对齐 tab 2 但可能省略部分维度 (取决于 DP 数据源覆盖)。

**依赖**: DP γ 24h 日韩数据源方案 (Yahoo Finance JP/KR 免费源 + Investpy + Stooq)。

### tab 4 · 高倍潜力（早期多倍候选）

**核心**: 小市值 + 高研发 + 行业早期 + 未被机构充分挖掘的候选。

**表格列**: symbol · name · market cap · 行业阶段 (chip: emerging/growth/mature) · 关键催化预期 · 多倍潜力评分 · Conviction · Entry Plan · RiskGate

**详情侧栏**: 高倍逻辑拆解 (总量空间/份额/单价/时点) + 关键风险 + 历史类似路径 + 检验里程碑

### tab 5 · 回测证据（6-month PIT）

**核心**: 展示上述所有推荐的 6 个月 PIT (point-in-time) 回测证据，防止 look-ahead bias。

**表格列**: 推荐日期 · 推荐标的 · 推荐 Score · 6 个月 return · 最大回撤 · 是否触发 Entry Plan · 命中率

**依赖**: 复用 `/api/backtests` + `/api/quant/research-experiments` + `/api/factors/ic` 已有能力，新增「按推荐日+推荐标的分组」的聚合查询。

### tab 6 · 每日日报

**核心**: 生成当日综合分析报告 (Markdown + 结构化字段)。字段：市场概览、tab 1-5 top picks 摘要、风险提示、次日观察点。

**表格列**: 日期 · 报告标题 · 关键 picks 数 · Conviction 分布 · 触发 Entry 计数 · 生成时间

**详情侧栏**: 完整 Markdown 报告 + 结构化字段 (JSON) + 下载 (PDF/MD 选)

### tab 7 · 报告历史

**核心**: 日报归档 + 搜索 + 复盘。

**表格列**: 日期 · 标题 · Conviction 平均 · 触发 Entry 数 · 命中率 (T+30/T+60/T+90) · 归档状态

---

## §三 · 端点 → tab 映射矩阵

per tab 「复用/需扩展/需新建」三分。

**v0.2 canonical mount 前缀**: 全部 `/api/v1/*` (Phase 1 单一挂载 · v0.1 `/api/*` 已废) · 服务侧 Backend γ SOLE `backend/**` lane.

### tab 1 · A 股早报

| 需求 | 现有端点 | 处置 |
|---|---|---|
| 美股催化事件列表 | (缺) | **新建** `GET /api/v1/morning-brief/:date` (Frontend γ-1 v0.2 canonical · date=YYYY-MM-DD) — 依赖 DP catalyst-mapping.md |
| A 股同日候选 | (缺) | **新建** `GET /api/v1/catalyst/:id/candidates` — 依赖 DP mapping + Strategy scoring |
| 关联度拆解 | (缺) | **新建** `GET /api/v1/catalyst/:id/relevance-breakdown?symbol=YYYYYY` (5-分量 · 上游 catalyst-900 §五 canonical) |
| 6-维打分 (每候选) | `/api/quant/research-experiments` (部分) | **需扩展** — 增加 `Score`/`Conviction`/`RiskGate`/`EntryPlan` 字段 (v0.2 shape · `Score.scoring_id` + `Score.snapshot_hash` + `Score.band`) |
| Entry Plan | `/api/portfolio/preflight` (部分) | **需扩展** — 抽独立字段 · `size_hint: {tier, pct ∈ [0,5], disclaimer_key: 'size_hint_advisory'}` v0.2 结构化 |
| 顶栏 KPI 汇总 | (缺) | **新建** `GET /api/v1/morning-brief/:date/summary` |
| 免责声明 | (可复用 settings) | 复用 + `disclaimer_version` list-level + Owner 免责铁律 msg=53b96525 措辞审计黑/白名单 |

### tab 2 · 美股优选

| 需求 | 现有端点 | 处置 |
|---|---|---|
| 美股全市场列表 + 6-维分 | (缺 · A 股为主) | **新建** `GET /api/v1/us-stocks/scored?limit=N&profile=us_preferred` — list envelope 补 `rating_band` 只读镜像 (= `entry.score.band`) |
| 每维因子拆解 | `/api/factors` + `/api/factors/ic` | **需扩展** — 增加 US universe + 6-维 (Q/G/V/M/T/R) `Score.dims[i].band` 独立徽章 |
| 综合分 + Conviction/RiskGate | (缺) | **新建** `GET /api/v1/us-stocks/:symbol/score-breakdown?include=inputs` (audit-only inputs 分层) |

### tab 3 · 日韩市场

| 需求 | 现有端点 | 处置 |
|---|---|---|
| 日韩标的列表 + 6-维分 | (完全缺) | **新建** `GET /api/v1/jpkr-market/:date?market=JP|KR&profile=japan_blue_chip|korea_semiconductor_chain` — 依赖 DP γ-2 §5.2 profile canonical |
| 每标的详情 | (缺) | **新建** `GET /api/v1/jpkr-market/:symbol/detail` |

### tab 4 · 高倍潜力

| 需求 | 现有端点 | 处置 |
|---|---|---|
| 高倍候选池 | `/api/screener` (部分能力) | **新建** `GET /api/v1/multibagger-pool/:date?limit=N&universe=us|cn` (DP γ-2 §9.2 canonical · fixed profile `multibagger`) |
| 多倍潜力评分 | (缺) | **新建** `GET /api/v1/multibagger-pool/:symbol/score` — 依赖 Strategy `multibagger` profile |
| 逻辑拆解 + 里程碑 | (缺) | **新建** `GET /api/v1/multibagger-pool/:symbol/thesis` |

### tab 5 · 回测证据 (单命名空间 canonical · Frontend γ-3 msg=a382e343 三方 lock)

| 需求 | 端点 | 处置 |
|---|---|---|
| PIT snapshot 单点 | **新建** `GET /api/v1/backtest-pit/:strategy/:as_of` | canonical · `strategy` = profile slug (japan_blue_chip / korea_semiconductor_chain / us_preferred / multibagger) · `:as_of` = ISO-8601 |
| 时间轴范围 | **新建** `GET /api/v1/backtest-pit/:strategy?from=&to=&limit=N` | 6-month PIT 时间轴 · 支撑 NetValueChart |
| 侧栏明细 (holdings) | **新建** `GET /api/v1/backtest-pit/:strategy/:as_of/holdings` | top-level 4-字段 `{ticker, weight, return_since_entry, is_stale}` byte-align DP γ-2 §四 JSONB payload |
| attribution / evidence 深链 (Sprint 2 起若需) | **新建 (备位)** `GET /api/v1/backtest-pit/:strategy/:as_of/holdings/:ticker/attribution` | Sprint 2 需求实证后开工 · Backend γ SOLE 权威 · DetailSidebar sections slot 二次调 |
| 命中率统计 (list-level) | `/api/factors/ic` | **需扩展** — 按 profile+as_of 聚合 |

**payload shape canonical (三方 lock verify · Backend γ msg=07b34ce5 + Frontend γ-3 msg=a382e343 + DP γ-2 msg=9c3a349d)**: top-level `{snapshot_id, strategy, as_of_utc, is_survivorship_biased, is_delisted_at_as_of, source_versions}` + `metrics: {net_value, drawdown, cumulative_return, sharpe_ratio_6m, win_rate_6m}` + `holdings: [{ticker, weight, return_since_entry, is_stale}]`

### tab 6 · 每日日报 (单一入口 canonical · Backend γ aggregator · AI-γ 反签 msg=095dda3a PASS)

| 需求 | 端点 | 处置 |
|---|---|---|
| 生成日报 (async) | **新建** `POST /api/v1/daily-report/generate` | 返回 `{job_id: UUIDv4}` (v303 LOCK #7 REST 轮询 canonical · SSE §4.7.2.6 永久归档) |
| 生成状态轮询 | **新建** `GET /api/v1/daily-report/status?job_id=X` | client backoff 1s→2s→5s cap 10s · timeout 60s → status=error + retry-after |
| 结构化 + Markdown 双输出 | **新建** `GET /api/v1/daily-report/:date` | `entries[i]` = AI-γ `Recommendation` byte-align 直穿 · envelope 加 `date` + `report_id` + `disclaimer_version` UI meta · `[E<n>]` evidence hover |
| status enum 分层 | (Backend γ SOLE aggregator) | UI 侧 `queued\|generating\|complete\|error` (Backend γ 映射) ↔ AI-γ pipeline 侧 `queued\|running\|complete\|error` (AI-γ SOLE canonical) |
| AI-γ 独立 5-endpoint 家族 (retained · zero Frontend γ-3 tab 6 consumer) | AI-γ SOLE `/api/v1/ai/recommendations/{latest, :snapshot_id, by-date/:trading_day, POST /replay + /status?job_id, :snapshot_id/diff/:other_snapshot_id}` | AI-γ lane · Backend γ zero shape 侵入 · POST /replay job_id UUIDv4 canonical byte-identical with tab 6 REST 轮询 |

### tab 7 · 报告历史

| 需求 | 端点 | 处置 |
|---|---|---|
| 日报列表 | (缺 · journals 相邻但语义不同) | **新建** `GET /api/v1/daily-report/history?limit=N` (list envelope 补 `rating_band` mirror + `disclaimer_version`) |
| 单日报详情 | (缺) | **复用** `GET /api/v1/daily-report/:date` (与 tab 6 共享) |
| T+30/60/90 命中率 | `/api/factors/ic` (部分) | **需扩展** — 增加 daily-report 归档命中率聚合 |
| 搜索/过滤 | (缺) | **新建** `GET /api/v1/daily-report/search?q=X&from=&to=` |

---

## §四 · 契约字段 v0.2 canonical (v303 10 LOCK · types.ts SoT γ-2 SOLE · Strategy γ SOLE 权威)

v0.1 三方 draft shape 已升 v0.2 canonical · byte-align Frontend γ-2 msg=ac424277 types.ts 7 项 shape · AI-γ msg=095dda3a `contracts/recommendation.md` v0.2 · Strategy γ `contracts/scoring.md` v0.2.

### `Score` (v0.2 · scoring_id + snapshot_hash + band 独立 rating)
```jsonc
{
  "value": 82,                        // 0-100 综合分
  "band": "B",                        // 5-tier Rating · A≥85 · B 70-84.9 · C 55-69.9 · D 40-54.9 · F<40 · Strategy §2.2 canonical · 独立于 conviction.level
  "dims": [
    { "key": "quality",   "value": 88, "band": "A" },
    { "key": "growth",    "value": 76, "band": "B" },
    { "key": "valuation", "value": 65, "band": "C" },
    { "key": "moat",      "value": 92, "band": "A" },
    { "key": "trend",     "value": 80, "band": "B" },
    { "key": "risk",      "value": 78, "band": "B" }
  ],
  "weights": {                        // Strategy 契约 SOLE 定 · profile 可切换 tab 2
    "quality": 0.20, "growth": 0.20, "valuation": 0.15,
    "moat": 0.15, "trend": 0.15, "risk": 0.15
  },
  "inputs": null,                     // audit-only · 仅 ?include=inputs 时返回 · 默认 null (分层加载)
  "scoring_id": "UUIDv4",             // Strategy γ 生成
  "snapshot_hash": "SHA-256-hex",     // SHA-256(JCS(Score minus scoring_id + snapshot_hash)) · US-038 deterministic
  "as_of_utc": "2026-07-10T15:30:00Z"
}
```

### `Conviction` (v0.2 · Option A adjustments · 阈值 75/50 canonical)
```jsonc
{
  "level": "HIGH",                    // enum: "HIGH" | "MED" | "LOW" · 阈值 HIGH≥75 · MED 50-74.9 · LOW<50 (Strategy §4 SOLE 权威)
  "base_score": 82,                   // Score.value 起始
  "adjustments": [                    // Option A · length ∈ [0, 5] · Σ delta ∈ [-20, +20] · evaluation-order-free
    { "code": "catalyst_kind:earnings",  "delta": 5,  "reason": "Q3 revenue beat +6% · guidance raised" },
    { "code": "risk_gate:yellow",        "delta": -5, "reason": "20d rolling drawdown -18%" }
  ],
  "final_score": 82,                  // = base_score + Σ adjustments[*].delta
  "as_of_utc": "2026-07-10T15:30:00Z"
}
```

### `RiskGate` (v0.2 · 12-trigger canonical · severity 分档)
```jsonc
{
  "status": "YELLOW",                 // enum: "GREEN" | "YELLOW" | "RED" · dual-gate 硬门 = GREEN
  "triggers": [                       // 12-code canonical (9 US + 3 A股)
    { "code": "DRAWDOWN_20D",          "severity": "warn",  "detail": "20d rolling drawdown -18%" },
    { "code": "BETA_HIGH",             "severity": "warn",  "detail": "1yr beta 1.85 (>1.5 threshold)" }
    // ST_TAG · PRICE_LIMIT_APPROACH · SUSPENDED · 等 · full 12 见 Strategy §5
  ],
  "checked_at_utc": "2026-07-10T15:30:00Z"
}
```

### `EntryPlan` (v0.2 · size_hint 结构化 + currency + time_horizon + invalidation + conviction_ref)
```jsonc
{
  "currency": "CNY",                                              // ISO 4217 · v0.2 新增
  "trigger":    { "type": "price", "condition": ">=", "value": 42.50, "note": "突破前高" },
  "stop_loss":  { "type": "price", "value": 38.00, "note": "-10.6% 硬止损" },
  "targets": [
    { "value": 48.00, "weight": 0.5, "note": "T1 · +12.9% · 减半仓" },
    { "value": 55.00, "weight": 0.5, "note": "T2 · +29.4% · 清仓" }
  ],
  "size_hint": {                                                  // v0.2 结构化 (v0.1 union 废)
    "tier": "TIER_3",                                             // enum: TIER_5 (5%) · TIER_3 (3%) · TIER_2 (2%) · TIER_1 (1%) · SKIP (0%)
    "pct": 3.0,                                                   // ∈ [0, 5] · UI progress-bar 直取 (Orch v303 LOCK #9)
    "disclaimer_key": "size_hint_advisory",                       // 硬锁 · 指向 Disclaimer §7 · Owner 免责铁律 msg=53b96525
    "bridge_reason": "MED conviction 50-74.9 → TIER_3"            // MED→3% mapping 桥
  },
  "time_horizon": "MID_TERM",                                     // enum: INTRADAY · SHORT_TERM (1-5d) · MID_TERM (1-4w) · LONG_TERM (1-6m) · MULTI_YEAR
  "invalidation": {                                               // v0.2 新增 · Conviction 无效条件
    "type": "price_below", "value": 38.00, "note": "跌破止损即失效"
  },
  "conviction_ref": "conviction-uuid",                            // 引用同 payload 内 Conviction · Sprint 2 起实施
  "created_at_utc": "2026-07-10T15:30:00Z"
}
```

### `CatalystEvent` (v0.2 · 9-枚举含 unclassified · snapshot_id)
```jsonc
{
  "id": "catalyst-uuid",
  "snapshot_id": "snapshot-uuid",                                 // v0.2 新增 · 关联 Recommendation snapshot
  "occurred_at_et": "2026-07-10T22:00:00-04:00",                  // 美东时间
  "market": "US",                                                 // enum: "US" | "US-premarket" | "US-afterhours"
  "symbol": "NVDA",
  "name": "NVIDIA Corp",
  "kind": "earnings",                                             // 9-枚举 (Strategy §3.7.2 · AI-γ §2.10): earnings | upgrade_downgrade | product | regulator | geo_macro | ma_activity | sector_move | leadership | unclassified (backfill 补位 · GA 后归零 · UI 灰色徽章 · AI-γ pipeline `kind='unclassified'` 拒生成推荐)
  "summary": "Q3 revenue $35.1B beat consensus by 6%; forward guidance raised.",
  "source_url": "https://...",
  "related_a_shares": [
    {
      "symbol": "002049",
      "name": "紫光国微",
      "relevance": {                                              // 上游 catalyst-900 §五 5-分量 canonical
        "overall": 78,
        "industry": 85,
        "supply_chain": 72,
        "theme": 88,
        "capital_flow": 65,
        "technical": 80
      }
    }
  ]
}
```

### `BacktestPitSnapshot` (v0.2 · tab 5 三方 lock canonical)
```jsonc
{
  "snapshot_id": "uuid",
  "strategy": "us_preferred",                                     // profile slug: japan_blue_chip · korea_semiconductor_chain · us_preferred · multibagger
  "as_of_utc": "2026-07-10T21:00:00Z",
  "is_survivorship_biased": false,                                // 防幸存者偏差 SLA (DP γ-2 §四)
  "is_delisted_at_as_of": false,                                  // 侧栏 stale tag 消费
  "source_versions": {                                            // JSONB
    "us_price": "yahoo-2026-07-10",
    "fundamentals": "av-2026-Q2"
  },
  "metrics": {                                                    // 拍平 子对象
    "net_value": 1.24,
    "drawdown": -0.08,
    "cumulative_return": 0.24,
    "sharpe_ratio_6m": 1.85,
    "win_rate_6m": 0.58
  },
  "holdings": [
    { "ticker": "NVDA", "weight": 0.05, "return_since_entry": 0.12, "is_stale": false }
  ]
}
```

### `DailyReport` (v0.2 · tab 6 单一入口 canonical · AI-γ Recommendation 直穿)
```jsonc
{
  "date": "2026-07-10",
  "report_id": "uuid",
  "disclaimer_version": "v0.2.0",                                 // list-level · Owner 免责铁律措辞审计 hook
  "entries": [                                                    // = AI-γ Recommendation[] byte-align 直穿 (zero envelope 侵入 · zero-loss)
    {
      "snapshot_id": "uuid",
      "output_fingerprint": "SHA-256",
      "conviction": { /* ... */ },
      "risk_gate": { /* ... */ },
      "entry_plan": { /* ... */ },
      "evidence_refs": [ { "id": "E1", "short_text": "...", "url": "..." } ],
      "explanation": { "template_id": "...", "tokens": [ /* [E<n>] placeholders */ ] }
    }
  ]
}
```

---

## §五 · Sprint 2 起 API 实施优先级 (v0.2 canonical · v1-prefix)

per Orch v300 §四 · Sprint 2 = 第 2 周 · A 股早报 tab 端到端跑通 (最重) + 美股优选 tab 骨架 + 6-维打分接通.

### P0 · Sprint 2 必交付 (支撑 tab 1 端到端)

1. **`GET /api/v1/morning-brief/:date`** — 美股隔夜催化事件列表 (`date`=YYYY-MM-DD)
2. **`GET /api/v1/catalyst/:id/candidates`** — 单事件对应 A 股候选清单 (返回 `CatalystEvent` + `related_a_shares[]` · 9-枚举 kind 含 unclassified backfill)
3. **`GET /api/v1/morning-brief/:date/summary`** — 顶栏 KPI 汇总
4. **`GET /api/v1/catalyst/:id/relevance-breakdown?symbol=YYYYYY`** — 关联度 5-分量拆解 (上游 catalyst-900 §五 canonical)
5. **扩展** `/api/v1/quant/research-experiments` → 返回中增加 `Score` (含 `scoring_id` + `snapshot_hash` + `band` + `dims[i].band`) / `Conviction` (Option A `adjustments`) / `RiskGate` (12-trigger) / `EntryPlan` (`size_hint` 结构化 + `time_horizon` + `invalidation` + `conviction_ref`) 字段 (v0.2 §四 shape)

### P1 · Sprint 2 骨架 (支撑 tab 2)

6. **`GET /api/v1/us-stocks/scored?limit=N&profile=us_preferred&sort_by=score`** — 美股优选 6-维分列表 (list envelope 补 `rating_band` 只读镜像 + `disclaimer_version`)
7. **`GET /api/v1/us-stocks/:symbol/score-breakdown?include=inputs`** — 单标的 6-维拆解 (`inputs` 分层加载 audit-only)

### P2 · Sprint 3 (tab 3+4+5)

8. `GET /api/v1/jpkr-market/:date?market=JP|KR&profile=japan_blue_chip|korea_semiconductor_chain&limit=N`
9. `GET /api/v1/jpkr-market/:symbol/detail`
10. `GET /api/v1/multibagger-pool/:date?limit=N&universe=us|cn` (DP γ-2 §9.2 canonical)
11. `GET /api/v1/multibagger-pool/:symbol/thesis`
12. `GET /api/v1/backtest-pit/:strategy/:as_of` (三方 lock canonical · Frontend γ-3 msg=a382e343 · DP γ-2 msg=9c3a349d)
13. `GET /api/v1/backtest-pit/:strategy?from=&to=&limit=N` (时间轴范围 · NetValueChart)
14. `GET /api/v1/backtest-pit/:strategy/:as_of/holdings` (top-level 4-字段 byte-align)

### P3 · Sprint 4 (tab 6+7)

15. `POST /api/v1/daily-report/generate` → `{job_id: UUIDv4}` (REST 轮询 canonical · SSE §4.7.2.6 永久归档)
16. `GET /api/v1/daily-report/status?job_id=X` (client backoff 1s→2s→5s cap 10s · timeout 60s → status=error + retry-after)
17. `GET /api/v1/daily-report/:date` (`entries[i]` = AI-γ `Recommendation` byte-align 直穿 · `disclaimer_version` + `[E<n>]` evidence hover)
18. `GET /api/v1/daily-report/history?limit=N` (list envelope + `rating_band` mirror)
19. `GET /api/v1/daily-report/search?q=X&from=&to=`

### AI-γ SOLE (lane 契約 msg=a5297512 · Backend γ zero-touch · zero Frontend γ-3 tab 6 consumer)

- `GET /api/v1/ai/recommendations/latest`
- `GET /api/v1/ai/recommendations/:snapshot_id`
- `GET /api/v1/ai/recommendations/by-date/:trading_day`
- `POST /api/v1/ai/recommendations/replay` → `{job_id: UUIDv4}` byte-identical with tab 6 REST 轮询 canonical
- `GET /api/v1/ai/recommendations/status?job_id=X`
- `GET /api/v1/ai/recommendations/:snapshot_id/diff/:other_snapshot_id`

### 复用铁律

- 中间件栈全部保留 (version/deprecation/rate-limit/retry-after/server-timing/CORS/trace/web-linking/reporting/alt-svc) · 新端点 free-of-charge 继承
- Auth: 新端点全部走 `authController.authenticate`
- 错误 shape 保持一致 (未来若需 RFC 7807 Problem-Details 再补 · Sprint 2 后作为 potential 优化项 · 非 MVP 阻塞)
- **`/api/v1/*` mount canonical (v0.1 `/api/*` demoted · Phase 1 唯一挂载前缀)**
- **tab 6 REST 轮询 canonical · §4.7.2.6 SSE backoff L3.6 永久归档 (Orch v303 LOCK #7 + Cleanup γ msg=8675050e 硬 DISCARD)**
- **status enum 分层**: UI 层 `queued|generating|complete|error` (Backend γ SOLE aggregator 映射) ↔ AI-γ pipeline 层 `queued|running|complete|error` (AI-γ SOLE canonical)
- **job_id UUIDv4 canonical byte-identical**: tab 6 generate job vs AI-γ replay job · 两 job kind · 命名空间独立 · shape 同 (Backend γ 侧 job_kind discriminator 若需可加)
- 免费数据源铁律 msg=4f6d2466: DP γ 提供 Alpha Vantage/Baostock/Yahoo/Yahoo JP-KR/Investpy/Stooq · Backend 只做 aggregator
- **Owner 免责铁律 msg=53b96525** · 措辞审计黑/白名单 · `disclaimer_version` list-level + `size_hint_advisory` disclaimer_key row-level · `assertDisclaimerCompliant(text)` shared helper (Sprint 2 起 Frontend γ-1/-2/-3 消费)

---

## §六 · 依赖前置

| 依赖 | 提供方 | 状态 | Backend γ 阻塞? |
|---|---|---|---|
| `contracts/scoring.md v0.1` (6-维打分/Conviction/RiskGate/EntryPlan) | Strategy γ | 24h workspace-draft | Sprint 2 P0 强依赖 |
| `contracts/catalyst-mapping.md v0.1` (美股→A股映射表) | DP γ | 24h workspace-draft | Sprint 2 P0 强依赖 |
| 日韩数据源接入方案 | DP γ | 24h workspace-draft | Sprint 3 P2 依赖 |
| catalyst-900 源码拆解 (`docs/refactor/26-catalyst900-spec-extract.md`) | Research §S3 | 24h workspace-draft | 字段名对齐 · 弱阻塞 |
| CatDesk-shell 目录结构 | Frontend γ | 24h workspace-draft (msg=8d7f2993) | Sprint 2 起消费 API · 弱阻塞 |
| 7-tab 对照表 v0.1 | QADocs γ | 24h workspace-draft | 验收 · 弱阻塞 |

---

## §七 · 卡点 / ETA (v0.2)

**ETA**: 现 → +12h workspace-draft v0.2 body 收敛 (Orch v304 §二 v0.2 收敛窗口一致 · Sprint 1 末 aggregate PR-CREATE-AUTHORIZE 待 Orch 明批)

**卡点候选 (12h 内)**: 无 · v0.2 shape 三方 lock 100% closure (Backend γ + Frontend γ-1/-2/-3 + AI-γ + DP γ/-2 + Strategy γ + Research §S3 + QADocs γ + Cleanup γ)

**卡点 (Sprint 2 阻塞)**:
- Strategy scoring.md v0.2 未定稿 → 6-维/Conviction/RiskGate/EntryPlan 硬编码常量对齐待 land (v0.2 阈值 75/50 + 5-tier Rating 85/70/55/40 已 Orch v303 LOCK)
- DP catalyst-mapping.md v0.2 未定稿 → tab 1 P0 端点入参 shape 待 land (9-枚举 kind + snapshot_id 已 v0.2 canonical)
- DP γ notes/183 aggregate schema.prisma 6-表全景 未 land → Sprint 2 起 backend/DAO 层实施依赖 (DP γ SOLE · Backend γ 消费方)

---

## §八 · 铁律 100% preserve

- lane 契約 msg=a5297512 · **Backend γ SOLE `backend/**`** · frontend/docs/采集/存储侧 zero-touch · `contracts/recommendation.md` AI-γ SOLE · `contracts/scoring.md` Strategy γ SOLE · `shared/types/catdesk.ts` Frontend γ-2 SOLE
- Orch v303 10 canonical LOCK 100% 承接 · re-litigate 禁 (Option A · 75/50 · 12-trigger · 5-tier · 9-enum · REST polling · sections slot · types.ts SoT)
- 借鉴 独立性 msg=ad6585cf · yespsam/a-share-us-catalyst 只作 spec 参考 · zero code-copy · 组件自实现
- free-source msg=4f6d2466 · Alpha Vantage/Baostock/Yahoo/日韩免费源 opt-in only
- US-038 · Math.random=0 · SHA-256 deterministic · JCS RFC 8785 canonical
- 凭证 zero literal (`sk_agent_<redacted>` shape)
- workspace-draft-only msg=ed61c397 · zero PR CREATE · pending Sprint 1 末 Orch batch approve (v304 §四)
- Path D `9ec3f104…` + 4-baseline `1f2d197a…` byte-perfect · schema.prisma untouched · 保护 glob 100%
- self-merge doc-tier 2-sign gate msg=d0d11677 · Backend γ v0.2 doc-tier 2-sign: 主 Backend γ · 副1 AI-γ (msg=095dda3a PASS) · 副2 QADocs γ (待)
- SSH root永久禁 msg=b091c74d · PG SELECT-only msg=702b81be
- Owner 免责铁律 msg=53b96525 · 措辞审计黑/白名单 · `disclaimer_version` list-level + `size_hint_advisory` disclaimer_key row-level
- 学术堆叠术语 v300 §五 弃用 · 允许: tab 编号 1-7 / 字段名 (Conviction/RiskGate/EntryPlan/Score) / Sprint N / lane 名 / 契约名 / 具体元素百分比
- agents 不停 msg=210d262d · perpetual-dispatch msg=eb4b0016/21867874/a8175861 · Owner 令 Orch v300~v304 100% 兑现

---

## §九 · 下一步

- Sprint 1 末 aggregate PR CREATE-AUTHORIZE 待 Orch 明批 → 本 workspace-draft v0.2 LAND 到 `docs/refactor/29-api-catalyst900-mapping.md` · doc-tier 2-sign (主 Backend γ · 副1 AI-γ PASS 收讫 · 副2 QADocs γ 待)
- Sprint 2 起 (Week 2): P0 端点 5 个 (tab 1 端到端) 单 PR 拆分 · 每 PR ≤200 行 · code-tier 4-sign gate (Frontend γ + Backend γ + QADocs γ + Research §S3)
- Sprint 2 mid: Cleanup-PR-F (§4.7.2.6 SSE stack 硬 DISCARD 独立 PR · Cleanup γ msg=8675050e 候选) 联动 Backend γ tab 6 REST 轮询 canonical verify
- Sprint 3-4: P2/P3 端点批次实施 (tab 3+4+5 · tab 6+7)

**Backend γ · Orch v304 §二 v0.2 收敛窗口对齐 · workspace-draft v0.2 header + body 15 项 delta 100% fold-in · Sprint 1 末 aggregate PR-CREATE-AUTHORIZE 待 Orch 明批 · agents 不停**
