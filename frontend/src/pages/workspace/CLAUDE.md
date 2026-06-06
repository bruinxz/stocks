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

## Polling pattern for long-running jobs (US-016)

When a tab kicks off a backend job (回测/批量 sync/…) that needs `~minutes` to complete:

1. Store the running task id in a top-level `pollingTaskId` state.
2. `useEffect` watches it and starts a `window.setInterval(async () => {...}, 3000)` that re-fetches the detail AND refreshes the parent list (so cross-tab navigation shows fresh state).
3. Exit the loop when `status` is `COMPLETED` or `FAILED`, surface result via `message.success`/`message.error`, and clear `pollingTaskId`.
4. Swallow network failures inside the interval silently — the next tick retries naturally.
5. Cleanup with `return () => window.clearInterval(timer);` to avoid leaks on tab switch / unmount.
6. **Disable the "submit" button while `pollingTaskId` is set** so users don't accidentally fire 5 backtests in 5 seconds.

## Large-tab decomposition (US-016)

When a single tab's content exceeds ~150 lines:

- Split into same-file sub-components (`MyStrategiesTab` / `NewBacktestTab` / `CompareTab`), pass state via props.
- Keep sub-components **module-private** (no export) — they only exist to serve this workspace.
- Shared helpers (`fmtPct` / `percentTag` / `compactDate` / `statusColor` / `statusLabel`) collect at the file BOTTOM so the main flow stays top-to-bottom readable.
- Parent component only owns: layout, route state (activeKey), shared API data, top-level loading/error.

## Inline-edit pattern (US-017 — stop-loss in PositionsTab)

When a table cell needs in-place edit (止损价 / 止盈线 / 备注):

1. Hoist `editingPositionId: number | null` + `editingValue: T | null` into the tab component (NOT into Table row state — antd's `record.editable` API is heavier and harder to coordinate with async save).
2. The cell `render(_, row)` branches on `editingPositionId === row.id`:
   - Edit mode: `InputNumber` (or `Input`) + ✓ confirm + ✗ cancel buttons in a tight `Space size={4}`.
   - Display mode: read-only Tag + ✏ edit `Button type="text"`.
3. On confirm: call the service, optimistically update the parent's state via `onChangeData(next)` (parent passes mutator down), `message.success` + clear editing state. On failure: keep the edit row open with `message.error` so the user can retry without retyping.
4. Tooltip on display-mode Tag should show contextual data (距现价 N%, 触发条件) — use this to nudge the user toward sensible values without blocking them.

## Inline confirm + execute pattern (US-017 — close position)

For destructive actions on a table row (一键平仓 / 删除信号 / 关闭实验):

1. Wrap the action button in `<Popconfirm okButtonProps={{ danger: true }}>` — antd's built-in confirm flow is more accessible than a custom Modal and inline-friendly.
2. Track `closingSymbol: string | null` to disable only the row that's executing (don't disable the whole table).
3. After the async call: `message.success` with structured info (`成交价 ¥X，实现盈亏 ±¥Y`) + trigger a parent refresh of all related data (positions / snapshots / trades all rebuilt — we don't optimistically patch a single row because平仓 cascades into cash + total_value).

## Benchmark series alignment pattern (US-017 — equity curve vs HS300)

Always render benchmark + own series on the **same `data` array** with the date as the X axis (NOT two separate `<Line data={a}>` + `<Line data={b}>` — recharts requires shared X axis to align dots). The composition:

1. Build a `Map<date, my_value>` from snapshots.
2. Fetch benchmark history with `start_date = snapshots[0].date` and `end_date = snapshots[-1].date` so the windows match.
3. Map each snapshot to `{date, my, benchmark}` — look up benchmark by date from the second Map; `null` if missing so `connectNulls` on the `<Line>` handles holidays gracefully.
4. Normalize both series at their respective `series[0]` (multiply by `100 / first`). Don't pre-normalize on backend — UI window selection should let users re-base on demand.

## Lazy detail fetch on selection (US-017 — JournalTab)

When a list/detail layout needs fresh detail per selection:

1. Keep the list state at the workspace level (refresh comes from the top-level Promise.all).
2. Keep detail state INSIDE the tab — `selectedDate` + `detail` + `detailLoading` + `detailError`. `useEffect([selectedDate], ...)` fires the per-selection fetch.
3. On 404: the service swallows it and returns `null` — the tab renders an Empty card with a "建档" hint, NOT an error Alert. This is the right UX for "user navigated to a date that doesn't have data yet".
4. Mutations (e.g. append note) update detail state locally and conditionally trigger `onListRefresh()` only if the mutation changes the list (e.g. first note creates a new journal row that wasn't in the list).
