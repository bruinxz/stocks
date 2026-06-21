# 08 — 公告（财报 / 重大事项 / 减持 / 收购 / 股权激励）

## A. 操盘手心智

公告是 A 股 **"信息源头 + 事件驱动 alpha"** 的核心。所有的研报、新闻、分析都是对公告的二次解读 — 第一手来源就是公告。

我每天看的公告维度：
- **公告类型分类**：财务报告 / 重大事项 / 融资公告 / 风险提示 / 资产重组 / 信息变更 / 持股变动
- **公告时效性**：T+0 收盘后 / T+1 早 8:30 集中披露（按规则）
- **公告 NLP 摘要 + 关键金额 + 主题词**：人工读不过来，AI 给我 1 句话总结
- **公告情绪打分**：正面（重大订单 / 业绩超预期）/ 中性 / 负面（减持 / 诉讼）
- **公告关联个股 + 行业联动**：上市公司 A 的公告，对行业内 B / C 是否有 spillover

**3 个典型 use case**：
1. **业绩超预期 / 大订单事件**：盘后公告 "签订 5 亿订单" → 第二天集合竞价高开追买
2. **黑天鹅排雷**：持仓股出现 "立案调查 / 高管减持 / ST 警告" → 第二天集合竞价清仓
3. **股权激励行权价跟随**：行权价是机构定价基准，相对股价折溢价能反映管理层信心

**不看公告**：错过事件驱动 30% alpha；可能被黑天鹅打懵

---

## B. 系统设计

### B.1 schema 推荐

**AnnouncementSummary**（现有 [`backend/src/models/AnnouncementSummary.ts`](../../backend/src/models/AnnouncementSummary.ts) 196 行）：
- PK: `id` autoIncrement + UNIQUE `(announce_date, stock_code, original_title)`
- 字段：announcement_type / url / **summary** (AI 抽取) / **sentiment** (正/中/负) / **key_amounts_json** [{label, amount, unit}] / **key_topics_json** [字符串] / status (completed/partial/failed) / nlp_engine

### B.2 6 项硬要求

1. **全公告入库**：不预筛分类，先全部入；NLP 再分桶
2. **NLP fail-OPEN**：AI 失败回退到启发式 fallback（关键词字典）；status='partial' 仍写库
3. **状态可追溯**：status ∈ {completed/partial/failed/pending} 让 UI 知道 AI 是否成功
4. **金额结构化**：key_amounts_json 数组 [{label="订单金额", amount=5, unit="亿元"}]
5. **主题词标准化**：key_topics_json ⊂ 预设词典（新能源 / 光伏 / 半导体 / …），避免长尾噪音
6. **NLP 引擎可替换**：nlp_engine 标 trading_agents / openai / heuristic，便于后续切换/迭代

### B.3 NLP 抽取流程

```
1. SyncService 拉 AKShare stock_notice_report 全量公告（按日期 + symbol 分类）
2. 落 AnnouncementSummary status='pending' + original_title
3. AnnouncementNLPService.summarize(title, options) → AI 抽 summary/sentiment/amounts/topics
4. AI 失败 → heuristic fallback（关键词字典匹配）→ status='partial'
5. 全部失败 → status='failed' 仍保留 original_title
```

---

## C. 现状 review

### C.1 已实现

| 项 | 文件:行 | 状态 |
|---|---|---|
| AnnouncementSummary model | [`AnnouncementSummary.ts`](../../backend/src/models/AnnouncementSummary.ts) 196 行 | ✅ 含 6 字段 + status |
| AnnouncementNLPService | `backend/src/services/AnnouncementNLPService.ts`（见 grep） | ✅ |
| Python helper | [`akshare_helper.py:3643`](../../backend/python/akshare_helper.py) `get_announcement_report` | ✅ |
| sync-announcements.ts CLI | [`backend/src/scripts/sync-announcements.ts`](../../backend/src/scripts/sync-announcements.ts) | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 08-1 | **没有专门的 AnnouncementSyncService**（与其他数据源 SyncService 命名约定不一致） | `ls backend/src/data/services` 无 AnnouncementSyncService.ts | sync 流程靠 script + Service 混合，对外接入不规范 |
| 08-2 | **NLP 流程"状态机"** 是否实现？status='pending' → 'completed' 的过渡 cron | 未验证 | pending 公告可能堆积 |
| 08-3 | **公告类型映射不稳定** | AKShare "公告类型" 字段中文，没有 enum 约束 | 类型过滤偶有漏 |
| 08-4 | **正文 / PDF 不拉**：only 标题 + URL；NLP 只看 title 信息少 | AnnouncementSummary 无 content 列 | NLP 准确性受限 |
| 08-5 | **关键事件没有显式告警** | grep "announcement.*alert\|black_swan_announcement" 无 | 黑天鹅公告（立案调查 / 退市预警）不主动推送 |
| 08-6 | **主题词字典未公开维护** | grep "key_topics_dict\|TOPIC_DICTIONARY" 无显眼结果 | NLP 主题词易长尾化 |
| 08-7 | **公告 NLP 引擎可观测性差** | 没有"近 7 日 status 比例" dashboard | partial / failed 占比可能高但 ops 不知 |

---

## D. 改造方案

### D.1 P0

**US-08-1：建立独立 AnnouncementSyncService**
- 描述：把 script 内的 sync 逻辑抽到 `AnnouncementSyncService`；统一 cron 9:00 / 15:00 / 19:00 三次拉（盘前 / 盘中 / 盘后）
- 验收：与其他 SyncService 命名一致；HealthService 能查 last_synced

**US-08-2：NLP 状态机 cron**
- 描述：每 5 分钟扫一遍 status='pending' 公告 → 调 NLP；批 50/批；status='partial' 重试 1 次后转 failed
- 验收：pending 队列不堆积，max ≤ 100

**US-08-3：黑天鹅公告主动告警**
- 描述：title 包含 {立案调查/被处罚/ST/退市预警/重大诉讼/财务造假} → 立刻写 RiskAlert(rule_id='announcement_black_swan')
- 验收：测试 case 5 个全触发告警

### D.2 P1

**US-08-4：公告正文 NLP**
- 描述：从 url 抓 PDF 或 HTML 正文（PDF 用 pdfplumber）；NLP 喂正文而非 title；status='content_completed' 标识深度版
- 验收：随机 20 条对比 title-only vs content NLP 准确率：content 提升 ≥ 15pp

**US-08-5：主题词字典维护机制**
- 描述：建 `TOPIC_DICTIONARY` 常量 ~100 条；NLP 主题词必须落字典内；新词通过 ops 申请加入
- 验收：长尾主题词占比 < 5%

**US-08-6：NLP 可观测性 dashboard**
- 描述：前端面板：近 7 日 status 比例柱状图 + nlp_engine 分布 + sentiment 分布
- 验收：ops 一眼看见 partial / failed 占比

### D.3 P2

**US-08-7：公告 spillover 识别**
- 描述：公司 A 公告 → 通过行业 join 识别同行业 B / C 是否被联动；推荐相关股
- 验收：抽 5 个龙头公告 case，spillover 推荐 5 只同行业关联股

---

## E. 验收口径

1. 任选 3 个交易日，AnnouncementSummary 覆盖东财公告大全 ≥ 95%（vs 人工核对）
2. NLP 状态：随机抽 100 条 status='completed' 公告，summary 通顺率 ≥ 90%；sentiment 准确率 ≥ 80%
3. 黑天鹅告警：构造 5 个"立案 / ST / 退市预警"测试 case，alert 必出 + 飞书弱告警 0 延迟
4. partial 率：连续 7 日 status='partial' 占比 ≤ 15%
5. 主题词字典：长尾主题（出现 < 3 次）占比 ≤ 5%

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/AnnouncementSummary.ts](../../backend/src/models/AnnouncementSummary.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/services/AnnouncementNLPService.ts](../../backend/src/services/AnnouncementNLPService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/scripts/sync-announcements.ts](../../backend/src/scripts/sync-announcements.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（L3643 `get_announcement_report`）
