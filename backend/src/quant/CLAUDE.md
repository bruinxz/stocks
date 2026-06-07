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
- 加贝叶斯优化（US-038）→ 已实现，见下节。

## US-038: BayesianOptimizer — 贝叶斯（高斯过程 + EI）参数搜索

`backend/src/quant/backtest/BayesianOptimizer.ts` 是 US-037 GridSearchOptimizer
的姐妹模块：同样的公共 class、同样在 `backtest/` 顶级（不在 `internal/`）。两
者的**互补关系**：

| 维度 | GridSearchOptimizer | BayesianOptimizer |
| ---- | ---- | ---- |
| 搜索空间 | 离散 cartesian product | 连续 / 整数 bounds (min/max) |
| 适合维度 | 1-3 维 / 每维 5 取值 | 3-8 维 / 大空间 |
| 信息利用 | 无（穷举） | 有（GP 后验 + EI 引导） |
| 复现性 | 完全确定 | 同 seed 完全确定 |
| 共享表 | ✅ optimization_runs / results | ✅ 同表，optimizer_type='bayesian' |
| 共享 API | OptimizationResultRecord / BacktestRunner / CompositeScoreWeights / computeCompositeScore / sortByCompositeScoreDesc | 全部 import 自 GridSearchOptimizer |

```ts
import { bayesianOptimizer } from './backtest/BayesianOptimizer';
const out = await bayesianOptimizer.optimize(
  {
    strategy_key: 'multi_factor_alpha',
    param_bounds: {
      topN: { min: 10, max: 50, integer: true },
      stopLossPct: { min: -15, max: -3 },
    },
    base_config: { start_date, end_date, initial_capital, benchmark_symbol },
  },
  {
    iterations: 30,        // 总采样数（含 init_points）
    init_points: 8,        // 初始拟随机均匀采样（默认 max(5, 2*D)）
    exploration_xi: 0.01,  // EI exploration factor
    kernel_length_scale: 0.3, // RBF kernel 平滑度（归一化空间）
    seed: 42,              // 同 seed → 完全相同的采样序列
    persist: true,
  }
);
```

### Design constraints

- **共享 OptimizationRun + OptimizationResult 表**：OptimizationRun 加了
  `optimizer_type` 字段（'grid_search' / 'bayesian'），区分两种优化器历史。
  `BayesianOptimizer.listRuns()` 默认只列 bayesian 行；GridSearchOptimizer.
  listRuns() 不过滤（兼容旧代码，旧行 defaultValue='grid_search'）。
- **自实现 EI + GP 而非 npm 依赖**：`bayesian-optimization` 包近 4 年未更新且
  依赖 ml-matrix（多 MB）；EI + RBF GP 的核心数学 < 200 行，自实现可保持纯函
  数 + 可单测。所有数学函数（normalCDF / normalPDF / rbfKernel /
  choleskyDecompose / solveLowerTriangular / solveUpperTriangular /
  gaussianProcessPosterior / expectedImprovement）都是 `export function` 让
  bayesian-optimizer.test.ts 可在毫秒级跑完 161 测试。
- **归一化到 [0,1]^D 空间**：RBF kernel length scale 与维度无关（原始空间下
  stopLossPct ∈ [-15,-3] 和 topN ∈ [10,50] 的 distance 完全不可比）。
  `normalizeParams` / `denormalizeParams` 是 export 纯函数，integer bounds
  在 denormalize 时 Math.round。
- **失败点不进入 GP 训练集**：单 iter 失败时记 `status='failed' +
  error_message`，但 observations 数组只 push 成功且 composite_score 有限的
  点。NaN 进 GP 会让 Cholesky 协方差矩阵不可逆，必须严格过滤。
- **SeededRandom (Park-Miller LCG)** 替代 Math.random()：同 seed + 同 bounds
  + 同 runner → 完全相同的采样序列。单测可断言精确的 x 序列，回测可复算论文
  结果。**永不引入 Math.random** 到优化器代码（已在 jsdoc 顶部强制约定）。
- **EI candidate 网格策略**：D ≤ 3 用 cartesian (gridSize^D)；D ≥ 4 退化为
  随机采样 min(50_000, gridSize * D * 4) 个点避免内存爆炸。当前最优点周围
  加密 32 个 jittered 候选实现 local refinement。
- **strategy_key 校验仅在未注入 runner 时执行**——与 GridSearchOptimizer 同款
  约定。caller 注入 fake runner 时自然不需要 StrategyRegistry。

### 何时扩展 BayesianOptimizer

- 加新 acquisition function (UCB / PI)→ 抽出 `acquisitionFunction` 函数式接
  口，let optimize() 接受 options.acquisition；保持 EI 为默认。**不要**在 EI
  公式内 if/else 切换。
- 加 categorical 维度（非连续 / 非整数）→ 扩 ParamBound interface 加
  `type: 'continuous' | 'integer' | 'categorical'` 字段，bayesian 需要在归一化
  空间上做特殊的 one-hot embed 而非直接 round；categorical 维度上 GP 不合
  适，考虑 fall back 到 random sampling。
- 加多目标 Pareto front（不是 composite_score 单标量）→ 不要扩本类，新建
  `MultiObjectiveBayesianOptimizer.ts` 用 NSGA-II 风格采样，共享 optimization
  _runs 表但加新 `objectives_json` 列。复杂度跨度太大不宜混 EI 同款 API。

### 测试模式

- `bayesian-optimizer.test.ts` 161 用例覆盖 8 个 export 纯函数 + 14 个端到端
  集成场景。包括"在 [0,10] 找 target=7 的连续优化 25 iter 收敛到 ±1.5"和
  "2D 在 (3,7) 25 iter 收敛到 ±2.5" 的合成 benchmark — 让数学正确性 + 算
  法收敛性都有 explicit 断言不只是 happy-path。
- **GP 数学的 Cholesky 测试**：手算 K=[[4,2],[2,3]] 的 L = [[2,0],[1,√2]]，
  断言每个元素 + 验证 L*L^T 重构 = K。同样为非正定矩阵手动断言抛错。下次
  改 GP 实现时 Cholesky 测试就是回归基线。

## US-039: WalkForwardValidator — 滚动 walk-forward 验证

`backend/src/quant/backtest/WalkForwardValidator.ts` 是 US-037/US-038 三件套
中的第三个：参数调优的"反过拟合检测器"。**走 train 窗口找 best params → 用该
params 在紧接的 test 窗口跑样本外 backtest → 窗口向前滚动**。一个策略 in-sample
sharpe 1.8 / out-of-sample 0.3 是经典过拟合，本验证器是把它揪出来的工具。

```ts
import { walkForwardValidator } from './backtest/WalkForwardValidator';
const out = await walkForwardValidator.validate(
  {
    strategy_key: 'multi_factor_alpha',
    param_grid: { topN: [20, 30, 50], industryNeutral: [true, false] },
    base_config: { initial_capital: 1_000_000, benchmark_symbol: 'sh.000300' },
    train_months: 12,
    test_months: 3,
    start_date: '2023-01-01',
    end_date: '2025-12-31',
  },
  { persist: true, train_concurrency: 1, persist_train: true }
);
// out.summary.mean_test_sharpe / win_ratio / out_of_sample_decay 是核心输出
```

### 与 GridSearch / Bayesian 的关系（三件套对比）

| 维度 | GridSearch | Bayesian | WalkForward |
| ---- | ---- | ---- | ---- |
| 找什么 | 单个最优参数（in-sample） | 单个最优参数（in-sample，高效） | K 个不重叠时段各自最优（泛化稳定性） |
| 时间维度 | 固定区间 | 固定区间 | K 个滚动窗口 |
| 主要输出 | best params + composite_score | best params + composite_score | mean/std/min/max **test_sharpe** + win_ratio + decay |
| 子任务 | 跑 N combo backtest | 跑 N iter backtest | K 次 train + K 次 test backtest（嵌入 GridSearch） |
| 用途 | "什么参数好？" | "什么参数好（搜索快）？" | "这参数能稳定盈利吗？" |

### Design constraints

- **嵌入式 GridSearchOptimizer 复用而非重写**：WalkForwardOptions 接受
  `optimizer: EmbeddedOptimizer` 注入；默认 `gridSearchOptimizer`。每个
  train 窗口创建一个子 OptimizationRun（optimizer_type='grid_search'），
  父 walk-forward run 通过 `WalkForwardResult.train_run_id` 关联回去。
  审计可追溯 "本窗口最优参数是从哪 N 个 combo 里挑出来的"。
- **共享 OptimizationRun 表 + 新 optimizer_type='walk_forward'**：避免引入第
  3 张 run 表。在父 run 上，`param_grid_json` 承载完整 walk-forward 配置
  `{ train_months, test_months, start_date, end_date, param_grid }`，而不是
  单纯参数网格；`backtest_config_json` 仍是通用 baseConfig。`listRuns()` /
  `deleteRun()` / `cleanupOlderThan()` 默认只过滤 `optimizer_type='walk_forward'`
  防与 grid/bayesian 历史串扰。
- **`best_result_id` 在父 run 上指向 WalkForwardResult.id 而不是 OptimizationResult.id**：
  walk-forward 的"冠军"是 test_sharpe 最高的单个 *窗口*，不是单个 combo。
  这是 walk-forward 与 GridSearch/Bayesian 父 run 的语义差异，**消费方
  必须按 optimizer_type 分支处理 best_result_id 的指向**。
- **错误隔离 per-window**：train 阶段全部 combo 失败 → status='train_failed'，
  跳过 test；train 成功但 test 抛错 → status='test_failed'，记录 best_params
  但 test_* 为 NULL。任一窗口失败不影响后续窗口——与 GridSearch 内部
  per-combo 失败隔离同款模式。
- **DataSource 双注入（optimizer + testRunner）**：测试可注入 fake optimizer
  完全脱离 DB / 网络；同时注入 fake testRunner 让 test 阶段也脱离 DB。
  生产环境两者都默认走 `gridSearchOptimizer` / `defaultBacktestRunner`。
- **`generateWalkForwardWindows()` 纯函数 export**：滚动算法独立于 DB / 业务
  逻辑，可直接单测覆盖 train=12/test=3、不足区间 → []、边界恰好够 1 窗口、
  跨年滚动 5 窗口等所有边界形态。`isoDateAddMonths()` 单独处理月末 clamp
  （1-31 → 闰年 2-29 / 平年 2-28）。
- **滚动步长 = `testMonths`（让 test 窗口不重叠；train 窗口可以重叠）**——
  这是 walk-forward 的标准设计。相邻 train 窗口共享大部分历史数据但 test
  窗口完全独立，保证样本外信号互不重复污染。
- **`aggregateWindowMetrics()` 纯函数**：mean/std/min/max test_sharpe + win_ratio
  + out_of_sample_decay 都按"剔除 NaN/null"算；train_failed 窗口不参与
  统计（test_sharpe=null）；std 单样本返回 null。`out_of_sample_decay` 是
  walk-forward 最有诊断价值的输出（>0 = 过拟合，绝对值越大越严重）。
- **`persist_train` 选项**：默认 true 让 train 阶段子 OptimizationRun + 全部
  combo Results 都落库（审计完整）；set false 大幅减少 DB 写入（仅父 run
  + WalkForwardResult 行），适合 K=20 窗口 × 100 combo = 2000 行不愿持久化
  的场景。**`deleteRun` 与 `cleanupOlderThan` 递归清理 train_run_id 关联的
  子 runs/results** 避免孤儿数据。

### 何时扩展 WalkForwardValidator

- 加滚动 anchored window（train 起点固定，window 累积加长）→ 加
  `WalkForwardInput.window_mode: 'rolling' | 'anchored'`（默认 rolling），
  仅修改 `generateWalkForwardWindows()` 的 trainStart 计算。不要改父 run
  schema，因 window 数与时长之间的关系会被汇总指标自动反映。
- 加自定义嵌入式 optimizer（如把每个 train 窗口换成 BayesianOptimizer）→
  `WalkForwardOptions.optimizer` 接口已是 `EmbeddedOptimizer`（只需要 `optimize()`），
  注入 bayesianOptimizer 实例即可。**但**贝叶斯在 train 窗口上的 max_combos
  默认 256 偏多，建议先扩 EmbeddedOptimizer 加 `optimize()` 方法的 iterations
  参数定制选项。
- 加多基准对比（每个窗口 sharpe vs 基准 sharpe）→ 不要扩本类，让 US-045
  BenchmarkAttributionService 在 walk-forward run 完成后 JOIN
  WalkForwardResult.test_start_date..test_end_date 计算 beta/alpha。
- 加交易日历感知的 month 边界（"3 个月" = 60-63 个交易日）→ 不要改本类，
  让 `generateWalkForwardWindows()` 接受 `windowCalendar: 'natural' | 'trading'`
  参数，新模式仍输出 isoDate 字符串，后续 backtest 引擎自然消化。

### 测试模式

- `walk-forward-validator.test.ts` 141 用例覆盖 6 个纯函数（isoDateAddDays
  / isoDateAddMonths / compareIsoDate / sampleStddev / generateWalkForwardWindows
  / aggregateWindowMetrics）+ 17 个 end-to-end validate() 场景。包括：
  happy 4 windows 全 completed / train_failed 隔离 / test_failed 隔离 /
  全部 train_failed / 总区间不足抛错 / 注入 testRunner 跳过 strategyRegistry
  校验 / param_grid 透传 / weights 透传 / best_window tie-break / 失败后续
  窗口仍正常。
- **关键 fake**：`makeFakeOptimizer(pickByStart)` 让单测能给每个 train_start
  指定不同的"最优"参数 + sharpe，模拟 walk-forward 在不同时段选不同 params
  的真实行为；`makeFakeTestRunner(bySharpe)` 同样按 (params, startDate)
  分发 test_sharpe，让 best_window / win_ratio 等聚合断言可预测。
- **isoDateAddMonths 闰年 / 月末 clamp 测试**：手算 1-31 → 闰年 2-29 / 平年
  2-28、跨年 12-15 → 1-15 都有 explicit 断言。下次改月份算法时这些就是回
  归基线，避免静默 off-by-one bug。



## US-040: RegimeSegmentedBacktest — 分段市场环境回测报告

`backend/src/quant/backtest/RegimeSegmentedBacktest.ts` 是事后分析工具：拿一次
已完成的回测的 equity_curve + trades，按市场环境（bull / bear / range / volatile）
切成 N 个连续段，对每段独立算 收益 / 夏普 / 最大回撤 / 胜率 / 成交数。回答"这个
策略到底在哪种行情下赚钱、在哪种行情下亏钱"这个 walk-forward 看不到的视角。

### 与 GridSearch / Bayesian / WalkForward 的关系

|              | 优化任务（找最优参数）            | 事后分析（已完成 backtest）         |
| ------------ | --------------------------------- | ----------------------------------- |
| US-037 Grid  | ✅ in-sample 全网格               | ❌                                  |
| US-038 Bayes | ✅ in-sample GP + EI              | ❌                                  |
| US-039 WF    | ✅ in-sample → out-of-sample 滚动 | ❌                                  |
| **US-040 Regime** | ❌                          | ✅ 按市场环境切片重算指标            |

**所以 US-040 不复用 OptimizationRun 父表**：它不是"长时间参数搜索任务"，是对
一次已 completed 的 QuantBacktestResult 做派生统计，直接通过 `run_id` 引用
QuantBacktestResult.id 就够了，无需引入第 N+1 张 run 表 / 状态机。

### Design constraints

1. **段必须连续覆盖整个回测期间，不留空隙** — 每个 equity_curve point 必须落入
   某段。run-length-encode 算法天然保证此性质，只要 caller 没在 equity_curve
   里留空白日期就 OK；防御性 `equity.sort()` 处理乱序输入。
2. **同 regime 的不相邻段视为两条独立记录** — bull → bear → bull → 三条记录，
   而非合并成"bull 段总数 2"。前端图表 / 历史时间轴展示需要保留时间顺序。
3. **RegimeSource 注入（与 WalkForward.EmbeddedOptimizer 对齐）** — 生产环境
   走 `marketEnvironmentService.getEnvironmentForStock(benchmark, {as_of: <date>})`
   逐日采样，测试注入 fake `RegimeSource` 完全脱离 MarketEnvironmentService
   与 DB。**单日 regime 检测失败必须由 source 自己 try/catch 兜底为 `'range'`**
   （`PRODUCTION_REGIME_SOURCE` 已实现），让单日失败不阻塞整个 run。
4. **4 种 regime 是单一事实源** —  与 `EnsembleStrategy.EnsembleMarketRegime`
   完全一致（bull / bear / range / volatile）。`mapRawRegimeToSegmentRegime`
   独立实现（不 import 自 strategies/）避免反向依赖，但语义 100% 镜像；如果
   未来策略层 ensemble 调整 regime 折叠规则，这里也要同步。
5. **trade 关联以 `sell_date` 为准** — 段内成交统计应反映"该段实际兑现的盈亏"，
   入场跨段、出场在该段的 trade 也算入该段。未平仓 trade（sell_date 未定义）
   不计入任何段。这与 BacktestEngine 的 trade.pnl 计算口径一致。
6. **`sharpe` 不足 5 个日收益时为 null** — 段太短没有统计意义；写 null 比写 0
   清晰，下游聚合 `avg_sharpe_by_regime` 也会 `mean()` 自动过滤 null。
7. **`drawdown_pct` 永远是正数** — 段内最大回撤的绝对值。与 WalkForwardResult /
   QuantBacktestResult 同口径，保证跨表 SUM/MAX 聚合不需 ABS()。
8. **`replace_existing=true` 默认覆盖式重算** — 同 `run_id` 已有 segments 时
   先 `destroy`，避免历史段与新段混在一起。CLI `--no-replace` 可关闭。
9. **`持久化` 与 `in-memory` 模式并存** — `equity_curve + trades` 直接传 in-memory
   跳过 DB round-trip（适合嵌入式调用 / 单测）；`quant_backtest_result_id` 走
   DB（CLI / UI 最常见入参）。两种入参形态同一 `segment()` 入口。

### 何时扩展 RegimeSegmentedBacktest

- **新 regime 维度**（如行业 regime / 板块 regime / 流动性 regime）—— 扩
  `RegimeSource` 接口为 `RegimeSource & IndustryRegimeSource`，让一个段可以
  按多维度切片，给前端类似"行业 × 市场" 4×4 矩阵展示。
- **per-stock 分段 attribution** —— 当前是组合级（单一 equity_curve），未来
  US-046 IndustryAttributionService 可能 join 本表把段拆到每只票贡献。
- **更细粒度的 regime 切片** —— 当前是日级（每日采样），如果需要月度 / 周度
  采样，调整 segment() 内部的 `for (const p of equity_curve)` 循环（采样间隔）。

### 测试模式

- `regime-segmented-backtest.test.ts` 136 ok / 0 failed —— 覆盖 7 个纯函数
  （mapRawRegimeToSegmentRegime / mergeAdjacentSegments / sampleStddev /
   mean / maxDrawdownPctFromEquity / computeSegmentMetrics /
   aggregateRegimeSegments）+ 12 个 end-to-end segment() 场景。
- **关键 fake**：`makeFakeRegimeSource(stamps: Record<date, regime>)` 让单测
  能给每个 asOfDate 指定确定的 regime，模拟"市场 1-5 日是 bull, 6-10 日是 bear"
  这种典型分段；`makeThrowingRegimeSource(throwOn)` 验证 source 兜底为
  `'range'` 时下游 segment 生成正确（不会单日抛错让整个 run 失败）。
- **`makeEquityCurve(startDate, count, startValue, growthPerDay)` 是
  fixture helper** — 生成连续日 equity 序列，避免在每个测试里手写 10 个
  `QuantEquityPoint` 字面量。`growthPerDay=0.01` 让 sharpe 测试有充足
  日收益（≥5 个），`growthPerDay=0.001` 让短窗口测试 sharpe=null。



## US-043: MonteCarloStressTest — 蒙特卡洛压力测试

`backend/src/quant/backtest/MonteCarloStressTest.ts` 是事后分析工具：拿一次已完成
回测的 trade returns（`return_pct` 序列），随机重排 N=1000 次复利得到 N 条模拟资金
曲线，输出最终收益 / 最大回撤 / 夏普的**分位数分布**。回答"我这个策略到底是真有
alpha，还是历史成功靠少数几笔超额交易碰巧落在了正确的位置"——这是 walk-forward
和 regime-segmented 都看不到的视角。

### 与 GridSearch / Bayesian / WalkForward / Regime 的关系

|                | 优化任务（找最优参数）            | 事后分析（已完成 backtest）         |
| -------------- | --------------------------------- | ----------------------------------- |
| US-037 Grid    | ✅ in-sample 全网格               | ❌                                  |
| US-038 Bayes   | ✅ in-sample GP + EI              | ❌                                  |
| US-039 WF      | ✅ in-sample → out-of-sample 滚动 | ❌                                  |
| US-040 Regime  | ❌                                | ✅ 按市场环境切片重算指标            |
| **US-043 MC**  | ❌                                | ✅ 按 N=1000 重排算路径敏感性分布    |

**所以 US-043 也不复用 OptimizationRun 父表**（与 US-040/US-041/US-042 判据一致）：
它是对一次已 completed 的 QuantBacktestResult 做派生统计，直接通过 `base_run_id`
引用 QuantBacktestResult.id。`MonteCarloResult` 用 2-tuple PK `(base_run_id, seed)`
让同一回测可以跑多个 seed 做敏感性对比。

### Design constraints

1. **共用 BayesianOptimizer.SeededRandom（Park-Miller LCG）**——同 seed + 同
   trades → 完全可复现的 shuffle 序列。**永不引入 `Math.random()` 到 Monte Carlo
   代码**（同 BayesianOptimizer 约束）；单测可断言精确 outcome 序列，论文/报告
   结果可重算，ops 可重跑出"我上周看到的同一份图"。
2. **Fisher-Yates 无放回重排 vs 有放回 bootstrap 的判定**——AC 用语"随机重排"
   暗示无放回（同样的 N 笔 returns 重新排列；mean/std 不变只有顺序变），让
   sharpe/drawdown 的分布变化纯粹来自顺序敏感性。未来若需要 classical bootstrap
   with replacement，扩 `mode: 'shuffle' | 'with_replacement'` 参数即可；不要默
   认改语义。
3. **TradeReturnSource DI 与 GridSearchOptimizer.BacktestRunner /
   RegimeSegmentedBacktest.RegimeSource 同款**——生产 `PRODUCTION_TRADE_RETURN_SOURCE`
   用 `require()` lazy 加载 QuantBacktestTrade / QuantBacktestResult（避免单测拉
   重量级 DB stack）；测试注入 fake source 完全脱离 DB。**in-memory 模式优先于
   source 模式**：caller 同时传 `trade_returns_pct` 与 `quant_backtest_result_id`
   时使用 in-memory（in-memory 数据本就是 source of truth）。
4. **6 个 export 纯函数 — 测试关键**：`computeQuantile / bootstrapResample /
   computeSimulationFinalReturn / computeSimulationMaxDrawdown /
   computeSimulationSharpe / aggregateSimulations` 全 export，让 144 个测试覆盖
   纯算法 + 边界 + 业务方向的同时完全脱离 DB。**`mean`/`sampleStddev` 与
   `RegimeSegmentedBacktest` 同名，独立实现而非 import**——避免 quant/backtest/MC
   反向依赖 quant/backtest/Regime（同 US-040 "跨模块反向依赖避免" 范式；同一目录
   下不同模块也保持独立，因 import 链稳定性比代码复用更重要）。
5. **MIN_TRADES_FOR_BOOTSTRAP=2 抛错**——少于 2 笔交易没有重排意义。
   `MIN_SIMULATION_COUNT=1`（debug 用）/ `MAX_SIMULATION_COUNT=100_000`（OOM 防护）。
   `simulation_count > MAX_SIMULATION_COUNT` 直接抛错而非 silent clamp，让用户
   明确知道自己设错了参数（与 walk-forward 的 trainMonths > 已写入历史长度 抛错
   一致）。
6. **NaN/Infinity 自动剔除而非抛错**——单笔 return_pct NaN 在 source 层是
   常见（数据缺/计算异常），**不阻塞整个 run**；过滤后若仍 ≥ MIN_TRADES 继续，
   否则抛错。同款"丢卫生数据但不杀整 run"模式可复用到 US-044 PortfolioOptimizer
   单 series NaN / US-045 Benchmark NaN。
7. **爆仓处理：单笔 ≤ -100% return → final = -100% + dd = 100%**——
   `factor = 1 + r/100 ≤ 0` 直接 short-circuit 避免 log/sqrt 错误传播。理论上 A
   股不会出现 -100% trade（涨跌停限制），但用户可能传 fake/test 数据；语义清晰
   优于 NaN 污染下游聚合。
8. **简易模式 sharpe 假设必须文档化**——把 trade returns 当成"每个 trade 一个
   时间单位"算 sharpe 不是真正的"日级 sharpe"，`SHARPE_ANNUALIZATION_FACTOR=sqrt(252)`
   是 nominal 缩放让数字与传统 sharpe 在同一量级。**`MonteCarloResult.sharpe_p5`
   不可直接对比 `QuantBacktestResult.sharpe_ratio`**——后者基于日级 equity 序列；
   MC 中分位数 sharpe 仅用于 *相对比较* 不同模拟之间的稳健性。这一假设 jsdoc
   顶部 + computeSimulationSharpe 函数 doc + CLAUDE.md 三处同步说明。
9. **upsert by `(base_run_id, seed)`**——同 base_run_id + 同 seed → 覆盖
   （findOne → update if exists, else create）。不同 seed 互不冲突（用户可同时
   跑 seed=42 + seed=100 对比稳健性 / 第二意见）。`simulation_count` / 分位数都
   是 "summary 性质"不进入 PK。

### 何时扩展 MonteCarloStressTest

- **bootstrap with replacement** —— 扩 `mode: 'shuffle' | 'with_replacement'`
  让 `bootstrapResample` 走不同分支。AC 默认 'shuffle' 不变。
- **block bootstrap（保留连续 K 笔的局部相关性）** —— 适合 trade 之间有自相关
  的策略（如 trend following 多笔同方向 trade 簇）；扩 `block_size: number` 参数。
- **VaR / CVaR / 半方差** —— 当前已有 `return_p5`（≈ 95% VaR 业务）；如需正式
  CVaR (TailMean below p5) 加 `aggregateSimulations` 内一行 mean(returns < p5)。
- **多策略并行 MC**（组合级蒙特卡洛） —— 不要在本模块扩展，新建
  `PortfolioMonteCarloStressTest`（US-044 之后），输入是 N 个策略的 trade 序列
  + 权重，分别 shuffle + 加权合成 portfolio 曲线。本模块严格单策略保持简单。

### 测试模式

- `monte-carlo-stress-test.test.ts` 144 ok / 0 failed —— 覆盖 7 个常量 +
  6 个纯函数（computeQuantile 14 case / bootstrapResample 8 case /
  computeSimulationFinalReturn 9 case / computeSimulationMaxDrawdown 11 case /
  computeSimulationSharpe 7 case / aggregateSimulations 18 case）+ 17 个
  end-to-end run() 场景。
- **关键 fake**：`makeFakeSource(returns, strategyKey)` 让单测注入任意 returns
  数组完全脱离 DB；`SeededRandom(42)` 是默认 seed 让所有"业务方向"测试
  （全负 → positive_ratio=0 / 全正 → dd=0）有可复现的 outcomes 序列。
- **复利顺序无关性是关键回归保护**：所有重排后的最终复利收益必须完全相等
  （`expectEqual('复利顺序无关 → 所有 final_return 相同', uniqueFinals.size, 1)`），
  这同时验证了 (a) Fisher-Yates 不复制元素 (b) computeSimulationFinalReturn 是
  正确的复利公式 (c) NaN 过滤不漏不重。任何未来改 `bootstrapResample` 或复利
  公式的修改都会立即触发此断言失败。
- **同 seed 复现序列断言**：`expectEqual('同 seed 复现 dd 序列', dds1, dds2)`
  确保 SeededRandom 没被 Math.random() 偷偷替代——任何未来引入 Math.random
  的修改都会立即触发此断言失败。
- **测试 sharpe 精确值**：用 5 个非全等 returns 手算 mean/std/sharpe 完整公式
  让 sharpe 实现的 n-1 公式 + sqrt(252) 年化因子双重锁定。
- **极端值不爆**：单笔 -100% / 含 Infinity / 全 NaN 用例显式验证 short-circuit
  分支 + 不污染下游聚合。






## US-044: PortfolioOptimizer — 多策略组合权重优化

`backend/src/quant/backtest/PortfolioOptimizer.ts` 是事后分析工具：拿 N 个已完成
回测的**日收益序列**（从 `QuantBacktestResult.equity_curve_json` 派生），求解一
组权重 (w_1, …, w_N) 使得组合的夏普比率最大化，约束 sum(w_i)=1 且每个 w_i ∈
[min_weight, max_weight]（AC 默认 max=0.4 防全押单策略退化）。

### 与 GridSearch / Bayesian / WalkForward / Regime / MC 的关系

|                  | 优化任务（找最优参数）            | 事后分析（已完成 backtest）            |
| ---------------- | --------------------------------- | -------------------------------------- |
| US-037 Grid      | ✅ 单策略 in-sample 全网格        | ❌                                     |
| US-038 Bayes     | ✅ 单策略 in-sample GP + EI       | ❌                                     |
| US-039 WF        | ✅ 单策略 in-sample → OOS 滚动    | ❌                                     |
| US-040 Regime    | ❌                                | ✅ 单回测按市场环境切片重算指标         |
| US-041 IC        | ❌                                | ✅ 因子 IC 衰减统计                    |
| US-042 Corr      | ❌                                | ✅ 因子相关性矩阵                      |
| US-043 MC        | ❌                                | ✅ 单回测按 N=1000 重排算路径分布      |
| **US-044 Port** | ❌                                | ✅ **N 个回测求最优权重组合**           |

**所以 US-044 也不复用 OptimizationRun 父表**（与 US-040/041/042/043 判据一致）：
它是对 *N 个* 已 completed 的 QuantBacktestResult 做派生求解，结果通过
`strategy_keys_json` + `period_start/end` 关联源回测。`StrategyPortfolioResult`
用 `id` 自增 PK；每次跑都新增一行（不 upsert），让用户能保留"不同 max_weight
约束下的多次求解"做对比。

### 求解器：projected_gradient（默认）+ equal_weight（baseline）

**Projected Gradient Ascent (PGA)** 范式：
1. 初始化多个起点（`equal_weight` + R 个 `seeded random`）
2. 每个起点：
   - 计算数值梯度 `g = computeSharpeGradient(returnMatrix, w, eps=1e-5)`
   - `w_new = projector(w + learningRate * g)` — 投影回约束集
   - 若 `|sharpe_new - sharpe_old| < tolerance` 即收敛
3. 选所有起点中 `sharpe` 最大者输出

**simplex + box constraint 投影 (`{w: sum(w)=1, w_i ∈ [min, max]}`)** 的 bisection
算法：`clip(w + λ, min, max).sum()` 是 λ 的单调非降函数 → bisection 一定收敛
（100 次迭代到 1e-10 精度）。**关键约束可行性提前 throw**（max*N<1 / min*N>1 /
min<0 / max<min）友好提示，不让 PGA 内部 simplex 投影时崩。

**`equal_weight` baseline solver** 必须 trivial（5 行内），让用户能 sanity check
"我这个 PGA 比 naive 等权强多少"。任何后续优化器（US-049 DrawdownCircuitBreaker
/ US-086 仓位再平衡引擎）都应该提供 baseline 对照。

### 关键设计判据（10 个）

1. **不复用 OptimizationRun 父表**（与 US-040/041/042/043 判据一致）。
2. **N ≥ 2 才有意义**：N=1 throw（无组合）。
3. **8+ 纯函数全 export**：`alignDailyReturns` / `computePortfolioDailyReturns` /
   `computeMean` / `computeStddev` / `computeAnnualizedSharpe` /
   `computeAnnualizedReturn` / `computeMaxDrawdownPct` / `projectOntoSimplexWithBox` /
   `computeSharpeGradient` / `deriveDailyReturnsFromEquityCurve` 让单测脱离 DB。
4. **StrategyReturnSource DI 注入**：`PRODUCTION_STRATEGY_RETURN_SOURCE` lazy
   require QuantBacktestResult 避免 fake-source 单测拉重量级 DB stack；测试
   注入 fake 完全脱 DB。
5. **in-memory + DB 两种入参**：`strategy_returns[]` 优先级高于
   `quant_backtest_result_ids[]`，CLI / 单测 / 嵌入式调用方都能用。
6. **多起点 PGA**：`equal_weight + R seeded random` 起点中择最优；R 默认 2。
   纯单一起点的 PGA 容易困在 saddle point 或 local optima。
7. **数值梯度而非解析梯度**：sharpe 的 dSharpe/dw_i 涉及 std 导数 + quotient
   rule 复杂，中心差分 eps=1e-5 简单可靠。每次 PGA 迭代 N+1 次 sharpe 评估，
   对 N=10 / 1000 daily returns 每秒可跑 1000+ 次评估足够。
8. **约束可行性提前 throw**：max*N<1 / min*N>1 / min<0 / max<min 全部在
   `optimize()` 入口 throw 友好提示，不让 PGA 内部 simplex 投影时崩。
9. **lookback_days 截尾**：求解所用日收益窗口可选；None = 用全部对齐后日。
   trailing 60 / 90 / 120 日窗口让权重对近期表现更敏感（避免远期 regime 已变
   仍按全部历史均权）。
10. **PRD 默认 max_weight=0.4**：单策略上限 40% 防"全押单策略"退化为非组合。

### admin 4 件套 + CLI 4 模式（与 US-040/041/042/043 同款）

- **admin**: `getRun(id)` / `listRecentRuns(limit)` / `deleteRun(id)` /
  `cleanupOlderThan(days)`。
- **CLI**: 主流程 `--backtest-result-ids=<csv>` + `--max-weight` / `--solver`
  / `--lookback-days` / `--seed` / `--no-persist` / `--notes` + admin
  `--list` / `--show=<id>` / `--delete-run=<id>` / `--cleanup-days=<n>`。
- **CLI 输出按 KPI 分组**: 最优权重 (per-strategy 一行) + 组合指标 (sharpe /
  annual / max_dd) + 求解器元信息 (solver / converged / iterations /
  daily_returns / period)。

### 何时扩展 PortfolioOptimizer

- **凸 QP 解析解**: 当 N 增长到 100+ 策略，PGA 的 N+1 次 sharpe 评估变成瓶颈。
  考虑引入 quadprog WASM 或调用 cvxpy 服务，把数值梯度换成解析 QP。但目前
  N=2-10 用 PGA 足够（1 秒收敛）。
- **min-variance / max-return 等其他目标**: 当前只支持最大化夏普。扩 `objective:
  'sharpe' | 'sortino' | 'min_variance'` 选项；每个 objective 用对应的
  `compute<objective>` 替换 `computeAnnualizedSharpe`。**注意**: min_variance 的
  解析解（mean-variance 椭圆 + simplex 切线）有 closed-form，不必 PGA。
- **多周期再平衡（multi-period optimization）**: 当前一次求解返回一组静态权重。
  未来 US-086 仓位再平衡引擎可能需要"按周/月动态调整权重"，扩
  `RollingPortfolioOptimizer` 滑动窗口逐期求解。
- **整数权重约束（实盘整手买入）**: 当前权重是 continuous。实盘下到券商系统
  时要换算成"100 股的整数倍"，那是 PaperTradingFacade.placeOrder 的边界
  对齐问题，不属于本优化器的 scope。

### 测试模式（127 个测试 / 全脱 DB）

`backend/tests/backtest/portfolio-optimizer.test.ts`：
- **10 个常量校验** + **10 个纯函数测试**（覆盖空 / 单值 / NaN / Infinity /
  边界 / 已知数值 / 多日 / 极端值）。
- **18 个 end-to-end optimize() 场景**（in-memory + fake source 两种入参 /
  equal_weight + PGA 两种 solver / seed 复现性 / lookback_days 截尾 /
  max_weight 约束生效 / N=2 max=0.4 抛错 / 共同日少于 MIN 抛错 / N=1 抛错 /
  缺 input 抛错 / fake source 错传播 / notes 透传 / period 字段 / min_weight
  多元化 / 权重 6 位 round / in-memory 优先 DB）。
- **关键 fake**: `makeFakeSource(returns)` 让测试注入任意 strategy_returns
  完全脱 DB；`generateRandomReturns(N, mean, std, seed)` 用 Box-Muller
  转换让测试有可复现的"近正态"日收益序列。

---

## US-045: BenchmarkAttributionService — 基准比较与超额收益拆解

`backend/src/quant/performance/BenchmarkAttributionService.ts` 对一次完成的回测
（QuantBacktestResult.id 或 in-memory equity_curve）vs **N 个基准（默认 HS300 +
CSI500 + CSI1000）** 算出 CAPM alpha + beta + IR + excess_return + excess_drawdown，
回答策略到底是 lucky（beta 蹭大盘）还是 skilled（alpha 真信号）。
**首个 `backend/src/quant/performance/` 公共类**（与既有 `performance/internal/`
QuantPerformanceDashboardService 平级，对外通过 `PerformanceReporter` facade 暴露 — 见 US-004）。

### 与既有事后分析家族对比

| 工具                | 输入                  | 输出维度                                                |
| ------------------- | --------------------- | ------------------------------------------------------- |
| US-040 RegimeSegmented | equity_curve + trades | per-regime 切片 (bull/bear/range/volatile) 的 return/sharpe/dd |
| US-041 FactorIC     | (factor_scores, forward_returns) | per-factor IC mean/std/IR/positive_ratio + 衰减   |
| US-042 FactorCorrelation | factor_scores 宽表    | per-pair Spearman 相关 + redundancy 告警            |
| US-043 MonteCarlo   | trade_returns_pct     | 1000 次重排的 return/dd/sharpe 分布分位数            |
| US-044 PortfolioOpt | N 个策略 daily_returns | 最优权重组合 + 组合 sharpe/annual/dd                 |
| **US-045 Benchmark**| equity_curve + benchmark_returns | **per-benchmark alpha/beta/IR/excess_return/dd** |

**5 个事后分析家族都不复用 OptimizationRun 父表**（与 US-040/041/042/043/044
判据一致）：归因/分析是"对已完成回测做事后统计"，不是新的优化任务；通过 `run_id`
直接引用 `QuantBacktestResult.id` 即可。

### 8 个 design constraints (要遵守)

1. **共享 8 个纯函数** — `deriveDailyReturnsFromEquityCurve` /
   `alignReturnSeries` / `computeMean` / `computeStddev` / `linearRegression` /
   `computeInformationRatio` / `computeCumulativeReturn` /
   `computeExcessDrawdown` 全 export 独立单测；模式与 US-040 RegimeSegmented /
   US-041 FactorIC / US-043 MonteCarlo / US-044 Portfolio 一致。
2. **BenchmarkReturnSource DI 模式** — PRODUCTION 走 DailyBar + Stock lazy
   require 避免单测拉重量级 DB stack；测试注入 fake source 完全脱 DB。与
   GridSearchOptimizer.BacktestRunner / RegimeSegmented.RegimeSource /
   MonteCarloStressTest.TradeReturnSource / PortfolioOptimizer.StrategyReturnSource
   同款 DI 范式。
3. **三种入参形态 + 优先级** —
   `strategy_daily_returns` > `equity_curve` > `quant_backtest_result_id`。CLI /
   hook 走 result_id；in-memory 单测 / 嵌入式调用走数组形态。同时提供时取最高优先级。
4. **MIN_SAMPLE_COUNT = 5** — 对齐后日收益少于 5 时不做回归，但仍可算累计收益
   + excess_return（让 caller 看到"短回测虽不能算 alpha 但能算超额"），写
   `error` 字段提示。与 US-040 sharpe<5→null 同款"数据不足直接 null + 不阻塞"策略。
5. **per-benchmark 失败隔离** — 单基准 source 抛错 / 数据缺失 → 该 attribution
   `sample_count=0` + 全 null + `error` 字段记录；其他基准照常计算。
6. **IR std=0 浮点阈值** — `IR_STD_EPSILON=1e-10` 防止 strategy=benchmark+常数
   时浮点累计误差让 std≈1e-17 → IR 爆为天文数字。1e-10 远小于真实 daily return
   noise floor（实测 std > 0.1）→ 不误杀有意义 IR。
7. **`alpha_annual_pct = alpha_intercept × 252`** — 与 MonteCarloStressTest /
   PortfolioOptimizer 同款年化系数。IR 同样用 `* sqrt(252)` annualize。
8. **4-tuple PK upsert (run_id, benchmark_symbol, period_start, period_end)** —
   同一回测对同一基准重跑 idempotent 覆盖；不同 period 区间 = 不同行（让
   "3 月 1 日跑过一次 / 5 月 1 日重跑" 历史可保留）。与 US-041 FactorICResult /
   US-042 FactorCorrelationResult 4-tuple PK 范式一致。

### Backtest 完成 hook（fire-and-forget）

`QuantBacktestService.runBacktest()` 在 `task.update('COMPLETED')` 后通过
`setImmediate(() => this.triggerBenchmarkAttributionAsync(result_ids, task_id))`
异步触发 — **不 await，单回测完成不被归因耗时阻塞**；归因失败仅写 warning 日志
不污染回测主流程。每个 `QuantBacktestResult` 行独立触发（多策略回测 = 多个
results），per-result 失败隔离。

### admin 4 件套 + CLI 5 模式（与 US-040/041/042/043/044 同款）

- **admin**: `getRun(id)` / `getResultsForRun(run_id)` / `listRecentRuns(limit)` /
  `deleteRun(id)` / `deleteRunByRunId(run_id)` / `cleanupOlderThan(days)`。
- **CLI**: 主流程 `--backtest-result-id=<n>` + `--benchmarks=<csv>` /
  `--no-persist` + admin `--list` / `--show=<run_id>` /
  `--delete-run=<run_id>` / `--cleanup-days=<n>`。
- **CLI 输出按 KPI 分组**: per-benchmark `alpha_annual` / `beta` /
  `information_ratio` / `excess_return` / `excess_drawdown` / `r_squared` /
  `samples` / `strategy_return` / `benchmark_return` / `period` 一组 9 行
  + 自然语言提示（"IR>0.5 值得继续" / "beta > 1 = 放大基准"）让 ops 一眼看懂。

### 何时扩展 BenchmarkAttributionService

- **多因子模型基准（Fama-French / Carhart）**: 当前 CAPM 单因子。未来扩
  `RegressionMode: 'capm' | 'fama_french_3' | 'carhart_4'`，让 alpha 排除 SMB/HML/MOM 后
  的真"残差 alpha"。
- **滚动窗口 alpha/beta**: 当前一次回归整段。扩 `RollingBenchmarkAttribution`
  滑动 60-90 日窗口逐窗算 alpha/beta，输出 alpha_series / beta_series 看
  随时间漂移（策略风格是否稳定）。
- **行业归因联表（US-046 IndustryAttribution）**: US-046 IndustryAttributionService
  会把策略收益拆到每个行业贡献。可与 US-045 联表得到"行业 alpha vs 整体 alpha"
  对比视图（哪些行业是 alpha 来源、哪些是 beta drift）。
- **基准列表 dynamic per-strategy（US-084 BenchmarkSelector）**: 当前默认 3 大基准。
  US-084 BenchmarkSelector 会按策略风格（small_cap_growth / sector_rotation）
  自动选基准；本 service 的 `benchmark_symbols` input 已经支持自定义透传，
  US-084 实现后只需在 hook 调用前调 `BenchmarkSelector.select(strategy_key)`
  传给 input。

### 测试模式（171 个测试 / 全脱 DB）

`backend/tests/performance/benchmark-attribution-service.test.ts`：
- **5 个常量校验** (DEFAULT_BENCHMARK_SYMBOLS / BENCHMARK_NAME_MAP 7 项 /
  MIN_SAMPLE_COUNT=5 / ANNUALIZATION_FACTOR=252 / SHARPE_ANNUALIZATION_SQRT)。
- **8 个纯函数 helper 测试**（deriveDailyReturnsFromEquityCurve 7 边角 含
  null/NaN/Infinity/负 value/string 转换 / alignReturnSeries 8 边角 含
  部分重叠/无共同日/NaN 剔除/乱序输入按 ISO 升序 / computeMean+Stddev 8 边角 含
  全 NaN/n-1 公式精确 / linearRegression 10 边角 含完美线性/x 全相等→null/y 全相等→r² null /
  computeInformationRatio 5 边角 含完美 follow→null/IR 实际公式验算/NaN 剔除 /
  computeCumulativeReturn 7 边角 含爆仓-100% short-circuit / computeExcessDrawdown
  5 边角 含 strategy=benchmark→0/先赢后输 dd 精确验算）。
- **13 个 end-to-end computeAttribution() 场景**（happy 3 默认基准 / 自定义
  benchmark_symbols 透传 / 单基准缺数据隔离 / 不足 MIN sample 仍能算累计收益 +
  error 字段 / 三种入参形态优先级 / 三种入参全缺失抛错 / 空 returns 抛错 /
  equity_curve 派生模式 / 完美相关 beta=1/alpha=0/IR null / zero beta strategy
  全 0 / source 抛错 per-benchmark 隔离 / cleanupOlderThan 参数校验 4 边角 /
  computeSingleBenchmark 直接测 4 场景）。
- **关键 fake**: `makeFakeReturnSource(returnsBySymbol)` 让单测注入任意
  benchmark series 完全脱 DB；`makeReturnPoints(start, returns)` /
  `makeEquityCurve(start, returns, startValue)` fixture helpers 减少测试样板。

## US-046: IndustryAttributionService — 分行业归因分析

`backend/src/quant/performance/IndustryAttributionService.ts` 是第二个 `quant/performance/`
公共类（与 US-045 BenchmarkAttributionService 并列；都通过 PerformanceReporter facade 暴露）。
对一次完成的回测（QuantBacktestResult.id 或 in-memory trades + initial_capital）按行业分组
计算每个行业的 contribution_pct / win_rate / avg_hold_days / trade_count，让 ops 一眼看出
"策略 alpha 是哪些行业贡献的"。

### 6 事后分析家族对比（US-040..US-046）

| 模块 | 输入维度 | 输出维度 | 关键问题 |
|------|---------|---------|---------|
| US-040 RegimeSegmented | equity_curve + market regime | per-regime sharpe / annual / dd | 哪种市场环境策略表现好 |
| US-041 FactorIC | factor_scores + forward_returns | per-factor IC mean/std/IR/decay | 哪些因子真有信号 |
| US-042 FactorCorrelation | factor_scores 横截面 | per-factor-pair Spearman 相关 | 哪些因子冗余 |
| US-043 MonteCarlo | trade returns reshuffle | 收益/dd/sharpe 分位数 | 历史表现是不是巧合 |
| US-044 PortfolioOptimizer | multi-strategy daily returns | 最优权重 + 组合 sharpe | 怎么组合多个策略最优 |
| US-045 Benchmark | equity_curve + benchmark | alpha/beta/IR/excess | 是 alpha 还是 beta |
| **US-046 Industry** | **trades + Stock.industry** | **per-industry contribution/win_rate** | **alpha 来自哪些行业** |

### 9 个 design constraints（与既有 5 个分析模块判据一致）

1. **trade 归属以 sell_date 为准** — 与 US-040 RegimeSegmentedBacktest 同款判据。未平仓
   trade 不计入归因 — 浮盈在 equity_curve 已经反映，重复算成 trade 会双计。
2. **未识别行业归为 "其他"** — Stock.industry 缺失或 trim 后为空 → 归到 UNKNOWN_INDUSTRY_LABEL
   ("其他") 而非丢失数据，让 ops 看到「有多少 pnl 没法归到具体行业」。
3. **`industry_code = industry_name` 当前实现** — Stock 模型当前只有 `industry` (中文名)
   字段；未来引入独立 BK 编码后切换 DataSource 内部 join 逻辑即可，本表 schema 不变。
4. **win_rate 阈值: pnl > 0 算胜，pnl ≤ 0 算负** — pnl=0 偏保守归到 losing。trade_count = 0
   时 win_rate / avg_hold_days = null（与 IC 报告 sample_count<MIN 同款 'null vs 0' 策略）。
5. **contribution_pct 分母用 initial_capital** — `industry_pnl / initial_capital × 100`，
   所有行业相加 ≈ 策略总收益率（不考虑费率），符合「贡献分解」直觉。
6. **DataSource DI 注入** — `PRODUCTION_INDUSTRY_DATA_SOURCE` 用 lazy require 从
   QuantBacktestTrade + QuantBacktestResult + QuantBacktestTask + Stock 读数据；
   测试注入 fake source 完全脱 DB（与 US-040..US-045 6 个模块同款 DI 范式）。
7. **三种入参形态优先级**（与 US-045 同款）: in-memory `trades + initial_capital +
   symbol_to_industry` > `quant_backtest_result_id` 从 DB 读 > 完全无效 → 抛错。同时提供
   in-memory 与 result_id 时取 in-memory，但保留 result_id 写到 run_id 字段。
8. **4-tuple PK upsert idempotent** — `(run_id, industry_code, period_start, period_end)`
   主键。与 US-041 FactorICResult / US-042 FactorCorrelationResult / US-045
   BenchmarkAttributionResult 同款 4-tuple PK 范式。重跑同 (run, industry, 区间) 直接覆盖。
9. **per-industry 失败隔离不显式做** — 与 BenchmarkAttributionService 不同：行业归因的
   "失败" 只能发生在 industry 字符串处理层，没有外部数据源调用，所以无需 try/catch
   per industry。Trade 数据缺失会让该行业 trade_count=0 + 全 null 而非整体抛错。

### Backtest 完成 hook（与 US-045 并列）

`QuantBacktestService.runBacktest()` 在成功完成 + 创建 results 后 setImmediate
**fire-and-forget** 触发 `triggerIndustryAttributionAsync(result_ids, task_id)` —
对每个 QuantBacktestResult.id 调用 `industryAttributionService.computeAttribution`
(`source: 'backtest_hook'`)。**与 BenchmarkAttribution hook 并列**：两个 hook 互不影响、
互不阻塞，回测主流程不被任一归因耗时拖累。任一 result 失败只写 warning，其他 results
继续。批量级别再加一层 `.catch(err => logger.warn(...))` 兜底防 unhandled rejection。

### 7 个纯函数 helper（全 export，独立单测）

- `normalizeIndustryName(name)` — 中文名 trim + null/empty → "其他"。
- `isClosedTrade(trade)` — 已完成交易判定（sell_date 非空 + pnl 是有效数字）。
- `deriveHoldingDays(trade)` — 持仓天数派生（优先 trade.holding_days，缺则从 buy/sell 派生）。
- `aggregateTradesByIndustry(trades, industry_map)` — 按行业 Map<industry_code, IndustryGroup>。
- `computeContributionMetrics(group, initial_capital)` — 单行业 metrics 计算。
- `sortAttributionsByContribution(attributions)` — 按 |contribution_pct| 降序排序
  （UI 友好：贡献最大/拖累最大的一目了然），industry_code ASC tie-break 保证 deterministic。
- `roundTo(n, decimals)` — service-internal 4 位 round（避免浮点累计误差让 DB 写入失败）；
  不导出（与 BenchmarkAttributionService.roundTo 同款）。

### Admin 5 件套 + CLI

`IndustryAttributionService` 提供 `getRun / getResultsForRun / listRecentRuns /
deleteRun / deleteRunByRunId / cleanupOlderThan` —— 与 PortfolioOptimizer /
BenchmarkAttributionService 同款 admin 范式。

CLI `backend/src/scripts/run-industry-attribution.ts` (npm `run:industry-attribution`)
支持 5 模式：主流程 `--backtest-result-id=<n>` (with `--no-persist`) + 4 admin
(`--list` / `--show=<run_id>` / `--delete-run=<run_id>` / `--cleanup-days=<n>`)。
退出码 0/2 (success/hard-fail)。输出按 |contribution| 降序，正向行业 ↑ 反向 ↓ 中性 ·。

### PerformanceReporter facade 扩展

`backend/src/quant/performance/PerformanceReporter.ts` 新增 2 个 public 方法：
- `computeIndustryAttribution(input, options?)` — 调用 IndustryAttributionService.computeAttribution
- `getIndustryAttributionResultsForRun(run_id)` — 按 run_id 查全部行业归因结果

Controllers / UI 通过 facade 调用，不直接 import IndustryAttributionService（符合 US-004
公共 facade 收敛原则）。

### 测试模式（111 个测试 / 全脱 DB）

`backend/tests/performance/industry-attribution-service.test.ts`：
- **2 个常量校验** (UNKNOWN_INDUSTRY_LABEL='其他' / DEFAULT_SOURCE)。
- **6 个纯函数 helper 测试**（normalizeIndustryName 9 边角含 null/undefined/空/全空格/正常/前后空格 trim/非 string 类型 /
  isClosedTrade 8 边角含正常 closed/未平仓/null pnl/NaN pnl/空 sell_date/undefined sell_date/pnl=0 closed/负 pnl closed /
  deriveHoldingDays 5 边角含 holding_days 优先/null 派生/未平仓 0/负差值 clamp/非法日期 /
  aggregateTradesByIndustry 多场景含 3 行业 + 未平仓忽略 + map 值 trim + industry_code==industry_name + 空 trades + 全未平仓 /
  computeContributionMetrics 多场景含正常 5% / 空 group null / initial_capital=0 / 负数 / 负 contribution /
  sortAttributionsByContribution 含 \|降序\| + ASC tie-break + 不 mutate + 空数组 + 单元素）。
- **13 个 end-to-end computeAttribution() 场景**（happy 3 行业 / 未平仓不计入 / NaN pnl 不计入 /
  全未平仓 0 attributions / 缺 initial_capital 抛错 / 缺 input 抛错 / period 派生 /
  空 trades + 无 period 抛错 / DataSource 注入 / source 返回 null 抛错 / source initial_capital 无效 抛错 /
  input.strategy_key override source / in-memory 优先于 result_id 但保留 run_id 字段）。
- **1 个 cleanupOlderThan 参数校验** 含 days=0 / days=-5 / NaN / Infinity 4 边角。
- **关键 fake**: 自定义 fake DataSource per-test 注入 `loadAttributionContext` 返回任意
  fixture context，配合 in-memory 模式让全部测试零 DB 依赖。

### 何时扩展 IndustryAttributionService

1. **支持独立 industry_code (BK 编码)** — Stock 引入 BK 字段后切换 DataSource 的
   `symbol_to_industry` 返回为 `{symbol: {code: 'BK1024', name: '银行'}}`；computeMetrics
   保留 industry_name 作为 UI 展示文本，industry_code 用 BK 做主键。本表 schema 不变。
2. **支持行业 sub-attribution（行业内 top N 持仓）** — 当前是按行业聚合；未来 UI 想看
   "银行行业 +5% 主要是 招行+3% / 平安+1% / 兴业+1%" → 新建 IndustryStockAttributionResult
   表（4-tuple PK + stock_code），在 IndustryAttributionService 之外单独算（不污染本类）。
3. **支持行业相对超额（vs 行业 ETF）** — alpha 是「该策略在银行行业 vs 银行指数」的超额。
   需要 join 银行 ETF/指数 daily_returns。建议新建 IndustryRelativeAttributionService
   而非扩本类（避免本类公式从「绝对贡献」变到「相对超额」）。
4. **支持多区间归因（季度/月度对比）** — 当前 period_start/end 是单区间。多区间用 caller
   多次调用本类，每次传不同区间，本表 4-tuple PK 天然支持多行存储不冲突。
