# 21 — Alpha 因子库（22 个 factor 详解 + 待补缺口）

## A. 操盘手心智

因子是"市场无效性的可量化抓手"。每个因子背后必有一个**经济学故事**——为什么这种特征的股票将来跑赢？故事讲不通的因子都是 data mining，迟早归零。

A 股相对成熟市场多了几类独特因子：北向 / 龙虎榜 / 涨停连板 / 互动易热度 / 融资融券 / 大宗交易。把这些"中国特色"因子和经典 Fama-French 因子混搭，是 A 股量化的 alpha 源头。

---

## B. 系统设计

### B.1 18 + 4 = 22 个 factor 详解

每个 factor 一段：经济学逻辑 + 数据源 + 失效条件 + 相关性预估（与已有因子）。

#### B.1.1 value 价值因子（US-010）

- 逻辑：**Fama-French value premium** — 低估值股长期跑赢高估值股
- 公式: `1/PE_TTM + 1/PB`，避免单变量极端值
- 数据源: `StockValuationFactor.pe_ttm / pb` (`backend/src/quant/factors/library/ValueFactor.ts`)
- 失效: 抱团成长牛（2020 Q2 - 2021 Q1 茅指数 / 宁组合）；亏损股 PE<=0 强制剔除
- 相关性: 与 high_dividend 0.5+；与 quality 0.3；与 momentum 负相关 -0.2

#### B.1.2 quality 质量因子（US-010）

- 逻辑：**Asness QMJ** — 高 ROE/低负债/高现金流的"优质公司"长期跑赢
- 公式: 综合 ROE + 资产负债率 + 经营现金流 几个维度
- 数据源: `StockFundamentalFactor`
- 失效: 风格切换期；ROE 观测 < 2 个时跳过
- 相关性: 与 quality_high 0.7+（设计上同质，权重之比 0.10:0.07）；与 value 0.3

#### B.1.3 growth 成长因子（US-010）

- 逻辑：**业绩成长溢价** — 净利润 / 营收持续高增长股有定价溢价
- 公式: net_profit_growth + revenue_growth 加权
- 数据源: `StockFundamentalFactor`
- 失效: 增速预期已 priced in 后业绩兑现期的均值回归；业绩雷
- 相关性: 与 quality 0.3；与 momentum 0.4

#### B.1.4 momentum 动量因子（US-010）

- 逻辑：**Jegadeesh & Titman 1993** — 过去 N 月赢家未来 1-3 月继续赢
- 公式: `close[T-20] / close[T-120] - 1`，Asness 12-1 月动量剔除短反转
- 数据源: `DailyBar` 经 Stock.id 解析 (`MomentumFactor.ts`)
- 失效: 风格切换日（2014/11、2016/2、2017/11、2018/10、2020/3、2021/2 都崩过）
- 相关性: 与 momentum_reversal 0.3-0.5；与 low_vol 负 -0.3

#### B.1.5 low_vol 低波因子（US-010）

- 逻辑：**Low Volatility Anomaly** — 低波动股长期风险调整收益反而更高（Sharpe 更优）
- 公式: `-stddev(daily_returns[60])`，取负让高分=低波
- 数据源: `DailyBar`
- 失效: 牛市后期（高波动股急涨吃掉低波年化）；stddev=0 跳过
- 相关性: 与 high_dividend 0.5+；与 momentum 负

#### B.1.6 northbound 北向因子（US-010）

- 逻辑：**外资聪明钱信号** — 北向资金长期持股比例上升 = 海外机构看好
- 公式: hold_ratio 近 20 日 delta
- 数据源: `NorthboundHolding`
- 失效: 北向短期 noise；当日无数据或窗口 < 2 条跳过
- 相关性: 与 fund_consensus 0.3-0.4；与 margin_flow 0.2-0.4

#### B.1.7 money_flow 主力资金因子（US-010）

- 逻辑：**主力净流入** — 日级超大单 + 大单净流入 / 流通市值，反映席位级资金动向
- 数据源: `StockMoneyFlowFactor + Stock`
- 失效: circulating_market_cap ≤ 0；震荡市资金噪音大
- 相关性: 与 dragon_tiger 0.4；与 insider_trade 0.2-0.3

#### B.1.8 dragon_tiger 龙虎榜因子（US-010）

- 逻辑：**游资席位信号** — 知名营业部（famous_yz）净买入天数 = 游资抱团强度
- 公式: 窗口内 famous_yz 且 net_amount > 0 的**天数**（不用笔数，去噪）
- 数据源: `DragonTigerBoard`
- 失效: 未上榜的票不进 Map（中性补全为 0.5 percentile，避免拖低均值）
- 相关性: 与 money_flow 0.4；与 limit_up 板内 0.5+

#### B.1.9 liquidity 流动性因子（US-029）

- 逻辑：**U 形流动性溢价** — turnover 过低（僵尸股） / 过高（拥挤交易）都减分
- 公式: `-|avg_turnover_20 - P30| / sd`
- 数据源: `DailyBar.turnover_rate` (`LiquidityFactor.ts`)
- 失效: 有效 turnover < 10 / 全市场样本 < 2
- 相关性: 与 east_money_qa 0.3-0.5；与 money_flow 0.2

#### B.1.10 analyst_consensus 分析师一致预期上修（US-030）

- 逻辑：**Sell-side revision premium** — 分析师 EPS 预期上修股，短期跑赢
- 公式: per-year `(recent_avg - baseline_avg) / |baseline_avg|`，跨年度算术均值
- 数据源: `AnalystForecast`
- 失效: 90 日窗口内有效研报 < 5；baseline avg ≈ 0（亏损股 EPS 微变会放大）
- 相关性: 与 earnings_surprise 0.4+；与 growth 0.3

#### B.1.11 quality_high 高阶质量（US-031）

- 逻辑：**Asness QMJ Plus** — ROIC（用 ROE 代理）+ 毛利率稳定性 + 净利率 等权
- 数据源: `FinancialReport + StockFundamentalFactor.gross_margin`
- 失效: 任一子分量缺失即整体 null（异构维度，缺一项不能 0 代）
- 相关性: 与 quality 0.7+（与 quality 选一个用或合并）

#### B.1.12 earnings_surprise 盈利惊喜（US-032）

- 逻辑：**Post-Earnings Announcement Drift (PEAD)** — 实际 EPS 超预期股有 30-90 日漂移
- 公式: `(actual_eps - consensus_eps_avg) / |consensus_eps_avg|`
- 数据源: `FinancialReport + AnalystForecast`
- 失效: 最近财报 > 180 自然日 / 财报前研报 < 3 / `|consensus|` < 0.01 元/股
- 相关性: 与 analyst_consensus 0.4+；与 growth 0.3

#### B.1.13 momentum_reversal 动量反转差值（US-033）

- 逻辑：**Long vs Short momentum spread** — `mom_120 - mom_5`，正值=延续，负值=超涨反转
- 与 momentum 区别：momentum 是单一动量；本因子是两段动量差值
- 失效: bars < 121 / close ≤ 0
- 相关性: 与 momentum 0.3-0.5（非冗余，可同时用）

#### B.1.14 east_money_qa 散户关注度变化（US-034）

- 逻辑：**Retail attention shift** — 东财人气榜 rank 倒数近 5 日 / 近 30 日 baseline 比率
- 数据源: `StockSentiment.post_count` (代理: round(100000/rank))
- 失效: 30 日有效 post_count < 10 / baseline < 1.0
- 相关性: 与 liquidity 0.3-0.5；与 money_flow 0.1-0.2
- **代理注记**: AKShare 无真实发帖数，用人气榜 rank 倒数代理；scale-invariant 横截面 OK

#### B.1.15 shareholder_concentration 股东户数环比（US-035）

- 逻辑：**筹码集中度变化** — 户数下降 = 机构吸筹；上升 = 散户接盘
- 公式: `-(holder_count[latest] - prev) / prev`
- 数据源: `ShareholderCount` (季度低频)
- 失效: share_change != 0（送转股）整票跳过；快照 < 2 / holder_count_prev ≤ 0
- 相关性: 与 money_flow 0.3-0.4；与 northbound 0.1-0.2

#### B.1.16 gradual_breakout 渐进强爆（US-036）

- 逻辑：**Volume-Price Confirmation** — 近 30 日 Σ(daily_volume/avg_60d - 1) × sign(涨跌)
- 业务方向 4 象限: 量增价涨+ / 量减价涨- / 量减价跌+ / 量增价跌-
- 失效: bars < 61 / 60 日均量观测 < 30 / 近 30 日有效贡献天 < 21
- 相关性: 与 momentum 0.4；与 liquidity 0.3

#### B.1.17 insider_trade 内部人净买入（US-090）

- 逻辑：**Lakonishok & Lee 1998** — 董监高/大股东净买入是 alpha 信号
- 公式: 60 日 (Σ增持金额 - Σ减持金额) / 流通市值
- 数据源: `ShareholderTradeRecord`
- 失效: 60 日无公告 / 流通市值 ≤ 0
- 相关性: 与 money_flow 0.2-0.3；与 shareholder_concentration 0.2-0.3

#### B.1.18 margin_flow 融资余额变化（US-091）

- 逻辑：**杠杆资金方向** — 近 5 交易日融资余额变化率
- 公式: `(fin_balance[T] - fin_balance[T-5]) / fin_balance[T-5]`
- 数据源: `MarginTradingBalance`
- 失效: 当日无数据 / 5 日窗口 < 2 条 / baseline ≤ 0
- 相关性: 与 money_flow 0.3-0.4；与 northbound 0.2-0.4

#### B.1.19 industry_momentum 行业动量（Batch AC, 2026-06-18）

- 逻辑：**Industry rotation** — 让"今天该买半导体 vs 消费"成为可量化信号
- 公式: 5 交易日窗口 mean(industry_change_pct) + mean(industry_main_inflow_ratio) × 100
- 数据源: `IndustryFlow + Stock.industry` (`backend/src/quant/factors/library/IndustryMomentumFactor.ts:30-80`)
- 失效: Stock.industry 缺失；行业 5 日 flow 缺数据
- 相关性: 与 concept_heat 0.3-0.5；与 sector_rotation 策略输入直接相关

#### B.1.20 concept_heat 题材热度（Batch AC）

- 逻辑：**Cross-industry thematic exposure** — 跨行业概念（"AI 算力"含半导体+光通信+PCB）
- 公式: Σ(heat_score × hit_count) where stock ∈ keyword.related_stocks
- 数据源: `SnowballHotKeyword.related_stocks_json` (`backend/src/quant/factors/library/ConceptHeatFactor.ts`)
- 失效: 7 日窗口无关联 → 中性补全
- 相关性: 与 industry_momentum 0.3-0.5；与 east_money_qa 0.2

#### B.1.21 fund_consensus 公募抱团度（Batch AC）

- 逻辑：**机构共识 = 白马股** — 多个头部公募季报 top10 重仓 = 长期 alpha
- 公式: (重仓基金数) × log(累计占净值比例)
- 数据源: `FundTopHolding` (`backend/src/quant/factors/library/FundConsensusFactor.ts:1-79`)
- 失效: 季度低频（仅季报披露后 1-2 周内 IC 最强）；覆盖只有 12 家代表性基金
- 相关性: 与 quality 0.4-0.5；与 northbound 0.3

#### B.1.22 block_trade_signal 大宗交易折溢价（Batch AC）

- 逻辑：**Block trade premium/discount** — 大宗折价 = 机构甩货；溢价 = 机构抢筹
- 公式: 20 日 Σ(premium_pct × log(1 + amount/亿元))
- 数据源: `BlockTrade` (`backend/src/quant/factors/library/BlockTradeSignalFactor.ts`)
- 失效: premium_pct 缺；20 日窗口无大宗
- 相关性: 与 insider_trade 0.2；与 money_flow 0.1

### B.2 还缺哪些 alpha 因子（推荐增列）

按 alpha 显著性 × 实现复杂度排序：

#### B.2.1 P0 ROI 高（应该立即补）

1. **dividend_yield 高股息因子** — 当前用 HighDividendValue 策略内嵌算 yield_avg，没单独作 factor；提取为 factor 后 MFA 可直接加权
2. **turnaround 业绩拐点因子** — 前 4 季度连续亏损 / 微利 → 最新季度业绩转正，且 yoy > 100%
3. **ipo_freshman 次新股因子** — 上市 60-200 自然日窗口的 momentum；A 股次新有结构性溢价（pre-IPO 估值 + 解禁前博弈）
4. **industry_relative_strength 行业相对强度** — 个股 vs 行业指数 60 日 RS；区别于 industry_momentum 的行业绝对热

#### B.2.2 P1 中等 ROI

5. **high_dividend_persistence 高分红可持续性** — 不只是过去 3 年股息率高，还要 free_cash_flow / dividend ≥ 2 (分红没用借的)
6. **concept_breakthrough 概念板块突破** — 同概念多只股票同步放量 = 题材共振；联动 ConceptHeatFactor 增强
7. **continuous_limit_up_premium 连板溢价** — 二板 → 三板的胜率 × 平均收益；与 dragon_tiger 互补
8. **shareholder_increase 股东增持** — 区分自然人 vs 机构增持比例（insider_trade 当前不区分会损失信号）

#### B.2.3 P2 长期补

9. **etf_arbitrage_pressure ETF 申赎压力** — 重仓 ETF 申购时 ETF 内股有买盘压力
10. **margin_short_squeeze 融券逼空** — 融券余额下降 + 价格上涨 = 空头平仓
11. **convertible_bond_premium 可转债溢价** — 含可转债股票的转股套利信号
12. **policy_alignment_score 政策受益度** — NLP 从政策文档抽关键词命中所属行业（如"专精特新" / "新基建"）

---

## C. 现状 review

- 22 个因子文件: `backend/src/quant/factors/library/*.ts`
- 注册: `library/index.ts:30-51` 22 行 import-time self-register
- 类型: `Factor` 接口 (`backend/src/quant/factors/types.ts`) 4 字段 (name/description/category/compute)
- 复用 helper: `_helpers.ts` (stripSuffix / loadStocksByCodes / lookbackStartDate / isFiniteNumber) + `_tradingDayWindow.ts` (交易日窗口 vs 自然日窗口，Batch AC audit M-9 已切换 5 因子用真交易日)
- 测试: `backend/tests/factors/*.test.ts` 各 60-160 用例，全脱 DB（fake DataSource 模式）

### 现有问题（来自 review）

1. **22 个因子，但 CLAUDE.md / docs/00_overview.md 仍写 "18 个 / 20+"** — 文档与代码漂移
2. **fund_consensus / block_trade_signal / concept_heat 缺独立单测目录** — `ls backend/tests/factors/` 没有对应 .test.ts
3. **industry_momentum 的 baseline IndustryFlow 缺数据时静默跳过** (`IndustryMomentumFactor.ts` 第 50 行)，缺统计告警
4. **fund_consensus IC 还未验证** — 没有 factor_ic_results 跑过该因子；不知道实际 alpha 显著性

---

## D. 改造方案

### D.1 P0：补 dividend_yield / turnaround / ipo_freshman 3 个高 ROI 因子

每个新因子约 200-300 行：
- 数据源已有（DividendHistory / FinancialReport / Stock.listing_date）
- 在 library/ 加新文件，library/index.ts 加 import 一行
- 加 factors/ 下单测，断言纯函数 + 边界条件
- 自动进入 MFA 候选（权重默认 0.05，可由 ic_weighted 模式动态调）

### D.2 P1：industry_relative_strength + continuous_limit_up_premium

industry_relative_strength 与 momentum 互补 — 个股 momentum 高但行业 momentum 低 = 强势个股；可作"独立 alpha"，与 IndustryMomentumFactor 配对使用。

continuous_limit_up_premium 把 LimitUpStock.continuous_days 表中"二连板转三连板胜率"做成因子，给 DragonHead / GameTraderRelay 增强。

### D.3 P2：补 fund_consensus / block_trade_signal / concept_heat 单测

每个 factor 必须有 .test.ts 单测覆盖：边界 / NaN / 空 universe / 已知数值。

### D.4 持续 IC 验证 cron

让所有 22 个 factor 进 daily FactorICReport cron（已有 SchedulerService 任务 `FACTOR_IC_COMPUTE`，scheduler 第 4350 行），加上 fund_consensus / block_trade_signal / concept_heat 的覆盖。

---

## E. 验收口径

1. **覆盖率**: 每个 factor 在全市场 universe 覆盖率 ≥ 50%（或在 description 里明示低覆盖率原因）
2. **可解释**: 前端"因子详情"页能看到每个 factor 的 description / category / latest IC / 最近 30 日 z_score 分布 histogram
3. **独立性**: FactorCorrelationReport 跑完后 `|corr| > 0.7` 的因子对 ≤ 5 对（共 22 × 21 / 2 = 231 对）
4. **真生效**: 每个新因子上线前必须有 `factor_ic_results` 行；3 个月 rolling IC mean ≥ 0.02 才进 MFA 权重
