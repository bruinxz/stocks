# 82 — AI 公告 NLP（Announcement NLP）

## A. 操盘手心智

A 股每天上千份公告——大部分是噪音（关联交易、行政变更、子公司增减资），少部分是金子（业绩预增、重大合同、回购、ST 风险）。**人工读不过来**——AI 的核心价值是**分级 + 分类 + 抽要素**。

操盘手对公告的 3 个核心需求：
1. **第一时间知道"出大事了"**：业绩暴雷 / ST / 退市 / 立案 → 立即止损
2. **抓住"潜伏机会"**：减持完毕 + 业绩预增 + 回购 + 大订单
3. **细化敏感事件**：减持是高管减持还是大股东减持？数量多少？解禁是首发解禁还是定增解禁？业绩预告是预增 50% 还是预减 50%？

**当前 NLP 是粗分类**（正面 / 中性 / 负面 + topic keyword），v2 要做**事件细化 + 量级抽取**。

---

## B. 系统设计

### B.1 事件分类细化（v2 新增）

```
旧 3 类: 正面 / 中性 / 负面
旧 topic: 关键词 hit (新能源 / 光伏 / ...)

v2 新增"敏感事件分类" (orthogonal to sentiment):
  - holding_change:
      sub: increase / decrease / pledge_increase / pledge_release
      who: major_shareholder / executive / insider / fund
      amount: ratio_pct / shares_count / amount_yuan
  - acquisition_merger:
      sub: equity_buy / asset_buy / reverse_merger / spinoff
      counterparty / valuation / scheme
  - restructuring:
      sub: debt / equity / business
      stage: announce / hearing / approved / failed
  - delisting_risk:
      sub: warning / suspension / final_warning / forced
      reason: financial / regulatory / fraud
  - earnings_forecast:
      sub: increase / decrease / loss / turnaround
      grade: minor (< 30%) / moderate (30-100%) / major (> 100%)
      yoy_pct: 数字
  - regulatory_action:
      sub: inquiry / investigation / penalty / warning
      authority: csrc / exchange / local
  - dividend_buyback:
      sub: dividend_cash / dividend_stock / buyback
      yield: 数字 / scale: 数字
```

### B.2 量级抽取（v2 强化）

```
对每条公告:
  - extract amounts:
      [{ value: 5000000, unit: '元', context: '回购金额' }]
  - extract dates:
      [{ value: '2026-06-30', context: '解禁日期' }]
  - extract ratios:
      [{ value: 0.06, context: '减持比例 6%' }]
  - extract entities:
      [{ value: '张三', role: '高管', stake: 0.018 }]
```

### B.3 推送优先级

```
v2 新增 priority field:
  - critical:  delisting_risk(*) / regulatory_action(investigation, penalty) / earnings_forecast(loss, major_decrease)
  - high:      acquisition / earnings_forecast(major_increase) / holding_change(major_decrease > 5%)
  - medium:    dividend / restructuring / earnings_forecast(minor)
  - low:       其它

critical 公告 → 5 min 内飞书 push
high      → 30 min 内 push
medium/low → 走日报
```

---

## C. 现状 review

### C.1 已存在

| 文件 | 行 | 现状 |
|---|---|---|
| `backend/src/services/AnnouncementNLPService.ts` | 81-163 | ✅ ANN_SENTIMENT_KEYWORDS 4 分类（strongPos/weakPos/weakNeg/strongNeg），覆盖 ~70 关键词 |
| `AnnouncementNLPService.ts` | 164-219 | ✅ TOPIC_KEYWORDS 行业主题（新能源 / 光伏 / 锂电 / ...） |
| `AnnouncementNLPService.ts` | 403-431 | ✅ heuristicSentiment(title) 纯函数 |
| `AnnouncementNLPService.ts` | 432-461 | ✅ extractAmounts (推断含金额抽取) |
| `AnnouncementNLPService.ts` | 462-483 | ✅ extractTopics |
| `AnnouncementNLPService.ts` | 484-520 | ✅ heuristicSummarize |
| `AnnouncementNLPService.ts` | 521-619 | ✅ buildNLPResultFromPayload / buildHeuristicNLPResult — TradingAgents + heuristic fallback |
| `AnnouncementNLPService.ts` | 620-893 | ✅ class AnnouncementNLPService + syncDate / syncRange |

### C.2 关键缺口

1. **没有"敏感事件分类"维度**：当前是 (sentiment, topic) 两维，缺第三维 "event_type"
2. **量级抽取太弱**：extractAmounts 抽数字但不带 context（"减持 5%" vs "回购 5%" 完全不同）
3. **没有 entity 抽取**：减持公告里的"张三 / 高管 / 6%"完全没提取出来
4. **没有"业绩预告分级"**：strongPos 里"业绩预增"没区分增 10% 还是增 200%
5. **没有 priority 字段 + 推送**：所有公告同等优先级写库；critical 公告不会"立即推送"
6. **TOPIC_KEYWORDS 是字符串列表**，缺"主题层级"（科技 > AI > 大模型 / 算力 / 端侧）
7. **没有"公告关联公司"识别**：A 公司公告 "和 B 公司战略合作"，应该自动给 B 加一条公告
8. **没有"公告冗余去重"**：同一事件多次公告（首次披露 + 临时公告 + 公告补充），算多次 sentiment
9. **TradingAgents 远端服务调用是黑盒**：失败 fallback 到 heuristic，但 NLP 质量大幅下降

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| ANN-001 | 在 `AnnouncementNLPRecord` model 加字段：`event_type` (enum 7 类)、`event_subtype` (string)、`priority` (critical/high/medium/low)、`entities` (JSONB)、`amounts_detailed` (JSONB) | P0 | — |
| ANN-002 | 新建 pure function `classifyEventType(title, body?)`：基于扩展的关键词字典 + 正则 → 7 大事件类型 | P0 | ANN-001 |
| ANN-003 | 新建 pure function `extractEntities(text)`：识别人名 / 角色 / 持股比例（用 NER 或规则模板） | P0 | — |
| ANN-004 | 新建 pure function `extractEarningsGrade(title)`：业绩预告 yoy_pct 抽取 + 分级（minor/moderate/major + increase/decrease/loss） | P0 | — |
| ANN-005 | 新建 pure function `computePriority(event_type, sentiment, amounts)`：决策表 → priority | P0 | ANN-002 |
| ANN-006 | `heuristicSummarize` 升级为 `buildStructuredSummary`：输出包含 event_type / subtype / entities / amounts_detailed / priority | P0 | ANN-002~005 |
| ANN-007 | `AnnouncementNLPService.syncDate` 跑完 critical 公告 → 立即 enqueue `feishuNotifier.sendCriticalAnnouncementCard` | P0 | ANN-005 |
| ANN-008 | TradingAgents prompt template 升级：要求返回 event_type / subtype / entities / amounts_detailed（结构化 JSON），不是 free text | P1 | ANN-001 |
| ANN-009 | 新建 model `AnnouncementEventRelation.ts`：(announcement_id, related_stock_code, relation_type 'mentioned'/'subject'/'partner', confidence) — 公告关联公司 | P1 | — |
| ANN-010 | 新建 `services/announcement/RelatedCompanyExtractor.ts`：识别公告中提到的其它上市公司股票 | P1 | ANN-009 |
| ANN-011 | 新建 `services/announcement/AnnouncementDedupeService.ts`：基于 (stock_code, event_type, amounts_detailed.value) 去重，标 `is_duplicate_of` | P1 | ANN-001 |
| ANN-012 | TOPIC_KEYWORDS 升级为 `topic_taxonomy`（树形结构）：level1 (科技) → level2 (AI / 半导体) → level3 (大模型 / 算力 / GPU) | P2 | — |
| ANN-013 | 前端 TodayWorkspace 新增"今日重要公告"卡片：按 priority 分组展示 critical/high 公告；点击展开 entities / amounts | P1 | ANN-007 |
| ANN-014 | NewsAnalyzer 使用新的 `event_type` 维度：对 critical 公告直接 veto；high 公告作为 evidence | P1 | ANN-002 |
| ANN-015 | 集成测试：100 条历史公告 → 验证 event_type 分类准确率 ≥ 80% | P0 | ANN-002 |

---

## E. 验收口径

1. AnnouncementNLP 表所有新公告有 `event_type` + `priority` 字段
2. critical 公告 5 min 内飞书推送
3. high 公告 30 min 内飞书推送
4. 业绩预告类公告 entities 含 "yoy_pct" + "grade"
5. 减持公告 entities 含 "who" + "amount" + "ratio_pct"
6. event_type 分类准确率 ≥ 80%（100 条人工标注样本验证）
7. 公告冗余去重率 ≥ 70%
8. 前端 TodayWorkspace 能看到今日 critical/high 公告卡片
9. NewsAnalyzer 对 critical 公告 evidence 含明确的"事件类型 + 量级"
10. `npm test -- announcement-nlp/*.test.ts` 全绿
