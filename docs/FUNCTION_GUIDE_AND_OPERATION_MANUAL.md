# QuantX 功能手册与操作指南

> 版本：2026-07（Signal-First 重构后，ETF Core-Satellite 主线）
> 旧版 13+ 策略 / Kelly+ATR 个股主线已删除，本手册只描述当前实际存在的功能。

---

## 目录

1. [产品定位](#1-产品定位)
2. [自动会话与导航](#2-自动会话与导航)
3. [首页（/home）](#3-首页home)
4. [今日 Workspace（/workspace/today）](#4-今日-workspaceworkspacetoday)
5. [因子 Workspace（/workspace/factors）](#5-因子-workspaceworkspacefactors)
6. [实验室 Workspace（/workspace/lab）](#6-实验室-workspaceworkspacelab)
7. [持仓 Workspace（/workspace/portfolio）](#7-持仓-workspaceworkspaceportfolio)
8. [数据 Workspace（/workspace/data）](#8-数据-workspaceworkspacedata)
9. [设置 Workspace（/workspace/settings）](#9-设置-workspaceworkspacesettings)
10. [系统与文档 Workspace](#10-系统与文档-workspace)
11. [后端定时任务一览](#11-后端定时任务一览)
12. [关键 API 端点（运维参考）](#12-关键-api-端点运维参考)

---

## 1. 产品定位

QuantX 是面向 A 股的 **Signal-First + Core-Satellite** 量化辅助系统：

- **Core 70%**：ETF 因子轮动，月度机械换仓，不含个股。
- **Satellite 20%**：题材/事件机会，必须通过 EV gate（Wilson 下界置信度 × 胜率 × 盈亏比 > 0）。
- **Cash 10%**：硬底仓，永远不满仓。

所有功能围绕以上三个 bucket 设计；旧的 13+ 策略个股主线代码已物理删除。

---

## 2. 自动会话与导航

| 项 | 值 |
|---|---|
| 默认入口 | `/catdesk` |
| 会话方式 | 打开页面后自动建立默认管理员浏览会话，无需手工登录 |
| 鉴权 | 前端仍携带后端签发的 Bearer Token，不使用匿名后门 |
| 主入口 | `/home` → 侧边栏展开各 Workspace |
| 简易模式 | `/workspace/easy` — 教学用暖纸色极简视图 |

左侧导航 7 个 Workspace 入口（+首页）：今日 / 因子 / 实验室 / 持仓 / 数据 / 设置 / 系统。

---

## 3. 首页（/home）

**HomeWorkspace** — 全局状态快照。

| 区域 | 内容 |
|---|---|
| Core-Satellite bucket 概览 | 卫星推荐卡片（bucket = satellite），自动过滤掉 core bucket 条目 |
| 当前月度 ETF 排名摘要 | 来自 `ETFRotationService`，top4 ETF 简表 |
| 风险提醒 badge | 当前触发的 risk alert 数量 |

> 首页不显示 core 仓位推荐，core 操作在「因子 Workspace → ETF 调仓清单」执行。

---

## 4. 今日 Workspace（/workspace/today）

**TodayWorkspace** — 每天第一站：看卫星信号、今日题材机会、风险提醒。

### Tab 结构

| Tab key | 标签 | 用途 |
|---|---|---|
| `core_picks` | 题材机会 | 卫星 detector 产出的个股机会（需过 EV gate） |
| `signals` | 今日信号 | 全量信号列表，含置信分、胜率、盈亏比 |
| `alerts` | 风险提醒 | 当前触发的持仓风险 / 组合级熔断提醒 |
| `events` *(admin)* | 关键事件 | 日历事件（财报、分红、解禁等） |
| `risk_center` *(admin)* | 风控中心 | 全局风控参数实时面板 |

### 核心操作流程

1. 进入 **题材机会** tab，查看今日 EV 为正的卫星信号卡片（4 维评分 + 一句话理由）。
2. 点击卡片展开，查看 EV 分解：胜率 / 盈亏比 / Wilson 下界 / 样本量。
3. 确认后跳转「持仓 Workspace → 当前持仓」手动记录买入。
4. 切换 **今日信号** tab 可按 source_type 过滤，查看哪个 detector 在产信号。
5. **风险提醒** tab 有未处理提醒时会显示红色 badge。

### AlertsBell 快捷跳转

URL 参数 `?tab=risk_center` 可直接落到风控中心（admin），  
普通用户 AlertsBell 点击 → 跳到持仓 Workspace 的「我的提醒」tab。

---

## 5. 因子 Workspace（/workspace/factors）

**FactorWorkspace** — Core ETF 轮动的核心操控台。

### Tab 结构

| Tab key | 标签 | 用途 |
|---|---|---|
| `overview` | 因子总览 | 各因子健康状态（alpha/weak/unstable/unknown）、IC 90d |
| `weights` | 权重调参 | 四因子权重滑块预览（V0：Value 0.40 / Quality 0.30 / LowVol 0.30 / Momentum 0.0）|
| `picks` | ETF 调仓清单 | 月度 ETF 排名表，top8 含综合分、动作（买/卖/持有）、四因子 z 明细 |
| `board` | 行业决策 | 行业集中度 KPI、关键行业观察 |
| `sentiment` | 舆情雷达 | 宏观情绪指标（辅助参考，不直接影响因子权重） |
| `macro` | 宏观环境 | 利率 / 汇率 / PMI 等宏观指标面板 |
| `etf` | ETF 资金流 | 主力资金流入/流出排行 |
| `policy` | 政策要闻 | 政策关键词监控 |

### ETF 调仓清单操作指南

1. 每月第一交易日早上，打开 **ETF 调仓清单** tab。
2. 查看排名前 4（绿色「买入」）与掉出 top6（红色「卖出」）。
3. 排名 5-6 之间的 ETF 显示「持有」——缓冲带，减少不必要换手。
4. `data_incomplete` 标签表示该 ETF 本月成分股数据不足，已自动剔出，无需手动处理。
5. 展开任意 ETF 行可查看完整 `reasons` 与四因子 z-score 明细。

### 权重调参说明

- 权重调参只是**预览模式**（POST `/factors/preview`），不会修改生产因子权重。
- 正式改权重须在 `SIGNAL_FIRST_PLAN.md` §4.1 记录版本决策后，再修改后端配置。
- Momentum 当前权重 = 0（Shadow 模式仅观察），不要在 UI 上手动拉高。

---

## 6. 实验室 Workspace（/workspace/lab）

**LabWorkspace** — 策略回测与验证沙箱。用于验证信号有效性，不作为实盘执行依据。

### Tab 结构

| Tab key | 标签 | 用途 |
|---|---|---|
| `my-strategies` | 我的策略 | 已注册策略列表 + 运行状态 |
| `new-backtest` | 新建回测 | 配置策略 + 时间区间 + 股票池，提交回测任务 |
| `evaluation` | 评估报告 | 综合评估 / 实验账本 / Walk-Forward 走查 / 过拟合诊断 / 季度重训 |
| `advanced` | 进阶 | 回测对比 / 工作流体检 |

### 注意事项

- 回测遵循现实约束（T+1、滑点 0.1%、手续费 0.03%、卖出含印花税），与 USER_GUIDE §5.2 保持一致。
- 新增 ETF 因子扩展方案见 `docs/DEVELOPER_GUIDE.md`。
- 旧的「13+ 策略跑分验证」入口已删除；现有策略列表只含 ETF 轮动因子策略。

---

## 7. 持仓 Workspace（/workspace/portfolio）

**PortfolioWorkspace** — 持仓跟踪与复盘。

### Tab 结构

| Tab key | 标签 | 用途 | 权限 |
|---|---|---|---|
| `positions` | 当前持仓 | Core ETF + Satellite 个股，按 bucket 分区显示 | 所有人 |
| `trades` | 交易明细 | 历史买卖记录，含退出触发类型 | 所有人 |
| `equity` | 资金曲线 | 净值曲线 vs 沪深 300，drawdown 图 | 所有人 |
| `journal` | 复盘日记 | 按日期懒加载的交易归因笔记 | 所有人 |
| `alerts` | 我的提醒 | 当前持仓的风险提醒（止损/止盈接近）| 所有人 |
| `attribution` | 日归因 *(admin)* | 逐日 alpha 归因，按 regime 切片 | admin |
| `error-patterns` | 错误模式 *(admin)* | 错误归因聚类 | admin |
| `correlation` | 相关性矩阵 *(admin)* | 持仓相关系数热力图 | admin |
| `manage` | 模拟盘管理 *(admin)* | 初始化 / 重置模拟盘 | admin |

### 核心持仓视图

持仓按 bucket 分两区：

- **Core 区**：当前 ETF 持仓，显示入场价、当前综合分、距下次换仓天数。
- **Satellite 区**：当前个股持仓，显示入场日、退出条件进度（止损/止盈/时间 bar）、source_type。

退出触发类型记录在每笔平仓里：止盈 / 硬止损 / 软止损 / 时间退出 / 信号失效。

---

## 8. 数据 Workspace（/workspace/data）

**DataWorkspace** — 数据同步 + 任务调度 + 系统监控。

### Tab 结构

| Tab key | 标签 | 用途 |
|---|---|---|
| `health` | 数据健康 | 各数据表最新日期、延迟检查、异常 flag |
| `stocks` | 个股趋势 | 任意股票 K 线快速查看 |
| `sync` | 行情同步 | 手动触发数据同步命令 |
| `tasks` | 调度任务 | Cron job 列表、状态、上次运行时间 |
| `logs` | 系统日志 | 后端 log 实时查看（last 500 lines） |
| `monitoring` | 健康监控 | CPU / 内存 / DB 连接池状态 |

### 常用数据同步命令

在「行情同步」tab 或后端终端执行：

```bash
npm run sync:stock-basic          # 股票基础信息（全量，月跑一次）
npm run sync:daily-bars           # 日 K 线（每个交易日收盘后）
npm run sync:index-components     # 指数成分股（月跑一次）
npm run sync:fund-top-holdings    # ETF 前十大持仓（季度更新）
npm run compute:etf-factors       # 计算 ETF 因子分（月底）
```

### 调度任务说明

| 任务 | 触发时间 | 说明 |
|---|---|---|
| ETF 因子计算 | 每月最后交易日 22:00 | 计算下月换仓依据 |
| 日 K 线同步 | 每交易日 16:00 | 当日行情入库 |
| 卫星 EV 校准 | 每周日 02:00 | 更新各 detector source_type 胜率 |
| 持仓退出检查 | 每交易日 15:05 | 检查止损/止盈/时间退出 |

如需修改 cron 时间，编辑 `backend/src/jobs/` 对应文件并同步更新 `SIGNAL_FIRST_PLAN.md` §4.1。

---

## 9. 设置 Workspace（/workspace/settings）

**SettingsWorkspace** — 风控参数 + 仓位策略 + 待办建议。

### Tab 结构

| Tab key | 标签 | 用途 |
|---|---|---|
| `risk-params` | 风控参数 | 硬止损 / 软止损 / 时间退出阈值配置 |
| `portfolio-construction` | 组合构建 | Core / Satellite / Cash 比例确认 |
| `sizing-policy` | 仓位策略 | 单只 ETF 上限（15%）/ 单只个股上限（5%）|
| `todo-suggestions` | 待办建议 | AI 生成的月度操作检查清单 |
| `black-swan-history` | 黑天鹅历史 | 重大市场事件记录，用于历史对比参考 |

> **注意**：风控参数修改即生效，需同步在 `SIGNAL_FIRST_PLAN.md` §4.2 记录版本变更原因。

---

## 10. 系统与文档 Workspace

### SystemWorkspace（/workspace/system）

系统介绍页面，面向新用户，包含：

- Signal-First 架构说明卡片
- Core-Satellite bucket 图示
- 版本变更日志入口

### DocsWorkspace（/workspace/docs）

内嵌文档浏览器，直接展示 `docs/` 目录下的 Markdown 文档，支持目录导航。

---

## 11. 后端定时任务一览

任务定义文件在 `backend/src/jobs/`：

| 文件 | 任务描述 | 调度 |
|---|---|---|
| `etfFactorJob.ts` | ETF 四因子计算 + 生成换仓清单 | 月末最后交易日 22:00 |
| `dailyBarsSyncJob.ts` | 日 K 线增量同步 | 工作日 16:00 |
| `evCalibrationJob.ts` | EV 胜率/盈亏比校准（按 source_type）| 周日 02:00 |
| `exitCheckJob.ts` | 卫星持仓退出检查（止损/止盈/时间）| 工作日 15:05 |
| `indexComponentsJob.ts` | 指数成分股更新 | 每月 1 日 03:00 |

---

## 12. 关键 API 端点（运维参考）

> 完整 API 文档见 `backend/src/api/controllers/` 各 Controller 文件的 JSDoc。

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/v3/recommendations` | GET | V3 推荐列表（含 core_satellite 字段）|
| `/api/factors/etf-picks` | GET | 月度 ETF 换仓清单 |
| `/api/factors/overview` | GET | 因子健康状态汇总 |
| `/api/factors/preview` | POST | 权重调参预览（不写入 DB）|
| `/api/portfolio/positions` | GET | 当前持仓（含 bucket 字段）|
| `/api/portfolio/equity` | GET | 净值曲线数据 |
| `/api/sync/trigger` | POST | 手动触发数据同步 |
| `/api/health` | GET | 服务健康检查 |

---

*本手册对应 QuantX 重构完成后的 Signal-First 主线。如发现描述与实际功能不符，以代码为准，并提 PR 更新本文档。*
