# 90 — 前端 6 工作区设计完善度 review

## A. 操盘手心智

前端是**操盘手与系统的唯一接口**。一个高级操盘手的工作流必须能通过 ≤ 3 次点击完成所有日常操作：

- 早上：1 click 看今日大盘 + 候选 + 风险
- 盘中：1 click 改持仓 / 触发 alert
- 盘后：1 click 看归因 / 复盘 / 调权
- 周末：1 click 看周报 + 调整下周计划

**6 工作区设计**已经收敛了 38 页 → 6 页（参见 prd.json US-001/US-002），但每个工作区内部仍有"该有没有 / 路径太深 / 信息密度不够"问题。本文档对 6 工作区列出"现状 + 5 P0 改进 each"。

---

## B. 系统设计：6 工作区职责

| 工作区 | 解决"做什么"问题 | 顶部 KPI | 主操作 |
|---|---|---|---|
| TodayWorkspace（今日作战） | 今天该买什么/卖什么/避什么 | 账户余额/昨日盈亏/月收益/未读告警 | 一键应用信号 |
| FactorWorkspace（选股因子） | 因子层视角的候选股 | 因子 hit 数/今日 picks 数 | 调因子权重 |
| LabWorkspace（策略实验室） | 策略研发 / 回测 / 优化 | 我的策略数/最近回测数 | 新建回测/walk-forward |
| PortfolioWorkspace（持仓与复盘） | 持仓监控 / 历史复盘 | 总市值/今日盈亏/持仓数 | 调仓/平仓 |
| DataWorkspace（数据中心） | 数据健康监控 | 数据健康卡片红/黄/绿 | 触发同步 |
| SettingsWorkspace（账号设置） | 配置 / 推送 / 权限 | — | 编辑配置 |

---

## C. 现状 review（按 workspace）

### C.1 TodayWorkspace（`frontend/src/pages/workspace/TodayWorkspace.tsx:84-88`）

**Tabs**：signals / events / alerts / risk_center
**Lines**：1888 行

**已有**：
- 今日信号 3 列（MultiFactorAlpha / DragonHead / EarningsSurprise）
- 关键事件 + 高连板涨停
- 风险告警未读列表 + markAllRead
- AIStockAnalysisModal 集成
- 一键应用信号到模拟盘

**5 个 P0 改进**：
1. **没有"今日大盘判断"区块**：早上必看的"昨夜外盘 / 今日 regime / 风险偏好"完全缺失
2. **没有"集合竞价异动"区块**：9:25 之后市场动作没暴露给用户
3. **没有"今日交易计划"卡片**：从信号到下单中间缺"我今天打算买这 N 只"的工作流
4. **AI 大盘 brief 在哪？**：getMarketBriefToday 已 import 但仅展示文字，没有 LLM summary
5. **没有"今日卖出建议"**：只有买入信号，止盈/止损/减持的"今天该卖"列表完全缺失

### C.2 FactorWorkspace（`frontend/src/pages/workspace/FactorWorkspace.tsx:115-122`）

**Tabs**：overview / weights / picks / board / sentiment / macro / block
**Lines**：2617 行（+ BlockTrades 271 + MacroEnv 388 = 3276 行）

**已有**：
- 因子总览（18+ factor 列表）
- 权重调参 slider
- 今日选股清单
- 行业决策面板
- 舆情雷达（KOL / 新闻）
- 宏观环境
- 大宗交易

**5 个 P0 改进**：
1. **缺"因子健康度"信息**：每个因子的 IC_90d / IR_90d / classification (hot/warm/cold/dead) 没展示（73 文档的输出）
2. **权重调参 slider 没有"AI 建议权重"对照**：用户调权时没参考
3. **缺"自定义组合 factor 模板"**：用户只能改单 factor 权重，不能保存"价值组合 / 成长组合"
4. **缺 ETF 申赎 + 政策导向 tab**（81 文档新增的数据源）
5. **picks 列表缺"为什么入选"的 inline 说明**：要点击 modal 才能看 evidence，密度低

### C.3 LabWorkspace（`frontend/src/pages/workspace/LabWorkspace.tsx:98-106`）

**Tabs**：mine / leaderboard / new / compare / walk_forward / optimization / advanced_quant
**Lines**：2080 行（+ Tabs 1819 行 = ~3900 行）

**已有**：
- 我的策略列表
- 策略排行 leaderboard
- 新建回测
- 回测对比
- Walk-Forward 验证
- 优化历史
- 高级量化（GridSearch / Bayesian / Monte Carlo / Portfolio Opt）

**5 个 P0 改进**：
1. **缺"季度参数重训 dashboard"**（74 文档的输出）：当前用户看不到候选 vs 现行参数
2. **缺"shadow run 对比"区块**：策略参数 shadow 运行状态没暴露
3. **缺"OverfitMetrics 校验"显示**：跑完回测没显示 PBO / Deflated Sharpe
4. **新建回测的"参数空间"输入太手工**：应该提供"快速 grid"模板
5. **leaderboard 缺"vs benchmark"列**：只有 sharpe / return，没有 vs HS300/ZZ500 超额

### C.4 PortfolioWorkspace（`frontend/src/pages/workspace/PortfolioWorkspace.tsx:96-101`）

**Tabs**：positions / equity / trades / journal / correlation
**Lines**：1994 行

**已有**：
- 当前持仓 + 价格 + 行业
- 资金曲线
- 交易明细
- 复盘日记
- 相关性矩阵

**5 个 P0 改进**：
1. **缺"日 attribution"卡片**（71 文档输出）：当前只看 equity，不看归因
2. **缺"周报 / 月报 / 季报"tab**（72-74 文档）：复盘日记是"单笔"级，缺"时段"级
3. **缺"行业集中度"实时显示**：单行业 > 25% 应该 KPI 区红色高亮
4. **缺"持仓风险指标"**：当前每持仓显示市值 + 涨跌，缺 ATR / drawdown / days_held 等高级指标
5. **缺"AI 自进化日记 + 错误模式"**（76 文档）：复盘日记是手动，AI 自生成日记没集成

### C.5 DataWorkspace（`frontend/src/pages/workspace/DataWorkspace.tsx:37-44`）

**Tabs**：health / stocks / sync / tasks / logs / monitoring
**Lines**：155 行（最薄的工作区）

**已有**：
- 数据健康卡片
- 个股趋势
- 行情同步
- 调度任务
- 系统日志
- 健康监控

**5 个 P0 改进**：
1. **太薄了**：155 行只是 KPI 占位 + 6 个空 tab，实际内容散落在其它组件
2. **数据时效 SLA dashboard 缺**：盘中行情延迟 / 基本面 T+1 / 舆情 T+2 的实时 SLA 监控
3. **数据缺失自动告警 UI 缺**：当前 RiskAlert 是混合的，应该有独立 data alert
4. **数据补抓接口 UI 缺**：发现某天数据缺失，应该点一下补抓
5. **数据源切换 UI 缺**：主源挂了切备源，应该 UI 可视化

### C.6 SettingsWorkspace（`frontend/src/pages/workspace/SettingsWorkspace.tsx:113-121`）

**Tabs**：profile / keys / push-channels / notifications / sizing / portfolio-construction / users
**Lines**：2157 行（+ tabs 1218 行）

**已有**：
- 个人资料
- API 密钥
- 推送渠道
- 通知设置
- 仓位策略（已细化）
- 组合构建（已细化）
- 用户管理

**5 个 P0 改进**：
1. **缺"分析引擎 mode"切换 UI**（80 文档）：当前需要 SQL 改 risk_config，应该 UI
2. **缺"风控阈值统一面板"**：风控阈值散落在不同 tab，应该一个统一"风控参数中心"
3. **缺"AI 引擎权重调整 UI"**（80 文档 AE-014）
4. **缺"黑天鹅 + 偏差 + 改进建议"待办列表 tab**（75/76 文档）
5. **缺"策略 kill-switch + 启停"UI**：当前所有策略默认 on，没有 UI 可单独 disable

---

## D. 改造方案（每个 workspace 5 个 P0 user story，共 30 个）

| ID | 故事 | P |
|---|---|---|
| FE-TW-1 | TodayWorkspace 增加"今日大盘判断"卡片（昨夜外盘 / regime / 风险偏好 / 仓位建议） | P0 |
| FE-TW-2 | TodayWorkspace 增加"集合竞价异动"卡片（9:25 后展示一字 / 高开 / 撤单异常） | P0 |
| FE-TW-3 | TodayWorkspace 增加"今日交易计划"卡片：用户勾选信号 → 形成 plan list | P0 |
| FE-TW-4 | TodayWorkspace AI 大盘 brief：调 trading-agents 自动生成 ≤ 150 字摘要 | P0 |
| FE-TW-5 | TodayWorkspace 增加"今日卖出建议"卡片（止盈 / 止损 / 减持 / 调仓） | P0 |
| FE-FW-1 | FactorWorkspace 因子总览增加 health 列（IC_90d / IR / classification） | P0 |
| FE-FW-2 | FactorWorkspace 权重调参 slider 旁加"AI 建议权重"对照 | P0 |
| FE-FW-3 | FactorWorkspace 增加"自定义因子组合模板"功能（save/load） | P0 |
| FE-FW-4 | FactorWorkspace 新增 ETF 申赎 + 政策导向 tab | P0 |
| FE-FW-5 | FactorWorkspace picks 列表内嵌"为什么入选"短理由 | P0 |
| FE-LW-1 | LabWorkspace 增加"季度参数重训"tab：展示候选 + shadow run | P0 |
| FE-LW-2 | LabWorkspace 增加"shadow run"区块：实时显示 shadow vs live | P0 |
| FE-LW-3 | LabWorkspace 回测结果增加 OverfitMetrics 显示（PBO + Deflated Sharpe） | P0 |
| FE-LW-4 | LabWorkspace 新建回测提供"快速 grid"参数空间模板 | P0 |
| FE-LW-5 | LabWorkspace leaderboard 增加 vs HS300 / ZZ500 超额列 | P0 |
| FE-PW-1 | PortfolioWorkspace 增加"日归因"卡片（71 文档输出消费） | P0 |
| FE-PW-2 | PortfolioWorkspace 增加 weekly/monthly/quarterly review tab | P0 |
| FE-PW-3 | PortfolioWorkspace KPI 增加"最大行业集中度"，> 25% 红色高亮 | P0 |
| FE-PW-4 | PortfolioWorkspace 持仓列表增加 ATR / drawdown / days_held / mark_to_market 列 | P0 |
| FE-PW-5 | PortfolioWorkspace 增加 AI 日记 + 错误模式 tab（76 文档输出消费） | P0 |
| FE-DW-1 | DataWorkspace 加厚：每个 tab 实际内容（不只是占位） | P0 |
| FE-DW-2 | DataWorkspace 增加"数据时效 SLA"dashboard | P0 |
| FE-DW-3 | DataWorkspace 增加"数据缺失独立告警"UI（与 RiskAlert 分离） | P0 |
| FE-DW-4 | DataWorkspace 增加"补抓"接口按钮 | P0 |
| FE-DW-5 | DataWorkspace 增加"数据源切换 + 备源状态"可视化 | P0 |
| FE-SW-1 | SettingsWorkspace 增加"分析引擎 mode"切换 UI（off/shadow/hard） | P0 |
| FE-SW-2 | SettingsWorkspace 新增"风控参数中心"tab（合并所有风控阈值） | P0 |
| FE-SW-3 | SettingsWorkspace 增加"AI 引擎 8 dimension 权重调整"UI | P0 |
| FE-SW-4 | SettingsWorkspace 增加"待办建议"tab（黑天鹅 / 偏差 / 改进） | P0 |
| FE-SW-5 | SettingsWorkspace 增加"策略 kill-switch / 启停"UI | P0 |

---

## E. 验收口径

1. 每个 workspace 顶部 KPI 条信息密度 ≥ 5 指标
2. TodayWorkspace ≤ 3 click 完成"从信号到下单"工作流
3. FactorWorkspace 用户能在 1 个 tab 内完成"权重调整 + 验证"
4. LabWorkspace 用户能在 1 个 tab 内完成"建回测 → 看结果 → 决定 shadow"
5. PortfolioWorkspace 一进入就能看到"今日盈亏 + 日归因 + 行业集中度"
6. DataWorkspace 用户能 1 click 发现数据问题 + 1 click 补抓
7. SettingsWorkspace 所有 admin 配置都有 UI（不需要 SQL）
8. 移动端（useIsMobile hook）所有 workspace happy path 可跑
9. 整体 6 workspace 加入约 30 个 P0 改进后无 type error；lint pass
