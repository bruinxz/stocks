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
