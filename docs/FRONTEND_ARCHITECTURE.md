# 前端架构与信息架构 (Frontend Architecture & IA)

> 维护者速览。本文件描述 `frontend/src` 的**页面清单、导航信息架构 (IA)、入口路径、前后端端点映射**,以及 2026-07 前端整理中的**删 / 留 / 合决策**。
>
> 分支: `refactor/signal-first` · 主线业务: **ETF 因子轮动策略** (`getEtfRotationLatestPicks`)。
>
> ⚠️ 改动导航或删文件前先读本文件 —— 历史上曾因一条腐化注释("选股因子已合并进实验室")差点误删承载主线的 `FactorWorkspace`。

---

## 1. 技术栈

| 层 | 选型 |
|---|---|
| 框架 | React (Create React App / react-scripts) + TypeScript |
| UI | Ant Design + Heroicons |
| 状态 | Redux (`useSelector<RootState>`),`state.auth` 存 user/token |
| 动效 | framer-motion (`RouteTransition`) |
| 鉴权 | `localStorage.token`,`ProtectedRoute` 无 token → `/login` |
| 构建产物 | `frontend/build`,生产由 nginx `:3001` 托管,`/api/` 反代 `127.0.0.1:3000` |

---

## 2. 顶层导航 (主菜单)

所有用户看同一套菜单(Phase 7 决策:"我既是管理员也是想学量化的新手,不想页面分离")。**5 项基础 + 3 项 admin-only**:

| 菜单 | 路由 | 组件 | 可见性 |
|---|---|---|---|
| 主页 | `/home` | `HomeWorkspace` | 所有人(**默认登录落地页**) |
| 简易版 | `/workspace/easy` | `EasyQuantWorkspace` | 所有人(教学路径) |
| 持仓 | `/workspace/portfolio` | `PortfolioWorkspace` | 所有人 |
| 实验室 | `/workspace/lab` | `LabWorkspace` | 所有人 |
| 设置 | `/workspace/settings` | `SettingsWorkspace` | 所有人 |
| 数据中心 | `/workspace/data` | `DataWorkspace` | admin |
| 系统介绍 | `/workspace/system` | `SystemWorkspace` | admin |
| 文档 | `/workspace/docs` | `DocsWorkspace` | admin |

### 不在主菜单、但仍是活页面的路由(重要)

这些页面**故意从主菜单收起**,经其他入口进入。它们不是死页,勿删:

| 路由 | 组件 | 真实入口 |
|---|---|---|
| `/workspace/factors` | `FactorWorkspace` | 实验室策略详情页按钮 / `/screener` 别名 / deep link;承载 **ETF 轮动主线** |
| `/workspace/today` | `TodayWorkspace` | 首页"今日买卖信号"链接 (`?tab=signals`,其**独有**内容) / 首页"风控中心"链接 (`?tab=risk_center`) / `AlertsBell` 告警点击 / deep link。**2026-07-04 去冗余**:今日作战与首页曾并列一级导致重复,现今日作战不进主菜单,题材机会/风险提醒/市场研判已并入 `/home`,仅"今日信号(买卖计划)"为其独有,经首页单一链接进入。 |
| `/workspace/lab/strategies/:id` | `LabStrategyDetail` | 实验室"我的策略"点击进入 |
| `/stock/:symbol` | `StockDetail` | 各处个股链接 |

---

## 3. 页面清单与二级 Tab

顶层页面只有 ~8 个;"页面很多"的观感来自各工作台内部的二级 Tab(WorkspaceLayout + Segmented 子视图)。完整清单:

### 3.1 HomeWorkspace `/home` — 登录默认落地
三大块:**账户 · 推荐 · 持仓**。推荐区按 30 分钟时间桶分组展示 ETF 轮动卡片(`getEtfRotationLatestPicks`)。"推荐直观可见"需求由此满足:登录即见推荐。

### 3.2 EasyQuantWorkspace `/workspace/easy` — 简易版/教学

### 3.3 PortfolioWorkspace `/workspace/portfolio` — 持仓
Tab: 当前持仓 · 交易明细 · 资金曲线 · 复盘日记 · 我的提醒 · 日归因(admin) · 错误模式(admin) · 相关性矩阵(admin) · 模拟盘管理(admin)

### 3.4 LabWorkspace `/workspace/lab` — 策略实验室
Tab: 我的策略(策略列表 / 策略排行 / 综合评估 / 实验账本 / 数据审计 / 成交约束)· 新建回测 · 评估报告 · 进阶(Walk-Forward 走查 / 参数寻优历史 / 过拟合诊断 / 季度重训 / 回测对比 / 工作流体检)

### 3.5 FactorWorkspace `/workspace/factors` — 因子/ETF 轮动工作台(主线)
Tab: 因子总览 · 权重调参 · **ETF 调仓清单** · 行业决策 · 宏观环境 · ETF 资金流 · 政策要闻
拆分子文件: `FactorWorkspace.ETFFlowTab` / `.MacroEnvTab` / `.PolicyNewsTab`

### 3.6 SettingsWorkspace `/workspace/settings` — 设置
Tab: 个人 · 通知 · 风控 · 高级 · 用户管理(admin)
拆分子文件: `.RiskParametersCenterTab` / `.SizingPolicyTab` / `.PortfolioConstructionTab` / `.BlackSwanHistoryTab` / `.TodoSuggestionsTab`
- 风控 Tab 的"紧急停机 (kill-switch)" Segmented 子视图为**真实功能**,不依赖已删的 helper。
- 个人 / API key / 用户管理三个 Tab 目前为占位 (`renderPlaceholder`,"待接入")。`services/userService.ts` 是用户管理 Tab 的**现成 CRUD 实现**(getUsers/createUser/updateUser/changePassword/deleteUser),接入即用 —— **勿删该 service**。

### 3.7 TodayWorkspace `/workspace/today` — 今日(非主菜单)
Tab: 题材机会 · 今日信号 · 风险提醒 · 关键事件(admin)· 风控中心(admin)
承载 市场研判 · 风控中心 · 今日交易计划(`data.earnings_surprise` / `dragon_head` / `overnight_foreign`);风控中心子面板 `RiskAlertCenterPanel`。

### 3.8 DataWorkspace `/workspace/data` — 数据中心 (admin)
Tab: 数据健康 · 个股趋势 · 行情同步 · 调度任务 · 系统日志 · 健康监控
(整合了旧独立页 `DataUpdateStatus` / `HealthMonitor` / `SystemLogs` / `TaskScheduler` 的能力)

### 3.9 SystemWorkspace `/workspace/system` · DocsWorkspace `/workspace/docs` (admin)
系统介绍 / 文档中心。

### 3.10 StockDetail `/stock/:symbol` · Login `/login`

---

## 4. 路由别名 (legacy deep-link 兼容)

`App.tsx` 的 `routeSelectionAliases` 把大量历史路由重定向到当前工作台,并让侧边栏高亮正确的顶层项。核心组:

| 旧路由 (正则) | 归属 |
|---|---|
| `/quant/*`,`/strategy*`,`/backtest*`,`/strategy-research*`,`/ai-advisor*` | `/workspace/lab` |
| `/live-trading*`,`/review*`,`/portfolio*`,`/journals*`,`/paper-trading*`,`/autonomous-trading*` | `/workspace/portfolio` |
| `/today*`,`/dashboard*`,`/risk-alerts*`,`/recommendations*` | `/workspace/today` |
| `/screener*` | `/workspace/factors`(注:菜单高亮归 lab) |
| `/market*`,`/data-update*`,`/tasks*`,`/logs*` | `/workspace/data` |
| `/profile*`,`/users*` | `/workspace/settings` |

`/` 与未匹配 `*` → `/home`。

---

## 5. 前后端端点映射

每个 service 对应一个后端挂载点 (`backend/src/index.ts` 的 `app.use('/api/...')`)。审计结论:**无死端点**,前端引用的 service 均对应存活后端路由。

| Service | 用途 | 主要页面 |
|---|---|---|
| `factorService` | ETF 轮动/因子(`getEtfRotationLatestPicks`,`/api/strategies/multi-factor/latest-picks`) | Home / Factor |
| `labService` / `backtestService` | 策略/回测 | Lab |
| `portfolioWorkspaceService` / `portfolioCrudService` | 持仓/模拟盘 | Portfolio |
| `todayWorkspaceService` / `marketJudgmentService` / `marketBriefService` | 今日/市场研判 | Today / Home |
| `riskAlertService` / `alertsRealtimeClient` / `blackSwanService` | 风控告警(含实时) | Today / Settings |
| `settingsService` / `sizingPolicyService` | 设置/仓位策略 | Settings |
| `userService` | 用户 CRUD(占位 Tab 现成实现,待接入) | Settings·用户管理 |
| `dataHealthService` / `taskService` / `logService` | 数据健康/调度/日志 | Data |
| `docsService` / `docsCommentsService` | 文档 | Docs |
| `easyQuantService` | 简易版 | Easy |
| `authService` / `api` | 鉴权 / axios 基座 | 全局 |
| `aiStockAnalysisService` / `v3RecommendationService` / `userFeedbackService` | 个股 AI / 推荐 / 反馈 | StockDetail / Home |

---

## 6. 2026-07 整理决策 (删 / 留 / 合)

### 6.1 已删(4 个孤儿,非页面;删后 `tsc` 保持 exit 0)

| 文件 | 行数 | 原因 |
|---|---|---|
| `services/marketService.ts` | 31 | 仅 `/market/search`,0 引用 |
| `services/portfolioService.ts` | 170 | 旧模拟盘,已被 `portfolioWorkspaceService`/`portfolioCrudService` 取代,0 引用 |
| `components/trading/TradePolicyExplainPanel.tsx` | 273 | 0 引用 |
| `pages/workspace/strategyKillSwitchHelpers.ts` | 217 | 0 import(仅注释里被提及) |

### 6.2 保留(策略性,非孤儿)
- `services/userService.ts` —— 用户管理 Tab 的现成 CRUD,为未来 admin 功能保留,已修正注释。
- 所有顶层页面 —— 经独立 subagent 复审,均可达且承载独有功能,**无页面删除**。

### 6.3 合并
- 旧独立页 `DataUpdateStatus` / `HealthMonitor` / `SystemLogs` / `TaskScheduler` 的能力已收敛进 `DataWorkspace` 的 Tab。

### 6.4 注释修正(源码卫生,不改运行逻辑)
- `App.tsx`: 修正"选股因子合并到实验室"假注释 → 说明 factors 是独立 ETF 轮动工作台、功能未合并、经策略详情/`screener` 进入,并加"勿误删 FactorWorkspace"警告。
- `App.tsx`: 修正 `today` 注释 → 如实说明其为活页面及真实入口。
- `SettingsWorkspace.tsx`: 修正注释 → 说明 3 个占位 Tab 待接入,userService 为现成实现勿删。

---

## 7. 白屏防御 (历史事故)

登录后 `/home` 白屏根因:渲染期未保护的 `null.toFixed()` → 同步 TypeError → 整棵 React 树卸载 → `#root` 空白。已修复。**教训:渲染路径上一切数值格式化必须先判空。**

> 注:产线构建 (react-scripts build) 排除 test 文件,删后类型检查为绿。但仓库级 `npx tsc --noEmit` 会报 ~93 错,全部集中在两个 test 文件(缺 `@types/jest`,“Cannot find name describe/test/expect”),为**本次整理之前就存在**的遗留问题,与删文件无关。
