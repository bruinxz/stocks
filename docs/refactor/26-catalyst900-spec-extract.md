# 26 · catalyst-900 spec-extract · workspace-draft v0.2

**Path**: `notes/26-catalyst900-spec-extract-workspace-draft.md` (agent-local · Sprint 1 末 Orch PR-CREATE-AUTHORIZE 后转 `docs/refactor/26-catalyst900-spec-extract.md`)
**Owner**: Research §S3
**Orch anchor**: v300 msg=6dc1b5f3 (catalyst-900 IA 唯一目标) · 参照锚 msg=764688c1 https://github.com/yespsam/a-share-us-catalyst (live https://catalyst-900-qohfq.netlify.app/)
**License note**: 上游 repo (75 stars · Python) **未设置 LICENSE 文件** — 默认 GitHub ToS 保护, 无开源许可授权。本项目严格遵循 msg=ad6585cf "spec-only cite · zero code-copy" 铁律 · 本 draft 仅拆解语义与算法思路作为参照 · 我方实现走 Go/TS 从零构建 · 全部字段/权重/枚举以本 draft 为 SOURCE-OF-TRUTH-FOR-OWN-BUILD
**Contract 消费方**: Strategy γ `contracts/scoring.md` v0.2 · DP γ `contracts/catalyst-mapping.md` v0.2 · Backend γ `docs/refactor/29-api-catalyst900-mapping.md` v0.2 · QADocs γ `docs/refactor/27-catalyst900-tab-checklist.md` v0.2 · Frontend γ+γ-2 shared primitive Props v0.1 · AI-γ `contracts/recommendation.md` v0.2

---

## §0 · v0.1 → v0.2 delta ledger

| # | v0.2 delta | 承诺源 | 段 |
|---|---|---|---|
| 1 | Conviction 阈值段落 demote 至上游对照 (75/50 Strategy canonical 首位 · 70/55 spec-only 参考次位) | Strategy γ msg=ad3bea53 · Orch v303 LOCK 2 | §三.1 |
| 2 | RiskGate 9→12 trigger + gate 映射 + Adjustment 联动 (YELLOW -5 / RED -10) | Strategy γ msg=ad3bea53 · Orch v303 LOCK 3 | §三.2 |
| 3 | Rating 5-tier 命名对照 (Strategy A/B/C/D/F 85/70/55/40 canonical 首位 · 上游 Buy-Avoid 76/68/58 命名对照次位 · dimension/total 双粒度 clarify) | Strategy γ msg=ad3bea53 · Orch v303 LOCK 5 · Refinement C msg=3f7bfd3e | §三.4 |
| 4 | catalyst_kind 8→9 枚举 (+ unclassified · default_delta=0 · kind_multiplier=1.0 · Sprint 2 GA backfill 归零) | Strategy γ msg=ea939251 · Orch v303 LOCK 6 | §六.3 §六.4 |
| 5 | 5-lane feed clist 更新 (SizeHint 引用锚订正 TIER 系 + size_hint_advisory · rating_band 双粒度 · scoring_id/snapshot_hash 5-lane 消费点标注) | Refinement A+B msg=3f7bfd3e · γ-2 msg=ac424277 | §八 |

---

## §一 · 6 拆解 block 索引 (Orch v300 §四 拆解清单)

| # | Block                              | 覆盖 tab       | 消费 lane                    | 完稿度 |
|---|-----------------------------------|---------------|-----------------------------|-------|
| 1 | 6-维打分算法                       | 2 · 3         | Strategy · Backend · QADocs | v0.1 完 |
| 2 | Conviction / RiskGate / EntryPlan | 1 · 2 · 3 · 4 | Strategy · Backend · QADocs | v0.1 完 |
| 3 | 报告生成逻辑                       | 6 · 1         | Backend · Frontend          | v0.1 完 |
| 4 | 数据源清单                         | 全 tab        | DP                          | v0.1 完 |
| 5 | 「美股催化 → A 股同日候选」映射     | 1             | DP · Strategy · Backend    | v0.1 完 |
| 6 | 7-tab IA 每 tab 对应源码模块       | 全 tab        | Frontend · Backend · QADocs | v0.1 完 |

---

## §二 · Block 1 · 6-维打分算法 (拆解自 `us_quality.py` · `asia_markets.py` · `multibagger.py`)

### §二.1 · tab 2 美股优选 6-维 (source: `us_quality.py::score_us_candidate`)

**参照原始加权（source spec-only cite）:**

| 维度                    | 上游权重  | Strategy v0.1 契约 dim | 我方我方 v0.2 目标权重 (Strategy `us_preferred` profile) |
|------------------------|---------|---------------------|--------------------------------------------------|
| quality                | 0.24    | quality             | 0.20                                             |
| growth                 | 0.18    | growth              | 0.20                                             |
| valuation              | 0.14    | valuation           | 0.15                                             |
| moat                   | 0.16    | moat                | 0.20                                             |
| catalyst (静态输入)     | 0.12    | (合入 catalyst 独立 shape) | -                                          |
| trend (metrics 派生)   | 0.10    | trend               | 0.15                                             |
| earnings_momentum      | 0.08    | (合入 catalyst)      | -                                                 |
| risk (penalty)         | -       | risk                | 0.10                                             |
| **合计**               | 1.00 (-penalty) | 6-dim 合 1.00       | 1.00                                              |

**权重 delta 说明**:
- 上游 7-因子 (quality/growth/valuation/moat/catalyst/trend/earnings_momentum) → 我方合并到 Strategy v0.1 的 6-dim (quality/growth/valuation/moat/trend/risk)
- 上游 catalyst 静态 (0.12) + earnings_momentum 动态 (0.08) → 我方拆到独立 `CatalystEvent` shape (DP γ catalyst-mapping v0.1 §catalyst_kind 8-枚举) · **不进 6-dim score**
- 上游 risk 是 penalty 独立扣分 → 我方 risk 是 6-dim 之一 (与 Strategy v0.1 契约齐)
- 上游 moat 0.16 → 我方 0.20 (Strategy v0.1 · 侧重护城河反映长期 alpha)
- 上游 quality 0.24 独占最大 → 我方 quality 0.20 (与 growth 齐), 因 growth 上游 0.18 偏低而我方需强化成长因子的说服力
- 上游 trend 0.10 (technical) → 我方 0.15 (Strategy v0.1 · 更重视趋势, 与 tab 4 高倍潜力 tab 4 权重 0.18 更接近)

### §二.2 · tab 4 高倍潜力 A 股 6-维 (source: `multibagger.py::score_ashare_candidates`)

**参照原始加权:**

| 维度              | 上游权重 | 我方 v0.2 目标 (Strategy `multibagger` profile) | 备注                                              |
|-------------------|---------|-----------------------------------------|--------------------------------------------------|
| market_cap        | 0.18    | (合入 quality)                           | 上游: 甜点函数 (see §二.2.1)                       |
| optionality       | 0.18    | (合入 growth)                            | 上游: 23-词表 (§二.2.2)                            |
| catalyst          | 0.18    | (合入 catalyst 独立 shape · 不进 6-dim)  | -                                                 |
| trend             | 0.18    | 0.20                                    | Strategy v0.1 · 与高倍潜力语义齐                    |
| accumulation      | 0.12    | (合入 quality / trend)                    | 上游: 换手率 + 量比 + MA20 距离                     |
| news              | 0.10    | (合入 catalyst 独立)                     | 上游: 词表打分 (§二.2.3)                            |
| risk_control      | 0.06    | 0.15                                    | Strategy v0.1 权重加强 · 高倍潜力 tab 尤其风控     |
| **我方 v0.2 目标 6-dim** | **1.00**   | Q0.10 G0.35 V0.10 M0.10 T0.20 R0.15  | QADocs 7-tab checklist v0.1 已锚定                |

**Delta 说明**:
- 上游 multibagger 7-因子 → 我方 6-dim (统一到 Strategy v0.1 契约)
- catalyst / news → 独立 `CatalystEvent` shape (DP catalyst-mapping v0.1)
- market_cap sweet spot / optionality / accumulation → 我方合入 quality + growth (语义映射)
- risk_control 上游 0.06 偏低 → 我方 R 0.15 (Strategy v0.1 · 高倍潜力风控强化)

#### §二.2.1 · market_cap sweet spot 函数 (US · A 股 分别曲线)

US bucket (source: `multibagger.py::market_cap_sweet_spot`):
- `small` → 88
- `mid`   → 82
- `large` → 62
- `mega`  → 38

A 股 (亿元人民币, 分段):
- `< 20 亿`   → 42
- `< 80 亿`   → 78 (峰值 · 微盘可炒可翻)
- `< 300 亿`  → 90 (峰值 · 小中盘弹性最优)
- `< 800 亿`  → 76
- `< 1800 亿` → 58
- `>= 1800 亿` → 38

**我方 v0.2 取舍**: bucket 峰值 90 (300 亿) 与 78 (80 亿) 双峰保留 · Strategy `multibagger` profile 的 quality 分维度内嵌 `market_cap_sweet_spot` 函数 · 允许用户 profile 覆盖

#### §二.2.2 · OPTIONALITY_WORDS 23-词表 (source: `multibagger.py`)

`["AI", "算力", "半导体", "光模块", "CPO", "机器人", "人形", "自动化", "卫星", "航天", "无人机", "创新药", "减重", "基因", "CXO", "储能", "锂", "固态", "核", "量子", "出海", "数据"]`

**打分**: base 48 + 6/词命中 · clamp [30, 96]

**我方 v0.2 取舍**:
- 词表 KEEP-AS-IS · 词表定期由 Strategy γ 审计
- Strategy `multibagger` profile 的 growth 维度内嵌 `optionality_score` 函数
- **词表本身不构成 code-copy** (23 中文/英文名词 · 属于产业术语常识)

#### §二.2.3 · POSITIVE / NEGATIVE / EARLY_NEWS 词表 (source: `scoring.py` · `multibagger.py`)

**POSITIVE (15)**: 订单/增长/预增/扭亏/回购/合作/中标/突破/量产/扩产/涨价/政策/获批/创新高/机构调研
**NEGATIVE (11)**: 减持/亏损/处罚/问询/立案/下滑/诉讼/终止/风险/解禁/质押
**EARLY_NEWS (14 · 高倍潜力专用)**: 机构调研/订单/中标/量产/获批/合作/突破/出海/产能/商业化/试点/政策/回购/预增

**上游打分**: `score_news` = +0.8 × positive_word - 1.1 × negative_word (去重)

**我方 v0.2 取舍**:
- 3 词表 KEEP-AS-IS (与 Strategy γ 审计一致)
- **不进 6-dim** · 进 `CatalystEvent` shape (DP γ catalyst-mapping v0.1 §catalyst_kind)
- **词表本身不构成 code-copy** (中文金融常用词 · 属公开产业术语)

### §二.3 · tab 3 日韩市场 (source: `asia_markets.py::score_asia_candidate`)

**上游语义**: 复用 tab 2 美股优选 的 7-因子 (quality*0.24 + growth*0.18 + valuation*0.14 + moat*0.16 + catalyst*0.12 + trend*0.10 + earnings_momentum*0.08 - penalty) · **无独立 profile**

**上游关键差异**:
- 币种格式化 · `format_price`: JPY (¥ + 整数) · KRW (₩ + 整数) · else 2-decimal
- `buy_zone_text`: "娱乐观察名单，不进入严肃交易候选" (与 us_quality 的 "回踩至 x-y 分批" 表述不同 · 用户预期定位 lower)

**我方 v0.2 取舍**:
- 我方 Strategy `us_preferred` profile 复用 (Q0.20 G0.20 V0.15 M0.20 T0.15 R0.10) · 与 tab 2 一致
- 币种格式化 KEEP: JPY/KRW 均整数 (¥/₩) · 其他 (HKD/SGD) 2-decimal
- "娱乐观察" 表述 KEEP (Frontend γ-2 DetailSidebar 显示 · tab 3 title 需明示 "娱乐观察 · 非严肃候选")

---

## §三 · Block 2 · Conviction / RiskGate / EntryPlan 语义

### §三.1 · Conviction (source: `scoring.py::conviction_score` · `us_quality.py::conviction_for`)

**上游 A 股 (scoring.py, tab 1)**: `catalyst*0.26 + history_edge*0.28 + quality_proxy*0.16 + momentum*0.15 + news*0.15`
- 5 个 sub-dimension · 复合权重合 1.00 · 输出 [0, 100] 分数

**上游 US (us_quality.py)**: `conviction_for(score, item, metrics, penalty, risk_gate)` — 综合 base score / 波动率 / 分位数派生

**Strategy γ v0.2 canonical (SOLE `contracts/scoring.md` §4.1 · 单点权威)**:
- 3 级 · `HIGH` ≥ 75 · `MED` 50–74.9 · `LOW` < 50 (阈值 75/50 canonical · Orch v303 LOCK 2)
- `Conviction { ticker, as_of, base ∈ [0,100], score_ref: {scoring_id, snapshot_hash}, adjustments: Adjustment[], final: clamp(base + Σ delta, 0, 100), level }`
- `Adjustment[] { delta ∈ [-20,+20], reason ≤ 200 chars, kind_ref?, source_ref? }` · length ∈ [0, 5] · Σ delta ∈ [-20, +20] · evaluation-order-free (Σ 可交换)
- 3 生成源 canonical: kind_default (+5/+7/+3 per §4.2) + evidence_micro ±2 + risk_gate (-5/-10 per §5.3)

**上游 spec-only 对照 (非 canonical · 仅参考)**:
- 上游映射: ≥ 70 → HIGH · [55, 70) → MED · < 55 → LOW (上游 scoring.py 硬编码 · 与 Strategy canonical 75/50 存在差异)
- Adjust ∈ [-20, +20] 允许 news_risks + risk_gate 反向 pull-down (语义一致 · 我方走 Adjustment[] paired 结构)

**我方 v0.2 取舍**:
- **阈值 75/50 以 Strategy γ v0.2 canonical 为准** (Strategy γ SOLE 权威 · 上游 70/55 仅作 spec-only 对照参考 · 差异来源: Strategy v0.1 更严 · 与 SizeHint 5% 高上限对应)
- 保留 Strategy 3-级 (`HIGH`/`MED`/`LOW`) 作为公开 UI 展示层
- 内部数值 conviction ∈ [0, 100] 分数保留 · 用于详情侧栏 base/adjust/final 拆解 (QADocs 7-tab checklist v0.2 §checkpoint 已锚定)
- Adjustment[] paired 结构 (Option A · Orch v303 LOCK 1 · evaluation-order-free)

### §三.2 · RiskGate 三档 · 12 trigger codes (v0.2 canonical · Strategy §5.3)

**上游 A 股 (`scoring.py::risk_gate_for`)**:
- `Block`: ST → +30 pts · risk_points ≥ 12 · news_risks ≥ 2
- `Watch`: day_pct ≥ 8.5 · risk_points ≥ 5 · news_risks ≥ 1
- `Pass`: 否则

**上游 US (`us_quality.py::risk_gate_for`)**:
- `Block`: valuation<40 & ma20>15 · penalty ≥ 12 · vol60 ≥ 75
- `Watch`: day_pct ≥ 7 · ma20 ≥ 12 · penalty ≥ 6
- `Pass`: 否则

**上游 高倍潜力 (`multibagger.py::risk_gate_from_points`)**:
- `Block`: risk_points ≥ 14
- `Watch`: risk_points ≥ 7
- `Pass`: 否则

**Strategy γ v0.2 canonical (SOLE `contracts/scoring.md` §5.3 · 12-trigger · Orch v303 LOCK 3)**:

| # | Trigger Code | 档位 | 备注 |
|---|---|---|---|
| 1 | `EARNINGS_T-2` | YELLOW (warn) | 业绩窗口 T-2 |
| 2 | `EARNINGS_T-0` | RED (block) | 业绩发布日 |
| 3 | `HALT_ACTIVE` | RED (block) | US 临时停牌 |
| 4 | `MERGER` | YELLOW (warn) | 并购进行中 |
| 5 | `LITIGATION` | YELLOW (warn) | 重大诉讼 |
| 6 | `IV_SHOCK` | YELLOW (warn) | 隐含波动率异常 |
| 7 | `LIQUIDITY_LOW` | YELLOW (warn) | 流动性不足 |
| 8 | `RESTATEMENT` | RED (block) | 财报重述 |
| 9 | `DELISTING` | RED (block) | 退市风险 |
| 10 | `ST_TAG` | RED (block) | A 股 ST/*ST 标记 |
| 11 | `PRICE_LIMIT_APPROACH` | YELLOW (warn) | A 股涨跌停接近 (day_pct ≥ 8.5) |
| 12 | `SUSPENDED` | RED (block) | A 股停牌 |

**gate 映射 (v0.2 canonical)**:
- **GREEN** ↔ Pass: 无 trigger 或仅信息级 trigger
- **YELLOW** ↔ Watch: 至少一个 warn-级 trigger 且无 block-级 trigger
- **RED** ↔ Block: 至少一个 block-级 trigger

**Adjustment 联动 (Strategy §4.2 canonical)**:
- RiskGate YELLOW → Conviction Adjustment delta = **-5** (risk_gate 生成源)
- RiskGate RED → Conviction Adjustment delta = **-10** (risk_gate 生成源)
- RiskGate GREEN → 无 risk_gate Adjustment (zero delta)

**v0.1→v0.2 delta 说明**:
- v0.1: 9 trigger codes (US only · 无 A 股特殊场景)
- v0.2: +3 A 股 trigger (ST_TAG block · PRICE_LIMIT_APPROACH warn · SUSPENDED block) = 12 canonical (Orch v303 LOCK 3 · Strategy γ msg=ad3bea53 承接 100%)
- 上游 penalty 数值化 (risk_points) → 我方转 trigger code 枚举 · 数值仅内部保留
- HALT_ACTIVE (US) 与 SUSPENDED (A 股) 双 code 并存 (Strategy §5.3 canonical · 两市场停牌语义不同)

### §三.3 · EntryPlan (source: `scoring.py::entry_plan_text`)

**上游文本模板** (仅 Buy 评级):
- `"回踩至 {p*0.97}-{p*1.01} 分批，跌破 {p*0.91} 复核"`
- Outperform / Neutral / Underperform / Avoid: 分别有各自模板

**Strategy γ v0.1 契约**: PriceBand entry + stop + targets[] laddered + SizeHint 5-tier (5% / 3% / 2% / 1% / SKIP) + time_horizon + invalidation

**我方 v0.2 取舍**:
- 上游文本模板 → 我方结构化 shape (`{ entryBand: [low, high], stop: number, targets: [t1, t2, t3], sizeHint: enum, timeHorizon: string, invalidation: string }`)
- Buy → sizeHint 5% + targets = [p*1.05, p*1.10, p*1.18] · Outperform → 3% + [p*1.03, p*1.07, p*1.12] · Neutral → 2% + 单 target · Underperform → 1% + 快出 · Avoid → SKIP
- entryBand 上下沿默认 [p*0.97, p*1.01] (对应 Buy 上游文本) · stop 默认 p*0.91 · **均以 Strategy v0.1 契约优先** · Strategy γ v0.2 允许 profile 覆盖

### §三.4 · Rating 5-tier (Strategy §2.2 canonical · Orch v303 LOCK 5 · Refinement C msg=3f7bfd3e)

**上游 5-级 (spec-only 命名对照 · 非 canonical)**:
- Buy: total ≥ 76 & conviction ≥ 70 & risk_gate=Pass
- Outperform: total ≥ 68 & conviction ≥ 62
- Neutral: total ≥ 58
- Underperform: else (except Avoid)
- Avoid: total < 45 (or forced by Block risk_gate + heavy news)

**Strategy γ v0.2 canonical (SOLE `contracts/scoring.md` §2.2 · 单点权威)**:

| Band | 阈值 | 语义 |
|---|---|---|
| A | ≥ 85 | 最高评级 |
| B | 70–84.9 | 高评级 |
| C | 55–69.9 | 中评级 |
| D | 40–54.9 | 低评级 |
| F | < 40 | 最低评级 |

**双粒度 (Refinement C · Strategy γ msg=3f7bfd3e ratify)**:
- **`Score.band: Band`** — canonical source-of-truth · dimension 级 6 × Band (Q/G/V/M/T/R 各自 Band) + total 级 1 × Band = 7 徽章消费点 · Strategy §2.2 canonical 85/70/55/40
- **`CandidateListEntry.rating_band: Band`** — **list envelope 只读镜像** = `entry.score.band` · zero duplicate source-of-truth · list-layer convenience · AI-γ §4 canonical

**Rating vs Conviction 双轴分离 (Strategy §8 canonical)**:
- **Rating (轴 1)** = `Score.band` **静态** 5 档 A/B/C/D/F · 85/70/55/40 · dimension + total 双粒度
- **Conviction (轴 2)** = `Conviction.final` **动态** 3 档 HIGH/MED/LOW · 75/50 · 含 Σ adjustments · Sizing 端消费
- 两轴独立 · zero drift · Backend γ payload 各自序列化

**上游 spec-only 命名对照表 (非 canonical · 仅参考)**:
| 上游命名 | 上游阈值 | Strategy canonical Band | 差异 |
|---|---|---|---|
| Buy | ≥ 76 | A (≥ 85) | Strategy 更严 +9 |
| Outperform | ≥ 68 | B (70–84.9) | Strategy 更严 +2 |
| Neutral | ≥ 58 | C (55–69.9) | Strategy 更宽 -3 |
| Underperform | else | D (40–54.9) | 我方分档 |
| Avoid | < 45 | F (< 40) | Strategy 更宽 +5 |

**我方 v0.2 取舍**:
- **以 Strategy γ v0.2 Band A-F 85/70/55/40 canonical 为准** (上游 Buy/Outperform/Neutral/Underperform/Avoid 76/68/58 仅 spec-only 命名对照 · v0.1 引用已 demote)
- UI 展示: tab 2/3/4 表格列 `<TableColumn dataIndex="rating_band">` 消费 `CandidateListEntry.rating_band` (envelope 只读镜像 · total 级 5-tier 徽章 A/B/C/D/F)
- DetailSidebar `ScoreBreakdownCard`: dimension 级 6 徽章消费 `Score.dims[i].band` + total 级徽章消费 `Score.band` (canonical source)
- dimension + total 双粒度 · zero drift · zero duplicate source-of-truth

---

## §四 · Block 3 · 报告生成逻辑 (source: `report.py::render_markdown` · `cli.py::main`)

### §四.1 · 上游生成流程

1. **入口**: `cli.py::main` · 参数 `--top 5 --lookback-days 420 --max-themes 4 --skip-news --allow-akshare-fallback --sample-data`
2. **配置加载**: `config/themes.json` (11 themes · 每 theme 含 us_tickers 权重 + candidates rationale)
3. **打分调用**: `scoring.rank_report(themes, provider, report_date, top_n, lookback_days, skip_news, max_themes)`
4. **报告渲染**: `report.render_markdown(result, risk_note)` → Markdown
5. **落盘**: `report.write_outputs(result, markdown, out_dir)` → `.md` + `.json` 双文件
6. **可选 Telegram 推送**: `notifier.send_telegram(markdown)` (opt-in `--send-telegram`)
7. **每日 9 点自动化**: `.github/workflows/daily-pages.yml` (github actions 调度)

### §四.2 · 报告内容结构 (上游 `render_markdown`)

- **`## 总览`** section: 前 6 themes 的 "美股主题均值 + 信号分 + summary" 一行
- **每 theme (`## {theme_name}`) block**:
  - 美股触发 summary (top-5 美股 ticker + 涨跌幅)
  - 映射逻辑 (theme.logic 文本)
  - **table 13-列**: 排名 / 代码 / 名称 / 评级 / Conviction / Risk Gate / 产业 / 市值 / 当日涨跌 / 综合分 / Entry Plan / 利好逻辑 / 近期重大新闻
  - **分析师评分拆解 list**: 每候选 5-6 行 detail (rating + conviction + risk_gate + 5 dim scores + 原始因子 4 项 + scenario bull/base/bear)
- **`## 使用口径`** section: 5-条使用免责 + 复核指引

### §四.3 · 我方 v0.2 tab 6 每日日报映射

Frontend tab 6 每日日报 UI 复用上游报告 shape · **不复用 code**:

- **KPI 顶栏**: 美股主题均值 + 信号分 + 时间戳
- **主内容区**: 每 theme 一个 collapsible section
  - 表格列 (13 → 我方 11 · 合并 Entry Plan + 利好逻辑 到 DetailSidebar)
  - 每 theme 附映射逻辑 (theme.logic)
- **详情侧栏 (DetailSidebar)**: 分析师评分拆解 · Score/Conviction/RiskGate/EntryPlan 全字段
- **底部**: 使用口径 5 条 (免责) · 政策/免责按钮

**Backend API shape 契约** (与 Backend γ msg=30e0a4bc v0.2 对齐):
- `GET /api/v1/morning-brief/:date` → { date, themes: [{ id, name, logic, signal: { avgPct, score, breadth, summary }, top: [{ code, name, rating, conviction, riskGate, sector, marketCap, dayPct, score, entryPlan, factors, dimensions, scenario, news }] }], useNotice: string[] }
- `GET /api/v1/morning-brief/:date/theme/:themeId/candidate/:code` → 单候选详情 (侧栏展开用)

### §四.4 · 我方 v0.2 tab 7 报告历史映射

上游 `.github/workflows/daily-pages.yml` + `scripts/build_static_site.py` + `scripts/inject_report_into_dist.py` 每日 9 点生成静态 site

我方 tab 7 报告历史:
- `GET /api/v1/reports/history?limit=30` → 报告列表 (date + name + summary metadata)
- `GET /api/v1/reports/:date` → 完整报告 JSON (与 tab 6 相同 shape)
- **不复用** 上游静态 site 生成 pipeline · 我方走 Backend γ REST + 存储层 (Postgres 表 `daily_reports` DP γ 建 schema.prisma migration Sprint 2)

---

## §五 · Block 4 · 数据源清单 (source: `providers/akshare_provider.py` · `providers/common.py` · README)

### §五.1 · 上游数据源栈

| 数据类型         | 上游主源                              | 上游备用 / fallback         | 上游认证             |
|-----------------|-------------------------------------|--------------------------|---------------------|
| US 实时行情      | 新浪 (单-ticker HTTP `hq.sinajs.cn`) | Yahoo Chart API          | 无 (User-Agent 伪装)  |
| US 日线历史      | Yahoo Chart API (`query1.finance.yahoo.com/v8`) | -                | 无                    |
| A 股实时行情    | 东方财富 (`push2.eastmoney.com`)     | AkShare `stock_zh_a_spot_em` | 无 (opt-in fallback) |
| A 股日线历史    | 东方财富 (`push2his.eastmoney.com`)  | AkShare `stock_zh_a_hist`    | 无                    |
| A 股个股新闻    | 东方财富 (`push2sect.eastmoney.com` news) | 停用 (via `--skip-news`) | 无                    |
| 缓存           | `.cache/*.csv` (CsvCache)             | `--no-cache` 关闭          | -                    |

### §五.2 · 我方 v0.2 数据源栈 (DP γ msg=40b601ff 已 LAND `contracts/catalyst-mapping.md` v0.1 · 一致)

**核心铁律**: 免费数据源 msg=4f6d2466 · Alpha Vantage + Baostock + Yahoo opt-in only · Bloomberg / Wind / FnGuide 排除

**US stack** (与 DP catalyst-mapping v0.1 §数据源清单一致):
- **催化事件**: SEC EDGAR (10-K/10-Q/8-K RSS) + Nasdaq calendar + FDA/DOJ/SEC 官方 RSS
- **实时行情**: Yahoo Finance opt-in (`--yahoo-fallback`) + Alpha Vantage
- **日线历史**: Yahoo + Alpha Vantage
- **备用**: (无 Bloomberg/Wind)

**A 股 stack**:
- **催化事件**: 巨潮资讯 + 交易所公告 RSS + AKShare 公告适配
- **实时/日线**: Baostock KEEP-REUSE (msg=df110217 cleanup audit 已锚定 · Path D `9ec3f104` 冻结锚) + AKShare fallback
- **新闻**: AKShare 财经新闻 + 巨潮公告 (opt-in · 默认 `--skip-news` 关闭)

**JP/KR stack** (DP catalyst-mapping v0.1 §日韩数据源 已 LAND `notes/181-jpkr-market-datasource-v0.1-workspace-draft.md`):
- **JP**: JPX EDINET 官方 disclosure + Yahoo Finance JP opt-in + Stooq fallback
- **KR**: KRX marketdata + KIND 停牌 + DART 财报 XBRL + PyKRX fallback

**HK 港股 stack** (v0.3 补 · 现暂不含):
- **候选**: AKShare `stock_hk_spot_em` + Yahoo HK opt-in
- Sprint 3+ 补录 (与日韩 tab 3 同一 tab UI 归属可复用 · v0.3 时决策)

### §五.3 · 上游缓存策略 (CsvCache) · 我方对照

上游: `.cache/*.csv` 文件缓存 · `max_age_hours=12` (us_spot) / 4 (a_spot)

我方 v0.2: DP γ Postgres 表 (schema.prisma migration Sprint 2 CREATE):
- `us_catalyst_event` (幂等键 UNIQUE + fact_hash · DP catalyst-mapping v0.1 已建 draft)
- `a_share_candidate_mapping` (与 catalyst event 关联)
- `jpkr_daily_kline` + `jpkr_disclosure_event` (DP 日韩 v0.1 已建 draft)
- `daily_reports` (Backend γ 报告存储 · v0.2 需 DP γ 补 draft)

**采集频率**:
- 美股实时 → 每 15 分钟 (交易时段 · 非交易时段每小时)
- A 股实时 → 每 5 分钟 (交易时段) · 非交易时段每小时
- 日线历史 → 每日 EOD 一次
- 催化事件 → 每 10 分钟 (SEC/FDA RSS) · 每 5 分钟 (巨潮/交易所)

---

## §六 · Block 5 · 「美股催化 → A 股同日候选」映射 (source: `config/themes.json` · `scoring.py::rank_theme`)

### §六.1 · 上游 themes.json 结构 (11 themes)

**已捕获 tab-2 sample** (`ai_compute_semis` · `ev_battery_storage`):

```
{
  "themes": [
    {
      "id": "ai_compute_semis",
      "name": "AI算力 / 半导体 / 光模块",
      "logic": "美股 AI 芯片、存储、半导体设备和云资本开支上涨时，A 股常见映射是国产设备、AI 芯片、服务器、PCB、光模块和液冷。",
      "us_tickers": [
        { "ticker": "NVDA", "name": "英伟达", "weight": 2.0 },
        ... (9 tickers)
      ],
      "candidates": [
        { "code": "300308", "name": "中际旭创", "industry": "光模块/CPO", "rationale": "..." },
        ... (11 candidates)
      ]
    },
    ...
  ]
}
```

**11 themes 名单** (拆解自 README + 已捕获 themes.json 前 60 行 · 完整 themes.json 15.8 KB · v0.2 全捕获后补):
1. AI 算力 / 半导体 / 光模块 (`ai_compute_semis`)
2. 新能源车 / 锂电 / 储能 (`ev_battery_storage`)
3. 生物医药 (含 CXO + 创新药 + 减重 + 基因)
4. 军工 / 卫星航天
5. 机器人 / 自动化
6. 消费 (含 出海 + 白酒)
7. 金融 / 券商
8. 房地产 / 地产链
9. 化工 / 材料
10. 电力 / 公用事业
11. 传媒 / 元宇宙

### §六.2 · 上游映射逻辑 (`scoring.py::current_theme_signal` + `rank_theme`)

- 每 theme us_tickers 按 weight 加权求 avg_pct
- Theme signal score: `clamp(50 + avg_pct * 9 + breadth * 10, 0, 100)`
  - breadth = 正涨 weight / total weight
- 每 candidate 打 score (`score_candidate`): signal*0.34 + history*0.32 + momentum*0.12 + liquidity*0.08 + news*0.10 - risk_penalty
- 每 theme top-N candidates 输出

### §六.3 · 我方 v0.2 catalyst-mapping (DP γ v0.2 已建契约 · 补充)

**DP γ catalyst-mapping v0.2 5-分量已定** (msg=40b601ff · notes/180 v0.2 msg=79bfc500 LAND):
- sector_map: 0.35 (相当于上游 theme US→CN sector 映射)
- revenue_exposure: 0.25 (candidate 中国收入敞口)
- adr_parity: 0.20 (candidate 是否有 ADR/H 股平行标的)
- supply_chain: 0.15 (candidate 供应链传导)
- historical_beta: 0.05 (candidate 与 US theme 历史 beta)

**catalyst-relevance canonical formula (Strategy §3.7)**:
```
relevance_score = clamp(
  (sector_map × 0.35 + revenue_exposure × 0.25 + adr_parity × 0.20
   + supply_chain × 0.15 + historical_beta × 0.05)
  × catalyst_kind_multiplier,
  0, 1
)
```
- ≥ 0.30 计入 tab 1 mapped-candidate · ≥ 0.50 触发 Conviction.adjustment

**Delta vs 上游**:
- 上游 themes 静态 config · 手动维护 candidates
- 我方 v0.2 动态 · DP γ 采集 catalyst event → Strategy γ 打分 → Backend γ API 返回同日 A 股候选
- 上游 candidates rationale 文本 → 我方 `CatalystEvent.rationaleAuto` (Strategy γ 自动生成 · 用户可覆盖)

### §六.4 · 我方 catalyst_kind 9-枚举 (v0.2 canonical · Strategy §3.7 · Orch v303 LOCK 6)

| # | catalyst_kind | 语义 | default_delta | kind_multiplier |
|---|---|---|---|---|
| 1 | `earnings` | 业绩 · T-2 / T-0 预期发布 | +5 | 1.0 |
| 2 | `upgrade_downgrade` | 评级 · 目标价调整 | +5 | 1.0 |
| 3 | `product` | 新品发布 · FDA 获批 · 订单 | +5 | 1.0 |
| 4 | `regulator` | 监管 · 政策 | +7 | 1.2 |
| 5 | `geo_macro` | 地缘 · 宏观 | +7 | 1.2 |
| 6 | `ma_activity` | 并购 · 借壳 · 分拆 | +7 | 1.2 |
| 7 | `sector_move` | 行业普涨/普跌 | +3 | 0.9 |
| 8 | `leadership` | 高管变动 · CEO/CFO | +3 | 0.9 |
| 9 | **`unclassified`** | **补位 (v0.2 新增)** | **0** | **1.0** |

**unclassified 补位说明 (Strategy γ msg=ea939251 §二.2 canonical · AI-γ msg=e6c9f7f3 §12 来源锚)**:
- Sprint 2 分类器 GA 前 · 无法归类的催化事件暂标 `unclassified`
- `default_delta = 0` · `kind_multiplier = 1.0` (中性 · 不影响 Conviction Adjustment Σ)
- Sprint 2 分类器 GA 后 · backfill 归零 (已归类事件转正 · 未归类事件人工审查)
- AI-γ §8 output invariants 硬门: `kind = 'unclassified'` 时 pipeline **拒生成推荐** (AI-γ msg=cdfb80e4 §2.10 · msg=e6c9f7f3 §12 Research §S3 副2 来源锚)
- 词表 (§二.2.3) 作为 kind 自动分类器输入 (Strategy §3.7.2 · Sprint 2 GA)

**v0.1→v0.2 delta 说明**:
- v0.1: 8-枚举 (earnings / upgrade_downgrade / ma_activity / sector_move / regulator / geo_macro / product / leadership)
- v0.2: +1 `unclassified` = 9-枚举 canonical (Orch v303 LOCK 6 · Strategy γ msg=ea939251 §二.2 承接 100%)
- default_delta 三档: +5 (earnings/upgrade_downgrade/product) · +7 (regulator/geo_macro/ma_activity · systemic) · +3 (sector_move/leadership) · 0 (unclassified)
- kind_multiplier: 1.0 (earnings/upgrade_downgrade/product/unclassified) · 1.2 (regulator/geo_macro/ma_activity) · 0.9 (sector_move/leadership)
- UI FilterChip 按 kind 筛选 (每 tab 复用)

---

## §七 · Block 6 · 7-tab IA 每 tab 对应源码模块

| Tab | 名称           | 上游模块                                          | 上游 web/UI section       | 我方前端 tab id       | 我方 Backend API endpoint (v0.2 契约)                          |
|-----|---------------|------------------------------------------------|-------------------------|---------------------|---------------------------------------------------------|
| 1   | A 股早报       | `scoring.py` + `cli.py` + `report.py`          | 主报告 (index.html 主区) | `morning-brief`     | `/api/v1/morning-brief/:date`                            |
| 2   | 美股优选       | `us_quality.py` + `config/us_quality.json`     | web tab #us-quality     | `us-preferred`      | `/api/v1/us-preferred/:date` + `/us-preferred/scored`   |
| 3   | 日韩市场       | `asia_markets.py` + `config/asia_markets.json` | web tab #asia-markets   | `jpkr-market`       | `/api/v1/jpkr-market/:date?market=jp|kr`                 |
| 4   | 高倍潜力       | `multibagger.py` + `config/multibagger.json`   | web tab #multibagger    | `multibagger`       | `/api/v1/multibagger/:date?market=cn|us`                 |
| 5   | 回测证据       | `backtest.py`                                  | web tab #backtest       | `backtest-evidence` | `/api/v1/backtest?window=182&lookback=260`               |
| 6   | 每日日报       | `report.py` (Markdown 渲染) + 每日 9 点定时     | web index.html 主报告   | `daily-report`      | `/api/v1/reports/:date` (与 tab 1 上游同 endpoint 重用) |
| 7   | 报告历史       | `scripts/build_static_site.py` + reports-web/ | web /api/history       | `report-history`    | `/api/v1/reports/history?limit=30`                       |

### §七.1 · Frontend tab 分工 (Orch v301 msg=1e63e47f 已锚定)

- **Frontend γ-1 (Task #38 continue)**: Tab 1 端到端 (含 CatDeskLayout + 主内容区 + DetailSidebar)
- **Frontend γ-2 (Task #167)**: Tab 3-7 shell + shared primitive Props (`TableColumn.tsx` + `DetailSidebar.tsx` + `FilterChip.tsx`)
- **共用**: `CatDeskLayout` 左侧 7-tab nav (γ-1 主) · KPI 顶栏 primitive (γ-2 主)

### §七.2 · 上游 web/ UI 结构简读 (source: `web.py`)

上游 web 是 Python http.server 起本地服务 · 6 endpoints:
- `/api/report` · tab 1
- `/api/us-quality` · tab 2
- `/api/asia-markets` · tab 3
- `/api/multibagger` · tab 4
- `/api/backtest` · tab 5
- `/api/history` · tab 7
- 无 tab 6 独立 endpoint · tab 6 复用 tab 1 报告数据

**Delta vs 我方**: 我方走 Backend γ Go 服务 + REST · 与 Frontend γ+γ-2 分离 · v0.2 API shape 需重新设计 (与 Backend γ msg=30e0a4bc 已对齐)

---

## §八 · 契约喂送清单 (给下游 lane 消费 · v0.2 updated)

### §八.1 · 给 Strategy γ `contracts/scoring.md` v0.2

- §二.1 · `us_preferred` profile 权重 (Q0.20 G0.20 V0.15 M0.20 T0.15 R0.10)
- §二.2 · `multibagger` profile 权重 (Q0.10 G0.35 V0.10 M0.10 T0.20 R0.15) + market_cap sweet spot 函数 + OPTIONALITY_WORDS 23
- §二.2.3 · POSITIVE/NEGATIVE/EARLY_NEWS 词表 (Strategy 定期审计)
- §三.1 · Conviction 3-级映射: ≥ 75 → HIGH · 50–74.9 → MED · < 50 → LOW (**75/50 Strategy v0.2 canonical · 上游 70/55 已 demote 至 spec-only 对照**)
- §三.1 · Conviction shape: Adjustment[] Option A · len ≤ 5 · Σ delta ∈ [-20,+20] · evaluation-order-free · scoring_id + snapshot_hash v0.2 §2.1
- §三.2 · RiskGate **12** trigger codes canonical (9 US + 3 A股: ST_TAG block · PRICE_LIMIT_APPROACH warn · SUSPENDED block · **v0.2 LOCK 3 已采纳**)
- §三.2 · RiskGate Adjustment 联动: YELLOW → -5 · RED → -10 (Strategy §4.2 canonical)
- §三.3 · EntryPlan SizeHint 5-tier: **TIER_5 / TIER_3 / TIER_2 / TIER_1 / SKIP** (Refinement A · Strategy v0.2 canonical) + **disclaimer_key = `size_hint_advisory`** (Refinement B)
- §三.4 · Rating 5-tier Band A-F: **85/70/55/40 Strategy v0.2 canonical** (上游 Buy/Outperform/Neutral/Underperform/Avoid 76/68/58 已 demote 至 spec-only 命名对照)
- §三.4 · Rating 双粒度: `Score.band` (dimension/total canonical) + `CandidateListEntry.rating_band` (list envelope 只读镜像 · Refinement C)
- §六.4 · catalyst_kind **9**-枚举 (含 unclassified · **v0.2 LOCK 6 已采纳** · default_delta 三档 +5/+7/+3/0 · kind_multiplier 1.0/1.2/0.9/1.0)

### §八.2 · 给 DP γ `contracts/catalyst-mapping.md` v0.2

- §五.2 · 数据源栈完整 (US + CN + JP + KR + HK v0.3 pending)
- §五.3 · 采集频率 + 缓存策略 (Postgres 表 vs 上游 CsvCache)
- §六.3 · 5-分量相关性打分权重 (Strategy §3.7 canonical formula · 0.35/0.25/0.20/0.15/0.05 · sum=1.0)
- §六.4 · catalyst_kind **9**-枚举 (v0.2 含 unclassified · default_delta=0 · Sprint 2 GA backfill 归零)
- §七 · 7-tab 与后端 API endpoint 一一映射
- §三.1 · **scoring_id UUID + snapshot_hash SHA-256(JCS RFC 8785)** DP 存储层 `scoring_id UUID NOT NULL` + `score_snapshot_hash TEXT NOT NULL` 承接 (DP γ notes/180 v0.2 §6.2)

### §八.3 · 给 Backend γ `docs/refactor/29-api-catalyst900-mapping.md` v0.2

- §四.3 · tab 6 每日日报 API shape (`GET /api/v1/daily-report/:date` · REST 轮询 `/generate` + `/status?job_id` + `/:date`)
- §四.4 · tab 7 报告历史 API shape (`GET /api/v1/reports/history` + `/reports/:date`)
- §七 · 7-tab endpoint 全表 (v0.1 已锚定 · v0.2 shape 字段全补齐)
- §五.3 · Postgres 表新建 4 张 (`us_catalyst_event` · `a_share_candidate_mapping` · `jpkr_daily_kline` · `jpkr_disclosure_event`) + 建议补 1 张 (`daily_reports`)

### §八.4 · 给 QADocs γ `docs/refactor/27-catalyst900-tab-checklist.md` v0.2

- 全 § 全字段字典对齐
- §三.1 · Conviction 阈值 75/50 canonical (v0.2 LOCK 2) + Adjustment[] Option A (LOCK 1) + evaluation-order-free
- §三.2 · RiskGate **12** trigger 每 tab checkpoint (v0.2 LOCK 3 · Adjustment 联动 YELLOW -5/RED -10)
- §三.3 · EntryPlan SizeHint **TIER_5 / TIER_3 / TIER_2 / TIER_1 / SKIP** (Refinement A) + **disclaimer_key = `size_hint_advisory`** (Refinement B · Owner 免责铁律 msg=53b96525)
- §三.4 · Rating Band A-F 85/70/55/40 (LOCK 5) + 双粒度 `Score.band` / `rating_band` (Refinement C)
- §四.3 · tab 6 使用口径 5-条 (免责) 需 QADocs 补进 checklist + AI-γ 4 硬门 UI checkpoint
- §六.4 · catalyst_kind **9**-枚举 每 tab FilterChip 验收 checkpoint (含 unclassified · AI-γ pipeline 拒推荐硬门)
- §七 · 7-tab UI shell 与 Backend API 一致性验收 protocol
- v0.2 新增: **scoring_id/snapshot_hash 显式列** + **hash 校验按钮 (SHA-256 JCS)** + **免责措辞审计 (黑/白名单)** + **AI 8-阶段透明** + **回放字节级一致** + **dual-gate (GREEN + kind ≠ unclassified)**

### §八.5 · 给 Frontend γ+γ-2 shared primitive Props v0.2 + AI-γ `contracts/recommendation.md` v0.2

- §四.3 · DetailSidebar 消费字段 shape (rating Band A-F + conviction 3-级 HIGH/MED/LOW 75/50 + risk_gate 3-档 GREEN/YELLOW/RED 12-trigger + entryPlan 结构化 SizeHint {tier,pct,disclaimer_key} + dimensions 6-dim Q/G/V/M/T/R + scenario bull/base/bear)
- §五.2 · 上游 "娱乐观察" 表述 KEEP · tab 3 title 需明示
- §六.4 · FilterChip 消费 catalyst_kind **9**-枚举 (每 tab 复用 · 含 unclassified)
- §三.4 · **双粒度**: tab 表格列 `<TableColumn dataIndex="rating_band">` 消费 list envelope 只读镜像 · DetailSidebar `ScoreBreakdownCard` dimension 级 `Score.dims[i].band` + total 级 `Score.band` canonical
- §三.1 · **scoring_id + snapshot_hash** DetailSidebar 显式展示 + hash 校验 (SHA-256 JCS RFC 8785)
- AI-γ §六.3 · catalyst_kind 9-枚举 **unclassified 来源锚** = Research §S3 §六.3 + Strategy γ msg=ea939251 §二.2 canonical (Research §S3 副2 doc-tier 2-sign 承接 msg=e6c9f7f3 §12)

---

## §九 · 铁律 · 100% retain

- msg=53b96525 catalyst-900 anchor · msg=764688c1 参照锚 URL · msg=6dc1b5f3 v300 PIVOT
- msg=ad6585cf **借鉴独立性 · zero code-copy · spec-only cite** · 全部实现走我方 Go/TS 从零构建
- msg=4f6d2466 免费数据源 · Alpha Vantage + Baostock + Yahoo opt-in · Bloomberg/Wind/FnGuide 排除
- msg=a5297512 lane 契约 · Research §S3 SOLE `docs/refactor/26-catalyst900-spec-extract.md` (+ 本 workspace-draft agent-local)
- msg=ed61c397 workspace-draft-only · pending Sprint 1 末 Orch PR-CREATE-AUTHORIZE
- msg=d0d11677 self-merge 4-sign (code-tier) / doc-tier 2-sign · Research §S3 副签 doc-tier armed
- msg=eb4b0016 / msg=210d262d / msg=21867874 / msg=a8175861 perpetual-dispatch canonical · agents 不停
- msg=b091c74d SSH root永久禁 · msg=702b81be PG SELECT-only · 凭证 zero literal `sk_agent_<redacted>` shape
- Path D `9ec3f104e268a44f8fcfab6e0ae6905faa6b6ec3` byte-perfect preserve · 4-baseline `1f2d197a23c89eec23b5a5addc0e054974a6eaa5` byte-perfect · schema.prisma untouched (待 Orch PG-write 令 Sprint 2)
- US-038 SeededRandom only · jscpd ≤30% hard-gate · Math.random=0 SHA-256 deterministic
- 反-fabrication 铁律 · 所有引用源码模块 100% 来自 Fetched GitHub raw (scoring.py / us_quality.py / multibagger.py / asia_markets.py / report.py / cli.py / config.py / web.py / providers/akshare_provider.py / config/themes.json 前 60 行)
- 上游 repo 无 LICENSE 文件 · 我方 zero code-copy 严格约束 · 词表/算法 SEMANTIC ONLY
- **v0.2 新增** Strategy γ scoring v0.2 SOLE canonical 单点权威 (msg=3f7bfd3e) · `contracts/scoring.md` 为 Score/Band/Conviction/RiskGate/SizeHint/Rating 全域唯一 canonical source · Research §S3 引用值 demote 至 spec-only 上游对照 · zero re-litigate
- **v0.2 新增** 3 Refinement canonical LOCK (msg=3f7bfd3e downstream):
  - Refinement A: SizeHintTier `TIER_5|TIER_3|TIER_2|TIER_1|SKIP` (弃 T1_5/T2_3 系)
  - Refinement B: disclaimer_key `"size_hint_advisory"` (弃 SIZING_NOT_ORDER_V1)
  - Refinement C: `Score.band` dimension/total canonical + `CandidateListEntry.rating_band` list envelope 只读镜像 = entry.score.band · zero duplicate SoT
- **v0.2 新增** Orch v303 10 canonical LOCK (msg=f53c62a0): (1) Conviction Adjustment[] Option A (2) 阈值 75/50 (3) RiskGate 12-trigger (4) catalyst_kind→adjust 三档 (5) Rating 5 档 A-F (6) catalyst_kind 9-枚举含 unclassified (7) tab 6 REST 轮询 (8) Q1 权重可调 (9) Q4 SizeHint progress-bar (10) DetailSidebar sections slot

---

## §十 · v0.2 迭代路径

- **v0.1 (2026-07-10 LAND msg=645fc2a1)**: 6 block 全部 v0.1 完稿 · Strategy/DP/Backend/QADocs/Frontend 5 lane 契约喂送清单已备
- **v0.2 (本 draft · 2026-07-10 Strategy γ scoring v0.2 LAND +12h)**: 5-段 delta 消化 (§三.1 阈值 demote · §三.2 12-trigger + Adjustment 联动 · §三.4 Rating 5-tier 双粒度 · §六.3/§六.4 catalyst_kind 9-枚举 unclassified · §八 5-lane feed clist 更新) + 6-lane 消费方扩展 (+ AI-γ `contracts/recommendation.md` v0.2) + 3 Refinement A/B/C fold-in (SizeHintTier TIER 系 + size_hint_advisory + rating_band 双粒度) + scoring_id/snapshot_hash 全段标注
- **PR CREATE 时机**: Sprint 1 末 · Orch batch approve `PR-CREATE-AUTHORIZE` 后 · 走 doc-tier 2-sign gate (msg=d0d11677) · QADocs γ 副1 (msg=3024d5bd §十二 #5 explicit) + Research §S3 主签
- **v0.3 (Sprint 3 · Research §S4 联动)**: JP/KR profile (japan_blue_chip Q0.25 G0.15 · korea_semiconductor_chain Q0.15 G0.30) + multibagger profile refinement + HK 港股 stack 补录 + kind_auto_classifier GA 后 backfill 完形

**Research §S3 · v0.2 workspace-draft LAND · 5-段 delta 消化完稿 · 6 lane 契约喂送清单 v0.2 updated · Strategy γ SOLE canonical 100% 尊重 · agents 不停**
