# `backend/src/portfolio/`

This directory owns the **PaperTrading facade** introduced in US-003.  All
external code (controllers, scripts, jobs) MUST consume `PaperTradingFacade`
rather than reaching into individual `internal/` services.

## Layout

```
portfolio/
├── PaperTradingFacade.ts          # 7-method public surface — controllers import this
├── PortfolioReturnSimulator.ts    # standalone return simulator (pre-existing)
├── risk/                          # pre-trade risk gates — US-047+
│   ├── PositionLimitGuard.ts      # max positions + single-stock + single-industry caps
│   ├── TrailingStopGuard.ts       # 追踪止损 — daily highest_price + next-day SELL trigger
│   └── DrawdownCircuitBreaker.ts  # 组合级回撤熔断 — LEVEL_1/2/3 cascade + 24h pause
└── internal/                      # private — only the facade may import from here
    ├── PaperTradingAttributionService.ts
    ├── PaperTradingAutomationService.ts
    ├── PaperTradingDashboardService.ts
    ├── PaperTradingOrderIntentService.ts
    ├── PaperTradingPlanService.ts
    ├── PaperTradingPortfolioFamilies.ts   # constants module — re-exported by facade
    ├── PaperTradingRiskProfileService.ts
    └── PaperTradingTuningApplyService.ts
```

## Rules

1. **Controllers** (`backend/src/api/controllers/`) may import **only** the
   `paperTradingFacade` instance and the 4 re-exported constants
   (`DEFAULT_PAPER_TRADING_INITIAL_CAPITAL`, `AUTONOMOUS_PORTFOLIO_NAME`,
   `DEFAULT_AUTONOMOUS_INITIAL_CAPITAL`, `QUANT_ONLY_PORTFOLIO_NAME`).  Never
   import `./internal/...` from a controller.

2. **Other backend services / scripts / jobs** are still allowed to reach into
   `./internal/...` (e.g., `SchedulerService` and `QuantFusionService` import
   `paperTradingAutomationService` directly).  This is intentional — the
   facade-only constraint is the controller boundary.  Cross-service
   composition still happens at the internal layer to avoid threading every
   call through the facade.

3. The facade exposes **exactly 7 public methods**.  Do NOT add an 8th method
   to `PaperTradingFacade`; instead extend the existing `action` / `view`
   discriminator union of the closest-fitting method.  The 7 methods are:
   `getPortfolio`, `placeOrder`, `closePosition`, `getDailySnapshot`,
   `attributePnl`, `applyAutomation`, `getRiskProfile`.

4. When adding a new action to `applyAutomation`, also extend
   `ApplyAutomationAction` so the `switch` block stays exhaustive (the default
   branch type-asserts `never` to catch missing cases at compile time).

5. **Adding a new internal service?** Place it under `./internal/`, import it
   from the facade, and re-export only the constants the controller absolutely
   needs.  Never `export` it from `PaperTradingFacade.ts` itself.

## When you'd touch this directory

- Adding a paper-trading capability that has an HTTP surface →
  extend an existing facade method's discriminator and add a thin internal
  helper if the implementation is non-trivial.
- Refactoring an internal service → safe to do without touching the facade
  signature as long as the facade's contract stays the same.
- Removing/renaming a re-exported constant → must update both the controller
  and any tests that still reference the old name.

## `risk/` — pre-trade gates (US-047+)

A `risk/` subdirectory hosts pre-trade guards that the facade calls **inline
before** ordering side effects.  Guards follow the project's `組合級
strategy` and `factor diagnostic` patterns:

1. **DataSource interface injection** — every guard exposes a
   `Xxx<DataSource>` interface + `Default<Xxx>DataSource` Sequelize impl +
   `PRODUCTION_<XXX>_DATA_SOURCE` singleton + a constructor that accepts an
   override, so tests can drive the guard with synthetic snapshots and **zero
   DB**.
2. **Pure-function helpers all exported** (`evaluatePositionCount`,
   `evaluateSingleStock`, `evaluateSingleIndustry`, `pickSingleViolation`,
   `normalizePositionLimitsConfig`) — single tests can hit boundaries / NaN
   / zero cases without booting the guard.
3. **Config lives in `User.risk_config.<key>` JSONB** + a project-wide
   `Object.freeze`'d default constant (e.g. `DEFAULT_POSITION_LIMITS`).
   Guards expose `getConfig(user_id)` and `updateConfig(user_id, raw)`;
   the latter normalizes invalid input back to defaults before persisting.
   Persisting JSONB requires `user.changed('risk_config', true)` (US-017).
4. **Violations are `RiskAlert(level='HIGH')` rows** written via the
   DataSource.  `writeAlert` failures are caught + logged but MUST NOT mask
   the violation itself — the caller still rejects the order.
5. **Single-violation priority chain** — `pickSingleViolation` short-circuits
   on the first failing rule so the user sees one clear reason, not a
   cascade.  Fix the first → next attempt surfaces the next.
6. **Facade integration**: the guard is called BEFORE the cash check inside
   `placeOrder` so a position-limit violation is reported as "仓位上限"
   rather than misleadingly as "可用资金不足".  Errors carry `code`,
   `rule`, `detail`, and `statusCode=400` for the controller layer.
7. **HTTP surface lives at `/api/risk/<resource>`** (mounted in `index.ts`
   alongside `/api/risk-alerts`).  `RiskController` is intentionally
   separate from `RiskAlertController`: the former is *pre-trade policy*,
   the latter is *post-trade consumption*.

## `risk/TrailingStopGuard` — US-048 specifics

The trailing-stop guard introduces a **two-phase scheduled** shape that
future drawdown / per-stock stop-loss / circuit-breaker guards can reuse.
Unlike `PositionLimitGuard` (single sync call inside `placeOrder`), it
runs in two cron-scheduled phases plus the same GET/PUT config endpoints:

1. **`updatePositionsAfterClose(user_id?)`** — post-close cron. Pulls each
   open position's DailyBar.close for `asOfDate`, recomputes
   `highest_price = max(prior_highest ?? avg_cost, today_close)` and
   `trailing_stop_price = highest * (1 - effective_pct)`, then writes both
   back via the DataSource.  Default scope = all users with portfolios
   (per-user `try/catch` isolation).  `user_id` parameter narrows to one
   user for ops backfills / re-runs.
2. **`evaluateNextDayTriggers(user_id?, dry_run?)`** — pre-open cron.
   Re-fetches DailyBar.close (= prev_close for the next trading day), and
   if `prev_close ≤ trailing_stop_price` returns a `TrailingStopTrigger`
   AND writes a `RiskAlert(level='HIGH')`.  The guard does NOT call
   `facade.placeOrder` — it surfaces structured triggers and lets the
   caller (the automation service / dashboard / human) decide the
   execution timing.  This preserves the facade's 7-method invariant and
   keeps "decide what to sell" decoupled from "execute the SELL".

Patterns codified in US-048 that future guards (US-049 drawdown,
US-051 per-stock stop-loss, US-052 industry rebalancer, ...) should follow:

- **`effective_pct` 三级覆盖**: `position.trailing_stop_pct` (策略层覆盖)
  → `user.risk_config.trailing_stop.pct` (用户全局)
  → `DEFAULT_TRAILING_STOP_CONFIG.pct` (兜底 0.10).  `pickEffectivePct()`
  is the reference helper — any guard that allows both per-position and
  per-user overrides should copy this 3-level shape rather than reinvent.
- **`highest_price` 初始化用 `avg_cost` 而非 `today_close`**: 开仓首日如果
  `today_close < avg_cost`, 直接用 close 当 high 会让追踪止损在第一根 bar
  就跳水触发.  `computeNewHighestPrice(null, close, avg_cost)` 永远先用
  `avg_cost` 作 floor, 同款思路适用未来"加仓后 high 水位重算" / "止损价
  跟随 avg_cost" 类逻辑.
- **触发判定用 `≤`，单股仓位用 `>`**: 保护性硬触发用 `≤` 包含 boundary
  (命中立即止血), 风控上限用 `>` 不含 boundary (恰好触线还可以). 这与
  US-047 PositionLimitGuard 单股 `>` 镜像反向 — 防御 vs 限制是 2 种 boundary
  语义, 写新 guard 时先想清楚自己是哪一种再选边.
- **数据缺失时安全 HOLD 而非 fallback**: DailyBar 缺当日 close →
  `skipped_no_bar`, 不退回 `current_price`.  current_price 会被 facade
  下单流程 mutate, fallback 会让 highest 突然跳水触发误平.  US-026 RSI
  bar-shortage guard 同款"数据不足 ≠ 信号"原则.
- **写 RiskAlert + 返回 trigger 同时做**: 调用方既能立即从 RiskAlert UI
  bell 看到, 也能从 evaluateNextDayTriggers 返回值拿到结构化 list 决定撮合.
  RiskAlert 写入 try/catch + logger.warn, 失败不掩盖 trigger 返回 — 同 US-047.
- **SchedulerService 双 task type**: `PAPER_TRADING_TRAILING_STOP_UPDATE`
  (收盘后) + `PAPER_TRADING_TRAILING_STOP_CHECK` (开盘前).  Cron 在 DB 表
  `scheduled_tasks` 配置 (不在代码硬编码), ops 可以按市场假期自定义.
  `dry_run=true` 参数让 UI dashboard 能"预演今日 trigger" 不写真实 alert.

## `risk/DrawdownCircuitBreaker` — US-049 specifics

The drawdown circuit breaker introduces the **third risk-guard shape** —
**portfolio-level cascading levels** (not per-position).  Where
`PositionLimitGuard` (sync inline) and `TrailingStopGuard` (two-phase cron)
target individual orders or positions, this guard watches the WHOLE
portfolio against its historical peak.

1. **`evaluateAfterClose(user_id?, dry_run?)`** — post-close cron.  Computes
   `peak_value = max(snapshots.total_value, current.total_value)` over the
   lookback (default 365d), then `drawdown_pct = (peak − current) / peak`.
   `pickDrawdownLevel()` picks **one** level via short-circuit chain
   (LEVEL_3 ≥ 20% > LEVEL_2 ≥ 15% > LEVEL_1 ≥ 10%), mirroring US-047's
   `pickSingleViolation`.  Side effects per level:
   - **LEVEL_1** — writes `User.risk_config.drawdown_breaker.paused_until`
     (24h ISO timestamp); the next BUY hits the inline `checkBuyAllowed`
     hook and is blocked.
   - **LEVEL_2** — emits `DrawdownSellTrigger[]` for the top 50% by
     `gain_ratio` (using `Math.ceil(N/2)` for the strong-disposal path —
     N=3 sells 2, N=1 sells 1).  Does NOT call `facade.placeOrder`;
     surfaces structured triggers + `RiskAlert(level='HIGH')`.
   - **LEVEL_3** — emits triggers for ALL open positions (清仓).
2. **`checkBuyAllowed(user_id, symbol)`** — `placeOrder` inline hook
   (placed BEFORE position-limit guard).  Blocks only when (a) pause is
   active AND (b) `symbol` isn't already in the user's open positions
   (so add-on to existing positions still works during a pause).  SELL
   never invokes this hook — closing positions during a pause is always
   allowed.  **Failure mode: fail-OPEN.**  DB outage in the guard simply
   lets the order proceed (`positionLimitGuard` + cash check still gate
   it).  Don't let risk-guard DB issues block all trading.
3. **`clearPause(user_id)`** — admin/operator override that clears the
   `paused_until` early (used when the drawdown turned out to be a
   benchmark dislocation rather than a real strategy issue).

Patterns codified in US-049 that future risk guards should follow:

- **LEVEL cascade pick (single-level short-circuit)** mirrors
  `pickSingleViolation` (US-047) — one cascading guard returns ONE event,
  the highest-severity one wins.  Cascading multiple LEVEL_X simultaneously
  would force operators to mentally decompose; sequential one-at-a-time
  preserves clarity.
- **`peak_value` includes current实时值, not just snapshots**.  EOD
  snapshots can lag intra-day evaluation.  Letting peak fall behind
  current would zero-out drawdown for the window before the next
  snapshot lands, then re-trigger when it does.  Belt-and-suspenders
  pattern reusable for any "lookback metric vs realtime" comparison.
- **`gain_ratio` sort: gain desc, symbol asc (stable tie-break)** — same
  as US-025 GameTraderRelay's stable sort discipline.  V8 sort isn't
  stable; explicit secondary key prevents monthly-rebalance picks from
  drifting across runs.
- **`Math.ceil(N/2)` is the strong-disposal path** — N=3 → 2 sold (more
  conservative is N=1; the strong path matches "减仓 *至* 50%" wording
  better than "减仓 *了* 50%").  Apply same shape to any future "keep
  the smaller half" / "trim the larger half" disposal logic.
- **`paused_until` is ISO timestamp string, not epoch ms** — audits are
  more readable, JS `new Date(s).getTime()` makes timezone-safe
  comparisons trivial.  `isPauseActive(pausedUntil, nowMs)` is the
  single read-side helper; never inline-compare `Date.now() < s`.
- **`≥` includes boundary (defensive硬触发)** vs PositionLimitGuard's
  `>` for limits.  US-048 / US-049 both use `≥` for triggers; US-047
  uses `>` for caps.  Decide upfront which side your guard sits on
  before writing comparisons.
- **Guard output ≠ order execution** — `evaluateAfterClose` returns
  `triggers: DrawdownSellTrigger[]` to the caller; the actual SELL
  is dispatched by `PaperTradingAutomationService` (or human approval)
  via `paperTradingFacade.placeOrder` like any other order.  This keeps
  the facade's 7-method invariant intact and matches US-048's pattern.
- **`SchedulerService` single task type**:
  `PAPER_TRADING_DRAWDOWN_BREAKER_CHECK` (post-close).  Unlike US-048
  there's no separate pre-open phase — `checkBuyAllowed` is the inline
  guard that consumes the pause state.  `dry_run=true` parameter for
  UI dashboard "predict today's triggers" preview.
- **HTTP surface**: 3 endpoints under `/api/risk/drawdown-breaker/*` —
  `GET` (read config), `PUT` (update config), `POST /clear-pause`
  (admin override).  All require auth.  Same namespace as US-047/US-048.
