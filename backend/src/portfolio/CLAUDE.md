# `backend/src/portfolio/`

This directory owns the **PaperTrading facade** introduced in US-003.  All
external code (controllers, scripts, jobs) MUST consume `PaperTradingFacade`
rather than reaching into individual `internal/` services.

## Layout

```
portfolio/
├── PaperTradingFacade.ts          # 7-method public surface — controllers import this
├── PortfolioReturnSimulator.ts    # standalone return simulator (pre-existing)
├── RebalanceEngine.ts             # 通用目标权重再平衡引擎 — US-086
├── risk/                          # pre-trade risk gates — US-047+
│   ├── PositionLimitGuard.ts      # max positions + single-stock + single-industry caps
│   ├── TrailingStopGuard.ts       # 追踪止损 — daily highest_price + next-day SELL trigger
│   ├── DrawdownCircuitBreaker.ts  # 组合级回撤熔断 — LEVEL_1/2/3 cascade + 24h pause
│   ├── MarketRegimeAlertService.ts # 市场级环境预警 — 指数 3 日/月度跌幅 + MA20/MA60 死叉
│   ├── PerStockStopLossGuard.ts   # 每股止损 — close vs avg_cost loss ≤ -7% + 50% mass alert
│   └── IndustryConcentrationGuard.ts # 行业集中度 — post-trade > 35% alert + 一键再平衡
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

## `risk/MarketRegimeAlertService` — US-050 specifics

The market-regime alert service introduces the **fourth risk-guard shape** —
**market-level signals** (indicator-driven, no user positions involved).
Where the prior three guards ran on user data (positions / portfolio peak),
this one runs purely on benchmark index bars and fans the resulting alerts
out to every user with a portfolio.

1. **`getMarketRegimeStatus(options)`** — read-only HTTP query.  Computes
   3-day cumulative return, 20-day cumulative return, MA20 today vs
   yesterday, MA60 today vs yesterday, and the death-cross flag in one
   pass.  Returns a `MarketRegimeStatus` snapshot with all fields plus the
   alerts that *would* fire (already-evaluated by `pickRegimeAlerts`).
   Used by the UI dashboard / 风控面板 for live display.  Does **not**
   write any RiskAlert row.
2. **`evaluateAfterOpen(options)`** — post-open cron.  Internally calls
   `getMarketRegimeStatus`, then fans the same alerts out as one RiskAlert
   per (user × alert) pair.  Sentinel symbol `SYSTEM:MARKET_REGIME_<TYPE>`
   matches US-042 / US-049 convention so the front-end can filter
   组合级/系统级 alerts apart from per-stock alerts.  `dry_run=true` skips
   the writes but still populates `per_user[*].alerts_written` for preview.
3. **`getConfig(user_id)` / `updateConfig(user_id, raw)`** — same shape as
   US-047/US-048/US-049 config CRUD; backed by `User.risk_config.market_regime`
   JSONB + `Object.freeze`'d `DEFAULT_MARKET_REGIME_ALERT_CONFIG`.

Patterns codified in US-050 that future market-level guards should follow:

- **Multiple parallel signals per evaluation** — unlike US-049's
  single-level cascade, market-regime emits 0..N alerts simultaneously
  (3-day drop AND 20-day drop AND death-cross can all hit at once). The
  rationale: 市场综合状态 inherently requires N independent signals; the
  user wants to see "what's broken" not just "the most severe thing
  broken". `pickRegimeAlerts` returns `RegimeAlert[]` not a single pick.
- **`SYSTEM:` sentinel symbol prefix** — re-uses US-042 / US-049 convention.
  Front-end filters `symbol.startsWith('SYSTEM:')` to bucket
  组合级/系统级 alerts away from per-stock alerts. The per-type discriminator
  (`SYSTEM:MARKET_REGIME_DROP_3D`, `…_DROP_20D`, `…_DEATH_CROSS`) lets the
  bell view collapse same-day repeats by SQL `DISTINCT symbol`.
- **`≤ -threshold_pct` for drop boundaries** mirrors US-049's `≥ +x` for
  upside / drawdown thresholds. Both include the boundary (defensive硬触发).
  When pct is the drop magnitude (positive number), compare the actual
  return to `-pct` and use `≤` — `return_pct <= -config.drop_3d_pct`.
  Never mix `Math.abs(return)` with `≥ pct` — boundary semantics differ
  by one tick and the test boundary cases break.
- **Strict `<` for MA death-cross** — yesterday `MA20 ≥ MA60` (inclusive
  baseline) + today `MA20 < MA60` (strict穿越). Loose `≤` would re-fire
  on every flat day where the two MAs equal then re-equal; the strict
  穿越 rule is what separates "death cross today" from "below for the
  last 30 days". Same shape as US-026 RSI 上穿 detection.
- **Insufficient data ≠ negative signal** — `closes.length < period`
  → MA returns `null`, return calculations return `null`; `pickRegimeAlerts`
  treats each `null` as "this signal can't be evaluated" and skips it
  silently. Same `data-shortage = safe HOLD` principle as US-048
  (DailyBar missing → skip) and US-026 (bar < period → no RSI signal).
- **`prior <= 0` defensive divisor guard** — `computeReturnPct(latest, prior)`
  returns `null` for `prior=0 / prior<0 / NaN`. The benchmark close shouldn't
  ever be ≤0 in practice, but a single corrupted bar shouldn't cascade-fire
  +∞% gain/loss across all 3 signals. Same `分母接近 0 跳过` pattern as
  US-032's `CONSENSUS_NEAR_ZERO_THRESHOLD`.
- **DataSource `loadBenchmarkBars` fail → `status.error` set but no throw**
  — same fail-open pattern as US-049's `checkBuyAllowed`. A risk-guard DB
  outage must NEVER crash the scheduler task or 502 the dashboard endpoint.
  Caller sees `error: 'fake bar load outage'` + `bar_count: 0` + empty
  `alerts: []` and decides whether to surface to the user (UI) or log+continue
  (cron).
- **`benchmark_name` lookup is separate from `loadBenchmarkBars`** — keeps
  the bar loader pure (one query) and lets the name fetch fail
  independently (falls back to the symbol). Future: if the index name
  becomes a config knob, the name source doesn't have to be a DB row.
- **`per_user` write isolation** — same as US-049: each user wrapped in
  try/catch so one user's permission or DB issue doesn't block the rest.
  `loadConfig` failure for user N → `per_user[N].error` set; other users
  fan-out continues.
- **`SchedulerService` single task type**: `PAPER_TRADING_MARKET_REGIME_CHECK`
  (post-open). Same `dry_run` / `user_id` / `lookback_days` parameter shape
  as US-049, so ops scripts and cron configs follow one parameter dialect.
- **HTTP surface**: 3 endpoints under `/api/risk/market-regime*` —
  `GET /api/risk/market-regime-status` (live snapshot, no writes),
  `GET /api/risk/market-regime` (read config),
  `PUT /api/risk/market-regime` (update config). `market-regime-status` is
  the AC-specified endpoint; the other two follow the US-047/048/049 config
  CRUD convention for consistency. **`market-regime-status` accepts
  optional `?as_of=YYYY-MM-DD&lookback_days=N` query params** for historical
  replay / debugging — invalid dates fall back to `now()` silently, never
  4xx (same lenient-normalize philosophy as `normalizeMarketRegimeAlertConfig`).

## `risk/PerStockStopLossGuard` — US-051 specifics

The per-stock stop-loss guard introduces the **fifth risk-guard shape** —
**per-position aggregated to portfolio-level**. Where TrailingStopGuard
watches `from peak drawdown` (保利润逃顶) per position, this guard watches
`from entry cost loss` (硬保本) per position. The two are complementary
and intentionally coexist: profitable positions ride the trailing stop,
freshly-opened positions rely on the cost-based stop.

1. **`evaluateAfterClose(user_id?, asOfDate?, dry_run?)`** — post-close cron.
   For each open position, computes `loss_ratio = (close - avg_cost) / avg_cost`
   and triggers if `loss_ratio ≤ -effective_pct` (default -7%). The
   **per-position triggers** are surfaced as `PerStockStopLossTrigger[]`
   AND written as `RiskAlert(level='HIGH', symbol=position.symbol)`.
   Additionally, if `triggered_count ≥ Math.ceil(open_count × mass_threshold_ratio)`
   (default 50%), a **portfolio-level "LEVEL_2" mass alert** fires via a
   single sentinel `RiskAlert(level='HIGH', symbol='SYSTEM:PER_STOCK_STOP_LOSS_MASS')`.
   The guard does NOT call `facade.placeOrder` — surfaces structured
   triggers + lets the caller (automation service / dashboard / human) decide
   execution timing. Same pattern as US-048 / US-049.
2. **`getConfig(user_id)` / `updateConfig(user_id, raw)`** — config CRUD
   backed by `User.risk_config.per_stock_stop_loss` JSONB +
   `Object.freeze`'d `DEFAULT_PER_STOCK_STOP_LOSS_CONFIG`. Same shape as
   US-047/US-048/US-049/US-050.

Patterns codified in US-051 that future per-position-aggregated guards
should follow:

- **`effective_pct` 三级覆盖 reuses US-048's `pickEffectivePct` shape** —
  `position.stop_loss_pct` (策略层覆盖) → `user.risk_config.per_stock_stop_loss.pct`
  (用户全局) → `DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct` (兜底 0.07).
  **Note**: the per-position column is currently `trailing_stop_pct` (alias-reused
  since per-stock stop-loss + trailing-stop pct share the same semantic field).
  Future升级: add a dedicated `stop_loss_pct` column when the two need
  independent values.
- **`Math.ceil(N × ratio)` for mass-trigger threshold** mirrors US-049's
  `pickLevel2TrimTargets` strong-disposal path. `1/2 = ceil(1) = 1 → mass`,
  `1/3 = ceil(1.5) = 2 → NOT mass`. **Boundary is "ratio inclusive"** —
  exactly 50% triggers count as mass. This matches the "硬触发用 ≤" convention.
- **Mass alert uses single `SYSTEM:` sentinel symbol** (matches US-049/US-050
  convention) — `SYSTEM:PER_STOCK_STOP_LOSS_MASS`. Front-end filters
  `symbol.startsWith('SYSTEM:')` to bucket 组合级/系统级 alerts away from
  per-stock alerts. Only ONE mass alert per user per evaluation (not N) so
  the bell doesn't flood when many users hit mass at the same moment.
- **3-tier per-user level: NONE / INDIVIDUAL / MASS** — same shape as US-049's
  `DrawdownLevel`. `NONE = no triggers`, `INDIVIDUAL = some triggers but
  below mass threshold`, `MASS = ≥ threshold ratio triggered`. Operators
  see one clear status per user.
- **`SchedulerService` single task type**: `PAPER_TRADING_PER_STOCK_STOP_LOSS_CHECK`
  (post-close). Same `dry_run` / `user_id` parameter shape as US-049/US-050.
- **`facade.applyAutomation` action `per_stock_stop_loss_check`** —
  controllers can trigger evaluation through the facade (preserves the
  7-method invariant + reuses the existing automation routing). Body
  options: `{dry_run?: boolean, as_of?: 'YYYY-MM-DD', scope?: 'self'|'all'}`.
- **HTTP surface**: 2 endpoints under `/api/risk/per-stock-stop-loss` —
  `GET` (read config), `PUT` (update config). Same namespace as US-047/048/049/050.
- **Boundary `≤ -pct` for triggers** mirrors US-048 / US-049 protective硬触发
  semantics. **Defense-side guards use `≤`** (catch the boundary);
  **limit-side guards use `>`** (PositionLimitGuard's strict inequality).
  Always pick boundary direction by guard semantic intent before writing
  comparison.
- **`avg_cost ≤ 0` → `skipped_bad_cost`** (defensive divide-by-zero guard) —
  same pattern as US-049's `computeGainRatio` cost_basis check. Bad data
  shouldn't cascade-fire bogus triggers.
- **`DailyBar` missing → `skipped_no_bar`** (data-shortage = safe HOLD) —
  do NOT fall back to `current_price` (facade SELL mutates it, fallback
  causes drift / false triggers). Matches US-048 trailing-stop and US-026
  RSI bar-shortage guards.

## `risk/IndustryConcentrationGuard` — US-052 specifics

The industry-concentration guard introduces the **sixth risk-guard shape** —
**portfolio-level industry aggregation + forced rebalance endpoint**. Where
PositionLimitGuard (US-047) blocks NEW orders pre-trade from pushing an
industry past its 30% cap, this guard watches the *post-trade* drift caused
by holding-period price changes (an industry's pct grows as those positions
rally even without new orders) and surfaces alerts + a one-click rebalance.

The two industry-related guards are intentionally complementary, not
redundant:

  - **US-047 — pre-trade single-industry cap = 30%** (strict `>` boundary,
    blocks the *new* BUY that would push the sum past 30%).
  - **US-052 — post-trade industry alert = 35%** (strict `>` boundary,
    fires MEDIUM RiskAlert when held positions drift past 35%).

The 5% buffer (35% > 30%) is deliberate: the pre-trade cap leaves the
post-trade alert with breathing room so a normal day's price action
doesn't immediately re-fire the alert after the user just rebalanced.

1. **`evaluateAfterClose(user_id?, dry_run?)`** — post-close cron.  For
   each user, aggregates positions by industry (cash NOT included — pct
   is "industry share of held positions" not "industry share of total
   account"), then emits one `RiskAlert(level='MEDIUM', symbol='SYSTEM:
   INDUSTRY_CONCENTRATION:<industry>')` per industry exceeding `alert_pct`
   (default 35%). Multiple industries may trigger simultaneously (parallel
   signals, NOT cascade — same shape as US-050 multi-signal regime).
   Unclassified positions (Stock.industry null/empty) aggregate under a
   sentinel `__UNKNOWN__` bucket — message renders as "未分类" to user.
2. **`rebalanceIndustry(user_id, options?)`** — one-click rebalance
   endpoint (POST /api/portfolio/rebalance-industry).  Finds the worst
   over-alert industry, sorts its positions by `gain_pct DESC` (sell
   highest-gainers first → realize profit while reducing concentration),
   simulates per-position sells until projected industry pct < 30% or
   `rebalance_max_sell_count` (default 2) is reached.  `dry_run=true`
   returns the plan without calling facade.closePosition; `dry_run=false`
   actually closes positions via the facade (preserves the 7-method
   invariant + chains through DrawdownCircuitBreaker / other pre-trade
   guards). Sell failures (停牌 / cash error) record `status='failed'`
   and continue with the next planned position (fail-OPEN — partial
   results returned for human follow-up).
3. **`getConfig(user_id)` / `updateConfig(user_id, raw)`** — config CRUD
   backed by `User.risk_config.industry_concentration` JSONB +
   `Object.freeze`'d `DEFAULT_INDUSTRY_CONCENTRATION_CONFIG`. Same shape
   as US-047/US-048/US-049/US-050/US-051.

Patterns codified in US-052 that future portfolio-level aggregation guards
should follow:

- **Total denominator EXCLUDES cash** — `pct = industry_value / sum(all
  industry market values)`, not `industry_value / portfolio.total_value`.
  Rationale: cash can be redeployed to any industry instantly, so a user
  with 50% cash + 1 stock cares that "100% of my deployed capital is in
  one industry" (which the cash-exclusive ratio correctly surfaces) and
  not that "I'm 50% in that industry by total account" (which would
  under-represent the concentration risk). Future US-053 black-swan /
  US-086 portfolio rebalancing also follow this rule.
- **Multi-alert parallel signals** (NOT cascade) — like US-050 market
  regime. An industry can be in multiple alert states simultaneously
  (50% A AND 36% B both > 35%); both produce independent RiskAlert rows
  so the user sees the full picture rather than "the worst one this run".
- **Sentinel bucket for unclassified data** (`__UNKNOWN__`) — never
  silently merge unclassified positions into a real industry (would
  hide the data quality issue + corrupt the alert math). Surface as
  its own bucket; render as "未分类" in messages so the user knows to
  go fix the missing Stock.industry classifications upstream.
- **Strict `>` for alerts, strict `<` for rebalance target** — alert at
  35% strict means exactly 35% doesn't fire; rebalance to "< 30% strict"
  means we sell until the projected pct is strictly below 30%, not just
  ≤ 30% (would let the very next day's tiny price tick fire the alert
  again). The 5% gap between thresholds is the buffer; the strict-vs-strict
  boundary keeps the buffer intact.
- **Sort by `gain_pct DESC` + `symbol ASC` stable tie-break** in
  rebalance plan — sell the highest-gainers first to harvest profits
  AND reduce industry exposure in one move. The stable secondary key is
  the same V8-sort-isn't-stable defense codified by US-025 / US-049.
- **Plan cap at `max_sell_count=2`** even when target unreached — AC
  says "1-2 只". If 2 sales still don't get the industry < 30%, return
  `partial=true` for human follow-up rather than aggressively clearing
  more of the industry (small accounts could have an industry entirely
  liquidated by the algorithm, which is rarely the user's intent —
  human inspection makes the right call there).
- **Rebalance goes through `facade.closePosition`** — keeps the 7-method
  invariant intact + means the SELL still flows through pre-trade guards
  (e.g. DrawdownCircuitBreaker — though SELL is never blocked there).
  The DataSource exposes `executeFullClose` which lazy-imports the
  facade to avoid circular import (facade → guard → facade).
- **`dry_run=true` returns plan without execution** — supports UI "preview
  what would happen" pattern. Each plan entry includes the projected
  industry pct after that sell, so the dashboard can show "after 2
  sells you'd be at 33%".
- **Single user / fail-OPEN policy** — `rebalanceIndustry` per-symbol sell
  failures don't abort the rest of the plan (status='failed' + continue);
  `evaluateAfterClose` per-user errors don't abort the batch (try/catch
  isolation, same as US-047/048/049/050/051).
- **HTTP surfaces**:
  - `POST /api/portfolio/rebalance-industry` (AC-specified) — one-click
    rebalance, body `{portfolio_id?: number, dry_run?: boolean}`. Routed
    in `portfolio.routes.ts` and MUST be registered BEFORE the `/:id`
    catchall (US-015 ordering rule — otherwise Express matches
    "rebalance-industry" as the `:id` param).
  - `GET /api/risk/industry-concentration` (config read).
  - `PUT /api/risk/industry-concentration` (config write).

## `risk/BlackSwanWatchdog` — US-053 specifics

US-053 introduces the **7th risk guard** and first **event-driven** one:
the prior 6 (US-047..US-052) all consume *user-owned* data (positions /
portfolio / market index). **BlackSwanWatchdog consumes external event
sources** (AKShare ST list / 停牌 list / 个股新闻) and intersects them
with user holdings.

Three event types, all logged to `RiskAlert(level='HIGH')` + notified
via the `notify(payload)` DataSource hook (current stub logs only; the
real feishu / email / wechat routing lands with US-080):

  - **`ST`** — A-share 风险警示板 (`stock_zh_a_st_em`); persists as
    long as the stock is on the ST list (signature = `ST::<code>`).
  - **`SUSPENDED`** — A-share 停牌列表 (`stock_zh_a_stop_em`); persists
    as long as the stock is suspended (signature = `SUSPENDED::<code>`).
  - **`NEWS_KEYWORD`** — `stock_news_em(symbol)` per-stock news scan
    intersected with default keywords `[立案, 退市, 重大违规, 处罚, 问询函]`;
    signature includes title hash so distinct articles with the same
    keyword can each fire.

Patterns codified in US-053 that future event-driven guards (US-067 KOL
opinion alerts, US-068 sentiment shock detector, ...) should follow:

- **AC endpoint substitution — `stock_news_main_cx_em` ≠ `stock_news_em`**:
  AC text references `stock_news_main_cx_em` (which does NOT exist in
  AKShare — the closest `stock_news_main_cx` is a portal-wide weekly
  digest, NOT per-stock). The correct per-stock endpoint is
  `stock_news_em(symbol=6-digit)`. **4-place doc sync (US-034 / US-035
  范式)**: Python helper docstring / TS Client jsdoc / BlackSwanWatchdog
  jsdoc / (BlackSwanEvent model column comment when added). Future
  event-driven guards facing the same "AC names an endpoint that
  doesn't exist" trap follow the same substitution + 4-place pattern.
- **Shared market snapshot fetched ONCE per cron run** — ST list and
  suspended list don't differ per user, so `evaluateAfterOpen` fetches
  each exactly once and threads the resulting `Map<code, Row>` into
  every user's evaluation. Tests assert `stFetchCalls === 1` and
  `suspendedFetchCalls === 1` regardless of user count.
- **Per-stock news fetch is per-user-position** — news IS per-symbol
  so the AKShare cost is `O(unique positions across all users)`. The
  `news_per_stock_limit` (default 50) caps individual fetches, but
  guard does NOT (yet) deduplicate news fetches across users that
  hold the same stock — first optimization opportunity when this grows.
- **LRU dedup buffer in `User.risk_config.black_swan_seen` (200 entries)**:
  Signatures persist across cron runs to suppress repeat alerts for
  ongoing events (a stock that stays ST for 6 months fires alert ONCE,
  not 180 times). When a stock leaves the ST list and re-enters later
  (the signature ages out via LRU + repeated re-evaluations of other
  events), the alert fires again. Same JSONB column as other guards;
  `user.changed('risk_config', true)` mandatory (US-017 lesson).
- **Event priority chain — first hit wins per position** — within one
  position, ST > SUSPENDED > NEWS_KEYWORD. The thinking is that a
  single position should produce ONE bell-style alert per scan run, not
  3. If the user wants to act on the news independently of the ST, the
  audit trail (`detail` field on the trigger) still records all the
  evidence.
- **fail-OPEN on data source failure** — if `fetchSTList()` throws,
  the production `DefaultBlackSwanDataSource` catches + returns `[]`
  (logged as warn) so the daily cron continues. Suspended check and
  news check are independent: ST fetch failure doesn't skip them.
- **News recency window `≤ 24h`** — old news doesn't repeatedly trigger
  alerts when a stock's news feed is sparse. The `news_lookback_hours`
  is configurable per user; default 24h.
- **Case-insensitive keyword matching with `String.includes()`** — A-share
  news is predominantly Chinese, but English fragments (e.g. SEC notices,
  delisting risk announcements) occasionally appear. Normalize both sides
  to lowercase before substring matching.
- **`dry_run=true` returns triggers without writing alerts** — supports
  UI preview pattern (same as US-048 trailing stop + US-052 industry
  rebalance). Seen-sig persistence is also skipped in dry_run so a
  preview doesn't accidentally suppress the real alert later.
- **Per-user try/catch isolation** — single user's portfolio load failure
  doesn't abort the batch (same as US-047/048/049/051/052). The failed
  user's result has `error: <message>` set; downstream consumers can
  filter and retry that user later.
- **HTTP surfaces**:
  - `GET /api/risk/black-swan` (config read).
  - `PUT /api/risk/black-swan` (config write).
  - No POST-style trigger endpoint (yet) — the cron is the entry point;
    when US-067 / US-068 add manual "re-scan now" buttons, this guard
    should follow the same `POST /api/risk/black-swan/scan` shape.

## `risk/MorningRiskCheckupService` — US-054 specifics

US-054 introduces the **8th risk-management form** and first **snapshot
form** — distinct from the prior 7 *trigger-style* guards (US-047..US-053
all produce `RiskAlert` rows when "something bad happened"). MorningRiskCheckup
runs *every morning 8:30* (cron) and **folds the current portfolio panorama
into a single readable markdown line** for the user to consume *before the
open*. It is **not a new alert** — it is a daily aggregation of *existing*
risk alerts + positional exposure + drawdown that ships to feishu / email
via US-080 NotificationService.

Six dimensions per AC, persisted to `morning_risk_checkups` (`(user_id, date)`
UNIQUE — UPSERT semantics):

  1. **`positions_count`** — open positions (quantity > 0).
  2. **`max_single_pct`** + `max_single_symbol` — biggest single-stock
     weight = `market_value / sum(market_values)` (same denominator as
     US-052 IndustryConcentrationGuard — cash excluded).
  3. **`max_industry_pct`** + `max_industry_name` — biggest industry
     weight, via `aggregateByIndustry` imported from US-052 (same bucket
     map + `UNKNOWN_INDUSTRY_SENTINEL` for unclassified positions).
  4. **`drawdown_pct`** + `peak_value` — current drawdown vs historical
     peak, via `computePeakValue` + `computeDrawdownPct` imported from
     US-049 (`peak = max(snapshots, current_total_value)`).
  5. **`weekly_return_pct`** — `(current - baseline) / baseline` where
     `baseline = most recent snapshot.date ≤ (asOf - 7 days)`. Null when
     snapshot history < 7 days (new account / IPO < 1 week).
  6. **`unresolved_alerts_count`** — `RiskAlert.count({user_id, is_read=false})`.

Patterns codified in US-054 that future *snapshot-style* services (US-082
weekly recap, US-091 monthly review, ...) should follow:

- **Cross-service helper reuse → number alignment guarantee**: by directly
  importing `aggregateByIndustry` (US-052) and `computePeakValue` /
  `computeDrawdownPct` (US-049), the MorningRiskCheckup's industry pct and
  drawdown pct are **guaranteed identical** to what users see in the
  IndustryConcentrationGuard alert + DrawdownCircuitBreaker alert. Avoids
  the cardinal "three places say three different numbers" UX failure.
  **Rule**: when a snapshot service needs a number that already exists in
  a trigger guard, *import the pure helper* — do NOT re-implement the
  formula even when the math is trivial.
- **Snapshot vs trigger form decision tree**:
  - *Trigger form* (RiskAlert) → user needs to know *just happened* / *requires
    action* (止损 / 减仓 / 拒单);
  - *Snapshot form* (MorningRiskCheckup) → user needs to know *current state*
    (健康度仪表盘 / 开盘前体检 / 周报). No "act now" implied.
  - Both forms coexist. A drawdown of 12% writes both a DrawdownCircuitBreaker
    `LEVEL_1` RiskAlert *and* appears as `drawdown_pct=0.12` in the
    morning checkup row. Different ingestion timing → different UX layers.
- **`null` for "数据不足" not 0**: `max_single_pct` / `max_industry_pct` /
  `drawdown_pct` (when `peak_value ≤ 0`) / `weekly_return_pct` (when snapshot
  history < lookback days) all return **null** rather than 0. The reason: a
  brand-new account legitimately has 0 drawdown — but rendering "0%" suggests
  "perfectly healthy"; rendering "—" tells the user "not enough data, don't
  trust this column yet." Snapshot UIs render null differently from 0.
  Same range applies to weekly_return: a stable account with 0 change
  legitimately reads 0%, but a *new* account with no baseline should read
  "—" to avoid implying "no movement" when really there is "no history".
- **fail-OPEN on persistence failure**: `upsertCheckup` throws → in-memory
  `MorningRiskCheckupResult` still returned with `error: <msg>` + `persisted:
  false`. Same fail-OPEN philosophy as US-052 writeAlert: never let a DB
  outage hide the calculation from caller (UI dashboard / preview consumer).
- **UPSERT semantics on `(user_id, date)`**: same user same day always
  overwrites (admin re-runs the morning task / ops re-scans). `dispatch_status`
  is NOT touched on update — US-080 owns its lifecycle, so a sent-and-then-
  re-computed row stays `'sent'` (the user already saw the morning report;
  the re-compute is silent).
- **`dispatch_status` three-state**: `'pending'` (calculated, awaiting US-080
  push) / `'sent'` (US-080 successfully pushed) / `'failed'` (US-080 tried but
  failed). MorningRiskCheckupService **never** pushes — it only writes
  `'pending'` on insert. **Decoupling compute from delivery** so US-080's
  channel logic (feishu rate limits / email retries / wechat) is independent
  of the calc pipeline.
- **`dry_run=true` returns full result without persisting** — supports UI
  preview pattern (same as US-048 / US-052 / US-053). `persisted=false` in
  dry_run; `result.checked_users` still increments (caller wants to know how
  many users *would have been* checked).
- **`Promise.all` for per-user fan-out within `checkupOneUser`**: positions /
  snapshots / unresolved-alerts are independent queries — parallelism saves
  ~70ms per user. Compare to US-049/US-052 which is one big `loadOpenPositions`
  call (positions only, no parallel ops).
- **Top-N breakdown in JSONB**: `breakdown.top_positions` (top 3 by mv pct) +
  `breakdown.top_industries` (top 3 by aggregated pct) materialize for UI
  charts without re-fetching all positions. The render budget for the morning
  push is ~10 lines of text — top 3 each fits comfortably.
- **HTTP route order rule** (US-015 lesson reinforced): `GET /morning-checkup/today`
  must be registered **before** `GET /morning-checkup` (the bare config GET) —
  Express matches top-down, so the more-specific path goes first. The base
  config route would NOT have caught `/today` (no param), but adding a
  `:date` route later would silently shadow `/today` if not careful. The
  jsdoc on the route file says so explicitly.
- **No SchedulerService hook in US-054** (matches US-052/US-053 batch — the
  task type registration is deferred until US-080 NotificationService lands,
  at which point cron + push are wired together). Production deployment of
  US-054 thus requires either US-080 *or* a manual ops cron task with `type =
  'PAPER_TRADING_MORNING_CHECKUP'` calling `morningRiskCheckupService.runMorningCheckup()`.
- **HTTP surfaces**:
  - `GET /api/risk/morning-checkup/today` — UI fetches today's row (or latest
    fallback) for the "今日体检" dashboard widget.
  - `GET /api/risk/morning-checkup` (config read).
  - `PUT /api/risk/morning-checkup` (config write).

---

## risk/ — RiskAlert.rule_id 写入约定 (US-067 引入)

`RiskAlert.rule_id` 由 US-067 新增。**所有 guard `DefaultXxxDataSource.writeAlert()`
都必须显式 set `rule_id`**（不传 = `null` 让 dispatcher dedup 退化为 `unknown::symbol::level`，
不同 rule 的 HIGH 告警在 30 min 窗口内互相 dedup —— 等于"任何一类 HIGH 告警 30 分钟
内只推一次"，严重违反 AC 的"同一类告警 30 分钟内只推一次"语义）。

已落实的 rule_id 命名（保持稳定，前端 / 告警归类 / ops 监控直接依赖此 enum）：

| Guard                              | rule_id                  |
|-----------------------------------|---------------------------|
| PositionLimitGuard (US-047)       | `position_limit`         |
| TrailingStopGuard (US-048)        | `trailing_stop`          |
| DrawdownCircuitBreaker (US-049)   | `drawdown_breaker`       |
| MarketRegimeAlertService (US-050) | `market_regime_alert`    |
| PerStockStopLossGuard (US-051)    | `per_stock_stop_loss`    |
| IndustryConcentrationGuard (US-052)| `industry_concentration`|
| BlackSwanWatchdog (US-053)        | `black_swan`             |
| FactorCorrelationReport (US-042)  | `factor_correlation`     |

新 guard / 新事后分析告警写入 `RiskAlert.create()` 必带 `rule_id`，命名遵循
`snake_case`、与 guard 文件名简写一致。同 guard 内部多种告警子类型（如
DrawdownCircuitBreaker 的 LEVEL_1/2/3）共享一个 rule_id（因为它们语义上属于同
一类"组合回撤"告警，dedup 30 min 是合理的——LEVEL_2 比 LEVEL_1 更严重时仍会
覆写同 signature 的 dedup 记录）。**不要**为每个 sub-level 拆 rule_id —— 那样会
让 LEVEL_1 / 2 / 3 在 30 min 内同时推 3 条飞书卡片（用户体验灾难）。

## risk/ — RealtimeAlertDispatcher hook (US-067)

`RiskAlert` model 的 `@AfterCreate` hook (`dispatchRealtimeAlert`) **自动**对
`level='HIGH'` 行 fire-and-forget 调 `realtimeAlertDispatcher.dispatch(...)`。
所以 guards 只管写 `RiskAlert` —— 不需要再显式调 dispatcher（避免双重推送）。

设计要点：
- **hook 顶层 try/catch 吞错**：`RiskAlert.create()` 主流程绝不被推送错误阻塞
  （否则 webhook 故障 = guards 写入失败 = 业务流程崩）。
- **lazy-require dispatcher**：避免 RiskAlert model 反向依赖 services 层。
- **level !== 'HIGH' 直接 skip**：MEDIUM/LOW 不推（保留给未来 cron 聚合 US 扩展）。
- **fire-and-forget**：不 await，主流程 0 增加延迟。

## `RebalanceEngine.ts` — US-086 specifics

US-086 introduces the **2nd rebalance surface** living at the portfolio top
level (next to `PortfolioReturnSimulator.ts`). It is **complementary, NOT
overlapping**, with US-052 `IndustryConcentrationGuard.rebalanceIndustry`:

|                       | US-052 行业级一键再平衡            | US-086 通用目标权重再平衡         |
|----------------------|-----------------------------------|-----------------------------------|
| 触发方式             | 系统自动应急（cron / 一键按钮）   | 用户/策略调仓                     |
| 输入                 | 无（自动找超 35% 行业）           | `Map<stock_code, weight>` (完整) |
| 操作范围             | 仅超标行业内 1-2 只               | 全 portfolio (target ∪ held)     |
| 默认执行             | `dry_run=false`（应急直接卖）     | `dryRun=true`（要求 review 后下单）|
| Lives at             | `risk/IndustryConcentrationGuard` | `RebalanceEngine.ts`             |
| HTTP endpoint        | POST /api/portfolio/rebalance-industry | (待 controller 故事接入) |

Both rebalance surfaces share these invariants:
- Execute leg **always** goes through `paperTradingFacade.placeOrder` /
  `.closePosition` (preserves 7-method facade invariant + chains pre-trade
  guards: PositionLimit / DrawdownCircuitBreaker).
- DataSource interface injection for tests (PRODUCTION singleton + fake for
  unit tests with zero DB).
- Pure-function helpers all exported for surface unit-testing.
- 失败隔离：per-symbol execute throws → `status='failed'` + continue
  (matches US-052 close-failure pattern).

`RebalanceEngine` design choices specific to "通用" 模式:

1. **dry_run 默认 true** — 用户/策略调仓 可能影响多只股票，强制 caller 显式
   `execute=true` 才下单。与 US-052 反向（系统应急默认执行）。
2. **`targetWeights.size === 0` 语义 = 全清仓**（与 US-083 set-membership
   default-deny 同款）。caller 想"不动" → 传 dryRun=true 而非空 Map。
   jsdoc 顶部 + 单测必须显式覆盖此反差。
3. **`minTradePct` 默认 0.5%** — 低于该偏差 → HOLD，避免无意义微调换手。
   严格 `<` 边界（< minTradePct → HOLD，== minTradePct → 仍 trade，与
   US-082 "合格线用严格 <" 同款）。
4. **100 股最小交易单位**硬编码 `MIN_TRADE_LOT_SIZE = 100`；未来支持北交所
   （5 股 / 10 股阶梯）时再扩 lot_size 参数。BUY 用 floor（防 cash 超支），
   SELL 用 ceil 上限 held quantity（避免 tail 卡 < 100 股的零碎持仓）。
5. **执行排序 SELL → BUY → HOLD** — 撮合层先卖出释放 cash，再 BUY，避免
   "BUY 时 cash 不够 → 拒单 → 漏调仓"的链式失败。
6. **`execute: true` 是 `dryRun: false` 的 convenience alias** —— caller
   显式表达"真的下单"的语义比 `dryRun: false` 在 API site 更易读。execute
   优先级高于 dryRun 字段；两者都不传 = dryRun=true 默认安全。
7. **lazy-require facade 解循环 import** — `executeOrder` 内
   `require('./PaperTradingFacade')` 而非顶层 `import`，因 facade.ts 会
   import 大量 internal/ 服务。同 US-052 `IndustryConcentrationGuard.
   executeFullClose` 同款；下次任何 portfolio/ 子模块走 facade 都按此
   pattern + `// eslint-disable-next-line @typescript-eslint/no-var-requires`
   显式标注（避免被未来 reviewer 当 lint warning 清掉）。

7 个 export 纯函数:
- `normalizeRebalanceOptions(input)` — partial → 完整 options + garbage 容错；
- `normalizeTargetWeights(input)` — Map / Record 兼容输入 + 负数 / NaN 抛错；
- `quantizeBuyQuantity(value, price)` — floor 100 shares；
- `quantizeSellQuantity(value, price, held)` — ceil 上限 held；
- `classifyOrderSide(diff, pct, minPct)` — BUY / SELL / HOLD 判定；
- `sortRebalanceOrders(orders)` — SELL → BUY → HOLD + 稳定 tie-break；
- `computeTradePlan(input)` — 纯函数核心。

HTTP / facade integration: 目前 RebalanceEngine **不直接绑定 HTTP route**
（与 US-052 不同）—— 设计为可被 (a) controller endpoint 直接调用（未来故事
落地）、(b) 策略层 `generateSignals` 输出直接调用、(c) PortfolioOptimizer
事后分析结果落地调用 这 3 种 caller 共享。caller 决定是否 audit log + 是否
推送（webhook / 飞书），引擎只负责"算 + 下单"。

### Engine 类的命名约定 (US-086 引入)

portfolio/ 目录新增"engine"类模块的命名 / 放置规则：
- **顶层放置**：非 facade、非 risk-guard、非 internal 的"算 + 下单"型
  模块（RebalanceEngine / 未来 TaxLossHarvestEngine / DriftRebalanceEngine）
  放在 portfolio/ 顶层（与 PortfolioReturnSimulator.ts 并列），不要塞进 risk/
  或 internal/。
- **risk/ 限定**：pre-trade / post-trade guards（阻止订单 / 监控持仓 / 写
  RiskAlert）。
- **internal/ 限定**：facade 私有实现（不能被外部 controller 直接 import）。
