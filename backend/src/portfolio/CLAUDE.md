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
│   └── PositionLimitGuard.ts      # max positions + single-stock + single-industry caps
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
