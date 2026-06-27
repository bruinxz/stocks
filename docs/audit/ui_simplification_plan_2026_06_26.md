# UI 简化方案勘探 (2026-06-26)

> 勘探阶段。不修改任何代码。
> 范围: `frontend/src/pages/workspace/` + `frontend/src/App.tsx` + `frontend/src/pages/`。
> 当前分支: `claude/happy-torvalds-180c51` (HEAD `aa5d3e8`), main HEAD `f0c7978`。
> **本分支落后 main 60 个 commit**, 简易版 / EasyQuantWorkspace 还没合到本分支, 文件在 main 上, 修改前必须 rebase。

---

## 0. TL;DR

- **简易版位置 (main 已合, 本分支待 rebase)**: 路由 `/workspace/easy`, 组件 `frontend/src/pages/workspace/EasyQuantWorkspace.tsx`。任何 UI 重构都不能动 EasyQuant 的 7 个文件 + App.tsx 里的 `/workspace/easy` 路由分支 + 主菜单第一项「简易版」+ `docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md`。详见 §2 完整清单。
- **当前主入口**: 8 个一级 workspace shell, 内含 49 个二级 tab。「简易版」之外, 用户从首页到具体功能最多要点 4 层 (主菜单 → workspace shell → 左侧子 tab → 行内子区/Drawer/详情页)。
- **复杂度最高**: TodayWorkspace (3849 行 / 6 tab / 80 个 `<Tag>` / 11 种 fontSize), PortfolioWorkspace (3294 行 / 8 tab), FactorWorkspace (3049 行 / 9 tab)。
- **AI 感主因**: 8 种 antd Tag 颜色 (`blue/cyan/geekblue/green/magenta/orange/purple/red/volcano`) 同屏 + 11 种 fontSize 阶梯 + 顶部 KPI 行 ≥5 个数字 + 多处 hex 散落色 (`#1677ff / #cf1322 / #52c41a / #fa8c16 / #722ed1 / #389e0d / #3f6600`) + Sprint/US 编号 Tag 当装饰 (workspace 内 206 处 US-/Sprint 引用)。
- **建议**: 主菜单从 8 项收到 5 项 (简易版 + 今日 + 持仓 + 实验室 + 设置), 把"选股因子 / 数据中心 / 系统介绍"折叠成二级 tab; 每个 workspace 把 tab 数压到 ≤ 5; 把 Sprint/US Tag、`Statistic` 顶部 KPI、Drawer 抽屉式装饰统一退役; 限 4 色 + 3 fontSize + 1 主色 (用 `--eq-clay #c96338` 与简易版语义保持一致)。

---

## 1. Workspace 全景

### 1.1 顶层 shell (main 上 8 个, 本分支 7 个)

| # | Shell 文件 | 路由 | 菜单项 (main) | 行数 | 备注 |
|---|------------|------|---------------|------|------|
| 0 | `EasyQuantWorkspace.tsx` | `/workspace/easy` | 简易版 (RocketOutlined) | 1049 | **简易版 — 不能动**。main 已合; 本分支待 rebase。 |
| 1 | `TodayWorkspace.tsx` | `/workspace/today` | 今日作战 (CompassOutlined) | 3849 | 默认落地页 |
| 2 | `FactorWorkspace.tsx` | `/workspace/factors` | 选股因子 (FilterOutlined) | 3049 | + 4 个子 tab 文件 |
| 3 | `LabWorkspace.tsx` | `/workspace/lab` | 策略实验室 (ExperimentOutlined) | 2116 | + 6 个子 tab 文件 + `LabStrategyDetail.tsx` (1279) |
| 4 | `PortfolioWorkspace.tsx` | `/workspace/portfolio` | 持仓与复盘 (PieChartOutlined) | 3294 | |
| 5 | `DataWorkspace.tsx` | `/workspace/data` | 数据中心 (DatabaseOutlined) | 221 | shell 薄, 内容靠 `components/data/*` 8 个卡片 |
| 6 | `SettingsWorkspace.tsx` | `/workspace/settings` | 账号设置 (SettingOutlined) | 2282 | + 7 个子 tab 文件 |
| 7 | `SystemWorkspace.tsx` | `/workspace/system` | 系统介绍 (InfoCircleOutlined) | 431 | 5 个 markdown tab |

> 原 `workspace/CLAUDE.md` 写"6 个 shell 固定", 但实际已破例两次: `SystemWorkspace` (Batch AL, 2026-06-21, 用户授权) + `EasyQuantWorkspace` (PR #14, 2026-06-25, "Claude-like easy")。CLAUDE.md 没同步更新。

### 1.2 各 workspace 子 tab 清单

`TodayWorkspace` — `default = core_picks` (`TodayWorkspace.tsx:165-171`):
- `core_picks` 核心推荐 — V3 抖音风刷卡片 (CA-1)
- `signals` 今日信号 — 多策略 BUY/SELL 信号汇总
- `events` 关键事件 — 业绩公告 / 龙虎榜 / 涨停
- `alerts` 风险提醒 — RiskAlert 列表
- `risk_center` 风控中心 — 高优先级告警 + ack 流
- `capital_flow` 资金流向 — 盘中行业资金流分时图 (BK-4)

`FactorWorkspace` — `default = overview` (`FactorWorkspace.tsx:192-202`):
- `overview` 因子总览
- `weights` 权重调参
- `picks` 今日选股清单
- `board` 行业决策
- `sentiment` 舆情雷达 (RobotOutlined)
- `macro` 宏观环境 (单独子文件 388 行)
- `block` 大宗交易 (单独子文件 271 行)
- `etf` ETF 资金流 (单独子文件 411 行)
- `policy` 政策要闻 (单独子文件 318 行)

`LabWorkspace` — `default = mine` (`LabWorkspace.tsx:103-113`):
- `workflow_readiness` 工作流体检
- `mine` 我的策略
- `leaderboard` 策略排行 (单独子文件 356 行)
- `new` 新建回测
- `compare` 回测对比
- `walk_forward` Walk-Forward (单独子文件 880 行)
- `optimization` 优化历史
- `quarterly_retrain` 季度参数重训 (单独子文件 360 行)
- `shadow_run` Shadow Run (单独子文件 401 行)
- `overfit_metrics` OverfitMetrics (单独子文件 386 行)
- `advanced_quant` 高级量化 (单独子文件 772 行, 5 个研究模块再次堆叠)

`PortfolioWorkspace` — `default = positions` (`PortfolioWorkspace.tsx:150-157`):
- `positions` 当前持仓
- `equity` 资金曲线
- `attribution` 日归因 (RobotOutlined — 有 AI 标签)
- `trades` 交易明细
- `journal` 复盘日记
- `error-patterns` AI 日记 + 错误模式
- `correlation` 相关性矩阵
- `manage` 模拟盘管理

`DataWorkspace` — `default = health` (`DataWorkspace.tsx:50-55`):
- `health` 数据健康
- `stocks` 个股趋势
- `sync` 行情同步
- `tasks` 调度任务 (admin)
- `logs` 系统日志 (admin)
- `monitoring` 健康监控

`SettingsWorkspace` — `default = push-channels` (`SettingsWorkspace.tsx:125-136`):
- `profile` 个人资料
- `keys` API 密钥
- `push-channels` 推送渠道 (US-080)
- `notifications` 通知设置 (US-063)
- `sizing` 仓位策略 (Sprint 26+)
- `portfolio-construction` 组合构建 (Sprint 29+)
- `analysis-engine` 分析引擎 (US-065)
- `risk-parameters` 风控参数中心 (US-066)
- `strategy-kill-switch` 策略 kill-switch (US-069)
- `todo-suggestions` 待办建议 (US-068)
- `black-swan` 黑天鹅历史 (PR-018)
- `users` 用户管理 (admin)

`SystemWorkspace` — `default = intro` (`SystemWorkspace.tsx:384-388`):
- `intro` 系统介绍 (markdown)
- `manual` 操作手册 (markdown)
- `changelog` 更新日志 (markdown)
- `architecture` 架构图 (SystemTopologyMap)
- `feedback` 用户反馈

合计 8 shell + 49 个二级 tab。

### 1.3 入口层级

```
首页 (/) → 默认 redirect → /workspace/today
└── Sider 主菜单 (8 项)
    └── workspace shell
        └── 左侧 Menu 二级 tab (3 ~ 12 项, 平均 6)
            └── tab 内容
                ├── 顶部 KPI 行 (3 ~ 6 个 Statistic)
                ├── 主 Card / Table
                │   └── 行内 Drawer / Modal / Popconfirm / 详情页
                └── 行内子区 (Card-in-Card, 因子热图 / 归因 6 维 / AI 摘要 等)
```

最深路径示例: 主菜单「策略实验室」→ 左 tab「我的策略」→ 行内 Action「查看详情」→ `/workspace/lab/strategies/:strategy_key` → 内含 6 个 sub-section + monaco viewer = **4 ~ 5 层**。

---

## 2. 简易版位置 — 不能改清单

### 2.1 文件 (来自 main, 不在本分支 HEAD)

| 路径 | 行数 | 角色 |
|------|------|------|
| `frontend/src/pages/workspace/EasyQuantWorkspace.tsx` | 1049 | 单文件 shell, 无二级 tab |
| `frontend/src/pages/workspace/EasyQuantWorkspace.css` | 1680 | "暖纸风" 设计令牌 + 全部 `eq-*` 类 |
| `frontend/src/pages/workspace/easyQuantHooks.ts` | 294 | scroll-spy / bootstrap / displayUsername / backtest 轮询 |
| `frontend/src/pages/workspace/easyQuantResultHelpers.ts` | 200 | 回测 verdict / 错误解释翻译 |
| `frontend/src/pages/workspace/easyQuantTemplates.ts` | 97 | 3 个新手模板: `steady_trend / breakout_ma / low_vol_value` |
| `frontend/src/services/easyQuantService.ts` | 212 | data freshness + runtime health + 健康裁决 |
| `frontend/tests/easy-quant-workspace-contract.test.js` | 215 | 路由 / 真实 API / fail-closed / 新手文案的源代码契约校验 |
| `docs/EASY_QUANT_UI_DESIGN_GUIDELINES.md` | 262 | 设计规范, 后续简易版迭代必须遵守 |

### 2.2 App.tsx 内不能动的位点 (main 版)

- `frontend/src/App.tsx:50-51` `EasyQuantWorkspace = lazy(...)` 导入
- `frontend/src/App.tsx:70` 引入 `RocketOutlined`
- `frontend/src/App.tsx:235` 菜单第一项 `menuLink('/workspace/easy', <RocketOutlined />, '简易版')`
- `frontend/src/App.tsx:311-329` `if (location.pathname.startsWith('/workspace/easy'))` 单独走 Suspense + ProtectedRoute, **绕开 modern-layout Sider 壳**, 让简易版整屏接管 (这是它能用自定义 header / scroll-spy 导航的关键, 不能合回主壳)。

### 2.3 服务端契约 (顺带不能动)

- `labService.ts` 中 `EasyQuantService` 依赖的 `listQuantStrategies / createBacktestTask / getBacktestDetail / listWorkflowPresets` — 任何重命名 / 签名变更会同时让简易版崩。
- `portfolioCrudService` — 简易版调用以挂载用户的 portfolio。
- 后端 health 端点 (data freshness + runtime health), `easyQuantService.ts` fail-closed 解析逻辑依赖 `status` 字段一致。
- 简易版的契约测试 (`frontend/tests/easy-quant-workspace-contract.test.js`) 对源码做了源代码 regex 校验, 改任何上述文件请先看测试。

### 2.4 不能改的视觉令牌

简易版用独立 CSS 变量 (`--eq-paper #f7f2e8 / --eq-sheet #fbf8f1 / --eq-ink #171512 / --eq-clay #c96338 / --eq-green #2f7d4b / --eq-amber #9a6a12 / --eq-red #b64232`)。
**重构其他 workspace 时严禁碰这些变量** — 改了 simple 版色调就垮。但 §6 提议把这套语义色作为全局令牌反向输出 (新加 `--qx-*` 系列复用 ink/clay/green/red), 推荐方案见后。

---

## 3. 复杂度热点

### 3.1 子 tab 最多

| Workspace | tab 数 |
|-----------|-------|
| `SettingsWorkspace` | **12** (最多, 含 5 个 admin/research 性质) |
| `LabWorkspace` | **11** (含 walk-forward / shadow run / overfit / advanced 等研究专用 tab) |
| `FactorWorkspace` | **9** |
| `PortfolioWorkspace` | 8 |
| `TodayWorkspace` | 6 |
| `DataWorkspace` | 6 |
| `SystemWorkspace` | 5 |
| `EasyQuantWorkspace` | 0 (整屏 scroll-spy) |

### 3.2 单文件 ≥ 600 行 (注意: `WorkspaceLayout.tsx` 不变, 这些是 shell + tab)

| 文件 | 行数 |
|------|------|
| `TodayWorkspace.tsx` | **3849** |
| `PortfolioWorkspace.tsx` | **3294** |
| `FactorWorkspace.tsx` | **3049** |
| `SettingsWorkspace.tsx` | **2282** |
| `SettingsWorkspace.RiskParametersCenterTab.tsx` | 2149 |
| `LabWorkspace.tsx` | 2116 |
| `LabStrategyDetail.tsx` | 1279 |
| `EasyQuantWorkspace.tsx` | 1049 (不要动) |
| `LabWorkspace.WalkForwardTab.tsx` | 880 |
| `SettingsWorkspace.SizingPolicyTab.tsx` | 816 |
| `LabWorkspace.AdvancedQuantTab.tsx` | 772 |
| `LabWorkspace.WorkflowReadinessTab.tsx` | 767 |
| `SettingsWorkspace.BlackSwanHistoryTab.tsx` | 625 |

四个 shell 都已超过 workspace/CLAUDE.md 暗示的「shell 只管布局, 内容拆 sub-component」原则。

### 3.3 研究 / 调试性质 (不该给普通用户看)

| 入口 | 性质 |
|------|------|
| `LabWorkspace` 全部 11 tab 中: `workflow_readiness / walk_forward / quarterly_retrain / shadow_run / overfit_metrics / advanced_quant` | 6 个面向量化研究员, 普通用户看到这些 "DSR / PBO / verdict / fold / IS-vs-OOS / Sprint 1-3 五大新模块" 会立刻退出 |
| `SettingsWorkspace.strategy-kill-switch / black-swan / todo-suggestions / analysis-engine / risk-parameters / sizing / portfolio-construction` | 7 个里 ≥5 个是 admin/调参/政策面板, 不该挂在「账号设置」下 |
| `DataWorkspace.tasks / logs / monitoring` | 已加 AdminGuard 但仍占 tab 位 |
| `SystemWorkspace.architecture / feedback` | 拓扑图 + bug 反馈, 量化用户用不到 |
| 各 workspace 标题区的 `<Tag>US-XXX / Sprint NN+</Tag>` | 当装饰. 工作区内文件共 **206 处** US-/Sprint 文本; SettingsWorkspace 顶部 header 处 12 个 tab 每个挂一个红/紫/橙色 US 标签 |
| TodayWorkspace 顶部 KPI 行 + Portfolio chip + Strategy chip + Factor chip | 4 类信息密度叠在 96px 高 KPI 条里 |

### 3.4 重复 KPI

| KPI | 出现位置 |
|-----|---------|
| 「总收益」 | `TodayWorkspace.tsx:344` + `PortfolioWorkspace.tsx:1403` |
| 总收益率 / annual_return_pct / excess_return_pct | `LabStrategyDetail` + `LabWorkspace.LeaderboardTab` 各自一份口径 (无统一来源, 用户切 tab 看数会对不上) |
| 今日盈亏 / 浮动盈亏 / 已实现盈亏 / 当日 P&L / 当日 SELL realized | `PortfolioWorkspace.tsx:275/1640/1650/1838/1846` (5 个变体, 互相区分但用户分不清) |
| 数据健康 trade_date 状态 Tag | `DataWorkspace.tsx:624, 922` 重复两套 |
| 「已注册」类 KPI | `LabWorkspace.tsx:355 已注册策略` + `FactorWorkspace.tsx:529 已注册因子` (语义类似但散落) |

### 3.5 同屏数字密度

- `TodayWorkspace` 顶部 KPI 条 = 5 个 Statistic + 1 PortfolioChip (含 ≤3 strategy chip + ≤3 factor chip) = 单屏 ≥ 9 个独立数据点。
- `PortfolioWorkspace.tsx:1402-1437` 一行内 5 个 Statistic (绩效指标 Card)。
- `PortfolioWorkspace.tsx:1838-1869` 当日归因区 6 维分布 + 残差解读, 8 个 Statistic 同屏。

---

## 4. 冗余 / 死代码

### 4.1 `routeSelectionAliases` (App.tsx:108-148) — 22 条 legacy 别名

主菜单选中态用, 命中后会让 Sider 高亮对应 workspace。**实际可达性**:

| Legacy alias | 是否还可点到 |
|--------------|-------------|
| `/quant/{research,signals,backtests,strategies,experiments,dashboard}` | 无 UI 入口, 仅深链 |
| `/strategy-research/...` | 无 UI 入口 |
| `/live-trading/{orders,reconcile}` | 无 UI 入口 |
| `/review/{trades,performance,agent-tail,journal}` | 无 UI 入口 |
| `/backtest/{id?}` | 仅 `LabStrategyDetail.tsx:957` 用 `<Link to="/legacy/backtest/${id}">` 还在生成链接 |
| `/autonomous-trading/...` / `/paper-trading` / `/recommendation-(performance/trade-outcomes/loop-policies)` | 无入口 |
| `/agent-tail-alpha` / `/strategy-experiment-lab` / `/strategy` | 无入口 |
| `/risk-alerts` / `/today` / `/dashboard` / `/portfolio` / `/screener` / `/market` / `/data-update` / `/tasks` / `/logs` / `/ai-advisor` / `/journals` / `/profile` / `/users` | 无入口 (全部 redirect 到 workspace) |
| `/signals/:id/trace` | RecommendationTrace, 唯一活路由 |

**结论**: 22 条别名里 ≥18 条已是死路由, 可以删 (留 `/signals/:id/trace`、`/backtest/:id` 二者依然有 deep link, 删前请 grep `Link to` 全仓)。

### 4.2 `/legacy/*` 路由 (App.tsx:538-700)

App.tsx 仍 lazy import 21 个 legacy `pages/*` 文件并挂在 `/legacy/<name>`:

`/legacy/today /portfolio /live-trading /quant-research /strategy-research /review /ai-advisor /backtest /backtest/:id /risk-alerts /dashboard /market /data-update /tasks /logs /portfolio-classic /screener /profile /users` + `/stock/:symbol` + `/signals/:id/trace` + `/recommendation-trade-outcomes/:id`。

仓库内 grep `'/legacy/'` 只命中 4 处:
- `LabStrategyDetail.tsx:957` `Link to="/legacy/backtest/${id}"` — 唯一真用户入口
- `SettingsWorkspace.tsx:1594/1599/1604` `url: '/legacy/profile' / '/legacy/profile#api-keys' / '/legacy/user-management'` (拼字符串, **未在 App.tsx 路由表中, `legacy/user-management` 是死链**)

**结论**: 除 `/legacy/backtest/:id` 与 `/stock/:symbol` 外的 ≥18 个 `/legacy/*` 路由全无入口, 可拆: 删 `pages/*.tsx` 14 个文件 (≈ 1.8 万行 dead code, 见 4.4)。

### 4.3 `pages/*.tsx` legacy 文件清单 (37331 行总量)

下表标 ✗ = 在主菜单 / 任何 workspace tab / Link/navigate 路径上找不到入口:

| 文件 | 行 | 状态 |
|------|----|------|
| `PaperTrading.tsx` | 4337 | ✗ (仅 `/legacy/portfolio-classic` 同款挂着) |
| `TaskScheduler.tsx` | 2504 | △ (admin via `/legacy/tasks`) |
| `DataUpdateStatus.tsx` | 2481 | ✗ |
| `LiveTrading.tsx` | 2385 | ✗ |
| `QuantPerformanceDashboard.tsx` | 2267 | ✗ (无 lazy import, 文件孤立) |
| `AutonomousOptimizationLab.tsx` | 1725 | ✗ (无 lazy import) |
| `AutonomousTradingOverview.tsx` | 1620 | △ (`/legacy/portfolio`) |
| `RecommendationTradeOutcomes.tsx` | 1495 | △ (动态 `/recommendation-trade-outcomes/:id` → 走 RecommendationTrace, 这个文件没人 import) |
| `Recommendations.tsx` | 1409 | ✗ (无 lazy import) |
| `RecommendationLoopPolicies.tsx` | 1373 | ✗ (无 lazy import) |
| `Portfolio.tsx` | 1305 | △ (`/legacy/portfolio-classic`) |
| `QuantBacktestLab.tsx` | 1298 | ✗ |
| `TodayCommandCenter.tsx` | 1171 | △ (`/legacy/today`) |
| `RecommendationPerformance.tsx` | 1152 | ✗ |
| `Market.tsx` | 1105 | △ (`/legacy/market`) |
| `QuantStrategyLibrary.tsx` | 860 | ✗ |
| `Dashboard.tsx` | 838 | △ (`/legacy/dashboard`) |
| `QuantSignalPool.tsx` | 789 | ✗ |
| `AIAdvisor.tsx` | 707 | △ (`/legacy/ai-advisor`) |
| `StrategyResearchCenter.tsx` | 703 | △ (`/legacy/strategy-research`) |
| `AgentTailAlphaLedger.tsx` | 644 | ✗ |
| `AutonomousRecommendationTracker.tsx` | 624 | ✗ |
| `ReviewCenter.tsx` | 593 | △ (`/legacy/review`) |
| `RecommendationTrace.tsx` | 556 | ✓ (`/signals/:id/trace` 还在用) |
| `Screener.tsx` | 552 | △ (`/legacy/screener`) |
| `UserManagement.tsx` | 419 | △ (admin via `/legacy/users`) |
| `StrategyExperimentLab.tsx` | 358 | ✗ (无 lazy import) |
| `SystemLogs.tsx` | 296 | △ (admin via `/legacy/logs`) |
| `Backtest.tsx` | 280 | △ (`/legacy/backtest`) |
| `HealthMonitor.tsx` | - | ✗ (无 lazy import) |
| `QuantResearchWorkbench.tsx` | - | △ (`/legacy/quant-research`) |
| `RiskAlerts.tsx` | - | △ (`/legacy/risk-alerts`) |
| `Profile.tsx` | - | △ (`/legacy/profile`) |
| `StockDetail.tsx` | - | ✓ (`/stock/:symbol`) |
| `Login.tsx` | - | ✓ |

✗ = 没 lazy import / 没 route, **完全 dead** (8 个文件 ≥ 1.4 万行)。
△ = 仅有 `/legacy/*` deep link 兜底, 主菜单无入口, workspace tab 也已替代功能, **可一并清掉** (15 个文件 ≥ 1.9 万行)。
✓ = 真在用, 留。

### 4.4 孤立组件

`frontend/src/components/` 下 29 个组件, 互相 import 关系扫一遍:
- 所有 `components/data/*.tsx` 都仅被 `DataWorkspace` 用; `SystemTopologyMap` 仅被 `SystemWorkspace` 用。
- `TradePolicyExplainPanel / TradeReasonCell / aiStockAnalysisModalV2Components` 只被 `pages/PaperTrading.tsx / RecommendationTradeOutcomes.tsx / RecommendationTrace.tsx` 引用 — 一旦 §4.3 ✗/△ 那一批 legacy 页删掉, **这些组件会变成孤立 dead code**。
- 测试文件 `Sparkline20d.test.tsx / V3RecommendationCard.test.tsx` 各 1 个, 留。

---

## 5. "AI 感太强" 的具体来源

### 5.1 配色过多 (主因)

- TodayWorkspace 单文件用了 9 种 antd Tag 颜色 (`blue cyan default geekblue green magenta orange purple red`), 121 处 `Tag color=` / `color: '#`。
- PortfolioWorkspace 用 8 种 (`blue default error green processing purple red volcano`)。
- 散落 hex 色: `#1677ff`(主蓝) `#cf1322`(红) `#52c41a`(绿) `#fa8c16`(橙) `#722ed1`(紫) `#389e0d`(深绿) `#3f6600`(墨绿) `#e6f4ff`(蓝底) `#f6ffed`(绿底) `#999`(灰) — 没有单一令牌, 各 tab 自行选色。
- 顶部 KPI 行 5 个 Statistic 每个 valueStyle 不同色; 同一行混 3 种盈亏色 + 1 个蓝 + 1 个红 alert badge。
- `<Tag>US-063 / US-066 / Sprint 26+ / Sprint 29+</Tag>` 当装饰: SettingsWorkspace shell header 一处就 12 个 tab 每个绑一个标签色 (`processing/purple/cyan/geekblue/volcano/red/gold` 都用上)。看起来像「研发周报封面」, 用户根本不需要知道哪个 Sprint 出的。

### 5.2 字号不统一

`TodayWorkspace` 单文件 `fontSize` 出现 **10 个不同值**: 9, 10, 11, 12, 13, 14, 15, 16, 18, 22。PortfolioWorkspace 5 个, FactorWorkspace 4 个。
antd 默认 14, 我们这里 ±2~4 都有, 表格内行内 chip / Tag / hint / suffix 各自选 size。

### 5.3 间距 / 圆角不一致

- TodayWorkspace `padding` 用了 `12 / 24 / 48` + inline tag `'0 6px' '4px 8px' '6px 12px'`。
- PortfolioWorkspace 用 `12 / 24 / 32 / 48` + `'2px 8px' '4px 6px' '4px 8px'`。
- `borderRadius` 全仓 `2 / 3 / 4 / 6 / 8` 五个值散落, antd 默认 `4`, 自定义 ≥10 处。

### 5.4 装饰条 / 边框线 (Card 套 Card)

- `paddingLeft: 8, borderLeft: '3px solid #1677ff'` (TodayWorkspace 5 处不同主色: `#1677ff / #fa8c16 / #722ed1 / #722ed1`) — 给每个子区加 3px 强调线, 模仿 dashboard 设计稿。
- Card-in-Card 出现频繁: TodayWorkspace 36 个 Card, PortfolioWorkspace 29 个, FactorWorkspace 28 个。Card 边框 + 内层小 Card 边框 + 行内 Tag 边框 = 三层框线。

### 5.5 Emoji / 渐变 / 阴影

- 实际 emoji 不多 (workspace 全集 ≤ 11 个: `🟣 🤖 💡 ✅ ❌ ⚠️`)。
- **无渐变**, **无 boxShadow**: 这一项不是问题。
- 但有大量 `<RobotOutlined>` (FactorWorkspace 7 处, PortfolioWorkspace 多处) — antd icon, 给 "日归因 / 舆情雷达 / AI 分析" 都挂机器人头, 强化"AI 感"。

### 5.6 信息密度

每个 tab 一进去, 顶部 96px KPI 条 + 1~2 行 Card chips + 主 Table 表头 ≥ 8 列 + 表内行内 Tag/Popover/Tooltip → **首屏可数到 ≥ 30 个独立信息块**。新手"不知道怎么操作"主因就是没有视觉主次。

---

## 6. 简化方案

### 6.1 顶层菜单: 8 → 5

| 当前 | 建议 | 理由 |
|------|------|------|
| 简易版 | **保留 (第 1 项, 默认登陆落地)** | 不能动 |
| 今日作战 | **保留** | 高频, 用户每天看 |
| 选股因子 | **折叠**进「策略实验室」 | 因子是策略的输入, 非平行概念 |
| 策略实验室 | **保留** | 内部减 tab, 见 §6.2 |
| 持仓与复盘 | **保留** | 高频 |
| 数据中心 | **折叠**进「设置」-> Admin only | 普通用户不看数据健康 |
| 账号设置 | **保留**, 但只留个人 + API + 通知 + 推送 | |
| 系统介绍 | **降级**为右上角 "?" 帮助按钮, 不占主菜单 | 占位浪费 |

默认登陆: `/workspace/easy` (而不是当前 `/workspace/today`), 让新人看到的第一屏是简易版引导, 老用户右上"专业版"切换。

### 6.2 各 workspace tab 精简

`TodayWorkspace` (6 → 3):
- ✅ 保: `core_picks 核心推荐` (默认)、`signals 今日信号`、`alerts 风险提醒`
- ❌ 删: `events 关键事件` (并入 core_picks 卡片下方 timeline)、`risk_center 风控中心` (并入 alerts, 用 filter `level=HIGH`)、`capital_flow 资金流向` (折叠进 signals 顶部带状图)

`FactorWorkspace` → 并入 LabWorkspace
- 推 `overview / weights / picks` 三个 tab 上移到「策略实验室 > 因子」分组; `sentiment / macro / block / etf / policy` 这 5 个数据视图全部并入「数据中心 > 数据面板」, 不占用户最频繁的二级菜单。

`LabWorkspace` (11 → 5):
- ✅ 保: `mine 我的策略` (默认)、`new 新建回测`、`leaderboard 策略排行`、`compare 回测对比`、`factors 因子` (新增, 接收 FactorWorkspace overview/weights/picks)
- ❌ 删/移: `workflow_readiness / walk_forward / quarterly_retrain / shadow_run / overfit_metrics / advanced_quant / optimization` → 全部塞进「实验室 > 高级 (研究员)」一个二级折叠区, 默认隐藏, header 加个 "切换到研究员模式" 开关

`PortfolioWorkspace` (8 → 4):
- ✅ 保: `positions 当前持仓` (默认)、`equity 资金曲线`、`trades 交易明细`、`journal 复盘日记`
- ❌ 删/移: `attribution 日归因` → 合并进 positions 顶部摘要 (3 行 sparkline); `error-patterns AI 日记 + 错误模式` → 合并到 journal 内 Tab; `correlation 相关性矩阵` → 移到 LabWorkspace 高级研究区; `manage 模拟盘管理` → 弹窗 / Drawer, 不占 tab

`DataWorkspace` (6 → 0, 整个折叠到设置内):
- 普通用户从不需要看 "数据健康 / 行情同步 / 调度任务 / 系统日志 / 健康监控"。把 6 个 tab 全塞进「设置 > 系统状态」, 仅 admin 可见。
- 「数据中心」原来吸收的因子数据视图 (`block / etf / policy / macro`) 改为简易版式只读卡片, 嵌进 TodayWorkspace 的 `events` 替代位。

`SettingsWorkspace` (12 → 4 + admin 折叠区):
- ✅ 保: `profile 个人资料` (默认)、`keys API 密钥`、`notifications 通知设置`、`push-channels 推送渠道`
- ❌ 折叠: `sizing / portfolio-construction / analysis-engine / risk-parameters / strategy-kill-switch / todo-suggestions / black-swan / users` → "设置 > 高级 (admin)", 默认隐藏

`SystemWorkspace` (5 → 弹窗式)
- 右上 "?" 按钮 Drawer: 系统介绍 / 操作手册 / 更新日志 三页 markdown。
- `architecture / feedback` 移到 admin 折叠区。

### 6.3 默认 tab

- **每个 workspace 默认 tab 都应该是"用户进入第一眼看到的最重要事"**:
  - Today → `core_picks` (今天买什么), 当前已是 ✅
  - Lab → `mine` (我的策略, 当前) → 改 `leaderboard` (新手先看排行选, 再看自己), 待定
  - Portfolio → `positions` ✅
  - Settings → `profile` (而不是当前的 `push-channels` 推送矩阵)

### 6.4 KPI 精简 (每 workspace ≤ 4)

| Workspace | 当前 KPI | 建议 |
|-----------|---------|------|
| Today | 账户净值 / 今日盈亏 / 当月收益 / 总收益 / 未读风险 (5) + Portfolio chip + 策略 chip + 因子 chip | **3**: 账户净值 / 今日盈亏 (大字红绿) / 未读风险 (小 badge)。当月收益 + 总收益移到 Portfolio。chip 系列只在副标题一行 |
| Portfolio | 当前持仓 / 浮动盈亏 / 当月收益率 / 最大回撤 + ... | **4**: 持仓数 / 总收益率 / 当月收益率 / 最大回撤。其余进 detail card |
| Lab | 已注册策略 / 进行中回测 / 最近 7 日完成 | **3**: ✅ 已是 3 个, 维持 |
| Factor (并入 Lab) | 已注册因子 / 覆盖股票 / 最新计算日 | **0** (并到 Lab 二级菜单, 不再独立 KPI 条) |
| Data | 各 tab 一组 | **0**, 折叠后只在 admin 看 |
| Settings | 账号角色 / 启用通道 / 已订阅事件 / 飞书日报 | **2**: 账号角色 / 启用通道 |
| System | 无 | 不变 |

### 6.5 视觉降"AI 感"

借用简易版的 `--eq-*` 令牌反向输出为全局 `--qx-*`, 让专业版与简易版同源:

- **限 4 色**: `--qx-text #171512` (替 `#000` / antd 默认 14 灰阶), `--qx-mute #48433c`, `--qx-accent #c96338` (替全部 `#1677ff` 主蓝), `--qx-green #2f7d4b` / `--qx-red #b64232` (替 `#52c41a / #cf1322` 等所有盈亏色)。
- **限 3 fontSize**: 12 (辅助 / 表格内 Tag), 14 (body / Statistic value 默认), 20 (Statistic value 大数字 / Card 标题)。删 9 / 10 / 11 / 13 / 15 / 16 / 18 / 22。
- **限 3 padding**: 8, 16, 24 (8 的倍数, 与简易版一致)。删 12 / 32 / 48 / `'2px 8px'` / `'4px 6px'`。
- **限 4 antd Tag color**: `default / red / green / orange`。退役 `cyan / geekblue / magenta / purple / volcano / processing / gold`。把"流派/状态分类"改成左侧 dot + 文字, 不靠彩色 Tag 区分。
- **删 Sprint/US 装饰 Tag**: workspace 内 206 处 `Tag color="..." US-XXX / Sprint NN+` 全部退场, 改成 git commit message 内的元数据, 不进 UI。
- **删 borderLeft 装饰条**: TodayWorkspace 4 个 3px 强调线删掉, 改用大字标题 + 一行 mute 副文。
- **降 Card 嵌套**: 把所有「Card title="..." 内含 Card size=small」改成单层 Card + `<Typography.Title level={5}>` 内部分区。
- **去 RobotOutlined**: "日归因 / 舆情雷达 / AI 分析" 改图标为 `<RiseOutlined>` / `<FundOutlined>` / `<BulbOutlined>`。"AI 感"主要来自机器人头, 换成中性 icon 立刻去掉一半。

### 6.6 删除清单 (可立即开 PR)

- `pages/` 下 ✗/△ 23 个 legacy 文件 (PaperTrading / LiveTrading / QuantPerformanceDashboard / AutonomousOptimizationLab / AutonomousTradingOverview / RecommendationTradeOutcomes / Recommendations / RecommendationLoopPolicies / Portfolio (legacy) / QuantBacktestLab / TodayCommandCenter / RecommendationPerformance / Market / QuantStrategyLibrary / Dashboard / QuantSignalPool / AIAdvisor / StrategyResearchCenter / AgentTailAlphaLedger / AutonomousRecommendationTracker / ReviewCenter / Screener / StrategyExperimentLab / DataUpdateStatus / HealthMonitor / QuantResearchWorkbench) — **约 1.9 万 ~ 3.3 万行**, 删前请逐个 grep `<Link to="/legacy/<name>"` + `navigate('/legacy/<name>'`, 确认 0 hit。
- `App.tsx` 22 条 `routeSelectionAliases` 中 18 条死路由 + 18 个 `/legacy/*` Route 块 + 21 个 legacy `lazy(import('./pages/...'))` 声明。
- `components/trading/{TradePolicyExplainPanel,TradeReasonCell,aiStockAnalysisModalV2Components}` (在 legacy 页删后会自动孤立)。
- `components/portfolio/PortfolioManagementPanel` (仅被 legacy Portfolio.tsx 用, 删 legacy 后孤立)。

---

## 7. 操作建议 (给后续实施 agent 的备忘)

1. 实施前必须先 `git fetch origin main && git rebase origin/main` 把 `EasyQuantWorkspace.*` 6 个文件 + 简易版菜单/路由块 + `EASY_QUANT_UI_DESIGN_GUIDELINES.md` 拉到当前分支。否则在 HEAD 上看不到简易版, 会误删 RocketOutlined / `/workspace/easy` 路由分支。
2. 简易版 contract test (`frontend/tests/easy-quant-workspace-contract.test.js`) 在源代码层校验 22 个断言, 任何 App.tsx 重构都要先看一遍。
3. 用户原话「简易版不要动」= EasyQuant 7 文件 + App.tsx 内 4 个位点 + labService 内被引依赖 + EASY_QUANT_UI_DESIGN_GUIDELINES.md, 见 §2 完整清单。
4. workspace/CLAUDE.md 里 "6 shell 固定" 这条规则已经过时 (实际 8 个)。修改 shell 集合前先更新 CLAUDE.md, 把"5 个新一级菜单 (含简易版)" 写清楚。
5. 简易版的 `--eq-*` CSS 变量是它独立打包的资产, 想"反向输出为全局令牌"必须在新 PR 里另起 `--qx-*` 系列, 不能直接 import EasyQuantWorkspace.css 给其它 workspace (那样会把简易版 1680 行 CSS 拉到主壳)。
