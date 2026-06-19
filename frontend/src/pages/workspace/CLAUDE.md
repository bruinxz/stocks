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

## Multi-field inline-edit per row pattern (US-076 — stop-loss + take-profit in PositionsTab)

When the same table row has **N independently editable inline fields** (止损价 + 止盈价 / 行情价 + 数量 / 起始日 + 结束日):

1. **Use a `(rowId, field)` tuple state** instead of N independent `editingXxxId / editingYyyId` states. The PositionsTab carries `editingPositionId: number | null` + `editingField: 'stop_loss' | 'take_profit' | null` + a single `editingValue` shared across both fields. Switching from止损 ✏ → 止盈 ✏ on the same row naturally replaces the previous edit (rowId same / field changes / value re-initialized from the new field's current value).
2. **Why this matters**: With independent state buckets, clicking ✏ on field B while field A's edit is open leaves both fields in edit mode simultaneously — the user faces two ✓ buttons in one row and can't tell which saves which. The tuple state collapses this into a single source of truth.
3. **Each field still has its own `handleSave<Field>` async function** — the save logic per field is field-specific (different endpoint, different validation, different success message). What's shared is the *editing UX state*.
4. **Cell render branches on both id AND field**: `if (editingPositionId === row.id && editingField === 'stop_loss')` — only render the edit UI for the cell that matches both. The other field renders as read-only Tag even when the row has an open edit.

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

## Multi-source 3-column comparison + per-block error fallback (US-018 — TodayWorkspace)

For workspaces that show **N parallel data sources side-by-side** (3 strategies in TodayWorkspace; later: US-019..US-023 add more策略 cards; US-022 高分红 vs 低 PE 双因子对比 etc):

1. **Backend service emits per-block error fields** — each Card's data block has `error?: string` populated when its compute branch throws. The aggregator uses `Promise.all(blocks.map(b => b.compute().catch(e => fallbackWithError)))` so one failure doesn't blank the page.
2. **Frontend Card renders `<Alert type="warning">` for error blocks** instead of bailing out. Other Cards on the same row keep their data. This is critical when each Card's underlying data source (factor_scores / limit_up_stocks / earnings_forecasts) ingests via independent cron jobs — a single missing day shouldn't take down the whole `/workspace/today` page.
3. **Row layout: `<Row gutter={[16,16]}><Col xs={24} lg={8}>...` for 3 columns**, `lg={12}` for 2 columns. The `xs={24}` falls back to stacked on mobile.
4. **Each Card structure**: mini-KPI `<Space size={24}>` 三件套 (e.g. "新进入选 / 保留 / 剔除") + 主 Table (rowKey=stock_code) + `Empty image={Empty.PRESENTED_IMAGE_SIMPLE}` 占位。Table 用 `expandable={{ expandedRowRender: row => <Paragraph>{row.reason}</Paragraph> }}` 展示 why-this-pick 细节，不占主行宽度。

## Cross-workspace navigation after an action (US-018 — apply-signals)

For "do something" buttons that send the user to a different workspace afterwards:

1. **Use `useNavigate()` from react-router-dom**, NOT `window.location.href`. The latter triggers a full-page reload, losing antd `ConfigProvider` state and Redux store.
2. **Pattern**: `Popconfirm → async API call → Modal with result detail → setTimeout(() => navigate(...), 1800) for auto-jump`. The 1.8s delay lets users see what happened before being shuttled away. Always also include a "前往 X" button in the Modal footer for users who want to skip the delay.
3. **Result Modal table shows per-item status** (placed / skipped / failed + reason). Users need to know *which* of their 12 signals succeeded vs. why others were skipped — a single "完成" toast is not enough for batch actions.

## A-share signal data dependency (US-018 — three strategies need three different tables)

Each策略 Card depends on a distinct upstream table that ingests via its own cron job. When the table is empty, the corresponding `compute<Strategy>Block()` should return `{...emptyBlock, error: "X 表为空，请运行 npm run Y"}` — **never** silently render an empty table or a 500 error.

| Strategy             | Required upstream tables                                            | Sync script                       |
| -------------------- | -------------------------------------------------------------------- | --------------------------------- |
| MultiFactorAlpha     | `factor_scores`                                                      | `npm run compute:factors`         |
| DragonHeadMomentum   | `limit_up_stocks` + `industry_flows` + `dragon_tiger_boards`         | US-006/007/008 sync scripts       |
| EarningsSurprise     | `earnings_forecasts` (is_surprise=true) + `northbound_holdings`      | US-005/013 sync scripts           |

## Draft/view 双状态 + 矩阵格批量保存 pattern (US-080 — SettingsWorkspace 推送渠道)

矩阵 / 多 cell 同时编辑 + 一次性保存的 tab 用 **`view: T | null` + `draft: T | null`** 双状态，而不是直接编辑 view。

1. **`view`** = 服务器最近一次返回的"真实状态"；`draft` = 用户本地未提交的修改副本。两者都从 `loadXxx()` 初始化（`setView(v); setDraft(v)`）。
2. **每个 cell toggle / 字段输入** 只更新 `draft`（`setDraft(prev => ...)`）；UI 渲染始终基于 `draft`，所以即使保存失败用户输入也不丢。
3. **保存按钮做 `draft vs view` diff** 只发改动字段 → PUT 一次 → 成功后 `setView(server_response); setDraft(server_response)`（同步重置两者，避免 stale draft）。失败保留 `draft` 让用户重试。
4. **"有未保存改动" 提示** 用 `useMemo(() => JSON.stringify(draft) !== JSON.stringify(view), [...])` 计算，给 Save 按钮 `disabled={!hasChanges}` + Tag 显示 "有未保存的改动"。
5. **同源数据多个 tab 同步**：US-080 的 push-channels 与 notifications tab 共用底层 `risk_config.notification_channels` JSONB，保存后 `setConfig(view.raw)` 把刚拉的最新数据回灌到另一个 tab 的 state，避免用户切 tab 看到旧数据。

适用场景：矩阵编辑（事件×渠道）、表格批量勾选 / 拖拽排序、Form 多字段批量更新、任何 "改一堆字段最后一次提交" 的 UX。**不适用**：单字段实时同步的场景（输入→自动保存），那种用 debounce + 单字段 endpoint 即可，不需要 draft 影子状态。

## Monaco code viewer 嵌入 pattern (US-093 — LabStrategyDetail 代码视图)

需要在 tab 里展示 .ts / .json / .log 等大段代码 / 文本内容时（只读 viewer 场景）：

1. **复用 `frontend/src/components/monaco/MonacoSourceViewer.tsx`** —— 不要再自己 `import('monaco-editor')`。组件已封装：worker 抑制（noop `MonacoEnvironment` 退化主线程模式）/ 动态 import 让首屏不下 ~1.5MB monaco chunk / TypeScript diagnostics 关闭（无 worker 跑不动会刷 console error）/ dispose on unmount 防泄漏 / `setValue` 替换内容而非重建 editor。
2. **必须 lazy-load**：`activeTab !== 'source' return` 短路，第一次进 tab 才动态 import monaco。否则 LabStrategyDetail / 任何承载 viewer 的页面 first-load JS 暴增 ~1.5MB。
3. **Tabs 数据三态独立**：`source` + `sourceLoading` + `sourceError` 三个 state，与 'detail' tab 的数据互不影响（"代码加载失败但回测数据正常" 应允许）。useEffect 监听 `[activeTab, source, sourceLoading, sourceError]` —— 同款 [[lazy-load tab data 三态判定]] 范式。
4. **切换 strategy 清空 source**：`useEffect([strategyKey], () => setSource(null))` —— 否则切到下一个策略时残留前一策略的源码。
5. **后端 API 必须 strategy_key 严格白名单** (`^[a-z][a-z0-9_]*$`) + 预扫建立 key→filename map + 文件大小硬上限 (256KB)。**绝不**让前端传任意 path 拼接到 fs.readFile —— path traversal 直接读 /etc/passwd。
6. **路由 ordering**：`/strategies/:strategy_key/source` GET 必须在 PATCH `/strategies/:strategy_key` 之前注册（即便 HTTP 方法不同，与 `/detail` 同款 ordering 规则，避免后期重构者无意识打乱顺序）。

适用场景：任何 "前端需要查看 / 对比 / 复制" 服务器侧文本的 viewer：策略源码 / 因子定义 JSON / 用户回测日志 / SQL 调试 / config diff。**不适用**：需要编辑回写（这是 v0 只读 viewer 范畴，编辑需开 monaco worker + 后端写回接口 + 权限设计 + 历史版本管理 —— PRD 明确 v0 只读）。

## Lazy-load tab data 三态判定 (US-074 → US-080 复用)

新 tab 数据是独立 endpoint 时：

```ts
useEffect(() => {
  if (activeKey !== 'X') return;        // 1. 当前不是 X tab → 跳过
  if (data || loading || error) return; // 2. 已加载 / 正在加载 / 之前失败 → 跳过
  void load();                          // 3. 首次进入且无 data 无 error → fire
}, [activeKey, data, loading, error, load]);
```

刷新按钮单独调 `load()`；错误重试也调 `load()`。"是否要 fire" 逻辑统一收敛在 useEffect，按钮只直接调 load。US-080 push-channels tab 复用此范式（避免一进 SettingsWorkspace 就拉两套 notification config，只在用户真正切到 push-channels 才拉矩阵视图）。

## Mobile-responsive table-to-card pattern (US-095)

When a workspace renders a wide antd `<Table>` (many columns, `scroll={{x: 1000+}}`) and is supposed to be browse-able on a < 768px phone screen:

1. **`import { useIsMobile } from '../../hooks/useIsMobile';`** — single hook, no antd Grid dependency, matches `(max-width: 767px)`.
2. **Conditional render `isMobile ? <CardList /> : <Table />`**, NOT a single render that depends on CSS hiding. CSS-only "hide columns at mobile" leaves the user with a horizontally-scrollable table where they can't see most data at once; replace the whole representation.
3. **Card sub-component per row** (`PositionMobileCard` / `TradeMobileCard` / etc) lives in same file, takes the same row + all the event handlers the table cell `render()` callbacks need, and stacks labels vertically with the shared CSS class `workspace-mobile-card-list` + `workspace-mobile-card-row` (defined in `frontend/src/index.css`).
4. **Touch-target sizing**: action buttons in card footers use `workspace-mobile-card-actions` which sets `height: 38px` + `flex: 1` (so two side-by-side buttons evenly fill row width). Don't keep `size="small"` for primary actions on mobile — 24px Buttons are not finger-tappable.
5. **Editing UI inside a card row** keeps `Space size={4}` with `<InputNumber size="small">` + ✓/✗ buttons — short widget chain still fits a 320px-wide phone if the label is on its own line above.
6. **WorkspaceLayout drawer auto-handles the secondary nav** (mobile = top-anchored Drawer triggered by 「☰ 切换标签」button, desktop = 220px left rail). Workspaces don't have to manage drawer state themselves.

Reference implementations: `PortfolioWorkspace.PositionsTab` + `PositionMobileCard`, `PortfolioWorkspace.TradesTab` + `TradeMobileCard`, `TodayWorkspace.{MultiFactorCard,DragonHeadCard,EarningsSurpriseCard}` — all read `useIsMobile()` once and branch the inner `<Table>` rendering. Next mobile responsiveness story should reuse `workspace-mobile-card-list` CSS classes and the same `useIsMobile()` hook, NOT introduce a new media-query approach.

## User-scoped localStorage pattern (US-047 因子组合模板 / pinned 等)

工作区里那些 "用户私有的 view 状态" — 已固定订阅 / 选盘 id / 因子组合模板 — 不应该立刻倒上后端表, 走 **localStorage + sessionCleanup 白名单** 的轻量范式即可:

1. **纯 helper 抽离**: 把 storage I/O 抽到 `<workspace>XxxHelpers.ts` 文件 (与 [[factorAIWeightHelpers]] 同款), 暴露 storage 接口让单测注入 in-memory mock. UI 组件只调 `listXxx() / saveXxx() / deleteXxx()`, 不直接 `localStorage.setItem`. 这样单测不依赖 jsdom — `backend/tests/services/<feature>.test.ts` 跑 ts-node 即可.
2. **payload 顶层 schemaVersion**: 永远 `{ schemaVersion: N, items: [...] }`, 不要直接 `JSON.stringify(array)`. Load 端校验 `schemaVersion === EXPECTED`, 不匹配返 `[]` (旧/新版本一律忽略), 不会误覆盖. 字段扩展时 +1, load 做迁移即可.
3. **写白名单**: 任何新加的 user-scoped localStorage key 必须登记到 `frontend/src/utils/sessionCleanup.ts USER_SCOPED_LOCAL_STORAGE_KEYS`. 否则 logout / 401-refresh fail / 切换用户时不会被清, 上一个用户的私有视图会泄漏给下一个登录用户. 这条规则被 BackendTests META-GUARD 覆盖 (regex fs 校验), 漏写会被测试拦下.
4. **加 max-count + name 校验 + sanitize**: 上限拒绝保存 (不是 silent FIFO), 让用户主动整理; name trim 后非空 + 长度限制 (UTF-8 char 数, 不是 byte); weights/数值类字段 sanitize 时丢 NaN/Infinity/负值. 这些放在 helper 而不是 UI 校验, 单测能直接验.
5. **load 时一次性灌全状态**: 比如 ComboTemplate 包含 (weights + topN + industryNeutral + maxPerIndustry + excludeST + excludeNew60d) 6 个字段, `handleLoadTemplate` 一次性调 6 个 setter; UI 不需要让用户再点 "应用" 二次确认, 直接生效 + message.success.

适用: 收藏 / 模板 / pinned / 隐藏列 / 排序偏好 / 最近选择 — 任何"用户改了, 但只需要本地记住"的 view 状态. **不适用**: 需要跨设备 / 跨人协作 / 审计 / 推送的状态, 那些必须上数据库 (如 portfolio_simulation / quant_strategy_weight).
