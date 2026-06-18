# 07 — 行业资金流

## A. 操盘手心智

行业资金流告诉我：**今天市场的钱往哪个板块跑了**。A 股 80% 的行情是行业级 / 概念级共振 — 抓住主力流入的板块龙头，胜率远高于单股博弈。

我每天看的行业维度：
- **申万一级行业（86+ 板块）**：白酒 / 半导体 / 光伏 / 银行 / 医药 …
- **二级 / 三级行业**：更细化，比如"半导体"细分到"半导体材料 / 设备 / 设计 / 制造"
- **概念板块（ConceptFlow）**：跨行业的主题概念（如"机器人"、"AI"、"低空经济"），常常是题材爆发源
- **主力净流入 + 净流入占比**：主力 = 单笔成交额 > 50 万的大单；净流入占比衡量"主力 / 散户"力量对比
- **行业涨停股数**：行业内涨停数 ≥ 3 → 板块爆发；≥ 5 → 题材风口
- **行业当日龙头股**：涨幅最大且非一字（可追） → 跟随龙头

**3 个典型 use case**：
1. **行业轮动**：每日 top 5 主力净流入行业，按权重调仓
2. **板块爆发跟随**：单日某行业涨停股 ≥ 5 → 第二天跟买行业涨幅靠前的非涨停补涨股
3. **风险预警**：持仓行业连续 3 日主力净流出 + 涨停数 < 5 日均值 → 减仓

**不看行业资金流**：错过 80% 的板块共振机会；持仓在弱势板块自己一只一只地割

---

## B. 系统设计

### B.1 schema 推荐

**IndustryFlow**（现有 [`backend/src/models/IndustryFlow.ts`](../../backend/src/models/IndustryFlow.ts) 166 行）：
- PK `(trade_date, industry_code)`
- 字段：industry_name / change_pct / **main_inflow** / **main_inflow_ratio** / **limit_up_count** / leader_stock_code / leader_stock_name / leader_stock_change_pct / advancing_count / declining_count
- ✅ 已含板块强度评分要素

**ConceptFlow**（**缺**）：
- 推荐：和 IndustryFlow 同款 schema，但 concept_code / concept_name；数据源 `ak.stock_board_concept_*`

### B.2 5 项硬要求

1. **盘后 T+1 入库**：cron 16:00 后跑（东财数据更新）
2. **realtime "实时快照"机制**：[`IndustrySyncService.ts:20`](../../backend/src/data/services/IndustrySyncService.ts) 已明确 — AKShare 接口只能拿当下时刻，**历史日期回填无意义**
3. **limit_up_count join**：sync 时同步 join LimitUpStock 算每行业涨停数（已实现 [`IndustrySyncService.ts:82-87`](../../backend/src/data/services/IndustrySyncService.ts)）
4. **leader_stock 识别规则**：行业内涨幅最大 + 非一字板（已实现）
5. **行业代码稳定性**：industry_code（BKxxxx）跨日跨月稳定；industry_name 偶有调整

### B.3 衍生指标

- **行业强弱榜**：主力净流入 desc 排序，前 10 = 强势板块
- **行业 7 日强弱**：滑窗 7 日累计主力净流入 / change_pct 平均
- **板块爆发度**：limit_up_count + change_pct + main_inflow_ratio 加权评分

---

## C. 现状 review

### C.1 已实现

| 项 | 文件:行 | 状态 |
|---|---|---|
| IndustryFlow model | [`IndustryFlow.ts`](../../backend/src/models/IndustryFlow.ts) 166 行 | ✅ 完整 |
| IndustrySyncService | [`IndustrySyncService.ts`](../../backend/src/data/services/IndustrySyncService.ts) 255 行 | ✅ 含 LimitUp join + 龙头识别 |
| Python helper | [`akshare_helper.py:1461`](../../backend/python/akshare_helper.py) `get_industry_flow` | ✅ |
| 行业一级（86+） | AKShare `stock_sector_fund_flow_rank` | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 07-1 | **概念板块（ConceptFlow）完全缺** | grep "ConceptFlow\|concept_fund_flow\|stock_concept" 无结果 | A 股 80% 的题材炒作集中在概念板块，本系统看不到 |
| 07-2 | **二级 / 三级行业缺** | IndustryFlow 只有 industry_code BKxxxx，没有 hierarchy | 半导体爆发但分不清细分领域 |
| 07-3 | **实时快照限制未被前端暴露** | `IndustrySyncService.ts:20` 注释明确 | 用户可能误以为可回填历史 |
| 07-4 | **行业 7 日强弱榜派生缺** | grep "industry_7d\|sector_strength" 无结果 | 行业轮动策略需现算 |
| 07-5 | **板块爆发度无综合评分列** | IndustryFlow 字段散 | 排序时要拼装多列 |
| 07-6 | **领先指标缺**：行业当日突破前 N 日高点 / 板块成交额历史百分位 | 无 | 突破策略难自动化 |
| 07-7 | **没有 "concept ↔ stock" 多对多映射表** | grep "stock_concepts\|stock_to_concept" 无结果 | 概念龙头联动无法 join |

---

## D. 改造方案

### D.1 P0

**US-07-1：ConceptFlow 表 + Sync**
- 描述：仿 IndustryFlow 建 `ConceptFlow` model；接 `ak.stock_board_concept_*` 系列；同款 SyncService
- 验收：每日 16:30 cron；前 20 强势概念可见

**US-07-2：建立 stock ↔ concept / industry 映射**
- 描述：`stock_concept_mappings` 表：(stock_code, concept_code/industry_code, weight)；每周更新
- 验收：随机选 5 只半导体股，能 join 到所属概念板块

**US-07-3：实时快照机制 UI 显式标注**
- 描述：前端"行业资金流"页面顶部注明 "AKShare 接口为实时快照，历史日期资金流字段同当下"
- 验收：用户看到 banner

### D.2 P1

**US-07-4：行业 7/30 日滑窗强弱榜**
- 描述：建 `industry_strength_summary` 派生表：滑窗 7/30 日累计主力净流入 + 累计涨跌幅；每日 cron
- 验收：行业轮动策略消费

**US-07-5：板块爆发度综合评分**
- 描述：派生 `industry_breakout_score = limit_up_count × 0.4 + change_pct × 0.3 + main_inflow_ratio × 0.3`；记入 IndustryFlow 新列
- 验收：score top 10 与人工观察的"今日爆发板块"高度一致

**US-07-6：申万二级 / 三级行业接入**
- 描述：扩展 AKShare endpoint 到二级三级行业；`industry_hierarchy` 增列 level + parent_industry_code
- 验收：可下钻 半导体 → 半导体材料

### D.3 P2

**US-07-7：行业突破 / 成交额历史百分位**
- 描述：派生指标：板块今日成交额 vs 60 日中位数；板块今日突破 60 日 high
- 验收：突破策略可消费

---

## E. 验收口径

1. 任选 5 个交易日，IndustryFlow 一级 86+ 行业全覆盖
2. ConceptFlow 上线后：任选 1 日的题材股（如"低空经济"龙头）能在 ConceptFlow 中找到对应概念
3. limit_up_count 准确性：任选 3 日，5 个行业的 limit_up_count 与 LimitUpStock 内手算结果一致
4. 行业轮动策略 paper trading 1 个月：top 5 行业 vs 沪深 300 超额 ≥ 3%
5. 板块爆发度评分：top 10 score 与人工观察的"今日热点板块" overlap ≥ 7

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/IndustryFlow.ts](../../backend/src/models/IndustryFlow.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/IndustrySyncService.ts](../../backend/src/data/services/IndustrySyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（L1461 `get_industry_flow`）
