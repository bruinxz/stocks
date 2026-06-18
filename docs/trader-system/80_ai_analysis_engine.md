# 80 — AI 多维分析引擎 v2（基于 GAMMA v1 + Hard Cutover + 前端升级）

## A. 操盘手心智

"为什么买这只票？为什么卖？为什么不动？"——一个高级操盘手对每一笔交易要能说出 3 条以上理由，且**每条都能追溯到具体数据点**。

AIAdvisorService 原本走 TradingAgents "一次大 prompt → 拿一段研报 → regex 拆 5 段"——5 段只是字段映射的"伪 5 维"。GAMMA v1 把它换成"8 个并发 analyzer + 1 个 aggregator"才是真的多维分析。

v1 已经就绪（shadow），v2 要做的：
1. **Hard cutover**：让 v1 真上场，AIInvestmentSignal 真桥接
2. **前端升级**：AIStockAnalysisModal 从"5 段 keyPoints"升级到"8 维 evidence + 加权可视化"
3. **6 项增强**：peer rank、同板块龙头共振、entry/stop 精算、ATR 调整、置信度分层、缺数据 UI 提示

---

## B. 系统设计

### B.1 v2 三件大事

```
1. Hard cutover 桥接
   AIAdvisorService.analyzeSingleStock(mode='hard')
     └─→ 直接 return AnalysisEngineService.analyzeStock 结果
     └─→ AIInvestmentSignalService.archiveAnalysisEngineResult(decision)
         → 写 AIInvestmentSignal(source_type='analysis_engine')
     └─→ AutomatedRecommendationLoopService 在 mode='hard' 时把 signal 自动跟单

2. 前端升级
   AIStockAnalysisModal v2:
     - 顶部: action chip + overall_confidence ring + risk_level tag
     - 左列: 8 个 analyzer score bar (彩色 + 透明度=confidence)
     - 中列: per-dimension evidence 列表（折叠展开）
     - 右列: entry_zone / stop_loss / take_profit / suggested_position_pct
     - 底部: data_missing 黄色 banner + data_quality verdict

3. 6 增强
   (a) FundamentalAnalyzer 加 peer rank（同行业百分位）
   (b) IndustryRegimeAnalyzer 加"同板块龙头共振"（hot 板块 + 龙头是否同步走强）
   (c) TechnicalAnalyzer 加 entry_zone 精算 = max(support[0], 涨跌停下限)
   (d) RiskAnalyzer 加 ATR-adjusted stop（atr × 2 / 3 兜底）
   (e) Aggregator 加 confidence 分层 (≥0.8 high / [0.5,0.8) medium / <0.5 low)
   (f) data_missing 不再被忽略 → UI 黄色提示 + 用户可一键"补数据"重跑
```

---

## C. 现状 review

### C.1 GAMMA v1 已就绪

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/services/analysis-engine/AnalysisEngineService.ts` | — | ✅ 编排器：Phase 1 context build / Phase 2 fan-out 8 analyzer / Phase 3 aggregator / Phase 4 persist |
| `backend/src/services/analysis-engine/analyzers/FundamentalAnalyzer.ts` | — | ✅ 复用 Value/Growth/Quality/AnalystConsensus/EarningsSurprise factor |
| `backend/src/services/analysis-engine/analyzers/TechnicalAnalyzer.ts` | — | ✅ 复用 TechnicalAnalysisService.analyze |
| `backend/src/services/analysis-engine/analyzers/CapitalAnalyzer.ts` | — | ✅ Northbound/MoneyFlow/Insider/Margin/DragonTiger/BlockTrade + bid/ask spread |
| `backend/src/services/analysis-engine/analyzers/NewsAnalyzer.ts` | — | ✅ AnnouncementNLP + MarketNews + KOLAggregator |
| `backend/src/services/analysis-engine/analyzers/SentimentAnalyzer.ts` | — | ✅ EastMoneyQA + ConceptHeat + ShareholderConc + MarketSentimentIndex |
| `backend/src/services/analysis-engine/analyzers/IndustryRegimeAnalyzer.ts` | — | ✅ MarketEnvironmentService + IndustryMomentumFactor |
| `backend/src/services/analysis-engine/analyzers/RiskAnalyzer.ts` | — | ✅ Liquidity/LowVol + isSTName + realtime_quote stale; -80 触发 veto |
| `backend/src/services/analysis-engine/analyzers/EventAnalyzer.ts` | — | ✅ EventIntelligenceLayer.filter 透传 veto/dampen/delay |
| `backend/src/services/analysis-engine/DecisionAggregator.ts` | — | ✅ DEFAULT_ANALYZER_WEIGHTS + veto/dampen 规则 |
| `backend/src/services/analysis-engine/ShadowDoubleRunService.ts` | — | ✅ off/shadow 三态；hard 退化 shadow |
| `backend/src/services/analysis-engine/DataQualityVerdict.ts` | — | ✅ data quality 评估 |
| `backend/src/services/analysis-engine/CLAUDE.md` | 1-103 | ✅ 模块文档完整 |
| schema | — | ✅ ai_stock_analysis_reports 加 engine_variant + shadow_of_report_id |

### C.2 v1 → v2 缺口

1. **hard mode 未实现**：`ShadowDoubleRunService` 收到 `hard` 会 warn + 退化 shadow（GAMMA 设计就这样，是 v2 工作）
2. **AIInvestmentSignal 没桥接**：`AIInvestmentSignalService.archiveTradingAgentsResult` 没有 `archiveAnalysisEngineResult` 对应方法
3. **前端 Modal 未升级**：`frontend/src/components/trading/AIStockAnalysisModal.tsx:1-296` 仍按旧 5 dimensions/keyPoints 结构展示；metadata.per_dimension 完全不读
4. **Fundamental peer rank 缺**：CLAUDE.md 第 22 行明确"+ 同行业 peer rank"，但实际 analyzer 实现需 review 是否已包含
5. **entry_zone 涨跌停修正**：CLAUDE.md 第 89 行写 "TODO: 等 ALPHA marketLimits.ts，暂用 inline 实现" — 现在 marketLimits.ts 已就绪，可以接上
6. **shadow dashboard 没前端 page**：implementation_summary 第 145 行明确 "暂无前端 page，可用 curl 或 Postman 看；v2 排前端"
7. **没有"用户调权"机制**：8 个 analyzer 的权重对所有用户一致（DEFAULT_ANALYZER_WEIGHTS）；不同风格用户应该可调
8. **缺"同板块龙头共振"分析**：design 第 158 行写"延后 v2"

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| AE-001 | 在 `AIInvestmentSignalService.ts` 新增 `archiveAnalysisEngineResult(decision)`：写 `source_type='analysis_engine'` | P0 | — |
| AE-002 | `ShadowDoubleRunService` 实现 `hard` 分支：mode='hard' 时调 AnalysisEngineService 主路径 + 写 AIInvestmentSignal + 返回 decision 转 AnalyzeSingleStockResult 给前端 | P0 | AE-001 |
| AE-003 | `AIAdvisorService.analyzeSingleStock` 在 mode='hard' 时短路：直接调 AnalysisEngineService.analyzeStock 并返回；mode='off'/'shadow' 走旧 + shadow | P0 | AE-002 |
| AE-004 | `AutomatedRecommendationLoopService` 检测到 `source_type='analysis_engine'` 的 signal 走"hard cutover"分支自动跟单 | P0 | AE-001 |
| AE-005 | 前端 `AIStockAnalysisModal.tsx` v2：读 `metadata.per_dimension` + `metadata.data_quality` + `metadata.engine_variant`；3 列布局（score bar / evidence / action plan） | P0 | — |
| AE-006 | 前端新增组件 `AnalyzerScoreBar.tsx`：水平 bar (-100 → +100) + analyzer name + score 数字 + 透明度=confidence | P0 | AE-005 |
| AE-007 | 前端新增组件 `EvidenceList.tsx`：分组展示 8 dimension evidence；每条含 label / direction icon / 数据来源 tag | P0 | AE-005 |
| AE-008 | 前端 `data_missing` UI：黄色 banner 列出缺的字段 + 提供"重跑分析"按钮 | P1 | AE-005 |
| AE-009 | FundamentalAnalyzer 加 `peerRank`：同行业 PE/PB/ROE 百分位 → evidence 含"PE-TTM 15.3，行业 35 分位" | P1 | — |
| AE-010 | TechnicalAnalyzer 的 entry_zone 接 `marketLimits.ts`：替换 inline 实现 | P1 | — |
| AE-011 | IndustryRegimeAnalyzer 加 `dragonResonance`：同板块龙头是否同步走强（行业内市值 top 3 是否 5d return > 5%） | P1 | — |
| AE-012 | DecisionAggregator 增加 `confidence_tier`: high/medium/low 字段；高 = ≥0.8 / 中 = [0.5,0.8) / 低 = <0.5 | P1 | — |
| AE-013 | User.risk_config.analysis_engine 增加 `analyzer_weights: Record<AnalyzerKey, number>` 字段；Aggregator 优先用用户设置 | P2 | — |
| AE-014 | 前端 SettingsWorkspace 新增"分析引擎权重调整"tab：让 power user 调 8 dimension 权重（slider，sum=1 自动归一） | P2 | AE-013 |
| AE-015 | 前端新增 admin page `AnalysisEngineShadowDashboard.tsx`：调 `/api/admin/analysis-engine/shadow-stats`；展示 consistency_rate / analyzer_health / 5d forward return | P1 | — |
| AE-016 | RiskAnalyzer 增加 ATR-adjusted stop：stop_loss = max(support[0], close - 2 × ATR) | P1 | — |
| AE-017 | 集成测试：3 只样本股（600519/000858/300750）端到端 v2 hard 跑 → 比对 shadow 一致率 ≥ 80% | P0 | AE-002 |
| AE-018 | RecommendationTradeOutcomeService 增加 `engine_variant` 标记：v1 vs v2 outcomes 可分组对比 forward_return | P2 | AE-001 |

---

## E. 验收口径

1. 切 mode='hard' 后，`AIStockAnalysisReport` 的 engine_variant='multi_dim_v1' 占比 > 80%
2. AIInvestmentSignal 表里出现 source_type='analysis_engine' 的记录
3. 前端 Modal 展示 8 dimension score bar + evidence；旧 5 维度键名只在兼容层保留
4. 至少 3 只样本股的 v2 输出包含 peer rank + ATR-adjusted stop + 涨跌停修正后的 entry_zone
5. data_missing 字段在 UI 显示黄色 banner，用户能 click 重跑
6. shadow dashboard 前端 page 可用，能看到 consistency_rate 趋势图
7. 5d forward return：v2 ≥ v1 + 3pp（推 hard 切量的前置条件）
8. 用户调权后，aggregator 输出 score 确认反映新权重
9. `npm test -- analysis-engine/*.test.ts` 全绿（新增 ~10 个 v2 case）
