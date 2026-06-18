# 12 — 融资融券 + 内部人交易 + 股东户数

> 这是 3 类"中介信号"数据：杠杆资金、内部人决策、筹码集中度。彼此互补，组合起来反映"内部人/机构 vs 散户"的力量对比。

## A. 操盘手心智

这 3 类数据是 **"中线资金跟踪"** 的核心：

1. **融资融券（margin trading）**：杠杆资金（融资 = 看多，融券 = 看空）。融资余额突增 = 杠杆资金加仓；突减 = 撤退
2. **内部人增减持（shareholder_trade）**：董监高 + 大股东主动买卖。**增持是中线 alpha 信号**（实证：Lakonishok & Lee 1998）；**密集减持是中线风险信号**
3. **股东户数（shareholder_count）**：A 股特色低频指标，季度披露。户数下降 = 筹码集中（机构吸筹）；户数上升 = 筹码分散（散户接盘）

**3 个典型 use case**：
1. **融资跟随策略（MarginFlow factor [`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-091）**：某股 5 日融资余额增 +30% → 杠杆资金加仓，跟买
2. **内部人增持金跟买（InsiderTrade factor US-090）**：高管 60 日净买入 / 流通市值 top 1% → 跟随中线持有
3. **筹码集中跟买（ShareholderConcentration factor US-035）**：股东户数环比 -10%（机构吸筹）→ 跟随

**不看这 3 类**：
- 不看融资 → 杠杆资金集体撤退时还满仓（2021 年茅指数 case）
- 不看内部人 → 错过最高质量的 buy signal
- 不看户数 → 看不见机构吸筹 / 散户接盘的拐点

---

## B. 系统设计

### B.1 schema 推荐

**MarginTradingBalance**（现有 [`backend/src/models/MarginTradingBalance.ts`](../../backend/src/models/MarginTradingBalance.ts) 203 行）：
- PK: `(trade_date, stock_code)`
- 字段：fin_balance / fin_buy_amt / fin_repay_amt / short_balance / short_sell_vol / short_volume / total_margin_balance / **exchange** ∈ {SZSE, SSE}
- ⚠️ 两交易所列名不一致；SZSE 没"融资偿还额"；SSE 没"融券余额" — 已在 Python helper 内统一对齐 + NULL 兜底

**ShareholderTradeRecord**（现有 [`backend/src/models/ShareholderTradeRecord.ts`](../../backend/src/models/ShareholderTradeRecord.ts) 231 行）：
- 5 元 PK: `(announce_date, stock_code, shareholder_name, trade_direction, change_start_date)`
- 字段：trade_shares / **trade_amount**（代理 = shares × latest_price）/ **shareholder_type** ∈ {机构投资者/自然人/高管/其他} / pct_of_total/float_shares / post_hold_shares
- ⚠️ trade_amount 是代理（AKShare 无成交均价）

**ShareholderCount**（现有 [`backend/src/models/ShareholderCount.ts`](../../backend/src/models/ShareholderCount.ts) 215 行）：
- PK: `(report_date, stock_code)`
- 字段：holder_count / holder_count_prev / **holder_count_change** / interval_change_pct / total_market_cap / total_shares / **share_change**（送转 / 增发 → 户数变化无意义）/ announce_date
- ⚠️ share_change != 0 时环比因子要 skip（避免送转污染）

### B.2 6 项硬要求

1. **融资融券 T+1 入库**：两交易所 T+1 早 9:30 披露昨日；cron 10:00 跑
2. **内部人交易实时入库**：快照型 endpoint（[`ShareholderTradeRecord.ts:26-28`](../../backend/src/models/ShareholderTradeRecord.ts)），无日期参数，每日全量 upsert
3. **股东户数季度披露**：年报披露窗口（4 月）+ 季报（10 月）集中入库；其他时点低频
4. **风险预警**：高管 60 日净减持 > 5% 流通市值 → 写 RiskAlert(rule_id='insider_dump')
5. **代理透明化**：trade_amount 是代理（× latest_price），公示给 ops 看
6. **scale-invariant 因子设计**：用 ratio（净买入 / 流通市值）避免代理偏差

### B.3 派生信号

- **MarginFlowFactor**（US-091）：5 日融资余额变化率
- **InsiderTradeFactor**（US-090）：60 日净买入 / 流通市值
- **ShareholderConcentrationFactor**（US-035）：股东户数环比

---

## C. 现状 review

### C.1 已实现

| 项 | 文件 | 状态 |
|---|---|---|
| MarginTradingBalance model | [`MarginTradingBalance.ts`](../../backend/src/models/MarginTradingBalance.ts) 203 行 | ✅ 两交易所对齐 |
| MarginTradingSyncService | [`MarginTradingSyncService.ts`](../../backend/src/data/services/MarginTradingSyncService.ts) 345 行 | ✅ |
| ShareholderTradeRecord model | [`ShareholderTradeRecord.ts`](../../backend/src/models/ShareholderTradeRecord.ts) 231 行 | ✅ 5 元 PK |
| ShareholderTradeSyncService | [`ShareholderTradeSyncService.ts`](../../backend/src/data/services/ShareholderTradeSyncService.ts) 233 行 | ✅ |
| ShareholderCount model | [`ShareholderCount.ts`](../../backend/src/models/ShareholderCount.ts) 215 行 | ✅ |
| ShareholderCountSyncService | [`ShareholderCountSyncService.ts`](../../backend/src/data/services/ShareholderCountSyncService.ts) 202 行 | ✅ |
| MarginFlowFactor | [`library/MarginFlowFactor.ts`](../../backend/src/quant/factors/library/MarginFlowFactor.ts) US-091 | ✅ |
| InsiderTradeFactor | [`library/InsiderTradeFactor.ts`](../../backend/src/quant/factors/library/InsiderTradeFactor.ts) US-090 | ✅ |
| ShareholderConcentrationFactor | [`library/ShareholderConcentrationFactor.ts`](../../backend/src/quant/factors/library/ShareholderConcentrationFactor.ts) US-035 | ✅ |

### C.2 关键缺口

| # | 缺什么 | 证据 | 影响 |
|---|---|---|---|
| 12-1 | **融资融券深交所无"融资偿还额"** | [`MarginTradingBalance.ts:121-126`](../../backend/src/models/MarginTradingBalance.ts) | service 层 day-to-day diff 推算；推算逻辑是否健壮需 review |
| 12-2 | **融资融券融券余额上交所缺** | [`MarginTradingBalance.ts:133`](../../backend/src/models/MarginTradingBalance.ts) | 融券方向信号在 SH 标的看不到 |
| 12-3 | **trade_amount 代理偏差** | [`ShareholderTradeRecord.ts:38-40`](../../backend/src/models/ShareholderTradeRecord.ts) | 横截面排序受 latest_price 时点影响 |
| 12-4 | **shareholder_type 启发式归类不公开** | grep "classifyShareholderType" 内部实现 | 准确率 ops 不可见 |
| 12-5 | **内部人减持告警缺** | 持仓股密集减持无 RiskAlert | 黑天鹅风险 |
| 12-6 | **股东户数 share_change 过滤逻辑**：因子默认 EXCLUDE_SHARE_CHANGE_PERIODS=true | [`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-035 | 送转股 / 增发后 1-2 个季度的因子值为 null（数据可用性变化） |
| 12-7 | **市场级融资融券聚合无表** | grep "margin_market_summary" 无 | 大盘择时计算需现 sum |
| 12-8 | **股东户数披露延迟**：announce_date - report_date 可能 7-30 天（[`ShareholderCount.ts:187`](../../backend/src/models/ShareholderCount.ts)） | model 注释 | as_of_date 必须 ≥ announce_date 否则 lookahead bias |

---

## D. 改造方案

### D.1 P0

**US-12-1：内部人密集减持告警**
- 描述：每日 20:00 跑 `InsiderDumpDetector`：持仓股近 30 日累计减持 / 流通市值 > 5% → 写 RiskAlert(rule_id='insider_dump_warning')
- 验收：测试 case 5 个全触发；飞书弱告警

**US-12-2：融资融券市场级聚合**
- 描述：建 `margin_market_summary` 派生表 (trade_date, total_fin_balance, total_short_balance, fin_inflow_5d, signal_strength); 每日 cron
- 验收：MarketSentimentIndex 直接 join；性能 ≥ 5×

**US-12-3：trade_amount 代理透明化**
- 描述：UI "内部人交易" 卡片显示 "trade_amount 为代理值 (粗略 × latest_price)"；ops 不依赖此做精确报表
- 验收：用户能看到 banner

### D.2 P1

**US-12-4：shareholder_type 准确率回测**
- 描述：抽 200 条样本人工标注 shareholder_type；vs 启发式分类对比；记录准确率 dashboard
- 验收：准确率 dashboard ≥ 85%；< 80% 触发人工 review

**US-12-5：SZSE 融资偿还额推算单测覆盖**
- 描述：构造 5 个 SZSE day-to-day case，验证 fin_repay_amt = max(0, prev_fin_balance + fin_buy_amt - fin_balance) 推算正确
- 验收：单测覆盖；边界 case（prev 缺失）输出 null 而非 0

**US-12-6：股东户数 share_change 过滤替代方案**
- 描述：当前因子 skip 整股；改为只 skip 该期，下一期恢复计算；保留中性补全
- 验收：因子覆盖率提升 ≥ 10%

### D.3 P2

**US-12-7：融券真接入（远期）**
- 描述：SSE "融券余额" 接入：寻找替代源（如 Wind / TuShare Pro）
- 验收：SSE 标的融券方向信号可用

**US-12-8：内部人增持金额质量打分**
- 描述：增持金额 / 内部人总持股 = 增持比例；比例 > 5% 标 "强增持"；信号权重高
- 验收：因子细分 weak/normal/strong 增持

---

## E. 验收口径

1. MarginTradingBalance 覆盖：任选 5 个交易日，两交易所 fin_balance 数据 ≥ 4000 只
2. InsiderTradeFactor 单测：构造测试 case，60 日净买入 +1 亿 + 流通市值 10 亿 → 因子值 = 0.1（[`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-090 已有 106 测试）
3. MarginFlowFactor 单测：构造 5 日 fin_balance 从 1 亿到 1.3 亿 → 因子值 = +0.30（[`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-091 已有 62 测试）
4. ShareholderConcentrationFactor：单测 holder_count 从 10 万降到 9 万 → 因子值 = +0.10（[`factors/CLAUDE.md`](../../backend/src/quant/factors/CLAUDE.md) US-035 已有 84 测试）
5. InsiderDump 告警：构造测试 case 密集减持 > 5%，告警 5 分钟内到飞书
6. shareholder_type 准确率：200 条人工标注 vs 启发式 ≥ 85%

---

## 引用文件清单

- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/MarginTradingBalance.ts](../../backend/src/models/MarginTradingBalance.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/ShareholderTradeRecord.ts](../../backend/src/models/ShareholderTradeRecord.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/models/ShareholderCount.ts](../../backend/src/models/ShareholderCount.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/MarginTradingSyncService.ts](../../backend/src/data/services/MarginTradingSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/ShareholderTradeSyncService.ts](../../backend/src/data/services/ShareholderTradeSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/data/services/ShareholderCountSyncService.ts](../../backend/src/data/services/ShareholderCountSyncService.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/library/MarginFlowFactor.ts](../../backend/src/quant/factors/library/MarginFlowFactor.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/library/InsiderTradeFactor.ts](../../backend/src/quant/factors/library/InsiderTradeFactor.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/library/ShareholderConcentrationFactor.ts](../../backend/src/quant/factors/library/ShareholderConcentrationFactor.ts)
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/src/quant/factors/CLAUDE.md](../../backend/src/quant/factors/CLAUDE.md)（US-035 / US-090 / US-091 设计判据）
- [/Users/bytedance/go/src/github.com/bruinxz/stocks/backend/python/akshare_helper.py](../../backend/python/akshare_helper.py)（L4094 `get_shareholder_trade` / L4331 `get_margin_trading_detail` / L2769 `get_shareholder_count`）
