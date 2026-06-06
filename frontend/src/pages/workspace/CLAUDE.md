# Workspace Shells

The 6 files in this directory are the **only** top-level navigation entries in `frontend/src/App.tsx`. Future stories (US-002 / US-015..US-018) build out each workspace into a tabbed page, but the **set of 6 shells must stay fixed** — adding a 7th breaks the PRD's information-architecture promise.

## How the workspaces map to legacy pages

| Workspace        | Absorbs (legacy pages)                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TodayWorkspace   | TodayCommandCenter, Recommendations, RiskAlerts, Dashboard                                                                                                                |
| FactorWorkspace  | Screener, factor-related parts of Quant\*                                                                                                                                 |
| LabWorkspace     | StrategyExperimentLab, AutonomousOptimizationLab, QuantBacktestLab, QuantPerformanceDashboard, QuantSignalPool, QuantStrategyLibrary, Strategy, AIAdvisor, Backtest       |
| PortfolioWorkspace | Portfolio, AutonomousTradingOverview, AutonomousRecommendationTracker, PaperTrading, ReviewCenter, LiveTrading, RecommendationPerformance, RecommendationTradeOutcomes |
| DataWorkspace    | Market, DataUpdateStatus, TaskScheduler, SystemLogs                                                                                                                       |
| SettingsWorkspace | Profile, UserManagement                                                                                                                                                  |

## When implementing a workspace tab

1. Edit the shell file in place — do **not** create a sibling page.
2. Use `WorkspaceLayout` (added in US-002) for the chrome; only the inner content per tab is unique.
3. Reuse the legacy component as-is when possible — import from `../<LegacyName>` and render it inside the relevant tab.
4. Remove the corresponding legacy `/legacy/*` route in `App.tsx` only after the workspace tab fully covers the legacy functionality.

## Tab key stability

Each shell already declares its secondary-tab `key` strings (e.g. `overview`, `weights`, `picks` in FactorWorkspace). These are the **stable contract** for future deep-link / URL-param support — don't rename a key during a content-add story unless you also update any consumers. If you need a new tab, append it to the array rather than reordering.

## KPI / actions slot conventions

- Use antd `Statistic` inside `kpiSlot` so the values share the global Card typography. Group multiple statistics in a `Space` with `size={32}`.
- Put workspace-wide refresh / settings buttons in `headerActions`; per-tab inline buttons belong inside `children`.
- The KPI bar is fixed at 96px — don't try to make it taller. If a workspace needs more chrome, render it as the first card inside `children`.

## Service layer (US-015+)

- **Per-workspace `<workspace>Service.ts`** under `frontend/src/services/` exposes typed functions that call the backend `/api/<workspace>/*` endpoints. FactorWorkspace pattern: types co-located with the function (e.g. `FactorOverviewResponse` next to `listFactorsOverview()`), with a bundled `<workspace>Service` default export for default-imported callers and named exports for tree-shaking.
- **Unwrap `{ success, data }`** at the service boundary, throwing a JS Error on `success=false`. Components consume `data` directly without re-extracting — keeps `await`s readable.
- **One state hook per data source.** FactorWorkspace pulls `overview` + `latestPicks` together because they share a single "load latest" UX; the user-driven `previewResult` lives in its own state because it has its own loading/error lifecycle. Don't merge unrelated requests into a single mega-state.

## Multi-tab data fetching pattern (US-015)

When a workspace has tabs that consume different endpoints:

1. **Load shared data eagerly on mount** (Tab 1 + initial KPI strip) via a single `Promise.all` so initial paint is fast.
2. **Lazy-fire on user action** for tabs whose data is driven by interactive controls (Tab 2's "预览" button → POST `/preview`). Don't refetch on tab-switch alone.
3. **Keep a single `loadError` top-level Alert** that survives across tabs — if `overview` fails, all tabs render the alert in place of their tab body. This avoids the "tab 1 shows error, tab 2 shows empty card with no explanation" inconsistency.

