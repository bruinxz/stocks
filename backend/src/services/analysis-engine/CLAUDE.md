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
- **`hard`** (US-021/AE-002 已落): 在 `shadow` 行为基础上 **追加** 调
  `archiveAnalysisEngineResult` 把决策落 `AIInvestmentSignal`
  (`source_type=AISignalSourceType.ANALYSIS_ENGINE`), 让
  `PaperTradingAutomationService.autoBuyFromSignals` 真的能跟单 +
  Dashboard / Attribution 看板可视化. archive 失败 fail-OPEN
  (仅 logger.warn 不阻塞主路径); shadow report 仍照写. 当前实现入口
  是 `ShadowDataSource.archiveHardSignal`, 生产实现委托
  `createProductionAnalysisEngineArchiveDataSource()` + `archiveAnalysisEngineResult`,
  测试可注入 fake 覆盖 ok/fail-open/throw 三路径.

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
- ~~替换 `AIInvestmentSignal.source_type='analysis_engine'` 由 hard 阶段才落, v1 不写.~~
  **2026-06-19 US-020 [AE-001] 起**: helper 已落 `analysisEngineSignalArchive.ts`,
  暴露 `archiveAnalysisEngineResult(source, input)` 主入口 + `AIInvestmentSignalService.archiveAnalysisEngineResult(input, source?)`
  薄 wrapper. Shadow mode 仍走 `ShadowDoubleRunService.persistShadowReport`
  写 `AIStockAnalysisReport` **不** 调本助手. Hard mode (US-021/AE-002) 才会同时调.

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
- `tests/services/analysis-engine/ShadowDoubleRunService.test.ts` — off/shadow/**hard** 三态全覆盖
  (US-021 [AE-002]: hard mode AC 主验收 双调 persistShadowReport+archiveHardSignal,
  archive 失败 fail-OPEN 不阻塞, archive throw 顶层 catch 吞错; META-GUARD fs+regex
  守 source 含 hard 分支 + 反向不再含 v1 仅 shadow 文案; 35 ok).
- `tests/services/analysis-engine/integration_300750.test.ts` — 端到端 mock fixtures.
- `tests/services/analysis-engine/newsAnalyzerKOL.test.ts` — US-036 [KOL-004]
  NewsAnalyzer 接 KOLAggregator 真输出: weightedAvgKOLSentiment (权威源主导) /
  buildKOLEvidenceDetail (top-N by authority × |sentiment|) / formatKOLSourceLabel
  (5 enum + fallback 'KOL') / toSixDigitStockCode (strip 交易所前缀) /
  KOL_SOURCE_LABEL 常量冻结 / AC 端到端 evidence + 加权与裸算术 avg 差异显著 /
  PRODUCTION 路径 dryRun:true 透传不触发 saveOpinions / META-GUARD 反向守
  KOL 段不再 `scored.reduce` 裸均值. 87 ok.

## NewsAnalyzer KOL 段约定 (US-036 [KOL-004])

- 入口 `NewsAnalyzerDataSource.aggregateKOLForStock(stockCode)` 返
  `NewsAnalyzerKOLRecord[]` (KOLOpinionRecord 子集), 必带 `kol_name` + `kol_source` +
  `sentiment_score`, 可选 `opinion_date` / `opinion_summary`.
- KOLAggregator 严格要求 6 位 stock_code — 调用前必须 `toSixDigitStockCode()` strip
  `sz.` / `sh.` / `bj.` / `SH` / `SZ` 前缀; 非法形态直接返 `[]` 入 data_missing 而非 throw.
- `aggregateForStock(code, { dryRun: true })` — analyzer 是只读端, 不应触发
  KOLAggregator.saveOpinions 落库; 旧实现传非法 option 走 persist 路径已修.
- 加权用 `authorityWeightedSentiment` (= |sentiment_score| × SOURCE_AUTHORITY[kol_source]),
  与 KOLAggregator dedupeAndSort / weightedAvgKOLSentiment / buildKOLEvidenceDetail 三处
  同源, 让 evidence top N 与加权 avg 的"信号主导项"完全一致 (研报 / 政策 自然排前).
- evidence detail 形态 `[研报] 中信证券:+0.80 | [政策] 国务院:+0.70 | [财经新闻] 财联社:-0.40`
  — tag 走 `formatKOLSourceLabel(kol_source)`, name 截 24 字符防爆, sentiment 显式带符号 +/-.
- 数据状态三态:
  - `kol.length === 0` → `data_missing.push('kol')` (无数据).
  - `kol.length > 0` 但 weightedAvgKOLSentiment 返 null (全 sentiment_score=null/0) →
    `data_missing.push('kol_sentiment_score')` (有数据无信号), 与"无 KOL 数据"区分.
  - 否则 `kolScore = clamp(avg * 80, -40, 40)` 占 0.25 权重.
- `tests/services/analysis-engine/analysisEngineSignalArchive.test.ts` — US-020 [AE-001]
  archiveAnalysisEngineResult 4 模块 99 ok (纯函数 helpers + DataSource DI 主入口 5 路径
  + service 集成 fs+regex + META-GUARD enum/Dashboard/Attribution 标签).

## `archiveAnalysisEngineResult` 调用约定 (US-020 [AE-001])

- 入参: `{decision, stock_name?, loop_run_id?, loop_policy_snapshot_id?,
  shadow_of_report_id?, market_environment?, extra_metadata?, dry_run?}`.
- source_id 命名: `${symbol}_${as_of}[_${loop_run_id}]` — 同 (symbol, as_of) 复跑 dedup 到同一行
  (findOrCreate path); 闭环对照 (AutomatedRecommendationLoop) 同一日多次重训用 `loop_run_id` 区分.
- metadata 保留 key: `paper_trading` + `paper_trading_by_portfolio` 由 PaperTradingFacade
  在 trade lifecycle 中回写, 重 archive 必须保留 (与 `archiveTradingAgentsResult` 同款).
- 返回: `{ok, reason?, signal?, created?, payload, error?}` — 4 种 reason: `dry_run` /
  `invalid_input` / `db_failure`; 调用方按业务决定 throw / log / skip, helper 自身不抛.

## hard mode 入口 (US-021 [AE-002])

`ShadowDoubleRunService` 在 `cfg.mode==='hard'` 时, 走完
`persistShadowReport` 之后追加调 `dataSource.archiveHardSignal(decision, prod_report_id, user_id)`.
默认 `PRODUCTION_SHADOW_DATA_SOURCE.archiveHardSignal` 用
`createProductionAnalysisEngineArchiveDataSource()` 构造生产 DataSource, 然后委托
`archiveAnalysisEngineResult` — extra_metadata 自动加
`{source_user_id, archived_from:'shadow_double_run_hard'}` 让下游 attribution
能区分 hard mode archive 与 AutomatedRecommendationLoop archive.

**边界**:
- `off` / `shadow` 模式完全不调 `archiveHardSignal`, 不污染 AIInvestmentSignal.
- archive ok=false (db_failure / invalid_input) 仅 logger.warn, 主路径 fail-OPEN.
- archive throw (lazy require 模块加载失败 / 其它意外) 被
  `PRODUCTION_SHADOW_DATA_SOURCE.archiveHardSignal` 内部 try/catch 转成
  {ok:false, reason:'db_failure'}; 测试 fake 直接 throw 则被 `runShadowAsync`
  顶层 catch 兜底 (返 null).
- 想完全替换 archive 路径 (e.g. shadow paper trader, integration 测) 实现自己的
  `ShadowDataSource` 注入 `new ShadowDoubleRunService(myDS)` 即可, 不要直接改
  `PRODUCTION_SHADOW_DATA_SOURCE`.

## hard 短路入口 (US-022 [AE-003])

`AIAdvisorService.analyzeSingleStock` 在调 TradingAgents 旧 5-维度路径之前先调
`maybeRunHardShortCircuit(PRODUCTION_HARD_SHORT_CIRCUIT_DATA_SOURCE, {stock_code, user_id, ...})`:

- `cfg.mode !== 'hard'` (off / shadow / 未知) → 返 null, caller 必须 fall-through 旧路径
  (shadow 仍由末尾 `shadowDoubleRunService.maybeRunShadow` trigger 处理, 本助手不接管).
- `cfg.mode === 'hard'` → 直接调 `AnalysisEngineService.analyzeStock` → 转
  `HardShortCircuitResult` (1:1 对齐 `AnalyzeSingleStockResult`) → 写
  `AIStockAnalysisReport(engine_variant='multi_dim_v1', shadow_of_report_id=null)` →
  调 `archiveAnalysisEngineResult` 写 `AIInvestmentSignal(source_type=ANALYSIS_ENGINE)` →
  caller 直接 `return hardResult`, 末尾 shadow trigger **整段跳过**, 不会双写 archive.
- `isAsync=true` 不走 hard 短路 (异步任务语义靠 TradingAgents). dry_run=true 跑完
  pure 转换但 **不** 写 report / 不 archive.

**与 ShadowDoubleRunService 边界**:

- shadow path **异步** 双跑 (旧路径主返 + 后台 setImmediate); hard path **同步** 接管.
- hard 模式下两者**不共存**: AIAdvisorService 见 `hardResult` 即 return, 末尾 shadow
  trigger 跳过, 所以 shadow 的 archiveHardSignal 在用户走 AIAdvisor 入口时不会触发.
- 但 PortfolioConstructionAdapter / 其它 caller 仍可独立走 ShadowDoubleRunService
  hard 分支, 两者各自有自己的 archive idempotency key (source_id = `${symbol}_${as_of}`
  夹 loop_run_id), 不会真重复.

**fail-OPEN 三层防御** (与 US-021 / US-018 同模式):
- helper 内 `try/catch` analyzeStock throw → 返 `status='failed'` result + error 字段
  (不静默 fallback 到 TradingAgents 否则破坏 hard 语义).
- persist throw → `metadata.save_error` + `persisted=false`, 仍返决策.
- archive throw / ok=false → 仅 `logger.warn` + `metadata.archive_error`.
- AIAdvisorService caller 自己再套一层 try/catch — helper 完全 crash 也 fall-through 旧路径 (生产 archive 写一行 audit 即可).

**接入新 caller** (未来若有别的服务想接 hard 短路, e.g. AutomatedRecommendationLoop):
1. Import `maybeRunHardShortCircuit` 与 `PRODUCTION_HARD_SHORT_CIRCUIT_DATA_SOURCE`.
2. 在 caller 的"调 TradingAgents 之前"加 `if (!isAsync) { const r = await maybeRunHardShortCircuit(...); if (r) return r; }`.
3. caller 自己套 try/catch 兜底 (helper crash 必须 fall-through, 不能阻塞主流程).
4. 更新 META-GUARD: 在 caller 对应单测加 fs+regex 守 import + 调用 + return short-circuit + 反向不再含 v1 仅 shadow 文案.
5. 若 caller 用自定义 `HardShortCircuitDataSource` (e.g. 集成测试注入 fake), `archiveHardSignal` 内的 fail-OPEN 三件套必须实现到位 (返 `{ok:false, reason}` 不 throw).

跑: `cd backend && npx ts-node --transpile-only tests/services/analysis-engine/<file>.test.ts`
或 `npm test` (runner 跑全部 .test.ts).
