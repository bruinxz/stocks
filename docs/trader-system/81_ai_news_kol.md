# 81 — AI 新闻 + KOL 聚合（News + KOL Aggregation）

## A. 操盘手心智

A 股是"消息市"。**60% 行情来自消息驱动**：研报上调、北向加仓、龙虎榜、ETF 申赎、政策利好、行业研究员观点。如果信息渠道不全、不快、不准——决策一定落后。

操盘手每天看 5 类来源：
1. **券商研报**（一致预期、评级变化、目标价调整）
2. **新闻 + 公告**（财经资讯、行业动态、个股事件）
3. **KOL 观点**（雪球、东方财富股吧热门发言、知名分析师）
4. **ETF 申赎**（行业资金流向 leading indicator）
5. **政策导向**（央行、证监会、行业部委）

**AI 在这里的价值**：信息太多人看不过来 → AI 做"分类 + 情绪 + 评分 + 去重" → 给操盘手 top 10 关键信号。

---

## B. 系统设计

### B.1 来源扩展（v1 已有 3 类 → v2 加 2 类）

```
v1 已有:
  - research_report (券商研报)
  - east_money_news (新闻)
  - xq_hot_concept (雪球热概念)

v2 新增:
  - etf_creation_redemption (ETF 申赎日数据 → 行业资金流)
  - policy_directives (政策导向，从央行/证监会/行业部委网站 + 公告分类)
  - industry_analyst (行业研究员观点聚合：从研报 author 抽取，按行业聚合月度观点)
```

### B.2 单股 KOL 聚合流程（v2）

```
KOLAggregatorService.aggregateForStock(stock_code, options)
  ├─→ fetch 5 类 source × N 条 → KOLOpinionRecord[]
  ├─→ 每条:
  │     - rating_label → sentiment ∈ [-1, +1] (RATING_SENTIMENT_MAP)
  │     - title NLP → sentiment 评分 (SENTIMENT_KEYWORDS)
  │     - source_authority weight (研报 0.6 / 新闻 0.3 / KOL 0.4 / ETF 0.5 / 政策 0.8)
  │
  ├─→ dedupe + sort by (recency × authority)
  ├─→ 输出 top N + 总体 score [-100, +100] + confidence
  └─→ save to KOLOpinion 表
```

### B.3 行业级聚合（v2 新增）

```
KOLAggregatorService.aggregateForIndustry(industry_code, options)
  ├─→ fetch 该行业所有 KOLOpinion (近 30 天)
  ├─→ + ETF 申赎数据 (行业 ETF 近 5 天 net flow)
  ├─→ + 政策导向 (相关行业)
  └─→ 输出: 行业热度 score + top stocks + top reasons
```

---

## C. 现状 review

### C.1 已存在

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/services/KOLAggregatorService.ts` | 51-820 | ✅ 3 类 source：research_report / east_money_news / xq_hot_concept；纯函数 ratingToSentiment / scoreNewsSentiment / conceptRankToSentiment / dedupeAndSort |
| `KOLAggregatorService.ts` | 60-138 | ✅ RATING_SENTIMENT_MAP 14 个评级映射 + SENTIMENT_KEYWORDS 4 分类强度词典 |
| `KOLAggregatorService.ts` | 226-360 | ✅ DefaultKOLAggregatorDataSource：fetchNews / fetchHotConcepts / loadResearchReports / saveOpinions |
| `KOLAggregatorService.ts` | 618-820 | ✅ class KOLAggregatorService + aggregateForStock |
| `backend/src/models/KOLOpinion.ts`（推断） | — | ✅ 聚合产物 model |

### C.2 关键缺口

1. **没有 ETF 申赎数据源**：完全缺失。ETF 申赎是行业资金流 leading indicator，应该接 AKShare `fund_etf_iopv_em` 或 `fund_etf_fund_info_em`
2. **没有"政策导向"分类**：当前 EastMoneyNews 是 raw 新闻，没有"政策类"vs "公告类"vs "行业类"分类
3. **没有行业级聚合**：当前只有 `aggregateForStock(single)`，没有 `aggregateForIndustry`
4. **source_authority 没有显式权重**：当前 dedupeAndSort 是 recency-based，缺权威度加权
5. **缺研报 author 信息抽取**：研报字段有 author，但没有"个人 KOL"聚合（个人分析师月度准确率、推荐胜率）
6. **缺"概念板块联动"信号**：xq_hot_concept 是单股 → 概念 mapping，没有"同概念板块多股共振"分析
7. **NewsAnalyzer 输入只是占位**：00_overview.md 第 188 行明确"NewsAnalyzer 的 KOLAggregator 输入只是占位"
8. **没有"信息时效"衰减**：3 天前的研报和今天的新闻 weight 一样
9. **没有"信息源可信度"反馈**：高准确率 KOL 应加权，但缺历史命中率统计

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| KOL-001 | 新建 model `ETFCreationRedemption.ts`：(trade_date, etf_code, etf_name, industry, net_creation, net_redemption, premium_pct) + migration | P0 | — |
| KOL-002 | 新建 `data/sources/ETFFlowDataClient.ts`：调 AKShare fund_etf_iopv_em / fund_etf_fund_info_em，按日 sync | P0 | KOL-001 |
| KOL-003 | 新建 CLI `npm run sync:etf-flow -- --date=YYYY-MM-DD` | P0 | KOL-002 |
| KOL-004 | 在 SchedulerService 注册 cron `ETF_FLOW_SYNC`（17:30 工作日） | P0 | KOL-002 |
| KOL-005 | 新建 `data/sources/PolicyDirectivesScraper.ts`：从央行、证监会、行业部委 RSS / 公告网站抓取；落 `policy_directives` 表 | P1 | — |
| KOL-006 | `KOLAggregatorService` 增加 `fetchETFFlow(stock_code)` / `fetchPolicyDirectives(industry)` 方法 + integrate to aggregateForStock | P0 | KOL-001 |
| KOL-007 | `KOLAggregatorService` 加 source_authority 权重表 `SOURCE_AUTHORITY_WEIGHTS`：research 0.6 / news 0.3 / kol 0.4 / etf 0.5 / policy 0.8；dedupeAndSort 加 authority × recency 综合排序 | P0 | — |
| KOL-008 | 新增 `KOLAggregatorService.aggregateForIndustry(industry_code)` 方法 | P1 | KOL-006 |
| KOL-009 | 新建 `services/kol/KOLAuthorTrackingService.ts`：追踪研报 author 历史推荐 + 30 天后 forward return → 计算个人胜率，写 `kol_author_stats` | P2 | — |
| KOL-010 | KOLAggregator 加 `time_decay`：opinion weight × exp(-days_old / half_life=7) | P1 | — |
| KOL-011 | NewsAnalyzer 接 KOLAggregator 真实输出：替换占位；evidence 显示 top 3 来源 + sentiment + authority | P0 | KOL-006, KOL-007 |
| KOL-012 | 新增 `services/kol/ConceptLinkageAnalyzer.ts`：基于 xq_hot_concept，分析"同概念板块 N 股 5 日联动强度" | P2 | — |
| KOL-013 | KOLAggregator 加 `dedupe_by_semantic`：用 NLP/embedding 去重（同事件多源描述）| P2 | — |
| KOL-014 | 前端 FactorWorkspace 新增 `/factors/kol` tab：展示行业级 KOL 热度榜 + 个股 KOL opinion list | P1 | KOL-008 |
| KOL-015 | 前端 AIStockAnalysisModal 在 NewsAnalyzer evidence 区域增加"来源 tag"（研报 / 新闻 / KOL / ETF / 政策），不同颜色 | P1 | KOL-011 |

---

## E. 验收口径

1. ETF 申赎数据每日 18:00 前入库（覆盖至少 200 个 ETF）
2. 政策导向每天有新爬取记录（至少 3 类来源）
3. KOLAggregator.aggregateForStock 输出包含 5 类来源（非空）
4. NewsAnalyzer evidence 包含 ≥ 3 条且每条有 source 来源 tag
5. 行业级聚合：随机抽 5 个行业，hot 行业的 score > 60，cold 行业 < 40
6. 前端 FactorWorkspace KOL tab 能展示 top 20 hot 行业 + drill-down 个股
7. AIStockAnalysisModal NewsAnalyzer 区域显示 source 颜色 tag
8. KOLAuthorTracking 跑 90 天后，能识别至少 3 个胜率 ≥ 60% 的 author
9. `npm test -- kol/*.test.ts` 全绿
