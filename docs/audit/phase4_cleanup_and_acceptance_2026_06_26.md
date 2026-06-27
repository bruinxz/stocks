# Phase 4: 清理冗余 + 端到端验收 (2026-06-27)

> Phase 1 (数据修复, PR #17) + Phase 2 (单一盘整合, PR #18) + Phase 3 (UI 简化, PR #19) 全部 merged.
> 本文记录 Phase 4 — 删 legacy pages / dead routes / 孤立组件 + 端到端验收。

主分支 baseline: `cb52f86` (Phase 3 merge commit on main).

---

## 1. 清理清单

### 1.1 删除 30 个 legacy pages (~ 4 万行死代码)

均位于 `frontend/src/pages/*.tsx`，删除前已 grep 全仓确认无引用 (除 App.tsx 自己的 `/legacy/*` lazy import 与 Group-A 内部互相 import)。

**Group A (18 个) — 仅有 `/legacy/*` deep-link 兜底，主菜单 + workspace tab 已替代:**

| 文件 | 之前挂在 |
|------|---------|
| Dashboard.tsx | /legacy/dashboard |
| TodayCommandCenter.tsx | /legacy/today |
| Backtest.tsx | /legacy/backtest (列表页, 详情 `/legacy/backtest/:id` 仍保留) |
| Portfolio.tsx | /legacy/portfolio-classic |
| Market.tsx | /legacy/market |
| Profile.tsx | /legacy/profile |
| UserManagement.tsx | /legacy/users |
| AIAdvisor.tsx | /legacy/ai-advisor |
| Screener.tsx | /legacy/screener |
| ReviewCenter.tsx | /legacy/review |
| StrategyResearchCenter.tsx | /legacy/strategy-research |
| AutonomousTradingOverview.tsx | /legacy/portfolio |
| LiveTrading.tsx | /legacy/live-trading |
| QuantResearchWorkbench.tsx | /legacy/quant-research |
| RiskAlerts.tsx | /legacy/risk-alerts |
| StrategyExperimentLab.tsx | (chained via StrategyResearchCenter / QuantResearchWorkbench) |
| AutonomousOptimizationLab.tsx | (chained via StrategyResearchCenter) |
| RecommendationLoopPolicies.tsx | (chained via StrategyResearchCenter) |

**Group B (10 个) — 上面 Group A 的级联依赖，删 A 后变孤立:**

| 文件 | 被哪个 Group A 引用 |
|------|------|
| RecommendationTradeOutcomes.tsx | ReviewCenter |
| RecommendationPerformance.tsx | ReviewCenter |
| AgentTailAlphaLedger.tsx | ReviewCenter |
| TradingJournal.tsx | ReviewCenter |
| QuantStrategyLibrary.tsx | StrategyResearchCenter, QuantResearchWorkbench |
| Strategy.tsx | StrategyResearchCenter |
| QuantPerformanceDashboard.tsx | QuantResearchWorkbench |
| QuantSignalPool.tsx | QuantResearchWorkbench |
| QuantBacktestLab.tsx | QuantResearchWorkbench |
| PaperTrading.tsx | AutonomousTradingOverview |

**Group C (2 个) — 删 Phase 3 前已无任何引用:**

| 文件 |
|------|
| Recommendations.tsx |
| AutonomousRecommendationTracker.tsx |

### 1.2 保留的 non-workspace 页面 (4 个)

| 文件 | 用途 |
|------|------|
| `pages/Login.tsx` | `/login` 路由 |
| `pages/RecommendationTrace.tsx` | `/signals/:id/trace` + `/recommendation-trade-outcomes/:id` deep link |
| `pages/StockDetail.tsx` | `/stock/:symbol` + `/stocks/:symbol` 详情 |
| `pages/HealthMonitor.tsx` | DataWorkspace `monitoring` tab 内嵌 |
| `pages/DataUpdateStatus.tsx` | DataWorkspace `sync` tab 内嵌 |
| `pages/TaskScheduler.tsx` | DataWorkspace `tasks` tab 内嵌 |
| `pages/SystemLogs.tsx` | DataWorkspace `logs` tab 内嵌 |

(其中后 4 个最初被列入删除候选，发现 DataWorkspace 通过 `lazy(() => import('../HealthMonitor'))` 等内嵌使用后保留。)

### 1.3 删除 18 个 `/legacy/*` 路由 + 18 个 lazy import (App.tsx)

`App.tsx` 内:
- 删 18 个 `<Route path="/legacy/..." element={<XxxPage />}>` 块 (~ 160 行)
- 删 18 个 `const Xxx = lazy(() => import('./pages/Xxx'))` 声明
- 删孤立的 `import AdminGuard from './components/AdminGuard'` (导入只在 `/legacy/tasks /logs /users` 中使用，三者已删)
- 保留 `/legacy/backtest/:id` — `LabStrategyDetail.tsx:957` 还在 `<Link to={\`/legacy/backtest/${row.id}\`}>` 跳转回测详情

### 1.4 删除 2 个孤立组件

| 文件 | 原使用者 |
|------|---------|
| `components/AdminGuard.tsx` | App.tsx /legacy/{tasks,logs,users} (3 路由已删) |
| `components/backtest/BacktestForm.tsx` | `pages/Backtest.tsx` (已删) |

### 1.5 SettingsWorkspace 占位 tab 修正

`SettingsWorkspace.tsx renderPlaceholder()` 之前 `profile` / `keys` / `users` 三个占位 tab 都给「前往旧版 /legacy/profile」按钮 — 三个 legacy 页都删了, 改成「暂未实现, 后续 sprint 接入」文案 (不再链到 dead URL)。

---

## 2. 验收结果

### 2.1 TypeScript

`npx tsc --noEmit` — production 代码 0 error (pre-existing `__tests__/*.test.tsx` 缺 `@types/jest` 与本批次无关)。

### 2.2 Build

```
baseline (cb52f86 main):         build 49,416 KB  / JS 48,208 KB
phase 4 (本分支):                 build 44,316 KB  / JS 43,112 KB
                                  ──────────────────────────────
reduction:                       -5,100 KB (-10.3%) / JS -5,096 KB (-10.6%)
```

DA-1 估算"减小 ≥ 5%"达成，code-splitting 已 lazy 多数 legacy page → bundle 体积主要来自 chunk 数量减少 + tree-shake 后的共享依赖。

### 2.3 Easy quant contract test (24 项)

```
node frontend/tests/easy-quant-workspace-contract.test.js
=> Result: 24 passed, 0 failed
```

简易版 `/workspace/easy` + EasyQuantWorkspace 8 个文件 + App.tsx 4 个位点全部未触动。

### 2.4 Prod 数据库验证

**单一盘 (Phase 2 验收):**
```
SELECT id, name, total_value, is_active, jsonb_array_length(strategy_keys) FROM paper_trading_portfolios WHERE is_active = true;
[
  { "id": 65, "name": "综合策略主盘", "total_value": "200000.00",
    "is_active": true, "n_strategies": 10 }
]
```
唯一 active 盘 = 65 号综合策略主盘 (Phase 2 配置正确)。

**数据 fresh (Phase 1 验收):**
```
SELECT MAX((time AT TIME ZONE 'Asia/Shanghai')::date) AS latest, COUNT(*) FROM daily_bars;
=> [{ "latest_date": "2026-06-25", "total": "742923" }]
```
最新 = 2026-06-25 (上一交易日)。6/26 周五数据尚未入库 — 这是 sync cron 单独的进度问题, 与 Phase 1 修复的 tradingCalendar 时区 bug 无关 (Phase 1 修的是 freshness check 把周五 16:00+ 漂周六的判定 bug)。

### 2.5 菜单 + tab 精简

(Phase 3 已交付, Phase 4 不动:)
- 主菜单: 5 项 (普通) / 7 项 (admin) — `frontend/src/App.tsx:246-263`
- SettingsWorkspace tabs: 4 项 (普通) / 12 项 (admin) — `frontend/src/pages/workspace/SettingsWorkspace.tsx:131-151`

---

## 3. 总览: Phase 1-4 用户 5 目标完成情况

| 目标 | 状态 |
|------|------|
| ① 数据每天 fresh, 周末/节假日不误报 | PR #17 修 tradingCalendar Asia/Shanghai 时区 + freshness 用 trade-day lag |
| ② 模拟盘从 21 个收到 1 个综合主盘 | PR #18 + prod consolidation 已跑, id=65 唯一 active (10 策略) |
| ③ 主菜单 8 项 → 5 项, 二级 tab 精简 | PR #19 menu 8→5, SettingsWorkspace 12→4, Lab tabs 减半 |
| ④ 降 AI 感, 视觉收敛 | PR #19 限 4 色 + 3 fontSize + 删 Sprint/US 装饰 Tag |
| ⑤ 清理 legacy 死代码 | 本 PR 删 30 pages + 2 components + 18 dead /legacy 路由 + 18 lazy imports, bundle -10.3% |

---

## 4. 文件变更清单

- 删 30 个 `frontend/src/pages/*.tsx` (Group A 18 + Group B 10 + Group C 2)
- 删 `frontend/src/components/AdminGuard.tsx`
- 删 `frontend/src/components/backtest/BacktestForm.tsx`
- 改 `frontend/src/App.tsx` — lazy import + /legacy 路由 + AdminGuard import
- 改 `frontend/src/pages/workspace/SettingsWorkspace.tsx` — renderPlaceholder 改文案
