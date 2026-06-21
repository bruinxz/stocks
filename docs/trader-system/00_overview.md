# 00 — 总览：把"高级操盘手"做成自动化系统

**作者视角**：假设我是一名做了 10+ 年 A 股、做过游资 / 做过价值 / 做过量化的高级操盘手。我现在要把脑子里的方法论变成一个 24x7 自动运行的系统。本文档**只讲方法论**，不讲实现；之后每个模块（`01_*` .. `99_*`）会把方法论拆成可工程化的设计 + 对照仓内代码 review + 改造方案。

**核心目标**：自动化的买入卖出，帮人赚钱。**衡量标准（按重要性排序）**：
1. **不爆仓**（年化最大回撤 ≤ 15%，单日 ≤ 3%）
2. **打得过基准**（年化超额 ≥ 沪深 300 + 5%）
3. **能扩规模**（capacity ≥ 5000 万，市场冲击 ≤ 0.3%）
4. **能解释**（每笔交易能说出 3 条以上理由 + 复盘可追溯）

**这套系统的根本信念**：A 股不是"找一个圣杯策略一劳永逸"，而是**多策略组合 + 严格风控 + 持续迭代**。系统要能：(a) 接住不同行情（牛/熊/震荡/暴跌）；(b) 自动止损不抗；(c) 数据可信、信号可信、执行可信、复盘可信；(d) 任何一环断了能自动降级而不是悄悄放行。

---

## 一、操盘手的工作流（一个交易日如何决策）

### 早上 8:30 — 盘前准备
1. 看**昨夜外盘**（美股、美债、美元、油、铜、黄金）→ 决定今日风险偏好（risk-on / risk-off）
2. 看**今日重大事件**（央行会议、PMI、CPI 公布、关键公司业绩、解禁、限售解禁、退市预警）
3. 看**昨日盘后异动**（涨停板分析、龙虎榜、北向资金、ETF 申赎、社融数据）
4. 看**今日盘前**（集合竞价异动、机构席位发布的研报、ST 摘帽公告）
5. 形成**今日操作纪要**：
   - 大盘判断（多 / 中 / 空 + 仓位建议）
   - 重点关注板块（hot / warm / cold）
   - 今日候选标的清单（买入观察池）
   - 持仓压力测试（哪些票该减/止损）

### 9:25 — 集合竞价
- 看候选标的的**集合竞价集合委托**（一字 / 高开 / 低开 / 撤单异常）
- 调整今日**早盘策略**（追涨 / 等回踩 / 不买）

### 9:30 - 11:30 - 13:00 - 15:00 — 盘中
- **执行止损 / 止盈**（机械化，不手动判断）
- **观察候选标的**是否触发买点（量、价、时位三要素同时验证）
- **拒绝追高**（涨停板上不追、爆量阴线不接）
- **关注异动**（突然的盘口、突然的资金流、突然的板块拉升）

### 15:00 - 16:00 — 盘后复盘
- 今日交易归因（哪些赚了 / 哪些亏了 / 为什么）
- 持仓压力测试（明日如果跳空低开 5%，仓位如何？）
- 明日候选池更新

### 周末 / 月末
- 周回测：策略表现 vs 基准
- 月度调仓：调权重 / 启停子策略 / 重新评估因子有效性
- 学习：复盘自己被市场打脸的案例

---

## 二、操盘手的核心方法（拆成可工程化的 6 大模块）

### 模块 A：数据层（Data Layer）—— "进了什么数据决定能产生什么决策"
**操盘手心智**：我每天看十几个数据源（行情、基本面、北向、龙虎榜、研报、公告、政策、舆情、互动易）。如果这些数据来不全或者来晚了，决策一定是错的。

**6 项硬要求**：
1. **多源**：行情至少 2 个源（主源 AKShare + 备源腾讯/新浪），互相校验
2. **新鲜**：盘中行情 ≤ 30 秒延迟、基本面 T+1 入库、舆情 T+2 入库
3. **完整**：A 股全市场（含 BJ 920/430）≈ 5500 只股票全覆盖
4. **可追溯**：每条记录带 `source / ingested_at / as_of_time`
5. **可验证**：每日自动 sanity check（涨跌幅范围、停牌识别、缺失率）
6. **可降级**：一个源挂了 → 自动切备源 + 写 RiskAlert + 不阻断决策（除非主备都挂）

详见 [01_data_sources_overview.md](01_data_sources_overview.md) 以及 [02_data_market_quotes.md](02_data_market_quotes.md) ~ [12_data_calendar_events.md](12_data_calendar_events.md) 等子文档。

### 模块 B：因子与信号（Alpha Engine）—— "信号是什么、为什么有效、什么时候失效"
**操盘手心智**：A 股能赚的钱无非几类——价值（长期低估值）、成长（业绩兑现）、动量（趋势延续）、反转（短期超跌）、情绪（事件驱动）、资金（机构/北向/游资动向）、规模（小盘）、行业轮动、龙头共振。每类都有它**赚钱的市场状态**和**失效的市场状态**。

**6 项硬要求**：
1. **每个因子有清晰的经济学逻辑**（不靠 data mining）
2. **每个因子 IC ≥ 0.03 / IR ≥ 0.3 才上线**（持续 3 个月不达标即下线）
3. **因子之间相关性 ≤ 0.7**（高相关合并或剔除）
4. **因子按市场状态加权**（牛市侧重动量 + 成长，熊市侧重低波动 + 高分红）
5. **每个信号有"为什么这只票被推荐"的可解释 evidence**（≥ 3 条）
6. **信号有时效**（产生后 1-3 个交易日未被消化即失效）

详见 [20_alpha_engine_overview.md](20_alpha_engine_overview.md)、[21_alpha_factor_library.md](21_alpha_factor_library.md)、[22_alpha_signal_generation.md](22_alpha_signal_generation.md)。

### 模块 C：策略与组合（Strategy & Portfolio）—— "怎么把信号变成持仓"
**操盘手心智**：信号告诉我"这只票现在可能涨"，但是否买、买多少、什么时候买、什么时候卖，是另一回事。

**6 项硬要求**：
1. **多策略组合**：至少 3 个不同风格策略（趋势 + 反转 + 价值），按市场状态分配权重
2. **仓位有上限**：单股 ≤ 8%、单行业 ≤ 25%、单策略 ≤ 30%、总仓位 ≤ 95%
3. **Kelly + ATR 双轨**：理论仓位（Kelly）和波动率仓位（ATR-based）取小
4. **执行有节奏**：大单拆 TWAP / VWAP / Iceberg
5. **再平衡有边界**（不每天动，只在偏离 > 3% 时调）
6. **每个策略有 kill switch**：连续 N 天表现差 → 自动暂停

详见 [30_strategy_overview.md](30_strategy_overview.md)、[31_strategy_dragon_head.md](31_strategy_dragon_head.md) ~ [38_strategy_ensemble.md](38_strategy_ensemble.md)、[40_portfolio_construction.md](40_portfolio_construction.md)、[41_position_sizing.md](41_position_sizing.md)、[42_rebalancing.md](42_rebalancing.md)、[43_execution_algos.md](43_execution_algos.md)。

### 模块 D：风控（Risk Management）—— "不爆仓比赚钱更重要"
**操盘手心智**：我见过太多人一笔大亏归零。系统化的好处是机械执行止损，没有"再扛一天"的心理。

**8 项硬要求**：
1. **pre-trade gate**：5 wizard 合规检查 + 涨跌停拦截 + T+1 + ST + 停牌
2. **per-stock 止损 / 止盈 / 追踪止损**：止损 -7% 硬线 / ATR 动态 / 突破后跟踪
3. **行业集中度熔断**：单行业 > 25% 触发减仓
4. **组合最大回撤熔断**：组合 dd > 8% 触发减仓 50% / dd > 12% 全仓清空
5. **市场环境熔断**：连续 3 日跌停个股数 > 100 → 全市场暂停建仓
6. **黑天鹅 watchdog**：ST 公告 / 退市预警 / 重大诉讼 / 高管减持暴增 → 立即清仓
7. **限售解禁预警**：解禁前 5 日仓位降一半
8. **fail-closed**：风控不可用时**拒单**而不是放行

详见 [50_risk_overview.md](50_risk_overview.md)、[51_risk_position_limits.md](51_risk_position_limits.md) ~ [58_risk_kill_switch.md](58_risk_kill_switch.md)。

### 模块 E：执行与对账（Execution & Reconciliation）—— "决策落地的最后一公里"
**操盘手心智**：好策略 + 烂执行 = 烂回报。滑点 1% 吃掉年化 10% 不奇怪。

**6 项硬要求**：
1. **算法执行**：大单 TWAP / VWAP / Iceberg，小单立即；按盘口流动性自适应
2. **集合竞价 vs 连续竞价 vs 收盘竞价**区分处理
3. **可行性预判**：feasibility score < 60 不下单（流动性差、bid/ask 异常、停牌）
4. **下单全幂等**：client_order_id 唯一、broker event 去重
5. **对账主动告警**：alignment_score < 70 / live_only / paper_only 漂移 → RiskAlert
6. **bridge fail-safe**：bridge 失联 / KillSwitch 激活 → 所有 pending 命令转 aborted

详见 [60_execution_overview.md](60_execution_overview.md)、[61_execution_feasibility.md](61_execution_feasibility.md)、[62_execution_algorithms.md](62_execution_algorithms.md)、[63_execution_bridge.md](63_execution_bridge.md)、[64_reconciliation.md](64_reconciliation.md)。

### 模块 F：复盘与迭代（Postmortem & Evolution）—— "持续学习是 alpha 的源头"
**操盘手心智**：市场永远在变，去年管用的因子今年可能死掉。系统必须不断"自检 + 进化"。

**6 项硬要求**：
1. **每日交易归因**：盈亏拆解到（因子 / 行业 / 时机 / 选股 / 择时）
2. **每周策略表现**：vs 基准、vs 上周、vs 历史均值；策略相关性、capacity 估算
3. **每月因子有效性**：IC 衰减监测、相关性矩阵、redundancy 告警
4. **每季度参数重训**：贝叶斯 / grid search / walk-forward
5. **黑天鹅事件复盘**：每次大跌 / 大涨后输出"系统是否预警 / 风控是否触发"报告
6. **AI 辅助复盘**：自动生成日记、自动识别错误模式（如"频繁追高")、自动建议改进

详见 [70_postmortem_overview.md](70_postmortem_overview.md)、[71_attribution_daily.md](71_attribution_daily.md) ~ [76_self_evolution.md](76_self_evolution.md)。

---

## 三、模块之间的关系（一图概括）

```
┌──────────────────────────────────────────────────────────────────┐
│  模块 A: 数据层 (10+ 数据源 → PG/TimescaleDB)                     │
│   行情 / 基本面 / 北向 / 龙虎榜 / 涨停 / 公告 / 研报 / 舆情 / 互动易 │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  模块 B: 因子与信号 (18+ factor, IC/IR 持续监测)                 │
│   value / quality / growth / momentum / low_vol / northbound /  │
│   money_flow / dragon_tiger / liquidity / sentiment / event ... │
│        ↓                                                         │
│   FactorPipeline → factor_scores → MultiFactorAlpha / DragonHead│
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  模块 C: 策略与组合 (13+ 策略, 按 regime 加权融合)              │
│   每个策略 → target_portfolio → 组合优化 (PortfolioOptimizer)   │
│        → PositionSizingPolicy → RebalanceEngine                 │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  模块 D: 风控 (8 层闸门, fail-closed)                            │
│   pre-trade: compliance + limits + 涨跌停 + T+1 + ST            │
│   post-trade: trailing stop + per-stock + drawdown + industry   │
│   watchdog: black-swan + restricted-share + market-regime       │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  模块 E: 执行 + 对账                                              │
│   ExecutionPolicyRouter → TWAP/VWAP/Iceberg → broker-bridge     │
│        ← Fill events ← Reconciliation cron → 飞书告警            │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│  模块 F: 复盘 + 迭代                                              │
│   daily attribution / weekly review / monthly factor IC /        │
│   quarterly param retrain / black-swan postmortem / AI diary    │
└──────────────────────────────────────────────────────────────────┘
                              ↓
                    返回到模块 B/C 调整权重
```

---

## 四、本设计与现有系统的关系

我们仓内已经有 80% 的基础设施（行情 / 因子 / 策略 / 回测 / 实盘 bridge / paper trading / shadow mode / 多维分析引擎 v1），最近的 audit (`docs/audit/`) 已经把 24 个 S/M/L 缺陷修了 17 个。

但是有一些**关键的"看似有，实则未真正生效"** 的地方，会在每个子文档的 review 段揭示，例如：
- "组合级策略在回测引擎里不下单" — 已修但 caller 层未全接通（ALPHA 的 caller layer 是 TODO）
- "shadow mode v1 不进 hard cutover" — runbook 完整但 W4+ 是 v2 工作
- "对账 cron 已注册但还没数据可验证" — 需要 paper account 跑一段时间
- "AI 个股分析" — 8 analyzer 框架就绪但 NewsAnalyzer 的 KOLAggregator 输入只是占位
- "BJ 920/430 默认避开" — 已生效，但 `include_bj` 开关后是否要在前端暴露给用户？UX 缺

每个子文档会基于现有代码给出"缺什么 / 该补什么 / 怎么补"。最后 [99_implementation_roadmap.md](99_implementation_roadmap.md) 会汇总所有补丁，按依赖排序，得到 ralph 的 prd.json 故事单。

---

## 五、本套设计的"成功标准"（用户验收口径）

1. **正确性**：跑 2020-2025 全 A 股回测，至少 1 个策略 sharpe ≥ 1.2，组合 sharpe ≥ 1.5
2. **稳定性**：任意 30 日窗口最大回撤 ≤ 12%
3. **可扩展性**：所有 5500 只股票每日因子 + 信号生成 ≤ 15 分钟
4. **可解释性**：随机抽 10 笔交易，AI 引擎能给出每笔 ≥ 3 条 evidence
5. **可观测性**：从 cron → 信号 → 风控 → 下单 → 回报 全链路在 Grafana 可见
6. **自我保护**：故意制造 5 种异常（数据源挂 / DB 抖 / bridge 失联 / 涨停 / 黑天鹅），系统都能 fail-closed
7. **前端可用**：6 工作区都能跑通 happy path + 至少 1 个真实样本股的完整 AI 分析

---

## 六、文档清单（本目录下）

| 编号 | 文件 | 主题 |
|---|---|---|
| 00 | 00_overview.md | 本文，操盘手方法论 + 6 大模块 + 系统关系图 |
| 01 | 01_data_sources_overview.md | 数据层总览 |
| 02 | 02_data_market_quotes.md | 行情数据（日线 / 实时 / 盘口） |
| 03 | 03_data_fundamentals.md | 基本面（PE/PB/ROE/营收/利润/资产负债） |
| 04 | 04_data_northbound.md | 北向资金（持股 / 流入 / 增减） |
| 05 | 05_data_dragon_tiger.md | 龙虎榜（机构 / 游资 / 著名席位） |
| 06 | 06_data_limit_up.md | 涨停板（连板 / 炸板 / 封板时间） |
| 07 | 07_data_industry_flow.md | 行业资金流（板块强弱） |
| 08 | 08_data_announcements.md | 公告（财报 / 重大事项 / 减持） |
| 09 | 09_data_research_reports.md | 研报（一致预期 / 评级变化） |
| 10 | 10_data_sentiment_news.md | 新闻 + KOL + 雪球热词 + 互动易 |
| 11 | 11_data_calendar_events.md | 事件日历（业绩 / 解禁 / 央行） |
| 12 | 12_data_margin_insider.md | 融资融券 + 内部人交易 + 股东户数 |
| 20 | 20_alpha_engine_overview.md | Alpha 引擎总览 |
| 21 | 21_alpha_factor_library.md | 因子库（18+ factor 详解） |
| 22 | 22_alpha_signal_generation.md | 信号生成 pipeline |
| 23 | 23_alpha_factor_ic_monitor.md | 因子 IC / IR 持续监测 |
| 30 | 30_strategy_overview.md | 策略总览 |
| 31 | 31_strategy_multi_factor_alpha.md | 多因子选股策略 |
| 32 | 32_strategy_dragon_head.md | 龙头策略 |
| 33 | 33_strategy_breakout.md | 突破策略 |
| 34 | 34_strategy_left_side_reversal.md | 左侧反转策略 |
| 35 | 35_strategy_high_dividend.md | 高股息价值策略 |
| 36 | 36_strategy_earnings_surprise.md | 业绩超预期策略 |
| 37 | 37_strategy_northbound_follow.md | 北向跟随策略 |
| 38 | 38_strategy_ensemble.md | 策略融合（regime + 权重） |
| 40 | 40_portfolio_construction.md | 组合构造 |
| 41 | 41_position_sizing.md | 仓位算法（Kelly + ATR） |
| 42 | 42_rebalancing.md | 再平衡 |
| 43 | 43_execution_algos.md | 执行算法（TWAP/VWAP/Iceberg） |
| 50 | 50_risk_overview.md | 风控总览 |
| 51 | 51_risk_position_limits.md | 仓位上限 |
| 52 | 52_risk_stop_loss.md | 止损 / 止盈 / 追踪 |
| 53 | 53_risk_drawdown_breaker.md | 组合熔断 |
| 54 | 54_risk_industry_concentration.md | 行业集中度 |
| 55 | 55_risk_market_regime.md | 市场环境熔断 |
| 56 | 56_risk_black_swan.md | 黑天鹅监测 |
| 57 | 57_risk_restricted_share.md | 限售解禁预警 |
| 58 | 58_risk_kill_switch.md | Kill Switch |
| 60 | 60_execution_overview.md | 执行总览 |
| 61 | 61_execution_feasibility.md | 可行性预判 |
| 62 | 62_execution_algorithms.md | 算法详解 |
| 63 | 63_execution_bridge.md | broker-bridge 协议 |
| 64 | 64_reconciliation.md | 对账 |
| 70 | 70_postmortem_overview.md | 复盘总览 |
| 71 | 71_attribution_daily.md | 每日归因 |
| 72 | 72_weekly_strategy_review.md | 每周策略表现 |
| 73 | 73_monthly_factor_ic.md | 每月因子 IC 衰减 |
| 74 | 74_quarterly_param_retrain.md | 每季度参数重训 |
| 75 | 75_black_swan_postmortem.md | 黑天鹅复盘 |
| 76 | 76_self_evolution.md | AI 自进化（日记 / 错误模式） |
| 80 | 80_ai_analysis_engine.md | AI 多维分析引擎 v2（v1 复盘 + 改造） |
| 81 | 81_ai_news_kol.md | AI 新闻 + KOL 聚合 |
| 82 | 82_ai_announcement_nlp.md | AI 公告 NLP |
| 83 | 83_ai_qa_topic.md | AI 互动易 NLP |
| 84 | 84_ai_copilot.md | AI 策略 Copilot |
| 90 | 90_frontend_workspace.md | 前端 6 工作区设计 |
| 91 | 91_frontend_alerts_panel.md | 前端实时告警面板 |
| 92 | 92_frontend_analysis_modal.md | AI 分析弹窗 v2 |
| 99 | 99_implementation_roadmap.md | 实施路线图 → ralph prd.json 故事单 |

每份文档遵循同一结构：
- **A. 操盘手心智**（this is why）
- **B. 系统设计**（what we want）
- **C. 现状 review**（what we have，对照仓内代码）
- **D. 改造方案**（how to bridge gap，列 user story）
- **E. 验收口径**（when we call it done）
