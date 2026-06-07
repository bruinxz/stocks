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

## US-037: GridSearchOptimizer — 参数网格调优

`backend/src/quant/backtest/GridSearchOptimizer.ts` is a 公共 class（与
`AShareConstraintEngine` 一样在 `backtest/` 顶级，不在 `internal/`），提供 grid
search 入口：

```ts
import { gridSearchOptimizer } from './backtest/GridSearchOptimizer';
const out = await gridSearchOptimizer.optimize(
  {
    strategy_key: 'multi_factor_alpha',
    param_grid: { topN: [10, 20, 30, 50], stopLossPct: [-5, -7, -10] },
    base_config: { start_date, end_date, initial_capital, benchmark_symbol },
  },
  { weights: { drawdown: 1.0 }, persist: true, concurrency: 1 }
);
```

### Design constraints

- **DataSource 注入与 strategies/ 一致**：`BacktestRunner` 是一个 `(combo,
  options) => Promise<BacktestSummary>` 函数式接口；默认实现 `defaultBacktestRunner`
  走 `quantBacktestEngine.run()` + `quantDataService.getContexts()`，单测通过
  `options.runner` 注入 fake 实现完全脱离 DB / 网络 / strategyRegistry。
- **persist=false 返回 plain `OptimizationResultRecord[]`**（非 Sequelize Model
  实例）：让单测无需启动 Sequelize 即可断言全部字段。`getRunResults()` 内部把 DB
  拉出的 model 通过 `modelToRecord()` 转成同样的 plain 形态——caller 只关心一
  个返回类型。
- **失败隔离 per-combo try/catch**：单个 combo 抛错只标该行 `status='failed' +
  error_message`，不中断其他 combo（与 strategies/ 中 per-block error fallback
  模式一致）。顶层 try/catch 仅捕获 worker 自身 bug（不该发生）。
- **多目标排序公式纯函数 export**：`computeCompositeScore({sharpe,
  annual_return, max_drawdown}, weights)` 让 UI 也能复算分数；权重可 partial
  override。`sortByCompositeScoreDesc(rows)` 同样是 export 纯函数，null 推到
  最末，同分时按 `combo_index ASC` 稳定 tie-break。
- **strategy_key 校验仅在未注入 runner 时执行**——caller 注入 fake runner 时
  自然不需要 StrategyRegistry，让单测可以用 `'test_strategy'` 这种假 key。
- **OptimizationRun + OptimizationResult 两张表**（PK + FK）；删除 run 时手动
  先删 results（没设 cascade，避免 ORM 行为差异）。`cleanupOlderThan(days)` 按
  `created_at` 批量删。

### 与 `QuantBacktestService.createParameterGridBacktests` 的关系

老的 `createParameterGridBacktests`（US-014 之前）走 Bull 队列异步任务，每个
combo 一条 `QuantBacktestTask`；GridSearchOptimizer 走**同步 in-process**，
适合：CLI 单次跑分、嵌入式 walk-forward 子 grid（US-039）、贝叶斯 baseline
对照（US-038）。两者并存：前者适合 UI 长时间任务（用户可关页面后台跑），
后者适合可编排的脚本化场景。**两者用不同的 DB 表**（`quant_backtest_tasks/
results` vs `optimization_runs/results`），互不污染。

### 何时扩展 GridSearchOptimizer

- 加新排序维度（如 calmar / sortino）→ 扩 `BacktestSummary` interface + 加新
  weight 到 `CompositeScoreWeights`，写 `computeCompositeScore` 新 branch；保
  持纯函数。
- 加新并发后端（Bull queue / Worker thread）→ 不要内嵌到 GridSearchOptimizer，
  写一个新 `BulkBacktestRunner` 实现 `BacktestRunner` 接口，caller 通过
  `options.runner` 切换。让 optimizer 本体保持简单。
- 加贝叶斯优化（US-038）→ 新建 `BayesianOptimizer.ts`，共享同一组 model 表
  （`OptimizationRun + OptimizationResult`），不要在 GridSearchOptimizer 内
  加 mode 切换分支。
