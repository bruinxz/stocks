# Quant subsystem — facade rules

After US-004 the `backend/src/quant/` tree is layered into **4 directories** with
a **single public facade class per layer** (5 total) plus an internal
implementation under each `internal/` folder.

```
quant/
├── engine/                      ← strategy + signal generation
│   ├── StrategyEngine.ts        (public, default singleton: strategyEngine)
│   ├── SignalEngine.ts          (public, default singleton: signalEngine)
│   ├── QuantMath.ts             (internal helpers, imported by strategies/)
│   ├── StrategyRegistry.ts      (internal, imported by strategies/)
│   └── internal/                ← 8 services, NOT imported by controllers
│       ├── QuantDataService.ts
│       ├── QuantStrategyService.ts
│       ├── QuantSignalService.ts
│       ├── QuantFusionService.ts
│       ├── QuantFusionAuditService.ts
│       ├── QuantStrategyFeedbackService.ts
│       ├── QuantStrategyExperimentService.ts
│       └── QuantStrategyParamVersionService.ts
├── backtest/                    ← async backtest task execution
│   ├── BacktestEngine.ts        (public, default singleton: backtestEngine)
│   └── internal/
│       ├── QuantBacktestService.ts
│       └── QuantBacktestEngine.ts
├── performance/                 ← dashboards + indicator catalog
│   ├── PerformanceReporter.ts   (public, default singleton: performanceReporter)
│   └── internal/
│       └── QuantPerformanceDashboardService.ts
├── health/                      ← data freshness, runtime health, open watchdog
│   ├── QuantHealthMonitor.ts    (public, default singleton: quantHealthMonitor)
│   └── internal/
│       ├── QuantDataFreshnessService.ts
│       ├── QuantRuntimeHealthService.ts
│       └── QuantOpenWatchdogService.ts
├── strategies/                  ← pure strategy implementations
└── types/                       ← shared TypeScript types
```

## Rules

### 1. Controllers MUST import only the 5 facades

```ts
// ✅ Good
import { strategyEngine } from '../../quant/engine/StrategyEngine';
import { signalEngine } from '../../quant/engine/SignalEngine';
import { backtestEngine } from '../../quant/backtest/BacktestEngine';
import { performanceReporter } from '../../quant/performance/PerformanceReporter';
import { quantHealthMonitor } from '../../quant/health/QuantHealthMonitor';

// ❌ Bad — controllers must NOT reach into internal/
import { quantSignalService } from '../../quant/engine/internal/QuantSignalService';
```

### 2. Non-controller code MAY still import from internal/

Schedulers, jobs, scripts, and sibling services (e.g. `SchedulerService`,
`StrategyResearchCenterService`, `quantBacktestWorker`) still import from
`internal/` because they need fine-grained methods that aren't part of the
public surface. Only the **controller boundary** is enforced.

### 3. Don't add a 6th facade class

If you need new behaviour, add a method to one of the 5 existing facades
(`strategyEngine.refreshSomething`, `signalEngine.generateXyz`, etc.). The
acceptance criteria for US-004 explicitly mandates 5 classes — splitting
further dilutes the layering. If a method genuinely belongs to a new domain
(e.g. "AlphaFactorEngine"), open a follow-up US first.

### 4. Cross-layer sibling imports go through `../../<layer>/internal/...`

Services inside one layer's `internal/` MAY reach into another layer's
`internal/` (this is unavoidable — e.g. `engine/internal/QuantFusionService`
needs `quantRuntimeHealthService` from `health/internal/`). Keep these imports
explicit and minimize them; if they grow numerous, hoist the shared logic into
a third layer.

### 5. `QuantMath.ts` and `StrategyRegistry.ts` stay at `engine/` top level

These are imported by every strategy under `strategies/`. Moving them under
`internal/` would force the strategies (which are NOT part of the facade
surface) to reach into `internal/`, which is fine in principle but creates
churn. They are effectively a third layer of shared primitives.

### 6. Each facade re-uses upstream singletons

Each facade class imports the existing `xxxService` singleton from `internal/`.
There is no DI rewiring. Tests that target the facade automatically exercise
the same upstream singletons that ran in production.

## Public method index (one place to look)

### `strategyEngine` (engine/StrategyEngine.ts)
Registry: `listStrategies`, `updateStrategyConfig`, `resolveStrategyKeys`,
`getDefaultParamsByStrategy`.
Experiments: `listExperiments`, `getExperimentParamSuggestions`.
Param versions: `listParamVersions`, `getActiveScanParams`,
`refreshParamVersions`, `refreshParamValidations`, `refreshParamLifecycle`,
`upsertGridSearchCandidates`.
Fusion/weights: `refreshWeights`, `listWeights`, `getAllocationPolicy`,
`runDailyPipeline`.

### `signalEngine` (engine/SignalEngine.ts)
`generate`, `list`, `getRankingDashboard`, `listAudits`,
`getFusionRankingDashboard`, `getRankings`.

### `backtestEngine` (backtest/BacktestEngine.ts)
`create`, `createWalkForward`, `createParameterGrid`, `summarizeParameterGrid`,
`list`, `get`, `retry`, `processTask`, `markTaskFailed`.

### `performanceReporter` (performance/PerformanceReporter.ts)
`getIndicatorCatalog`, `getDashboard`.

### `quantHealthMonitor` (health/QuantHealthMonitor.ts)
`getDataFreshness`, `getRuntimeHealth`, `getOpenWatchdog`.

## US-014: AShareConstraintEngine — A-share execution constraints

`backend/src/quant/backtest/AShareConstraintEngine.ts` is a **pure module** (no
state, no DB, no side-effects) that owns all A-share execution rules:

- **`evaluateOrder(ctx)`** — single entry for "can this fill?" decisions:
  T+1, 涨跌停, 停牌, ST 过滤, 流动性门槛. Returns `{ok, reason?, detail?}`;
  `reason` is from the `RejectionReason` enum so downstream aggregations
  (`block_reasons` counter, `RejectedOrder.reason` field, UI charts) all share
  one vocabulary.
- **`computeFees(amount, side)`** — A-share trading-cost model:
  commission 万 2.5 (min 5 元) **双边**, stamp tax 千 1 **仅卖出**, transfer fee
  万 0.1 **双边**. The 过户费 (transfer_fee) is the one most third-party回测
  漏算的项 — keep it always-on by default.
- **`executionPrice(bar, side, timing)`** — three execution-price models:
  `'next_open'` (default; bar.open + 滑点), `'same_close'` (bar.close + 滑点),
  `'twap_proxy'` ((open+high+low+close)/4 + 滑点 — proxy for VWAP, suits
  short-term/龙头 strategies). Dynamic slippage scales 滑点 by turnover
  buckets.

### Why a separate module instead of inlining into `QuantBacktestEngine`?

`QuantBacktestEngine` should be a撮合 dispatcher — it loops through dates,
positions, candidates. Encoding A-share rules inline was making 685 LOC out
of which ~300 were rule logic mixed with cash/position bookkeeping. Pulling
the rules out:

1. Makes the engine readable: 撮合 vs 规则 are visually separated.
2. Makes the rules **testable in isolation** without spinning up bars +
   contexts + strategies.
3. Lets future strategy-level code (e.g. live trading guard) reuse the same
   "can this order fill?" decision rather than reimplementing it.
4. Lets us add a 4th execution timing or new rejection reason in **one** file.

### When extending — design constraints

- **Never** add state (instance fields that change after construction). The
  engine is reused across all `(date, strategy, stock)` evaluations in a
  single run; any mutated state would leak across them.
- **Never** read from DB inside engine methods. If you need an external lookup
  (e.g. "is this stock in the 不可融券 list?"), accept the data as part of
  `EvaluateOrderContext` — let the caller load it.
- **All rejection reasons MUST be added to `RejectionReason` enum first**, then
  used. Free-text reasons break aggregation downstream (UI charts, alerting).
- **`isSTName(name)` must stay in sync with the same function in
  `strategies/MultiFactorAlphaStrategy.ts`**. If you tweak the detection rule
  (e.g. handle 退市风险警示 prefix), update BOTH files in the same commit.
  The strategies layer was the original home — engine just mirrors it.

### `rejected_orders` audit trail

`QuantBacktestStrategyResult.rejected_orders: RejectedOrder[]` is persisted to
`quant_backtest_results.rejected_orders_json` (US-014 new column). One row per
拒单 with `{trade_date, strategy_key, symbol, side, reason, detail?,
reference_price?}`. The UI uses this to answer "为什么这只票今天没买/卖
成?". The `diagnostics.block_reasons: Record<reason, count>` counter is the
aggregate twin — both views are kept because aggregation (heatmaps,
dashboards) and audit (per-row drill-down) have different consumers.
