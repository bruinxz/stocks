# 多维分析引擎设计 — 替换 `AIAdvisorService.analyzeSingleStock` 固定流程

**生成日期**：2026-06-18
**worktree**：`.claude/worktrees/happy-torvalds-180c51`
**前置文档**：[closed_loop_architecture_2026_06_18.md](closed_loop_architecture_2026_06_18.md)、[closed_loop_audit_2026_06_18.md](closed_loop_audit_2026_06_18.md)
**Scope**：仅设计与对接方案 + shadow 迁移计划，**不含代码改动**。文档中所有"高风险/有歧义"决策点都标 ⚠️ 等待你确认后再进入实现。

---

## 0. 设计原则（不背离）

1. **不重写已有维度**：仓里已经成熟的 [MarketEnvironmentService](../../backend/src/services/MarketEnvironmentService.ts)、[EventIntelligenceLayer](../../backend/src/services/event-intelligence/EventIntelligenceLayer.ts)、[QuantRecommendationService.scoreStock](../../backend/src/services/QuantRecommendationService.ts)、[TechnicalAnalysisService](../../backend/src/services/TechnicalAnalysisService.ts)、18 个 factor、AnnouncementNLP / KOLAggregator / QATopic / EarningsForecastWatcher 全部**通过 adapter 复用**，不重新造 service。
2. **可插拔 + 可解释**：每个 analyzer 独立可开关；最终推荐必须能 100% 回溯到各 analyzer 的 evidence。
3. **shadow → 灰度 → 切量**：复用仓里成熟的 [`PortfolioConstructionAdapter`](../../backend/src/portfolio/internal/PortfolioConstructionAdapter.ts) 的 `off/shadow/hard` 三态模式（[portfolio/CLAUDE.md 与 §239-310](../../backend/src/portfolio/internal/PortfolioConstructionAdapter.ts)），不重新设计灰度。
4. **前端契约不破坏**：`AIStockAnalysisModal` 在 4 个 Workspace 都嵌入，新引擎必须**先维持 5 维度键名 + recommendation 枚举 + key_points record 结构**，前端零改动；待 shadow 跑稳后再做前端升级。
5. **缺数据显式标 `data_missing`**：禁止编造、禁止隐式 fallback 到"中性"分数误导决策。

---

## 1. 现状回顾 — "固定流程"具体长什么样

详见 [closed_loop_architecture_2026_06_18.md §3](closed_loop_architecture_2026_06_18.md)。一句话：

```
analyzeSingleStock(stockCode, options)
  └─ 1 次 POST {TRADING_AGENTS_URL}/api/analyze   (单次大 prompt)
  └─ buildKeyPoints(text)                          按 frozen 5 维度名做字段 split
  └─ 落 AIStockAnalysisReport
```

**核心问题**：5 维度是"假象"——一次大 prompt 拿到一段研报，本地 regex/字段映射拆成 5 块，**不是真的"5 个独立 analyzer 并发 + 加权"**。要替换的就是这层"假 5 维度"。

---

## 2. 新引擎架构

### 2.1 进程内拓扑

```
┌────────────────────────────────────────────────────────────────────┐
│  AnalysisEngineService.analyzeStock(stockCode, asOf, options)      │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Phase 1: Context Build                                     │   │
│  │   - 加载 Stock / DailyBar / RealtimeQuote                   │   │
│  │   - 加载 MarketEnvironmentSnapshot (复用现有)                │   │
│  │   - 加载 factor_scores(stock, as_of_date)                   │   │
│  │   - 数据质量评估 → DataQualityVerdict                       │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↓                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Phase 2: Parallel Analyzers (fan-out via Promise.all)      │   │
│  │   ┌────────────────────┬────────────────────┐               │   │
│  │   │ FundamentalAnalyzer│ TechnicalAnalyzer  │               │   │
│  │   │ CapitalAnalyzer    │ SentimentAnalyzer  │               │   │
│  │   │ NewsAnalyzer       │ IndustryRegimeAna. │               │   │
│  │   │ RiskAnalyzer       │ EventAnalyzer      │               │   │
│  │   └────────────────────┴────────────────────┘               │   │
│  │  Each → { score, evidence[], data_sources[], confidence,    │   │
│  │           as_of_ts, data_missing[]?, error? }               │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↓                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Phase 3: Aggregator (decision layer)                       │   │
│  │   - DecisionPolicy.aggregate(analyzers, marketEnv, dq)      │   │
│  │   - 输出 RecommendationDecision:                            │   │
│  │     { action, suggested_position_pct, entry_zone,           │   │
│  │       stop_loss, take_profit, key_reasons, risk_warnings,   │   │
│  │       overall_confidence, per_dimension }                   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ↓                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Phase 4: Persist & Bridge                                  │   │
│  │   - 写 AIStockAnalysisReport (engine_variant='multi_dim')   │   │
│  │   - 写 AIInvestmentSignal (source_type='analysis_engine')   │   │
│  │   - 暴露给 QuantRecommendationService /                     │   │
│  │     AutomatedRecommendationLoopService 复核                  │   │
│  └─────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心接口（不写实现，只定型）

```ts
// 新文件：backend/src/services/analysis-engine/AnalyzerTypes.ts (暂拟)

export type AnalyzerKey =
  | 'fundamental' | 'technical' | 'capital'
  | 'news' | 'sentiment' | 'industry_regime'
  | 'risk' | 'event';

export interface AnalyzerContext {
  stock: { code: string; name: string; industry: string; market_segment: 'main'|'chinext'|'star'|'bj' };
  as_of: string;          // YYYY-MM-DD
  daily_bars: DailyBar[]; // 截止 as_of 收盘后
  realtime_quote?: RealtimeQuote;
  market_env: MarketEnvironmentSnapshot;          // 复用现有 service
  factor_snapshot: Record<string, number | null>; // 复用 factor_scores
  user_profile?: UserRiskProfile;
}

export interface AnalyzerOutput {
  analyzer_key: AnalyzerKey;
  score: number;          // 标准化 [-100, +100]，负=利空，正=利多
  evidence: Array<{
    label: string;        // 中文短描述："PE-TTM 15.3，低于行业中位数 24.1"
    detail?: string;
    metric_value?: number;
    threshold?: number;
    direction: 'bullish'|'bearish'|'neutral';
    weight: number;       // 该 evidence 在本 analyzer 内的相对权重 [0,1]
  }>;
  data_sources: Array<{ name: string; as_of: string; is_realtime: boolean }>;
  confidence: number;     // [0, 1]
  data_missing?: string[];// 显式枚举缺失字段，禁止隐式 fallback
  error?: { code: string; message: string };
  elapsed_ms: number;
}

export interface RecommendationDecision {
  action: 'strong_buy'|'buy'|'add'|'hold'|'reduce'|'sell'|'strong_sell';
  suggested_position_pct: number;       // 来自 PositionSizingPolicy
  entry_zone: [number, number] | null;  // 含涨跌停修正
  stop_loss: number | null;
  take_profit: number | null;
  key_reasons: string[];                // 来自 evidence 排序 top N
  risk_warnings: string[];              // 来自 RiskAnalyzer + EventAnalyzer veto/dampen
  overall_confidence: number;
  per_dimension: AnalyzerOutput[];      // 完整回溯
  data_quality: DataQualityVerdict;
  engine_variant: 'multi_dim_v1';
  shadow_of_report_id?: string;         // 双跑对比时填
}
```

### 2.3 每个 Analyzer 的"复用 ≥ 新建"映射

| Analyzer | 复用的现有 service / factor | 新加的最小逻辑 |
|---|---|---|
| **FundamentalAnalyzer** | [ValueFactor](../../backend/src/quant/factors/library/ValueFactor.ts) + [GrowthFactor](../../backend/src/quant/factors/library/GrowthFactor.ts) + [QualityFactor](../../backend/src/quant/factors/library/QualityFactor.ts) + [QualityHighFactor](../../backend/src/quant/factors/library/QualityHighFactor.ts) + [AnalystConsensusFactor](../../backend/src/quant/factors/library/AnalystConsensusFactor.ts) + [EarningsSurpriseFactor](../../backend/src/quant/factors/library/EarningsSurpriseFactor.ts) + `FinancialReport` 模型 | 把因子分数转 [-100,100] + evidence 中文化 + 同行业 peer rank（缺 §3.1） |
| **TechnicalAnalyzer** | [TechnicalAnalysisService](../../backend/src/services/TechnicalAnalysisService.ts)（含 NLP fallback）+ [QuantMath](../../backend/src/quant/engine/QuantMath.ts)（ATR/RSI/MACD/布林） | 把 `TechnicalAnalysisResult` 直接转 evidence；支持/压力位作为 entry/stop 锚点 |
| **CapitalAnalyzer** | [NorthboundFactor](../../backend/src/quant/factors/library/NorthboundFactor.ts) + [MoneyFlowFactor](../../backend/src/quant/factors/library/MoneyFlowFactor.ts) + [InsiderTradeFactor](../../backend/src/quant/factors/library/InsiderTradeFactor.ts) + [MarginFlowFactor](../../backend/src/quant/factors/library/MarginFlowFactor.ts) + [DragonTigerFactor](../../backend/src/quant/factors/library/DragonTigerFactor.ts) + [BlockTradeSignalFactor](../../backend/src/quant/factors/library/BlockTradeSignalFactor.ts) + [FundConsensusFactor](../../backend/src/quant/factors/library/FundConsensusFactor.ts) + bid/ask（[ExecutionFeasibilityService](../../backend/src/services/execution/ExecutionFeasibilityService.ts)） | 5 路资金分子分数合成 + spread 健康度 |
| **NewsAnalyzer** | [AnnouncementNLPService.listByStock](../../backend/src/services/AnnouncementNLPService.ts) + `MarketNews` 模型 + [KOLAggregatorService](../../backend/src/services/KOLAggregatorService.ts) | 取最近 N 条公告 + 新闻 → 按 sentiment 加权；阳光化 `nlp_engine` 来源 |
| **SentimentAnalyzer** | [EastMoneyQATopicService](../../backend/src/services/EastMoneyQATopicService.ts) + [EastMoneyQAFactor](../../backend/src/quant/factors/library/EastMoneyQAFactor.ts) + [ConceptHeatFactor](../../backend/src/quant/factors/library/ConceptHeatFactor.ts) + [ShareholderConcentrationFactor](../../backend/src/quant/factors/library/ShareholderConcentrationFactor.ts) + [MarketSentimentIndexService](../../backend/src/services/MarketSentimentIndexService.ts)（市场级） | 个股情绪 vs 市场情绪的 z-score |
| **IndustryRegimeAnalyzer** | [MarketEnvironmentService.getEnvironmentForStock](../../backend/src/services/MarketEnvironmentService.ts) `industry / breadth / regime` 子结构 + [IndustryMomentumFactor](../../backend/src/quant/factors/library/IndustryMomentumFactor.ts) + [RegimeProbabilityService](../../backend/src/services/regime/RegimeProbabilityService.ts) | 把 regime 概率 + 行业 hot/warm/cold 映射为 score |
| **RiskAnalyzer** | [LiquidityFactor](../../backend/src/quant/factors/library/LiquidityFactor.ts) + [LowVolFactor](../../backend/src/quant/factors/library/LowVolFactor.ts) + [Stock.is_suspended](../../backend/src/models/Stock.ts) + `stNameUtils.isSTName` + [RestrictedShareWatchdog](../../backend/src/portfolio/risk/RestrictedShareWatchdog.ts) | 输出 negative score；触发 veto/dampen 走 EventAnalyzer |
| **EventAnalyzer** | [EventIntelligenceLayer.filter](../../backend/src/services/event-intelligence/EventIntelligenceLayer.ts)（已是 6 类事件 → 5 种 MetaFilterAction） | 直接把 `MetaFilterResult` 转 evidence + 把 `action: 'veto'/'dampen'/'delay'` 透传给 aggregator |

**结论**：8 个 analyzer 里 6 个是"薄 adapter + 中文化"，2 个（Fundamental peer rank、Capital spread）需要新增少量计算逻辑。**不写新数据源、不接外部新服务**。

---

## 3. 缺口与是否补齐

按 [closed_loop_architecture_2026_06_18.md §6](closed_loop_architecture_2026_06_18.md) 列的 7 个缺口：

| 缺口 | 是否在 v1 补 | 原因 |
|---|---|---|
| 板块行情联动 / 概念板块强弱 | **延后到 v2** | 当前 IndustryRegime + ConceptHeat 已基本够用；v2 再加"同板块龙头共振" |
| 真实交易数据 / level-2 | **不在范围** | 数据源缺失，禁止编造；显式 `data_missing: ['level2_orderbook']` |
| **同业 peer comparison** | **v1 必补** | FundamentalAnalyzer 没有 peer rank 就只是因子值，无解释力 |
| 业绩日历 / 解禁日历 | **v1 部分补** | EventAnalyzer 已用 `EarningsForecast / RestrictedShareWatchdog`，作为 evidence；不新增数据源 |
| 筹码结构 / 成本分布 | **延后到 v2** | 缺数据源 |
| 风险敞口的 stress-test 入个股 | **延后到 v2** | 当前 RiskAnalyzer 已够 v1 用 |
| **AI 引擎可替换性 + shadow** | **v1 核心** | 见 §4 |

---

## 4. Shadow → 灰度 → 切量计划（复用 PortfolioConstructionAdapter 模板）

### 4.1 三态模式

```ts
type EngineMode = 'off' | 'shadow' | 'hard';

// 落 User.risk_config.analysis_engine = {
//   mode: 'shadow',
//   enabled_analyzers: ['fundamental','technical', ...],
//   aggregator_policy: 'weighted_v1',
// }
```

- `off`：完全走旧的 `analyzeSingleStock`（默认）。
- `shadow`：旧的 `analyzeSingleStock` 仍是主路径返回给前端；同时**异步**调新引擎，结果写 `AIStockAnalysisReport(engine_variant='multi_dim_v1', metadata.shadow_of_report_id=<prod_id>)`，不影响下游决策。
- `hard`：新引擎结果是主路径；旧路径降级为 fallback。

### 4.2 Schema 改动（**S 级，⚠️ 等你确认**）

`AIStockAnalysisReport` 加两列（[backend/src/models/AIStockAnalysisReport.ts:55-198](../../backend/src/models/AIStockAnalysisReport.ts)）：

```sql
ALTER TABLE ai_stock_analysis_reports
  ADD COLUMN engine_variant VARCHAR(40) NOT NULL DEFAULT 'tradingagents_legacy',
  ADD COLUMN shadow_of_report_id VARCHAR(100) NULL;

CREATE INDEX idx_ai_reports_variant ON ai_stock_analysis_reports(engine_variant);
CREATE INDEX idx_ai_reports_shadow_of ON ai_stock_analysis_reports(shadow_of_report_id);
```

`AIInvestmentSignal.source_type` 加新枚举 `'analysis_engine'`（[backend/src/models/AIInvestmentSignal.ts:23-27](../../backend/src/models/AIInvestmentSignal.ts) UNIQUE(source_type, source_id) 兼容）。

### 4.3 灰度切量流程（建议）

```
W0  (准备)     新引擎代码上线 + schema migration + mode=off（默认）
W1-W2 (shadow) 5% 用户开 mode=shadow，看 dashboard:
                - 与 prod 决策一致率
                - 平均 confidence
                - 各 analyzer error_rate
                - 推荐买入命中率（join verifySignalReturns horizon=5d）
W3   (扩 shadow) 50% 用户 shadow，确认 latency 不影响主链路
W4   (hard 灰度) 5% 用户开 mode=hard
W5-W6 (扩 hard) 50% → 100%
W7   (清理)    删除旧 buildKeyPoints 路径，TradingAgents 降级为 NewsAnalyzer/TechnicalAnalyzer 内部的可选 NLP 子组件
```

回滚开关：随时改 `User.risk_config.analysis_engine.mode = 'off'` 即可，无需重启。

### 4.4 Shadow Dashboard（最小集）

- 新增前端 page `frontend/src/pages/admin/AnalysisEngineShadowDashboard.tsx`（待你确认是否需要管理后台权限）
- 后端聚合接口 `GET /api/admin/analysis-engine/shadow-stats`，返回：
  - `consistency_rate{action_class}`：buy_class（strong_buy+buy+add）↔ hold ↔ sell_class 的一致率
  - `analyzer_health{analyzer_key}`：error_rate / mean_confidence / data_missing_rate
  - `forward_return_horizon=5d` join `AIInvestmentSignal.forward_returns`

---

## 5. 与闭环对接

### 5.1 信号桥接

新引擎产出的 `RecommendationDecision` 通过 [AIInvestmentSignalService.archiveTradingAgentsResult](../../backend/src/services/AIInvestmentSignalService.ts) **同款写法**写 `AIInvestmentSignal`：
- `source_type = 'analysis_engine'`
- `source_id = '${stock_code}-${as_of}-${engine_variant}'`
- `decision / normalized_decision / confidence_score / risk_level / rationale / detail` 对齐现有字段
- `metadata = { per_dimension, data_quality, shadow_of_report_id }`

下游 [AutomatedRecommendationLoopService](../../backend/src/services/AutomatedRecommendationLoopService.ts) 不需要改 schema，已经按 `AIInvestmentSignal.normalized_decision` 路由。**只在 `mode='hard'` 时，新引擎的 signal 才会被自动跟单流读取**。

### 5.2 字段映射（关键，确保闭环不漂移）

| 闭环字段 | 新引擎来源 | 备注 |
|---|---|---|
| `normalized_decision` | `decision.action` 直接 1:1 | 已对齐 enum |
| `confidence_score` | `decision.overall_confidence × 100` | [0,1] → [0,100] |
| `risk_level` | 根据 `RiskAnalyzer.score` 分桶 | < -50 → 高，[-50,-20) → 中，≥ -20 → 低 |
| `forward_returns` | 由 `verifySignalReturns` 异步回填 | 不变 |
| 建议仓位 | `decision.suggested_position_pct` 调用 [PositionSizingPolicy](../../backend/src/portfolio/PositionSizingPolicy.ts) | **不绕过现有 sizing policy**，保证 hard cutover 后总仓位上限仍受控 |
| stop_loss / take_profit | `decision.stop_loss / take_profit` | 由 `PaperTradingAutomationService` 在 createBuyTrade 时落到 position |

### 5.3 与"组合级 generateSignals"的关系

⚠️ **此处与阶段一 S-1 紧密相关**：
- 当前 MFA / DragonHead 等组合级策略走 [QuantSignalService.runCompositeStrategies](../../backend/src/quant/engine/internal/QuantSignalService.ts)，**不经过 AI 分析层**。
- 新引擎不替代组合级策略，**它是个股层的解释/二次确认**。
- 闭环里推荐 = 组合级策略产出 ∪ 新引擎产出（按 `loop_run_id` 关联）。AutomatedRecommendationLoop 已是这个范式。

---

## 6. 缺数据时的行为契约（禁止编造）

| 场景 | 行为 |
|---|---|
| 某 factor_score 字段缺失 | analyzer 的 `data_missing` 加该字段名；不参与加权；confidence 按比例下调 |
| TradingAgents 不可用（NewsAnalyzer 用） | 回退到 `heuristic_fallback`（已存在），evidence 标 `data_sources[].name='heuristic'`，confidence × 0.5 |
| 行情陈旧 > 30min | RiskAnalyzer 输出 `score = -100, action_hint='veto', reason='stale_quote'`，aggregator 直接 `action='hold'` |
| 停牌 / 退市 / ST 名称匹配 | EventAnalyzer `veto`，aggregator `action='sell'`（如有持仓）或 `hold`（无持仓） |
| factor_scores 整表当日未生成 | analyzer 抛 `DataQualityCriticalError`，引擎返回 `status='failed'` + report 写入失败原因，**不假装产出推荐** |

---

## 7. 迁移与回滚

### 7.1 平滑迁移 checklist

1. ⚠️ Schema migration（4.2）落库（先 dev → staging → prod）。
2. 新代码上线，`mode=off` 默认；旧 `analyzeSingleStock` 完全不动。
3. 开 5% 用户 shadow → 看 dashboard 7 天 → 扩到 50%。
4. 7 天后看 forward_return horizon=5d 命中率：新引擎 ≥ 旧 + 5pp → 可以推进 hard 灰度。
5. hard 灰度 1 个月，确认无重大事故 → 全量切。
6. 旧 `buildKeyPoints` 路径标 `@deprecated`，3 个 sprint 后删除。

### 7.2 回滚

任何一步发现问题：`UPDATE users SET risk_config = jsonb_set(risk_config, '{analysis_engine,mode}', '"off"')` 即可降级。不需要回滚代码或 schema。

### 7.3 与前端的契约

**v1（shadow + hard 灰度期）**：
- 后端返回 schema 维持 `AIStockAnalysisReport` 现状（dimensions / key_points / summary / recommendation / confidence_score / risk_level）。
- 新增字段全在 `metadata` 里（`engine_variant`、`per_dimension`、`data_quality`），前端 v1 不读。

**v2（hard 全量后）**：
- 增加前端 page / 升级 `AIStockAnalysisModal`：展示 per_dimension 的 evidence 列表（"为什么这只股推荐买"可视化），消费 `metadata.per_dimension`。

---

## 8. 风险清单与确认事项

⚠️ 下列项目我需要你明确同意后再进入实现阶段：

| # | 决策点 | 推荐 | 等你确认 |
|---|---|---|---|
| 1 | 是否同意把"AI 个股分析"作为**个股层的二次确认/解释**，不去替代组合级 `generateSignals` 策略 | ✅ | yes/no |
| 2 | 是否同意复用 `PortfolioConstructionAdapter` 的 off/shadow/hard 三态模式 | ✅ | yes/no |
| 3 | 是否同意改 `AIStockAnalysisReport` schema（加 `engine_variant` + `shadow_of_report_id`） | ✅ | yes/no（涉及 migration） |
| 4 | 是否同意 v1 不打破前端契约（5 维度键名 + key_points 结构维持）；前端 v2 再升级 | ✅ | yes/no |
| 5 | 是否同意"缺数据显式 data_missing + confidence 下调"而不是"假装中性 50 分" | ✅ | yes/no |
| 6 | 是否同意把 TradingAgents 在 v2 降级为 NewsAnalyzer/TechnicalAnalyzer 的可选子组件（**不是删掉**） | ✅ | yes/no |
| 7 | 是否同意 Aggregator 把 RiskAnalyzer 的 veto / EventAnalyzer 的 veto 当**硬否决**（不是加权平均） | ✅ | yes/no |
| 8 | 新引擎建议落到 `backend/src/services/analysis-engine/` 还是扩 `backend/src/services/research/` | 前者，更隔离 | 你定 |
| 9 | 灰度切量节奏（默认 W0→W7 ≈ 7 周）是否合理？要不要更激进/保守 | W0→W7 7 周 | 你定 |
| 10 | 阶段二的样本股选哪只？建议沪深主板各 1 只 + 1 只创业板（避开北交所）。具体股票代码？ | 例如 600519/000858/300750 | 你定 |

---

## 9. 阶段二交付物（待我确认实现后才动手）

待 §8 全部 yes 后，按下列顺序产出：

1. `backend/src/services/analysis-engine/AnalyzerTypes.ts`（接口定义）
2. `backend/src/services/analysis-engine/AnalysisEngineService.ts`（编排器 + Phase 1/3/4）
3. `backend/src/services/analysis-engine/analyzers/`：8 个 analyzer 文件
4. `backend/src/services/analysis-engine/DecisionAggregator.ts`
5. `backend/src/services/analysis-engine/ShadowDoubleRunService.ts`（mode='shadow' 时的异步双跑）
6. schema migration 文件
7. unit test：每个 analyzer 1 个 happy + 1 个 data_missing case；aggregator 5 case；shadow path 1 case
8. 集成 test：1 只样本股端到端 1 个分析全链路 → 写库 → 取出验证
9. 文档：`docs/audit/analysis_engine_runbook.md`（shadow dashboard 怎么看、灰度怎么推、回滚怎么做）
10. 至少 1 只样本股的**真实输出快照**（含 8 个 analyzer 的 evidence）作为 PR 附件

---

## 10. 与本仓库已有模式/规范对齐

- 服务命名：`AnalysisEngineService` 与 [AIAdvisorService](../../backend/src/services/AIAdvisorService.ts)、[QuantRecommendationService](../../backend/src/services/QuantRecommendationService.ts) 等同 camel + 单例 export 风格。
- 错误类：复用 [backend/src/utils/errors.ts](../../backend/src/utils/errors.ts) 的 `DomainError` 体系。
- 日志：复用 [backend/src/utils/logger.ts](../../backend/src/utils/logger.ts) 的 winston logger；每个 analyzer 一个 child logger。
- 指标：Prometheus 注册到 [backend/src/metrics/PrometheusRegistry.ts](../../backend/src/metrics/PrometheusRegistry.ts)。
- OpenAPI：新接口（若有 admin 用 dashboard 用）同步更新 [docs/openapi.json](../openapi.json)。
- 模块级文档：在 `backend/src/services/analysis-engine/CLAUDE.md` 写 ≤ 200 行说明（参考 [backend/src/services/CLAUDE.md](../../backend/src/services/CLAUDE.md) 风格）。

---

**下一步**：等你回答 [closed_loop_architecture §8](closed_loop_architecture_2026_06_18.md) 的 8 个问题 + 本文 §8 的 10 个问题（共 18 个）。所有问题都答完后，我会按顺序进入阶段一/阶段二的实现，每个高风险改动落地前再单独跟你确认一次。
