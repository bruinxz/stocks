# 05 — 龙虎榜

## A. 操盘手心智

龙虎榜是 A 股 **"游资 + 机构 + 外资席位"** 的公开博弈现场。每日收盘后东财公布前一日上榜股的买卖席位 + 金额。

游资派看的：
- **拉萨系**（自然人席位高地，"宁波敢死队 / 浙江帮 / 章盟主"）：日内超短资金的浮筹动向
- **欢乐海 / 益田路系**：连板接力主力
- **绍兴系（赵老哥早期 / 章盟主）**：题材龙头爆发的标志性席位
- **佛山系 / 温岭帮 / 中泰温岭**：中线游资，常吃低位首板

机构派看的：
- **"机构专用"**：公募基金共用席位，机构同时进场说明价值认可
- **中信/中金/国君总部**：大机构席位

外资派看的：
- **中信里昂 / 摩根士丹利 / 高盛 / 瑞银**：外资席位，反映 QFII / 北上意愿

**3 个典型 use case**：
1. **次日跟随接力**：游资 A 上榜买入某新连板股 → 第二天集合竞价跟买（高赔率短线）
2. **机构 + 游资共振**：机构席位 + 著名游资同时净买入 → 高确认度（信号强）
3. **席位卖出预警**：持仓股出现著名游资在卖方席位 → 减仓信号

**不看龙虎榜**：错过短线超额收益主战场；A 股短线 alpha 50% 来自席位识别

---

## B. 系统设计

### B.1 schema 推荐

**DragonTigerBoard**（现有 [`backend/src/models/DragonTigerBoard.ts`](../../backend/src/models/DragonTigerBoard.ts) 168 行）：
- 4 元 PK：`(trade_date, stock_code, buyer_seat, seller_seat)`
- 字段：reason / buy_amount / sell_amount / net_amount / **is_famous_yz** / **seat_type** ∈ {public_fund, foreign, private_fund, famous_yz, unknown}
- ✅ Sprint US-088 已扩展归属机构类型

### B.2 6 项硬要求

1. **席位白名单维护**：[`backend/src/constants/famousSeats.ts`](../../backend/src/constants/famousSeats.ts) 358 行 / 100+ 席位，按拉萨系 / 头部游资 / 机构席位 / 外资 4 类标注
2. **席位名拼写抗漂移**：famousSeats.ts 注释提到 "AKShare 返回的席位名拼写漂移用 FAMOUS_SEAT_ALIASES" — alias 表必须维护
3. **笛卡尔展开识别**：单股当日 buyer × seller 笛卡尔展开（~10 × 10 = 100 行），因子层用"天数 ∈ [0, 20]"而非"笔数"（[`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) DragonTigerFactor 关键设计判据）
4. **上榜原因分类**：reason ∈ {日涨幅 7%+ / 振幅 15%+ / 成交额 / 连续 3 日累计 20%+ / ST 5%}，策略层根据 reason 不同走不同跟随逻辑
5. **T+1 同步**：东财大约 T+1 早 8:30 出全量；cron 9:00 跑
6. **历史 ≥ 3 年**：游资跟踪需要回测，至少 3 年

### B.3 衍生表

**SeatActivitySummary**（缺，建议）：per-seat per-day 累计（买总额 / 卖总额 / 净额 / 上榜次数）；用于"席位强弱榜"

---

## C. 现状 review

### C.1 已实现

| 项 | 文件:行 | 状态 |
|---|---|---|
| DragonTigerBoard model | [`DragonTigerBoard.ts`](../../backend/src/models/DragonTigerBoard.ts) 168 行 | ✅ 4 元 PK + seat_type |
| famous_yz 白名单 | [`famousSeats.ts`](../../backend/src/constants/famousSeats.ts) 358 行 / 100+ 席位 | ✅ |
| DragonTigerSyncService | [`DragonTigerSyncService.ts`](../../backend/src/data/services/DragonTigerSyncService.ts) 368 行 | ✅ |
| DragonTigerFactor | [`library/DragonTigerFactor.ts`](../../backend/src/quant/factors/library/DragonTigerFactor.ts) | ✅ 用 "天数" 不用 "笔数" 已生效 |
| DragonHeadMomentumStrategy / GameTraderRelayStrategy | [`backend/src/quant/strategies/`](../../backend/src/quant/strategies/) | ✅ 见 grep |
| Python helper | [`akshare_helper.py:898-1109`](../../backend/python/akshare_helper.py) `get_dragon_tiger_detail` | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 05-1 | **FAMOUS_SEAT_ALIASES 表是否实现** | 注释提到（[`famousSeats.ts:33`](../../backend/src/constants/famousSeats.ts)）但需 grep 验证 | 席位名拼写漂移可能漏识别 |
| 05-2 | **席位白名单维护频率不清**：上次更新何时？需要每季度回测命中率 | 没有 maintenance log | 老席位可能已不活跃，新席位未补入 |
| 05-3 | **没有 SeatActivitySummary 派生表** | grep 无 | "席位强弱榜"功能空白 |
| 05-4 | **机构席位识别局限**："机构专用"是粗类，不能区分公募 vs 险资 vs 自营 | famousSeats 单一标 public_fund | 信号粒度粗 |
| 05-5 | **卖方席位未标 seat_type** | DragonTigerBoard 模型 jsdoc 明确说 "buyer_seat 标 seat_type；seller_seat 未存储" | 卖出方追踪也是信号 |
| 05-6 | **跟随策略 paper trading 数据缺**：GameTraderRelay 的"赢率 / 胜率 / 平均收益"是否有持续 dashboard？ | 未发现 | 策略效果黑箱 |
| 05-7 | **席位名 fuzzy match**：东财偶尔会简化席位名（如 "中信总部" vs "中信证券股份有限公司总部"），现在是精确字符串匹配 | grep "fuzzy\|levenshtein" famousSeats 无结果 | 漏匹配率不明 |

---

## D. 改造方案

### D.1 P0

**US-05-1：席位白名单季度回测 + 更新**
- 描述：每季度跑 `FamousSeatPerformanceReport`：每个席位最近 90 日上榜后 5 日股价均值收益；< 0 的标 "待审查"
- 验收：每季度生成报告；ops 据此扩/裁白名单

**US-05-2：FAMOUS_SEAT_ALIASES 表显式落地**
- 描述：建立 `Map<string, string>` alias → canonical name；DragonTigerSyncService 先 alias resolve 再判 is_famous_yz
- 验收：单测覆盖 5 个已知 alias

**US-05-3：卖方席位 seat_type 标注**
- 描述：DragonTigerBoard 加 `seller_seat_type`；sync 时同步标
- 验收：可查 "著名游资在卖" 的股票列表

### D.2 P1

**US-05-4：SeatActivitySummary 派生表**
- 描述：建表 + 每日 cron：聚合每个席位过去 N 日（30/90/180）买总额 / 卖总额 / 净 / 上榜次数；UI 展示 "席位强弱榜"
- 验收：用户能看到 "近 30 日最活跃游资 top 20"

**US-05-5：游资席位 fuzzy match**
- 描述：用 Levenshtein 距离 ≤ 3 或编辑后 normalize（去除"股份有限公司"等通用词）后 hash 比对
- 验收：拼写漂移测试 case 5 个全命中

**US-05-6：跟随策略 KPI dashboard**
- 描述：GameTraderRelay 每周输出：跟随次数 / 成功率 / 平均超额 / 最大单笔回撤；持续记录到 `QuantStrategyPerformanceSnapshot`
- 验收：策略每周指标可见；连续 3 周 < 基准 → kill switch

### D.3 P2

**US-05-7：机构席位细分**
- 描述：机构席位关联到具体券商研究所；进一步用资金流向区分公募 / 险资 / 自营
- 验收：席位类型 ∈ {public_fund, insurance, prop_trading, retail_fund, ...} 6 类
- 难度：高（需第三方数据）

---

## E. 验收口径

1. 近 30 日所有上榜股票，is_famous_yz 标注准确率 ≥ 95%（人工随机抽 50 只复核）
2. 拼写漂移 5 个 test case：alias resolve 后均命中
3. GameTraderRelay 策略 paper trading 1 季度：跟随成功率 ≥ 55%，超额 ≥ 5%
4. SeatActivitySummary：随机选 5 个游资席位，30 日净额数据与人工算结果一致
5. 卖方席位 seat_type：抽 100 行卖方 = 著名游资的行，所有 seller_seat_type 必须正确

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/DragonTigerBoard.ts](../../backend/src/models/DragonTigerBoard.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/DragonTigerSyncService.ts](../../backend/src/data/services/DragonTigerSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/constants/famousSeats.ts](../../backend/src/constants/famousSeats.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/library/DragonTigerFactor.ts](../../backend/src/quant/factors/library/DragonTigerFactor.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/strategies/GameTraderRelayStrategy.ts](../../backend/src/quant/strategies/GameTraderRelayStrategy.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/strategies/DragonHeadMomentumStrategy.ts](../../backend/src/quant/strategies/DragonHeadMomentumStrategy.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（L898-1109）
