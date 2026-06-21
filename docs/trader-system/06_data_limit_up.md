# 06 — 涨停板（连板 / 炸板 / 封板时间）

## A. 操盘手心智

涨停板是 A 股 **"短线 alpha 集中爆发"** 的场所。每日涨停股 30-150 只，决定了游资当日的关注度。涨停板分析有 4 个核心维度：

1. **连板高度（continuous_days）**：1 板 / 2 板 / 3+ 板节奏不同；高度越高代表市场认可越强但赔率越低
2. **一字板 vs 烂板**：一字板（开盘即封死，封板时间 ≤ 9:30）几乎追不进去；烂板（10:00 后封 + 多次炸板）赔率高但风险大
3. **炸板次数（open_times）**：当日打开涨停的次数；0 次 = 强势封死、1-2 次 = 抵抗封板、3+ 次 = 烂板
4. **封板时间 + 封板资金**：早封 + 重资金 = 强势；晚封 + 轻资金 = 偷袭式封板

**3 个典型 use case**：
1. **首板接力**：今日新增 1 板（昨日非涨停）+ 非一字 + 行业板块热度高 → 第二天追打 2 板的赔率高
2. **连板高度龙头识别**：3+ 板个股取行业涨幅最大的，做"补涨龙头"接力
3. **跌停反向识别**：连续跌停 + 炸板 → 短期超跌，挑选基本面有支撑的反弹（左侧反转策略）

**不看涨停板**：放弃 A 股短线最大 alpha 池（题材龙头 / 概念炒作 70% 在涨停股内）

---

## B. 系统设计

### B.1 schema 推荐

**LimitUpStock**（现有 [`backend/src/models/LimitUpStock.ts`](../../backend/src/models/LimitUpStock.ts) 145 行）：
- PK `(trade_date, stock_code)`
- 字段：limit_up_time（首封时间）/ limit_up_amount（封板资金）/ limit_up_open_times（炸板次数）/ **continuous_days**（连板天数，库内回算）/ reason / industry / **is_one_word_board**

**LimitDownStock**（**未建表**）：
- 当前 [`akshare_helper.py:3380`](../../backend/python/akshare_helper.py) 注释明确说 "下游若有 LimitDownStock 需求可入新模型"
- 当前 MarketSentimentIndex 只用 "跌停数" 整数信号

### B.2 6 项硬要求

1. **连板天数自算（不依赖 AKShare）**：[`LimitUpSyncService.ts:75-91`](../../backend/src/data/services/LimitUpSyncService.ts) 已实现 — 回看 5 自然日，库内 (stock_code) 连续涨停天数 + 1；与 AKShare 给的值互校验
2. **is_one_word_board 标注**：首封 ≤ 09:30:00 且炸板 = 0 → 一字（[`LimitUpStock.ts:117`](../../backend/src/models/LimitUpStock.ts) 注释）
3. **跨周末 / 节假日处理**：连板的 "前一交易日" 是上一个交易日，不是日历前一日；TradingCalendar 必须可用
4. **涨停原因分类**：reason 字段建议进一步 NLP 分类（个股事件 / 板块联动 / 题材发酵）
5. **行业 join**：industry 字段必须填，便于行业龙头识别
6. **历史 ≥ 3 年**：连板回测必需

### B.3 衍生表

- **DailyMarketBreath**（缺）：每日全市场涨停数 / 跌停数 / 涨家数 / 跌家数 / 平家数
- **ConceptLimitUpBoard**（缺）：当日涨停股聚合到概念板块，识别 "板块爆发"

---

## C. 现状 review

### C.1 已实现

| 项 | 文件:行 | 状态 |
|---|---|---|
| LimitUpStock model | [`LimitUpStock.ts`](../../backend/src/models/LimitUpStock.ts) | ✅ continuous_days + is_one_word_board |
| LimitUpSyncService | [`LimitUpSyncService.ts`](../../backend/src/data/services/LimitUpSyncService.ts) 293 行 | ✅ 含库内连板复算 |
| Python helper | [`akshare_helper.py:1249`](../../backend/python/akshare_helper.py) `get_limit_up_pool` + L3363 `get_limit_down_pool` | ✅ 双向都有 |
| DragonHeadMomentumStrategy | [`backend/src/quant/strategies/DragonHeadMomentumStrategy.ts`](../../backend/src/quant/strategies/DragonHeadMomentumStrategy.ts) | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 06-1 | **LimitDownStock 表不存在** | grep 无 + helper 注释说 "可入新模型" | 反弹策略 / 左侧反转策略缺数据基础 |
| 06-2 | **MarketSentimentIndex 只用 "跌停数"** | [`akshare_helper.py:3377`](../../backend/python/akshare_helper.py) | 个股级跌停跟踪缺失 |
| 06-3 | **涨停 reason NLP 分类缺失** | grep "limit_up.*reason.*classify" backend/src 无结果 | 题材 vs 个股 vs 板块联动无法区分 |
| 06-4 | **DailyMarketBreath 派生表缺** | 每日全市场涨跌停数 / 涨跌家数无独立表 | 大盘择时计算需现 join |
| 06-5 | **跨周末连板回算** | 注释说 "5 自然日足够覆盖跨周末" | 长假（春节/十一）连板可能漏算 — 5 自然日 != 5 交易日 |
| 06-6 | **封板资金 vs 流通市值占比** | LimitUpStock 有 limit_up_amount 但无 ratio | 真正强势封板需结合市值看 |
| 06-7 | **没有 ConceptLimitUpBoard 派生** | grep 无 | 板块爆发识别需现算 |
| 06-8 | **AKShare 原始 reason 字段拼写不稳定** | 经常出现 "连续N板涨停" 但 N 是中文/数字混用 | 因子从 reason 解析连板数易碎 |

---

## D. 改造方案

### D.1 P0

**US-06-1：建立 LimitDownStock 表**
- 描述：仿 LimitUpStock 建表 + 同款 LimitDownSyncService；字段：limit_down_time / limit_down_open_times / continuous_down_days / reason / industry
- 验收：每日 17:00 入库；左侧反转策略可消费

**US-06-2：跨长假连板回算修复**
- 描述：LimitUpSyncService.computeContinuousDays 改用 TradingCalendar 取"前 5 个交易日"（而非 5 自然日），春节/十一回算不漏
- 验收：单测：构造跨春节的连板序列，回算正确

**US-06-3：DailyMarketBreath 派生表**
- 描述：每日 17:30 cron 跑：统计全市场涨停数 / 跌停数 / 涨家数 / 跌家数 / 平家数 / 涨幅 > 5% 数 / 跌幅 > 5% 数；写 `daily_market_breath` 表
- 验收：大盘择时模型直接消费

### D.2 P1

**US-06-4：涨停原因 NLP 分类**
- 描述：调 `AnnouncementNLPService.summarize(reason)` 或新建 `LimitUpReasonClassifier`：分类 ∈ {题材发酵 / 板块联动 / 个股事件 / 业绩超预期 / 其他}
- 验收：抽 100 个涨停理由分类准确率 ≥ 85%

**US-06-5：封板强度评分**
- 描述：派生 `seal_strength_score`：封板资金 / 流通市值 × 早封时间分；记入 LimitUpStock 新列
- 验收：score 跨日比较稳定；可见前 10 强势封板

**US-06-6：ConceptLimitUpBoard 派生**
- 描述：每日按概念聚合涨停股，输出 "板块爆发度" + Top 5 涨停成份股
- 验收：题材龙头策略消费

### D.3 P2

**US-06-7：AKShare reason 字段稳定性 fallback**
- 描述：reason 解析失败时，回退到自算："本股票今日涨停 + 昨日涨停 + 前日涨停" → reason = "连续 3 板涨停"
- 验收：reason 不可解析的占比 < 1%

---

## E. 验收口径

1. 任选 2024-2025 任 10 个交易日，涨停股 LimitUpStock 全覆盖（vs 东财人工核对）
2. 连板复算：随机抽 5 只 3+ 板股票，连板天数与人工算结果一致（含跨周末）
3. 一字板识别：抽 10 只一字板，is_one_word_board = true
4. LimitDownStock 上线后：任选 5 日跌停股全入库
5. DragonHeadMomentum 策略 1 个月 paper trading：跟买胜率 ≥ 55%，平均收益 ≥ 3%

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/LimitUpStock.ts](../../backend/src/models/LimitUpStock.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/LimitUpSyncService.ts](../../backend/src/data/services/LimitUpSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（L1249 涨停 / L3363 跌停）
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/strategies/DragonHeadMomentumStrategy.ts](../../backend/src/quant/strategies/DragonHeadMomentumStrategy.ts)
