# 83 — AI 互动易 NLP（East Money Q&A Topic）

## A. 操盘手心智

东财股吧的"互动易"是个**容易被低估的 alpha 信号源**：散户问 + 公司答的"问答日志"暴露了 3 件事：
1. **散户在关心什么**（业绩 / 订单 / 产品 / 政策）→ 主题热度
2. **公司答得多积极 / 多回避**→ 隐含管理层态度
3. **问答热度趋势 vs 公司主动回答率**→ 市场情绪 leading indicator

经典套路：**散户密集问业绩**（10 倍以上日常）+ **公司频繁高质量回答** → 业绩预告大概率超预期。

操盘手对互动易的需求：
1. **主题分布**：今天关于这只股票的提问，是问业绩 / 订单 / 产品 / 高管？
2. **热度趋势**：本周 vs 上周提问数变化
3. **公司答复率 + 态度**：公司答了多少 / 答得详细 / 还是模板话术
4. **跨股票对比**：同行业里哪家公司问答最活跃

---

## B. 系统设计

### B.1 v2 主题分类细化

```
v1 已有 6 类: FINANCE / PRODUCT / ORDER / PERSONNEL / POLICY / OTHER
v1 已有: TOPIC_PRIORITY 平手优先级

v2 新增（subcategory，细化到能 actionable）:

  FINANCE:
    - earnings_forecast   (业绩预告 / 预增 / 预减)
    - quarterly_report    (季报 / 半年报)
    - dividend_buyback    (分红 / 回购 / 增持)
    - capital_action      (定增 / 配股 / 可转债)
    - cashflow_concern    (现金流 / 应收 / 存货)

  PRODUCT:
    - new_product         (新品 / 新车型 / 新规格)
    - capacity            (产能 / 量产 / 在建)
    - rd_progress         (研发进度 / 临床 / 专利)
    - quality_recall      (召回 / 缺陷 / 投诉)

  ORDER:
    - major_contract      (大订单 / 中标)
    - export              (出口 / 海外)
    - new_customer        (新客户 / 大客户)
    - delivery            (交付 / 出货)

  POLICY:
    - subsidy             (补贴 / 退税)
    - tariff              (关税 / 反倾销)
    - regulation          (监管 / 牌照 / 准入)
    - macro               (宏观 / 流动性)

  PERSONNEL:
    - executive_change    (高管变动 / 离职)
    - incentive           (股权激励 / 员工持股)
    - controversy         (高管争议)
```

### B.2 热度趋势 vs 答复率分析

```
新增 metric:
  - questions_count(stock, week)
  - questions_growth_pct(stock) = (本周 - 上周) / 上周
  - answer_rate(stock) = 公司回答数 / 总提问数
  - answer_quality(stock) = avg(answer.length / template_score)
  - topic_heat_distribution(stock, week)

分析:
  - questions_growth > 200% AND answer_rate > 50%  → "公司主动 + 散户关注" → bullish
  - questions_growth > 200% AND answer_rate < 10%  → "散户关注但公司回避" → bearish
  - 主题集中 earnings_forecast + 答复积极 → 业绩预增信号
```

### B.3 跨股票对比

```
新增 IndustryQAHeatService:
  for each industry:
    rank stocks by:
      - 7d questions count
      - 7d answer rate
      - 7d top_subtopic
    output top 10 most active in industry
```

---

## C. 现状 review

### C.1 已存在

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/services/EastMoneyQATopicService.ts` | 74-110 | ✅ 6 类 + OTHER 兜底；TopicCategory enum；TOPIC_PRIORITY 优先级 |
| `EastMoneyQATopicService.ts` | 120-225 | ✅ TOPIC_KEYWORDS 每类 14-22 词字典 |
| `EastMoneyQATopicService.ts` | 225-300 | ✅ QA_SENTIMENT_KEYWORDS 4 档情绪词 |
| `EastMoneyQATopicService.ts` | 502-570 | ✅ pure function classifyTopic / detectTopicByKeyword |
| `EastMoneyQATopicService.ts` | 569-596 | ✅ pure function scoreSentiment |
| `EastMoneyQATopicService.ts` | 597-650 | ✅ normalizeTopic / aggregateWeekly |
| `EastMoneyQATopicService.ts` | 376-454 | ✅ DataSource + DI |
| `backend/src/quant/factors/library/EastMoneyQAFactor.ts` | — | ✅ 已作为 SentimentAnalyzer 输入 |

### C.2 关键缺口

1. **没有 subcategory 维度**：当前 6 类，缺细化到 actionable 的 subcategory（业绩预告 vs 季报 vs 分红，差异巨大）
2. **没有"答复率 + 答复质量"分析**：只统计了 question topic，没看公司怎么答的
3. **没有"热度趋势"分析**：classifyTopic 是单 question 分类，缺 week-over-week 增长
4. **没有"模板话术"识别**：公司答复都是"感谢关注/详见公告"这种模板，应该自动 detect 标低分
5. **没有跨股票对比 API**：没有 IndustryQAHeatService 之类
6. **没有"业绩预告 leading"信号**：questions_count(earnings) 暴增 + answer 积极 → 应自动告警
7. **TOPIC_KEYWORDS 太粗**：智能驾驶 / 电池 / 芯片都在 PRODUCT 大类，应该更细
8. **没有"问题情绪"对答复情绪的对照**：散户态度 vs 公司态度对比缺失
9. **SentimentAnalyzer 只用 score，没用 question 数和增长率**
10. **EastMoneyQATopicService 数据是离线 sync**：缺实时性，热点事件后散户提问 1 小时内系统就该感知

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| QA-001 | TOPIC_CATEGORIES 增加 subcategory 维度，新增 `TOPIC_SUBCATEGORIES` 字典 + `TOPIC_SUBCATEGORY_KEYWORDS` | P0 | — |
| QA-002 | 新建 pure function `classifySubtopic(question)`：基于 SUBCATEGORY_KEYWORDS 返回 subcategory；落 `eastmoney_qa_topics.subtopic` 字段 | P0 | QA-001 |
| QA-003 | 新建 model `EastMoneyQAStat.ts`：(stock_code, week_start, questions_count, answer_count, answer_rate, top_subtopic, avg_question_sentiment, avg_answer_sentiment, answer_template_score) + migration | P0 | — |
| QA-004 | 新建 pure function `detectTemplateAnswer(answer_text)`：识别"感谢关注 / 详见公告 / 投资有风险"等模板词，返回 template_score [0,1]（1=纯模板，0=高质量） | P0 | — |
| QA-005 | 新建 `services/qa/QAStatAggregator.ts`：按周聚合 → 落 EastMoneyQAStat | P0 | QA-003, QA-004 |
| QA-006 | SchedulerService 注册 cron `WEEKLY_QA_STAT_AGGREGATE`（每周一 02:00） | P0 | QA-005 |
| QA-007 | 新建 `services/qa/IndustryQAHeatService.ts`：实现 `getHotStocksInIndustry(industry, lookback=7d)` 返回 top 10 active | P1 | QA-005 |
| QA-008 | 新建 `services/qa/QALeadingSignalDetector.ts`：检测"earnings questions 暴增 + answer 积极"组合；输出 leading_signal | P0 | QA-005 |
| QA-009 | 在 SentimentAnalyzer 增加 evidence：questions_growth_pct + top_subtopic + answer_rate | P1 | QA-005 |
| QA-010 | 新增 `EastMoneyQAFactor` v2：基于 questions_growth 和 leading_signal 输出新 factor score | P1 | QA-008 |
| QA-011 | 实时同步：将每日 sync 改为每 30 min sync 一次（最近 24h 数据） | P2 | — |
| QA-012 | 前端 FactorWorkspace 新增 `/factors/qa` tab：行业 QA 热度榜 + 个股 QA 趋势图 + leading signal 列表 | P1 | QA-007, QA-008 |
| QA-013 | 集成 AIStockAnalysisModal SentimentAnalyzer：展示"散户关注热点 + 公司答复活跃度"模块 | P1 | QA-009 |
| QA-014 | 测试集：100 条标注问答 → subcategory 准确率 ≥ 80% | P0 | QA-002 |

---

## E. 验收口径

1. EastMoneyQATopic 表所有记录有 `subtopic` 字段
2. EastMoneyQAStat 表每周一 04:00 前生成上周数据
3. answer_rate / template_score 在 EastMoneyQAStat 中非空
4. 至少识别 5 个"业绩 leading 信号"在最近 90 天历史中
5. 前端 IndustryQAHeat 能展示任一行业的 top 10 active stocks
6. SentimentAnalyzer evidence 出现 "本周提问 +320% / 业绩话题占比 60%" 之类
7. subcategory 分类准确率 ≥ 80%
8. `npm test -- east-money-qa/*.test.ts` 全绿
