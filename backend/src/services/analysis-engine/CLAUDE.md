# `backend/src/services/analysis-engine/` — 多维分析引擎 v1

8 个并发 analyzer + 1 个 aggregator, 替换 AIAdvisorService 的"假 5 维度"假象.
v1 shadow-only, 不破坏前端契约, 不替代组合级 `generateSignals`.

设计文档: `docs/audit/analysis_engine_design_2026_06_18.md`.
Runbook (灰度切量): `docs/audit/analysis_engine_runbook.md`.

## 模块边界

- 只做 **个股层的二次确认/解释**, 不替代组合级策略 (MFA / DragonHead / etc.).
- 输出 `RecommendationDecision`, 由调用方决定是否写 `AIInvestmentSignal` (hard 阶段).
- v1 通过 `ShadowDoubleRunService.maybeRunShadow()` 在 AIAdvisorService 末尾异步双跑;
  prod 主路径 (TradingAgents) 完全不动.
- **禁止编造数据 / 隐式 fallback 到中性 50 分**. 缺数据必须显式 `data_missing[]` +
  下调 confidence.

## 8 个 analyzer

| Key | 文件 | 复用 | 输出 score 范围 |
|---|---|---|---|
| fundamental | `analyzers/FundamentalAnalyzer.ts` | ValueFactor/Growth/Quality/.../EarningsSurprise + 同行业 peer rank | [-100,+100] |
| technical   | `analyzers/TechnicalAnalyzer.ts` | TechnicalAnalysisService.analyze (trend/RSI/MACD/量比) | [-100,+100] |
| capital     | `analyzers/CapitalAnalyzer.ts` | 7 个资金类 factor + bid/ask spread | [-100,+100] |
| news        | `analyzers/NewsAnalyzer.ts` | AnnouncementNLP + MarketNews + KOLAggregator | [-100,+100] |
| sentiment   | `analyzers/SentimentAnalyzer.ts` | EastMoneyQA/ConceptHeat/ShareholderConc + MarketSentimentIndex baseline | [-100,+100] |
| industry_regime | `analyzers/IndustryRegimeAnalyzer.ts` | MarketEnvironmentService + IndustryMomentumFactor | [-100,+100] |
| risk        | `analyzers/RiskAnalyzer.ts` | Liquidity/LowVol + isSTName + realtime_quote stale | [-100,+100], -80 触发 veto |
| event       | `analyzers/EventAnalyzer.ts` | EventIntelligenceLayer.filter (透传 veto/dampen/delay) | [-100,+100] |

## shadow mode 三态语义

三态写在 `User.risk_config.analysis_engine.mode`:

- **`off`** (默认): 完全走旧 `AIAdvisorService.analyzeSingleStock`. 引擎不消耗任何资源.
- **`shadow`**: 旧路径主返给前端; **异步** 调 `AnalysisEngineService.analyzeStock` 并写
  `AIStockAnalysisReport(engine_variant='multi_dim_v1', shadow_of_report_id=<prod_id>)`.
  不影响主路径; 错误吞掉. Dashboard 用 `engine_variant + shadow_of_report_id` 比对.
- **`hard`** (v1 不实现): 见 runbook W4+. 当前 ShadowDoubleRunService 收到 `hard`
  会 warn + 退化为 `shadow` 行为.

**怎么开**: 在 SettingsWorkspace (或 API `PUT /api/admin/...`) 改 user 的
`risk_config.analysis_engine = {mode:'shadow'}`. 必须 `user.changed('risk_config', true)`
后 save (US-017 JSONB 更新坑).

## 新加 analyzer 的 5 步流程

1. 在 `analyzers/` 下新建 `XxxAnalyzer.ts`, 继承 `BaseAnalyzer`, 实现 `run(ctx)`.
2. `requiredFields` 列表声明该 analyzer 的"必备字段" — `data_missing` ≥50% 时 confidence 归零.
3. 在 `AnalyzerTypes.ts` 把新 key 加到 `AnalyzerKey` union.
4. 在 `DecisionAggregator.DEFAULT_ANALYZER_WEIGHTS` 加权重, 同时下调老 analyzer 权重 (sum=1).
5. 在 `index.ts` 导出; 在 `AnalysisEngineService.allAnalyzers` 加默认实例; 写 1 个 happy + 1 个
   data_missing 单测.

## DataSource DI 模式

每个 analyzer 都有 `XxxSource` interface + `PRODUCTION_XXX_SOURCE` lazy-require 实现, 子类构造
函数可注入 fake (测试). 同 risk/ 与 advanced quant service 的 DI 范式.

## 禁止

- 编造数据 / 缺失字段隐式 fallback 到中性分.
- 修改前端 API schema (v1 不破坏 5 维度键名 + key_points 结构).
- 直接修改 18 个 factor 实现 (只复用).
- 在 analyzer 内部抛错 — 抛错由 `BaseAnalyzer` 捕获并转 `error` 字段.
- 改 `AIAdvisorService.analyzeSingleStock` 主路径 (只在末尾 1 行加 shadow trigger).
- 替换 `AIInvestmentSignal.source_type='analysis_engine'` 由 hard 阶段才落, v1 不写.

## 复用清单

- Factor library: `backend/src/quant/factors/library/` (18 个) → 直接读 FactorScore.z_score.
- `MarketEnvironmentService.getEnvironmentForStock()` → IndustryRegimeAnalyzer.
- `TechnicalAnalysisService.analyze()` → TechnicalAnalyzer + anchors.
- `AnnouncementNLPService.listByStock()` → NewsAnalyzer.
- `MarketNews` model → NewsAnalyzer.
- `KOLAggregatorService.aggregateForStock()` → NewsAnalyzer.
- `EastMoneyQATopicService` + `MarketSentimentIndexService` → SentimentAnalyzer.
- `EventIntelligenceLayer.filter()` → EventAnalyzer (1:1 透传).
- `isSTName` (`utils/stNameUtils.ts`) + `RealtimeQuote` model → RiskAnalyzer.
- `PortfolioConstructionAdapter` (off/shadow/hard 三态范式) → ShadowDoubleRunService.

## Aggregator 关键规则

- `data_quality=critical` → 直接 `hold`, overall_confidence=0.
- `event_action='veto'` 或 `RiskAnalyzer.score < -80` → 硬否决.
- `event_action='dampen'` → 加权 score × 0.5.
- 加权 score → action 映射: ≥60 strong_buy / ≥30 buy / ≥15 add / (-15,15) hold /
  (-30,-15] reduce / (-60,-30] sell / ≤-60 strong_sell.
- entry_zone: TechnicalAnalyzer.buy_zone + 涨跌停修正 (TODO: 等 ALPHA `marketLimits.ts`,
  暂用 inline 实现).
- stop_loss / take_profit: support[0]/resistance[0] 或 ATR×2/×3 兜底.

## 测试

- `tests/services/analysis-engine/types.test.ts` — 接口契约编译检查.
- `tests/services/analysis-engine/*Analyzer.test.ts` (8 个) — 每个 happy + data_missing 2 case.
- `tests/services/analysis-engine/DecisionAggregator.test.ts` — 5 case (veto/dampen/critical/各 action).
- `tests/services/analysis-engine/ShadowDoubleRunService.test.ts` — off/shadow path.
- `tests/services/analysis-engine/integration_300750.test.ts` — 端到端 mock fixtures.

跑: `cd backend && npx ts-node --transpile-only tests/services/analysis-engine/<file>.test.ts`
或 `npm test` (runner 跑全部 .test.ts).
