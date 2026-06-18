# 10 — 新闻 + 舆情：MarketNews / KOL / 雪球热词 / 互动易 / 个股情绪

## A. 操盘手心智

A 股是 **"散户主导 + 题材驱动"** 的市场。情绪和舆情是仅次于资金面的第二大 alpha 源。情绪信号有 5 个层次：

1. **市场宽度财经新闻**：财联社电报 / 东财全球 / 新浪 — 突发事件 / 政策 / 行业利好
2. **KOL 观点**：券商研报 + 财经记者 + 大 V — "信誉度高的角色对该股的态度"
3. **散户关注度**：雪球热词 / 百度热搜 / 东财人气榜 / 股吧
4. **互动易问答**：散户问公司 → 公司回答；问题分类（财务/产品/订单/政策/人事）反映散户关注主题
5. **社交情绪**：综合多源情感倾向（正面/中性/负面）

我每天看的舆情维度：
- **盘前 8:30**：财联社夜间电报 + 财经新闻 → 判断今日风险偏好
- **盘中 10:00**：突发新闻（央行降息 / 行业政策 / 龙头公告）
- **盘后 16:00**：复盘当日舆情热点，调整次日候选池

**3 个典型 use case**：
1. **政策风口跟随**：央行降息 → 银行 / 地产 / 高股息板块跟买
2. **散户狂热预警**：某股雪球关注度突增 + 互动易问题数倍增 → 短期顶部信号
3. **题材 NLP 联动**：财联社突发 "AI 大模型新进展" → 推送 AI 概念股清单

**不看舆情**：错过事件驱动；过度依赖技术指标会在题材爆发时段慢半拍

---

## B. 系统设计

### B.1 5 类舆情数据 + schema 推荐

| 数据 | Model | 数据源 | 更新节奏 |
|------|-------|--------|----------|
| **市场新闻** | [`MarketNews`](../../backend/src/models/MarketNews.ts) 113 行 | AKShare cls/em/sina/baidu 4 源 | 高频 / 30 天保留 |
| **KOL 观点** | [`KOLOpinion`](../../backend/src/models/KOLOpinion.ts) 176 行 | 研报 + 个股新闻 + 热门概念**代理** | 实时 |
| **雪球热词** | [`SnowballHotKeyword`](../../backend/src/models/SnowballHotKeyword.ts) 158 行 | AKShare `stock_hot_follow_xq`（**代理**：股票简称作热词） | T+1 |
| **百度热搜** | [`MarketHotSearch`](../../backend/src/models/MarketHotSearch.ts) 107 行 | AKShare `stock_hot_search_baidu` | T+1 |
| **个股情绪/人气** | [`StockSentiment`](../../backend/src/models/StockSentiment.ts) | AKShare `stock_hot_rank_detail_em`（**代理**：rank 倒数当 post_count） | T+1 |
| **互动易 Q&A** | [`EastMoneyQATopic`](../../backend/src/models/EastMoneyQATopic.ts) 184 行 | AKShare `stock_irm_cninfo`（**代理**：cninfo IRM 当东财股吧） | 周聚合 |
| **市场情绪指数** | [`MarketSentimentIndex`](../../backend/src/models/MarketSentimentIndex.ts) | 内部派生（融资+涨停数+市场宽度） | T+1 |
| **社交情绪快照** | [`SocialSentimentSnapshot`](../../backend/src/models/SocialSentimentSnapshot.ts) | 多源融合 | T+1 |

### B.2 6 项硬要求

1. **多源（≥ 2 源）**：MarketNews 已实现 cls / em / sina / baidu 4 源
2. **NLP 情感打分**：sentiment ∈ [-1, +1]（强空 -1 / 弱空 -0.5 / 中性 0 / 弱多 +0.5 / 强多 +1）
3. **热度变化检测**：滑窗 5d / 30d 比率（EastMoneyQAFactor [`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-034）
4. **代理透明**：AC 期望字段不可得时用代理 + 在 jsdoc 标 "代理"（已严格执行 US-031 / US-034 / US-035 / US-056 等）
5. **升级路径预留**：未来引入真数据源（Wind / Tushare Pro）只换 sync helper，因子和模型不动
6. **新进/异常识别**：SnowballHotKeyword 已加 `is_new` 字段；MarketHotSearch 可派生

### B.3 NLP 字典

- 情感字典：[`AnnouncementNLPService.ts`](../../backend/src/services/AnnouncementNLPService.ts) heuristicSentiment
- 主题字典：EastMoneyQATopic 6 类 + 1 兜底（FINANCE/PRODUCT/ORDER/PERSONNEL/POLICY/OTHER）

---

## C. 现状 review

### C.1 已实现

| 项 | 文件 | 状态 |
|---|---|---|
| MarketNews + sync | [`MarketNewsSyncService.ts`](../../backend/src/data/services/MarketNewsSyncService.ts) 202 行 | ✅ 4 源 |
| KOLOpinion + sync via KOLAggregatorService | `backend/src/services/KOLAggregatorService.ts` | ✅ 3 源聚合 |
| SnowballHotKeyword + sync | [`SnowballHotKeywordSyncService.ts`](../../backend/src/data/services/SnowballHotKeywordSyncService.ts) 334 行 | ✅ is_new 标注 |
| MarketHotSearch + sync | [`MarketHotSearchSyncService.ts`](../../backend/src/data/services/MarketHotSearchSyncService.ts) | ✅ 百度热搜 |
| StockSentiment + sync | [`StockSentimentSyncService.ts`](../../backend/src/data/services/StockSentimentSyncService.ts) | ✅ 双重代理 (US-034) |
| EastMoneyQATopic + sync | （未单独 Sync service，靠 EastMoneyQATopicService 内部） | ✅ |
| SocialSentimentSnapshot + sync | [`SocialSentimentSyncService.ts`](../../backend/src/data/services/SocialSentimentSyncService.ts) | ✅ |
| MarketSentimentIndex + service | `MarketSentimentIndexService.ts` | ✅ |
| AnnouncementNLPService（公告 NLP） | ✅ | ✅ |
| EastMoneyQAFactor / 情感因子 | [`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-034 | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 10-1 | **KOLOpinion "kol_source" 是聚合代理**，雪球评论 / 股吧高赞作者本质数据不可得 | KOLOpinion.ts:54-71 注释 | KOL 信号噪声大 |
| 10-2 | **StockSentiment 代理**：post_count = 1/rank × 100000，view_count = 粉丝占比 × 1000 | [`StockSentiment.ts:29-40`](../../backend/src/models/StockSentiment.ts) | 数值口径与真实股吧数据有偏差 |
| 10-3 | **EastMoneyQATopic 用互动易代理东财股吧** | [`EastMoneyQATopic.ts:22-35`](../../backend/src/models/EastMoneyQATopic.ts) | 命名 vs 语义不一致 (用户可能困惑) |
| 10-4 | **多源情感融合算法不清** | 8 个 model 各自打分，没有 unified `final_sentiment_score`/symbol/day | 单股综合情绪不可见 |
| 10-5 | **新闻 NLP 关键词字典不公开** | grep "NEWS_TOPIC_DICTIONARY" backend 无显式 | 长尾问题不可控 |
| 10-6 | **舆情突变告警缺**：某股 keyword 1 日突现 top 5、互动易问题数 3 日 ×5 等异常事件 | grep "sentiment_spike\|opinion_alert" 无 | 突发热度不告警 |
| 10-7 | **正文 / 长文 NLP 缺**：MarketNews.content 字段在但 NLP 仅看 title | MarketNews 模型 | 准确率受限 |
| 10-8 | **舆情时效性**：MarketNews 数据保留 30 天，不能做长期 NLP 训练 | MarketNews.ts 注释 | 训练样本不够 |

---

## D. 改造方案

### D.1 P0

**US-10-1：unified per-stock final_sentiment_score**
- 描述：建 `StockSentimentDaily` 派生表 (trade_date, stock_code, final_sentiment_score, sentiment_breakdown_json)；融合 8 个 model：KOL × 0.3 + News × 0.2 + Snowball × 0.15 + QA × 0.15 + StockSentiment × 0.1 + Announcement × 0.1
- 验收：每股一天一行；UI "个股情绪" 卡片展示

**US-10-2：舆情突变告警 cron**
- 描述：每日 19:00 跑 `SentimentAnomalyDetector`：(a) SnowballHotKeyword.is_new=true 且 heat_score top 100 (b) EastMoneyQATopic 同 stock 7d question count 突增 3× → 写 RiskAlert(rule_id='sentiment_spike')
- 验收：alert 表能查；UI 实时告警面板

**US-10-3：新闻 NLP 主题字典维护**
- 描述：建 `NEWS_TOPIC_DICTIONARY` 常量 ~150 条；MarketNews 入库时打 topic 标签；长尾词触发告警
- 验收：覆盖率 ≥ 80%；长尾词 < 5%

### D.2 P1

**US-10-4：新闻正文 NLP**
- 描述：MarketNews.content 拉全文 → 调 AnnouncementNLPService.summarize(content)；写 summary / sentiment / topics 新列
- 验收：title-only vs content NLP 准确率提升 ≥ 10pp

**US-10-5：KOL 信誉度评级**
- 描述：每个 kol_name 跟踪其历史信号准确率：sentiment_score > 0 推荐后股票 30 日是否上涨；建 `kol_credibility_summary` 派生表
- 验收：可查每个 KOL 准确率；融合时按信誉度加权

**US-10-6：MarketNews 长期归档**
- 描述：30 天后从主表移到 `market_news_archive`（冷库）；NLP 训练时回放
- 验收：归档表能查 90 天历史

### D.3 P2

**US-10-7：股吧 / 雪球真数据接入（远期）**
- 描述：尝试 Wind / TuShare Pro 接入；替换 StockSentiment / EastMoneyQATopic 的代理为真值
- 验收：post_count 与代理值偏差 < 30%（合理）

**US-10-8：跨源情感一致性 check**
- 描述：同一股同一天，News / KOL / QA / Snowball 4 源情感打分；偏差 > 1 → 写 sanity alert
- 验收：sanity check daily report

---

## E. 验收口径

1. 8 个舆情 model 覆盖率：随机 100 只候选股，sentiment 数据 7 日内可查 ≥ 95%
2. final_sentiment_score 上线后：抽 5 只爆雷股，雷前 7 日 score 显著下降（≥ -0.3）
3. 舆情突变告警：抽 5 个真实题材爆发案例（如低空经济），告警在爆发当日触发
4. 多源 NLP 一致性：抽 50 条新闻，3 源情感打分方向一致率 ≥ 70%
5. KOL 信誉度：累计 6 个月，TOP 10 KOL 准确率 ≥ 60%

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/MarketNews.ts](../../backend/src/models/MarketNews.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/KOLOpinion.ts](../../backend/src/models/KOLOpinion.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/SnowballHotKeyword.ts](../../backend/src/models/SnowballHotKeyword.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/MarketHotSearch.ts](../../backend/src/models/MarketHotSearch.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/StockSentiment.ts](../../backend/src/models/StockSentiment.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/EastMoneyQATopic.ts](../../backend/src/models/EastMoneyQATopic.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/MarketSentimentIndex.ts](../../backend/src/models/MarketSentimentIndex.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/SocialSentimentSnapshot.ts](../../backend/src/models/SocialSentimentSnapshot.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/services/AnnouncementNLPService.ts](../../backend/src/services/AnnouncementNLPService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/services/KOLAggregatorService.ts](../../backend/src/services/KOLAggregatorService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/MarketNewsSyncService.ts](../../backend/src/data/services/MarketNewsSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/SnowballHotKeywordSyncService.ts](../../backend/src/data/services/SnowballHotKeywordSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/StockSentimentSyncService.ts](../../backend/src/data/services/StockSentimentSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/SocialSentimentSyncService.ts](../../backend/src/data/services/SocialSentimentSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/CLAUDE.md](../../backend/src/quant/factors/CLAUDE.md)（US-034 east_money_qa 因子）
