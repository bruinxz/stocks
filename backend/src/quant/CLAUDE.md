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


