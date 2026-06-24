# Quant Workflow Readiness

This page documents the phase 1-3 implementation surface for turning the
platform into a simpler and more professional quant workflow.

This implementation is a stateless self-assessment layer. It does not pull
fresh data from the database, launch backtests, place paper/live orders, or
unlock canary trading automatically. The response labels are advisory signals
for the operator UI.

## API Surface

- `GET /api/quant/workflow-presets`
  - Returns beginner-friendly simple-mode strategy presets.
  - Each preset declares strategy key, data requirements, default backtest
    settings, paper-trading limits, and required hypothesis fields.

- `POST /api/quant/workflow-readiness/evaluate`
  - Evaluates one strategy workflow against phase 1-3 gates.
  - Request body accepts `strategy`, `data`, `backtest`, and `paper` snapshots.
  - Response includes `stages[]` and a top-level `verdict`.

## Phase Mapping

### Phase 1: Simple Usable Loop

The system checks whether the user has enough to run a reliable first backtest:

- simple strategy preset selected
- daily bar coverage meets the preset threshold
- factor coverage is usable
- latest trade date is present
- stale symbol count is controlled
- benchmark data is ready
- corporate action adjustment is known

If this phase is blocked, the UI should not encourage new backtests.

### Phase 2: Research Credibility

The system checks whether the strategy has enough research discipline to enter
paper trading:

- falsifiable alpha thesis
- target universe
- expected holding period
- invalidation rule
- risk notes
- sufficient backtest trading days and trade count
- benchmark-relative result
- drawdown control
- validation split
- walk-forward verdict
- overfit score
- point-in-time data readiness

If this phase is blocked, exploratory backtests can continue, but paper trading
should stay disabled.

### Phase 3: Paper-Trading Acceptance

The system checks whether paper trading has enough evidence for a canary-style
promotion decision:

- enough paper-trading days
- enough completed trades
- win rate and profit/loss ratio are acceptable
- paper drawdown is controlled
- average slippage is controlled
- backtest-to-paper consistency is present
- no hard risk-guard breaches
- manual overrides are limited

Only `stage_3.status === "ready"` opens
`verdict.can_promote_paper_to_canary`.

## Contract Notes

- All API fields use `snake_case`.
- Missing numeric fields are treated as blocked, never as passing values.
- `verdict.can_promote_paper_to_canary` is an advisory flag; it does not change
  live-trading or paper-trading permissions by itself.
- Backtests created before PR-13 may have `backtest_results.daily_returns`
  stored as percent values instead of decimal returns. Their detail-page
  daily-return chart can therefore show 100x values after the unit fix. Re-run
  those backtests to regenerate normalized daily-return series.
- Historical architecture debt is tracked separately in
  `scripts/ci/architecture-baseline.json`; new workflow readiness code should
  not add new cycles or live-trading layer violations.
