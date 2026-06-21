# 74 — 每季度参数重训（Quarterly Parameter Retrain）

## A. 操盘手心智

策略参数（lookback / threshold / sizing / stop / take）在写策略时就定了。但**参数从来不是"算出来"的，是"试出来 + 不死人地用着"**。

每季度必须做的 3 件事：
1. **重新校准**：拿过去 1-2 年数据跑 grid / Bayesian / walk-forward，看现在的参数还不是最优
2. **对比 AB shadow**：找到 top 3 候选参数组合 → shadow 跑 4 周 → 选出 winner
3. **灰度切换**：winner → paper trade 1 个月 → 没问题再 hard cutover

**绝对禁止"过拟合"**：用 walk-forward 验证 + out-of-sample test，单一 train/test 不算数。

---

## B. 系统设计

### B.1 季度重训流程

```
季末第一个工作日 09:00 cron `QUARTERLY_PARAM_RETRAIN`
  │
  ├─→ 阶段 1: GridSearch（粗扫）
  │     for each strategy with `auto_retrain=true`:
  │       grid = strategy.paramSpace (3-5 维, 每维 5-10 值)
  │       results = GridSearchOptimizer.search(grid, lookback=2y)
  │       top_30 = results.sortBy('sharpe').slice(0, 30)
  │
  ├─→ 阶段 2: BayesianOpt（精扫）
  │     for top_30 启动点:
  │       BayesianOptimizer.optimize(initial=top_30, n_iter=50)
  │       → top_3 候选
  │
  ├─→ 阶段 3: WalkForward（防过拟合）
  │     for each top_3:
  │       WalkForwardValidator.run(params, n_folds=8, train=18m, test=3m)
  │       drop if any fold sharpe < 0.5
  │
  ├─→ 阶段 4: AB shadow 启动
  │     winner = top_3.first_passing_walkforward
  │     write `strategy_param_candidates`:
  │       (strategy_key, candidate_params, status='shadow', shadow_start_date)
  │     shadow runner 每天对照跑（不实际下单）
  │
  └─→ 阶段 5: 4 周后 review → 决定切换 / 回退
        cron `QUARTERLY_RETRAIN_SHADOW_REVIEW`（每周日跑）
        if shadow_running_4w AND shadow_sharpe > current_sharpe × 1.05:
          mark candidate as `ready_for_hard_cutover`
          通知 admin 手动 confirm
```

### B.2 输出结构

```ts
interface QuarterlyRetrainReport {
  strategy_key: string;
  quarter: string;            // 2026Q2
  current_params: Record<string, any>;
  current_metrics: { sharpe; calmar; maxDD; winRate };
  grid_search_top_30: ParamResult[];
  bayesian_top_3: ParamResult[];
  walkforward_passed: ParamResult[];
  selected_winner: ParamResult | null;
  ab_shadow_started: bool;
  reasoning: string;
}

interface ParamResult {
  params: Record<string, any>;
  metrics: { sharpe; calmar; maxDD; turnover; winRate; trades };
  walkforward_passed: bool;
  walkforward_fold_results?: FoldResult[];
}
```

---

## C. 现状 review

### C.1 已存在（工具齐全，流程缺）

| 文件 | 行数 | 现状 |
|---|---|---|
| `backend/src/quant/backtest/GridSearchOptimizer.ts` | 739 | ✅ Grid 搜索完整实现 |
| `backend/src/quant/backtest/BayesianOptimizer.ts` | 1023 | ✅ Bayesian 优化器（GP / TPE） |
| `backend/src/quant/backtest/WalkForwardValidator.ts` | 1396 | ✅ Walk-forward 完整 + fold report |
| `backend/src/quant/backtest/OverfitMetrics.ts` | — | ✅ 过拟合指标（PBO / SR deflated） |
| `backend/src/quant/backtest/MonteCarloStressTest.ts` | 504 | ✅ Monte Carlo 压力测试 |
| `backend/src/quant/backtest/RegimeSegmentedBacktest.ts` | 545 | ✅ 按 regime 分段回测 |
| `backend/src/quant/backtest/internal/QuantBacktestEngine.ts` | — | ✅ 核心回测引擎（已修 composite_signals hook） |

### C.2 关键缺口

1. **没有 `QUARTERLY_PARAM_RETRAIN` cron**：三个 optimizer 都是手动调用
2. **没有 `strategy_param_candidates` 模型**：grid/bayes 结果跑完落 PR 是手动，没有"候选参数"的持久层
3. **没有 AB shadow 跑参数候选的机制**：当前 shadow 是"AI 引擎 shadow"，没有"策略参数 shadow"
4. **没有"自动 PR / 切量灰度"流程**：人工每季度想起来去跑
5. **strategy params 在代码里 hardcoded**：策略配置不是数据驱动的（推断，需 grep 验证）
6. **WalkForward 跑出的 fold report 没有持久化**：每次跑完丢
7. **缺 OverfitMetrics 集成**：跑参数优化时没有强制 PBO < 0.5 / Deflated Sharpe > 0 校验

---

## D. 改造方案

| ID | 故事 | P | 依赖 |
|---|---|---|---|
| QR-001 | 新建 model `StrategyParamCandidate.ts`：(strategy_key, quarter, candidate_params JSONB, source 'grid'/'bayes'/'walkforward', status 'evaluating'/'shadow'/'ready_for_cutover'/'live'/'rejected', metrics JSONB) + migration | P0 | — |
| QR-002 | 新建 model `StrategyParamConfig.ts`：(strategy_key, effective_from, params JSONB, source_candidate_id) — 策略读它而非 hardcode | P0 | — |
| QR-003 | 重构 13 个策略：把 hardcoded params 改为构造函数注入 + 从 `StrategyParamConfig` 加载 | P0 | QR-002 |
| QR-004 | 新建 `services/param-retrain/QuarterlyParamRetrainService.ts`：5 阶段流程编排 | P0 | QR-001 |
| QR-005 | 新建 `services/param-retrain/RetrainPipeline.ts`：串联 GridSearchOptimizer → BayesianOptimizer → WalkForwardValidator → OverfitMetrics 校验 | P0 | QR-004 |
| QR-006 | 新建 `services/param-retrain/ShadowParamRunner.ts`：每日 cron 对 `status='shadow'` 的 candidate 跑当日 signal，落 `param_shadow_results` | P1 | QR-001 |
| QR-007 | 在 SchedulerService 注册 `QUARTERLY_PARAM_RETRAIN`（每季初 09:00） + `WEEKLY_PARAM_SHADOW_REVIEW`（每周日） + `DAILY_PARAM_SHADOW_RUN`（每交易日 17:30） | P0 | QR-005, QR-006 |
| QR-008 | 实现 `evaluateShadowVsLive(candidate, lookback=20d)`：对比 shadow vs current params 的 pnl/sharpe；超 5% 标记 ready_for_cutover | P1 | QR-006 |
| QR-009 | admin route `POST /api/admin/param-retrain/candidate/:id/promote`：人工确认 cutover；写 `StrategyParamConfig` 新版本 | P1 | QR-008 |
| QR-010 | OverfitMetrics 强制集成：候选必须 PBO < 0.5 AND deflated_sharpe > 0 才 promote 到 shadow | P1 | QR-005 |
| QR-011 | 前端 LabWorkspace `/lab/retrain` tab：展示季度重训进度 + top 3 候选对比表 + shadow 跑 4 周 sharpe 折线图 | P2 | QR-008 |
| QR-012 | 飞书 push：季度重训完成、shadow 周报、cutover 提议 3 类通知 | P2 | QR-009 |

---

## E. 验收口径

1. 每季末后第 1 个工作日 12:00 前，`strategy_param_candidates` 表至少新增 13 × 3 = 39 条 candidate
2. 每条 candidate 有完整 metrics + walk-forward fold report
3. 至少 1 个策略产生 `ready_for_cutover` candidate（不可能所有策略都被否）
4. 任意 cutover 都有 admin 人工 click 才生效（不自动）
5. shadow 跑 4 周后，UI 能看到 shadow vs live 的对比折线图
6. OverfitMetrics 失败的 candidate 直接 reject，不进 shadow
7. 跑 `npm test -- param-retrain/*.test.ts` 单测全绿
