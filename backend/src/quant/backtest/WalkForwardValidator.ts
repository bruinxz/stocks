/**
 * WalkForwardValidator — 滚动窗口 walk-forward 验证（US-039）
 *
 * 训练 + 测试两段窗口在时间轴上向前滚动。每个窗口的处理：
 *   1. 在 `train_start..train_end` 跑一次嵌入式 GridSearchOptimizer，找到该
 *      训练期最优参数（按 composite_score）。
 *   2. 用该最优参数在 `test_start..test_end` 跑一次"样本外"backtest。
 *   3. 把 train+test 指标写入 WalkForwardResult 一行。
 *
 * 窗口完整滚完后：
 *   - 汇总每个 test 窗口的 sharpe / return / drawdown，输出 mean/std/min/max
 *     与 win_ratio（多少 test 窗口 sharpe > 0）。
 *   - 父 OptimizationRun（optimizer_type='walk_forward'）回写 status='completed'
 *     + best_result_id（指向 test_sharpe 最高的 WalkForwardResult.id 而不是
 *     OptimizationResult.id，这点与 US-037/US-038 不同——walk-forward 的
 *     "冠军"是单窗口）。
 *
 * **设计取舍 — 与 US-037/US-038 共享父表**：optimization_runs 加了
 * optimizer_type='walk_forward'；param_grid_json 字段在本场景下承载完整
 * walk-forward 配置 `{ train_months, test_months, param_grid, start_date, end_date }`
 * 而不是单纯参数网格；backtest_config_json 仍然是通用 baseConfig（除时间区间
 * 外的所有 backtest 配置）。这避免引入第 3 张 run 表，所有"长时间优化任务"
 * 的 UI 视图都能套用同一份分页 + 状态机。
 *
 * **关键差异 vs GridSearchOptimizer**：
 *   - GridSearch 是"在固定时间区间内找最优 N 个参数"
 *   - WalkForward 是"在 K 个不重叠的时间窗口内分别找最优参数，并在样本外
 *     验证泛化性"——本质是过拟合检测。一个策略 in-sample 优秀但 out-of-sample
 *     差，说明参数 fit 到了训练期噪音；本验证器是把它揪出来的工具。
 *
 * **数据源注入与 strategies/ 一致**：
 *   - `WalkForwardOptions.optimizer` 默认 gridSearchOptimizer；测试可注入
 *     fake optimizer（implements optimize() 接口）完全脱离 DB。
 *   - `WalkForwardOptions.testRunner` 默认 defaultBacktestRunner；测试注入
 *     fake runner（同 GridSearchOptimizer 的 BacktestRunner 接口）让 test
 *     窗口的 backtest 也脱离 DB。
 *
 * **错误隔离 per-window**：
 *   - train 阶段全部 combo 失败 → status='train_failed'，跳过 test。
 *   - train 成功但 test backtest 抛错 → status='test_failed'，记录 best_params
 *     但 test_sharpe/return/drawdown 全部 NULL。
 *   - 任何一个窗口失败都不影响后续窗口继续跑——与 GridSearch 内部 per-combo
 *     失败隔离同款模式。
 *
 * 主要消费方：
 *   - run-walk-forward.ts CLI
 *   - 未来 US-016 策略实验室 "walk-forward 验证" tab
 *   - 未来 US-045 BenchmarkAttributionService 可能 join test 窗口
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { OptimizationRun } from '../../models/OptimizationRun';
import { OptimizationResult } from '../../models/OptimizationResult';
import { WalkForwardResult } from '../../models/WalkForwardResult';
import { strategyRegistry } from '../engine/StrategyRegistry';
import { QuantBacktestOptions } from '../types/QuantTypes';
import {
  gridSearchOptimizer,
  GridSearchOptimizer,
  ParamGrid,
  BacktestRunner,
  BacktestSummary,
  CompositeScoreWeights,
  DEFAULT_COMPOSITE_WEIGHTS,
  computeCompositeScore,
  defaultBacktestRunner,
} from './GridSearchOptimizer';

// ============================================================
// Types
// ============================================================

/**
 * 滚动窗口的时间切片。所有日期都是 ISO 字符串 `YYYY-MM-DD`，闭区间。
 *
 * `test_start_date` 紧接 `train_end_date` 之后一日（即 train_end + 1 day）。
 * 不允许 train 与 test 重叠——这是 walk-forward 的核心约束（否则就是
 * in-sample 过拟合）。
 */
export interface WalkForwardWindow {
  index: number;
  train_start_date: string;
  train_end_date: string;
  test_start_date: string;
  test_end_date: string;
}

/**
 * `validate()` 输入。`param_grid` 是被搜索的参数网格（cartesian product，
 * 同 GridSearchOptimizer.ParamGrid）。
 *
 * `base_config` 是除时间区间 + 被优化参数外的所有 backtest 配置：
 * initial_capital / universe / symbols / benchmark_symbol / ...
 *
 * `train_months` / `test_months` 是 train / test 窗口的月数（自然月）。
 * `start_date` / `end_date` 是滚动覆盖的总区间（闭区间）。
 *
 * 推荐起手参数：train=12, test=3（一年 train、一季度 test）。让窗口数
 * = floor((总月数 - train) / test)。
 */
export interface WalkForwardInput {
  strategy_key: string;
  param_grid: ParamGrid;
  /** 通用回测配置（除时间区间外） */
  base_config: Omit<
    QuantBacktestOptions,
    'strategy_keys' | 'params_by_strategy' | 'start_date' | 'end_date'
  >;
  /** train 窗口长度（自然月） */
  train_months: number;
  /** test 窗口长度（自然月） */
  test_months: number;
  /** 滚动总区间起始日 YYYY-MM-DD */
  start_date: string;
  /** 滚动总区间结束日 YYYY-MM-DD（闭区间） */
  end_date: string;
}

/**
 * 嵌入式 GridSearchOptimizer 抽象。让测试可以注入 fake optimizer，
 * 完全脱离 DB / 网络。生产环境默认走 gridSearchOptimizer 单例。
 */
export interface EmbeddedOptimizer {
  optimize: GridSearchOptimizer['optimize'];
}

export interface WalkForwardOptions {
  /** GridSearch 嵌入式 weights，默认 DEFAULT_COMPOSITE_WEIGHTS */
  weights?: Partial<CompositeScoreWeights>;
  /** 是否写库，默认 true */
  persist?: boolean;
  /** test 窗口 backtest 并发度，默认 1（多数情况下 train 阶段 grid 内已并发） */
  concurrency?: number;
  /** train 阶段 grid 内并发度，默认 1 */
  train_concurrency?: number;
  /** train 阶段 max_combos 截断，默认 256（同 GridSearchOptimizer） */
  max_combos?: number;
  /** 触发用户 ID（落库 OptimizationRun.created_by） */
  user_id?: number;
  /** 注入嵌入式 optimizer（测试用），默认 gridSearchOptimizer */
  optimizer?: EmbeddedOptimizer;
  /** 注入 test 阶段 BacktestRunner（测试用），默认 defaultBacktestRunner */
  test_runner?: BacktestRunner;
  /** 是否让 train 阶段也 persist OptimizationRun + Results；默认 true 让审计可追溯，
   *  设 false 可大幅减少 walk-forward 总写入量（仅 WalkForwardResult 行被写入） */
  persist_train?: boolean;
}

/**
 * 单窗口的执行结果。`status` 反映本窗口是 completed / train_failed / test_failed。
 *
 * `train_*` 字段记录 train 阶段冠军 combo 的样本内指标，与 `test_*` 一一对比可
 * 让用户直观看出 overfit 程度（in-sample sharpe 1.8 / out-of-sample 0.3 是
 * 典型 overfit）。
 */
export interface WalkForwardWindowResult {
  id: number;
  run_id: number;
  window_index: number;
  train_start_date: string;
  train_end_date: string;
  test_start_date: string;
  test_end_date: string;
  best_params_json: Record<string, any>;
  train_composite_score: number | null;
  train_sharpe: number | null;
  test_sharpe: number | null;
  test_return: number | null;
  test_drawdown: number | null;
  test_total_return: number | null;
  test_win_rate: number | null;
  test_trade_count: number | null;
  train_run_id: number | null;
  train_combos_count: number | null;
  train_failed_combos: number | null;
  status: 'pending' | 'completed' | 'train_failed' | 'test_failed';
  error_message: string | null;
  duration_seconds: number | null;
}

/**
 * 全部窗口完成后的汇总指标。`win_ratio` 是 test_sharpe > 0 的窗口比例
 * （泛化稳定性的最直观指标）。`out_of_sample_decay` 是 train_sharpe
 * 减 test_sharpe 的平均值（>0 表示有过拟合衰减）。
 */
export interface WalkForwardSummary {
  total_windows: number;
  completed_windows: number;
  failed_windows: number;
  mean_test_sharpe: number | null;
  std_test_sharpe: number | null;
  min_test_sharpe: number | null;
  max_test_sharpe: number | null;
  mean_test_return: number | null;
  mean_test_drawdown: number | null;
  win_ratio: number | null;
  /** train_sharpe - test_sharpe 平均；>0 表示有过拟合衰减 */
  out_of_sample_decay: number | null;
}

export interface WalkForwardValidateResult {
  run: OptimizationRun | null;
  windows: WalkForwardWindowResult[];
  summary: WalkForwardSummary;
  best_window: WalkForwardWindowResult | null;
}

// ============================================================
// Pure helpers — independently unit-testable
// ============================================================

/**
 * ISO 日期 + 自然日偏移（不考虑交易日历，只算日历日）。
 *
 * 注意 GridSearchOptimizer 内的 BacktestRunner / engine 自行处理"周末/节假日
 * 没有 bar 就跳过"——所以滚动窗口用日历日切片不会产生 off-by-one 的问题。
 */
export function isoDateAddDays(asOfDate: string, days: number): string {
  if (!asOfDate || typeof asOfDate !== 'string') {
    throw new Error(`isoDateAddDays: invalid asOfDate '${asOfDate}'`);
  }
  const d = new Date(`${asOfDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`isoDateAddDays: unparseable asOfDate '${asOfDate}'`);
  }
  d.setUTCDate(d.getUTCDate() + Math.trunc(days));
  return d.toISOString().slice(0, 10);
}

/**
 * ISO 日期 + 自然月偏移。e.g. addMonths('2024-01-31', 1) → '2024-02-29'
 * （月末向后偏移自动 clamp 到下月有效末日；不抛错）。
 *
 * 行为：
 *   - addMonths('2024-01-31', 1) → '2024-02-29' (2024 是闰年)
 *   - addMonths('2023-01-31', 1) → '2023-02-28'
 *   - addMonths('2024-01-15', 3) → '2024-04-15'
 *   - addMonths('2024-12-15', 1) → '2025-01-15' (跨年)
 */
export function isoDateAddMonths(asOfDate: string, months: number): string {
  if (!asOfDate || typeof asOfDate !== 'string') {
    throw new Error(`isoDateAddMonths: invalid asOfDate '${asOfDate}'`);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOfDate);
  if (!m) throw new Error(`isoDateAddMonths: invalid date format '${asOfDate}'`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const totalMonths = year * 12 + (month - 1) + Math.trunc(months);
  const newYear = Math.floor(totalMonths / 12);
  const newMonth = (totalMonths % 12) + 1;
  // clamp day 到新月有效末日
  const daysInNewMonth = daysInMonth(newYear, newMonth);
  const newDay = Math.min(day, daysInNewMonth);
  return `${String(newYear).padStart(4, '0')}-${String(newMonth).padStart(2, '0')}-${String(
    newDay
  ).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  // month is 1-indexed
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 比较两个 ISO 日期字符串（YYYY-MM-DD），返回 a < b ? <0 : a > b ? >0 : 0。
 * 不调用 Date 解析（字典序就是日期序）让单测无需 mock 时间。
 */
export function compareIsoDate(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 生成滚动 walk-forward 窗口序列。
 *
 * 算法：
 *   for i = 0, 1, 2, ...:
 *     train_start = startDate + i * testMonths 月
 *     train_end   = train_start + trainMonths 月 - 1 天
 *     test_start  = train_end + 1 天
 *     test_end    = test_start + testMonths 月 - 1 天
 *     如果 test_end > endDate, 截断到 endDate
 *     如果 test_start > endDate, 不再生成新窗口
 *
 * 滚动步长 = `testMonths`（让 test 窗口不重叠；train 窗口可以重叠，因为相邻
 * train 窗口共享大部分数据但 test 窗口完全独立——这是 walk-forward 的标准设计）。
 *
 * 失败模式：
 *   - trainMonths <= 0 / testMonths <= 0 → 抛错
 *   - startDate > endDate → 抛错
 *   - 总区间不足 train + test → 返回 []
 */
export function generateWalkForwardWindows(
  startDate: string,
  endDate: string,
  trainMonths: number,
  testMonths: number
): WalkForwardWindow[] {
  if (!Number.isFinite(trainMonths) || trainMonths <= 0) {
    throw new Error(`generateWalkForwardWindows: trainMonths 必须 > 0，收到 ${trainMonths}`);
  }
  if (!Number.isFinite(testMonths) || testMonths <= 0) {
    throw new Error(`generateWalkForwardWindows: testMonths 必须 > 0，收到 ${testMonths}`);
  }
  if (compareIsoDate(startDate, endDate) >= 0) {
    throw new Error(
      `generateWalkForwardWindows: startDate '${startDate}' 必须 < endDate '${endDate}'`
    );
  }

  const windows: WalkForwardWindow[] = [];
  let i = 0;
  // 死循环保险阀：1000 个窗口足以覆盖 250 年的月度滚动
  const MAX_WINDOWS = 1000;
  while (i < MAX_WINDOWS) {
    const trainStart = isoDateAddMonths(startDate, i * testMonths);
    const trainEndPlus1Day = isoDateAddMonths(trainStart, trainMonths);
    const trainEnd = isoDateAddDays(trainEndPlus1Day, -1);
    const testStart = isoDateAddDays(trainEnd, 1);
    if (compareIsoDate(testStart, endDate) > 0) break;
    const testEndIdeal = isoDateAddDays(isoDateAddMonths(testStart, testMonths), -1);
    const testEnd = compareIsoDate(testEndIdeal, endDate) > 0 ? endDate : testEndIdeal;
    if (compareIsoDate(testStart, testEnd) > 0) break;
    windows.push({
      index: i,
      train_start_date: trainStart,
      train_end_date: trainEnd,
      test_start_date: testStart,
      test_end_date: testEnd,
    });
    i += 1;
  }
  return windows;
}

/**
 * 数学辅助：n-1 样本标准差。少于 2 个观测返回 null。
 */
export function sampleStddev(values: number[]): number | null {
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length < 2) return null;
  const m = valid.reduce((s, v) => s + v, 0) / valid.length;
  const ss = valid.reduce((s, v) => s + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (valid.length - 1));
}

/** mean of finite numbers; null if empty */
function mean(values: number[]): number | null {
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function minOrNull(values: number[]): number | null {
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length === 0) return null;
  return Math.min(...valid);
}

function maxOrNull(values: number[]): number | null {
  const valid = values.filter(v => Number.isFinite(v));
  if (valid.length === 0) return null;
  return Math.max(...valid);
}

/**
 * 把多窗口结果汇总成 WalkForwardSummary。所有 NaN/null 被剔除（不参与平均）。
 *
 * 这是 walk-forward 验证最有用的输出：
 *   - mean_test_sharpe 显示策略平均泛化能力（>1 才有实战价值）
 *   - std_test_sharpe 显示稳定性（std 高 = 看运气）
 *   - win_ratio 显示有多少 test 窗口赚了钱（< 50% 是危险信号）
 *   - out_of_sample_decay 显示过拟合幅度（>0 = train 高 test 低 = 过拟合）
 */
export function aggregateWindowMetrics(windows: WalkForwardWindowResult[]): WalkForwardSummary {
  const total = windows.length;
  const completed = windows.filter(w => w.status === 'completed').length;
  const failed = total - completed;
  // 只对 completed 窗口算指标，failed 窗口不参与汇总（test_sharpe=null 也会被
  // mean() 过滤；但显式判断 status 更清楚）
  const validWindows = windows.filter(w => w.status === 'completed');

  const testSharpes = validWindows.map(w => Number(w.test_sharpe)).filter(v => Number.isFinite(v));
  const testReturns = validWindows.map(w => Number(w.test_return)).filter(v => Number.isFinite(v));
  const testDrawdowns = validWindows
    .map(w => Number(w.test_drawdown))
    .filter(v => Number.isFinite(v));

  const winCount = testSharpes.filter(s => s > 0).length;
  const winRatio = testSharpes.length > 0 ? winCount / testSharpes.length : null;

  // out_of_sample_decay = mean(train_sharpe - test_sharpe)，只算两者都有限的对
  const decays: number[] = [];
  for (const w of validWindows) {
    const tr = Number(w.train_sharpe);
    const te = Number(w.test_sharpe);
    if (Number.isFinite(tr) && Number.isFinite(te)) {
      decays.push(tr - te);
    }
  }

  return {
    total_windows: total,
    completed_windows: completed,
    failed_windows: failed,
    mean_test_sharpe: mean(testSharpes),
    std_test_sharpe: sampleStddev(testSharpes),
    min_test_sharpe: minOrNull(testSharpes),
    max_test_sharpe: maxOrNull(testSharpes),
    mean_test_return: mean(testReturns),
    mean_test_drawdown: mean(testDrawdowns),
    win_ratio: winRatio,
    out_of_sample_decay: mean(decays),
  };
}

function roundTo(value: number | null | undefined, digits: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const k = Math.pow(10, digits);
  return Math.round(Number(value) * k) / k;
}

// ============================================================
// Main validator class
// ============================================================

export class WalkForwardValidator {
  /**
   * 单次完整 walk-forward 验证入口。流程：
   *   1. 校验 strategy_key ∈ StrategyRegistry（除非 options.test_runner 提供）
   *   2. generateWalkForwardWindows() 切片
   *   3. 写父 OptimizationRun（optimizer_type='walk_forward'）
   *   4. for each window:
   *      a. 嵌入式 gridSearchOptimizer.optimize(train_window) → best_params
   *      b. 用 best_params 在 test_window 跑一次 backtest
   *      c. 写一行 WalkForwardResult
   *   5. aggregateWindowMetrics() 汇总
   *   6. 回写 OptimizationRun.status='completed' + best_result_id（指向 test_sharpe
   *      最高的 WalkForwardResult.id）
   *   7. 返回 { run, windows, summary, best_window }
   */
  async validate(
    input: WalkForwardInput,
    options: WalkForwardOptions = {}
  ): Promise<WalkForwardValidateResult> {
    const persist = options.persist !== false;
    const persistTrain = options.persist_train !== false;
    const optimizer = options.optimizer || gridSearchOptimizer;
    const testRunner = options.test_runner || defaultBacktestRunner;
    const weights = {
      sharpe: options.weights?.sharpe ?? DEFAULT_COMPOSITE_WEIGHTS.sharpe,
      annual: options.weights?.annual ?? DEFAULT_COMPOSITE_WEIGHTS.annual,
      drawdown: options.weights?.drawdown ?? DEFAULT_COMPOSITE_WEIGHTS.drawdown,
    };

    // (1) 校验 strategy 存在（让 typo 在跑起来之前就报错；注入 test_runner 时信任 caller）
    if (!options.test_runner) {
      const exists = strategyRegistry.get(input.strategy_key);
      if (!exists) {
        throw new Error(
          `WalkForwardValidator.validate: strategy_key='${input.strategy_key}' 未在 StrategyRegistry 中注册`
        );
      }
    }

    // (2) 切片窗口
    const windows = generateWalkForwardWindows(
      input.start_date,
      input.end_date,
      input.train_months,
      input.test_months
    );

    if (windows.length === 0) {
      throw new Error(
        `WalkForwardValidator.validate: 总区间 ${input.start_date}..${input.end_date} 不足 ` +
          `train(${input.train_months}m) + test(${input.test_months}m)，未生成窗口`
      );
    }

    logger.info(
      `[walk-forward] start: strategy=${input.strategy_key} windows=${windows.length} ` +
        `train=${input.train_months}m test=${input.test_months}m range=${input.start_date}..${input.end_date}`
    );

    // (3) 写父 OptimizationRun（optimizer_type='walk_forward'）
    let run: OptimizationRun | null = null;
    if (persist) {
      run = await OptimizationRun.create({
        optimizer_type: 'walk_forward',
        strategy_name: input.strategy_key,
        param_grid_json: {
          // 父 run 上把 walk-forward 配置 + param_grid 一起序列化，便于审计
          train_months: input.train_months,
          test_months: input.test_months,
          start_date: input.start_date,
          end_date: input.end_date,
          param_grid: input.param_grid,
        },
        backtest_config_json: input.base_config as Record<string, any>,
        status: 'running',
        total_combos: windows.length,
        completed_combos: 0,
        failed_combos: 0,
        created_by: options.user_id,
        started_at: new Date(),
      });
    }

    // (4) 跑每个窗口，per-window 失败隔离
    const results: WalkForwardWindowResult[] = [];
    let failedCount = 0;

    try {
      for (const w of windows) {
        const t0 = Date.now();
        // train 阶段
        let bestParams: Record<string, any> | null = null;
        let trainCompositeScore: number | null = null;
        let trainSharpe: number | null = null;
        let trainRunId: number | null = null;
        let trainCombosRun = 0;
        let trainFailedCombos = 0;
        let windowStatus: WalkForwardWindowResult['status'] = 'pending';
        let errorMessage: string | null = null;

        try {
          const trainOut = await optimizer.optimize(
            {
              strategy_key: input.strategy_key,
              param_grid: input.param_grid,
              base_config: {
                ...input.base_config,
                start_date: w.train_start_date,
                end_date: w.train_end_date,
              } as Omit<QuantBacktestOptions, 'strategy_keys' | 'params_by_strategy'>,
            },
            {
              weights,
              persist: persist && persistTrain,
              concurrency: options.train_concurrency || 1,
              max_combos: options.max_combos || 256,
              user_id: options.user_id,
              // 关键：train 阶段沿用注入的 test_runner —— 在测试环境下 fake runner
              // 同时承担 train 和 test，简化注入；生产环境则两阶段都走 defaultBacktestRunner
              runner: options.test_runner,
            }
          );
          trainCombosRun = trainOut.combos_run;
          trainFailedCombos = trainOut.failed_combos;
          trainRunId = trainOut.run?.id ?? null;
          if (!trainOut.best) {
            windowStatus = 'train_failed';
            errorMessage = `train 阶段全部 ${trainOut.combos_run} 个 combo 失败`;
          } else {
            bestParams = trainOut.best.params_json;
            trainCompositeScore = trainOut.best.composite_score;
            trainSharpe = trainOut.best.sharpe;
          }
        } catch (err) {
          windowStatus = 'train_failed';
          errorMessage = err instanceof Error ? err.message : String(err);
          logger.warn(`[walk-forward] window #${w.index} train failed: ${errorMessage}`);
        }

        // test 阶段（仅 train 成功时跑）
        let testSummary: BacktestSummary | null = null;
        if (windowStatus === 'pending' && bestParams) {
          try {
            const fullOptions: QuantBacktestOptions = {
              ...input.base_config,
              strategy_keys: [input.strategy_key],
              params_by_strategy: { [input.strategy_key]: bestParams },
              start_date: w.test_start_date,
              end_date: w.test_end_date,
            } as QuantBacktestOptions;
            testSummary = await testRunner({ params: bestParams, index: w.index }, fullOptions);
            windowStatus = 'completed';
          } catch (err) {
            windowStatus = 'test_failed';
            errorMessage = err instanceof Error ? err.message : String(err);
            logger.warn(`[walk-forward] window #${w.index} test failed: ${errorMessage}`);
          }
        }

        if (windowStatus !== 'completed') failedCount += 1;

        const duration = (Date.now() - t0) / 1000;
        const record: WalkForwardWindowResult = {
          id: 0,
          run_id: run?.id ?? 0,
          window_index: w.index,
          train_start_date: w.train_start_date,
          train_end_date: w.train_end_date,
          test_start_date: w.test_start_date,
          test_end_date: w.test_end_date,
          best_params_json: bestParams ?? {},
          train_composite_score: roundTo(trainCompositeScore, 4),
          train_sharpe: roundTo(trainSharpe, 4),
          test_sharpe: testSummary ? roundTo(testSummary.sharpe, 4) : null,
          test_return: testSummary ? roundTo(testSummary.annual_return, 4) : null,
          test_drawdown: testSummary ? roundTo(Math.abs(testSummary.max_drawdown), 4) : null,
          test_total_return:
            testSummary && testSummary.total_return !== undefined
              ? roundTo(testSummary.total_return, 4)
              : null,
          test_win_rate:
            testSummary && testSummary.win_rate !== undefined
              ? roundTo(testSummary.win_rate, 4)
              : null,
          test_trade_count: testSummary?.trade_count ?? null,
          train_run_id: trainRunId,
          train_combos_count: trainCombosRun || null,
          train_failed_combos: trainFailedCombos || null,
          status: windowStatus === 'pending' ? 'train_failed' : windowStatus,
          error_message: errorMessage,
          duration_seconds: roundTo(duration, 3),
        };

        if (persist && run) {
          const created = await WalkForwardResult.create(record as any);
          record.id = created.id;
        }
        results.push(record);

        if (persist && run) {
          // 实时更新父 run 进度，让长任务可监控
          await run.update({
            completed_combos: results.length,
            failed_combos: failedCount,
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (run) {
        await run.update({
          status: 'failed',
          error_message: message,
          finished_at: new Date(),
          completed_combos: results.length,
          failed_combos: failedCount,
        });
      }
      throw err;
    }

    // (5) 汇总
    const summary = aggregateWindowMetrics(results);

    // (6) 选 best_window = test_sharpe 最高的 completed 窗口（tie-break by window_index ASC）
    const completedRanked = results
      .filter(r => r.status === 'completed' && r.test_sharpe !== null)
      .sort((a, b) => {
        const sa = Number(a.test_sharpe);
        const sb = Number(b.test_sharpe);
        if (sa !== sb) return sb - sa;
        return a.window_index - b.window_index;
      });
    const bestWindow = completedRanked[0] || null;

    // (7) 回写父 run
    if (persist && run) {
      await run.update({
        status: 'completed',
        completed_combos: results.length,
        failed_combos: failedCount,
        // 父 run.best_result_id 指向 best WalkForwardResult.id（不是 OptimizationResult.id —— 注意语义不同）
        best_result_id: bestWindow?.id ?? null,
        finished_at: new Date(),
      });
    }

    logger.info(
      `[walk-forward] done: windows=${results.length} failed=${failedCount} ` +
        `mean_test_sharpe=${summary.mean_test_sharpe?.toFixed(3) ?? 'NaN'} ` +
        `win_ratio=${summary.win_ratio?.toFixed(3) ?? 'NaN'} ` +
        `decay=${summary.out_of_sample_decay?.toFixed(3) ?? 'NaN'}`
    );

    return {
      run,
      windows: results,
      summary,
      best_window: bestWindow,
    };
  }

  /**
   * 查询一个 walk-forward run 的所有 windows，按 window_index 升序。
   */
  async getRunWindows(run_id: number): Promise<WalkForwardWindowResult[]> {
    const rows = await WalkForwardResult.findAll({
      where: { run_id },
      order: [['window_index', 'ASC']],
    });
    return rows.map(modelToRecord);
  }

  /**
   * 列出最近 N 个 walk-forward 类型的 OptimizationRun（仅 optimizer_type='walk_forward'）。
   */
  async listRuns(
    options: { strategy_name?: string; limit?: number; user_id?: number } = {}
  ): Promise<OptimizationRun[]> {
    const where: Record<string, any> = { optimizer_type: 'walk_forward' };
    if (options.strategy_name) where.strategy_name = options.strategy_name;
    if (options.user_id) where.created_by = options.user_id;
    return OptimizationRun.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(options.limit || 30), 1), 200),
    });
  }

  /**
   * 删除一个 walk-forward run + 所有 windows + 关联 train OptimizationRun/Results。
   * **递归删除**：每个 WalkForwardResult.train_run_id 指向一个 train-phase
   * OptimizationRun，那张 run 又关联 OptimizationResult 行——一并清掉避免孤儿数据。
   */
  async deleteRun(run_id: number): Promise<{
    deleted_windows: number;
    deleted_train_runs: number;
    deleted_train_results: number;
    deleted_run: number;
  }> {
    // 找到所有 train_run_id 关联
    const windows = await WalkForwardResult.findAll({
      where: { run_id },
      attributes: ['train_run_id'],
    });
    const trainRunIds = windows
      .map(w => w.train_run_id)
      .filter((id): id is number => typeof id === 'number');
    const deleted_train_results = trainRunIds.length
      ? await OptimizationResult.destroy({ where: { run_id: { [Op.in]: trainRunIds } } })
      : 0;
    const deleted_train_runs = trainRunIds.length
      ? await OptimizationRun.destroy({ where: { id: { [Op.in]: trainRunIds } } })
      : 0;
    const deleted_windows = await WalkForwardResult.destroy({ where: { run_id } });
    const deleted_run = await OptimizationRun.destroy({ where: { id: run_id } });
    return { deleted_windows, deleted_train_runs, deleted_train_results, deleted_run };
  }

  /**
   * 清理 N 天前的所有 walk-forward run + 关联 windows + train runs/results。
   */
  async cleanupOlderThan(days: number): Promise<{
    deleted_runs: number;
    deleted_windows: number;
    deleted_train_runs: number;
    deleted_train_results: number;
  }> {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const oldRuns = await OptimizationRun.findAll({
      where: { optimizer_type: 'walk_forward', created_at: { [Op.lt]: cutoff } },
      attributes: ['id'],
    });
    const runIds = oldRuns.map(r => r.id);
    if (!runIds.length) {
      return {
        deleted_runs: 0,
        deleted_windows: 0,
        deleted_train_runs: 0,
        deleted_train_results: 0,
      };
    }
    // 找出所有相关 train_run_id
    const windows = await WalkForwardResult.findAll({
      where: { run_id: { [Op.in]: runIds } },
      attributes: ['train_run_id'],
    });
    const trainRunIds = windows
      .map(w => w.train_run_id)
      .filter((id): id is number => typeof id === 'number');
    const deleted_train_results = trainRunIds.length
      ? await OptimizationResult.destroy({ where: { run_id: { [Op.in]: trainRunIds } } })
      : 0;
    const deleted_train_runs = trainRunIds.length
      ? await OptimizationRun.destroy({ where: { id: { [Op.in]: trainRunIds } } })
      : 0;
    const deleted_windows = await WalkForwardResult.destroy({
      where: { run_id: { [Op.in]: runIds } },
    });
    const deleted_runs = await OptimizationRun.destroy({ where: { id: { [Op.in]: runIds } } });
    return { deleted_runs, deleted_windows, deleted_train_runs, deleted_train_results };
  }
}

// computeCompositeScore is re-exported from GridSearchOptimizer for downstream convenience.
// Callers may want to recompute the win-or-lose threshold across windows with custom weights.
export { computeCompositeScore };

/**
 * 把 Sequelize 的 WalkForwardResult model 转成 plain record。
 */
function modelToRecord(row: WalkForwardResult): WalkForwardWindowResult {
  const numOrNull = (v: any): number | null =>
    v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  return {
    id: row.id,
    run_id: row.run_id,
    window_index: row.window_index,
    train_start_date: String(row.train_start_date),
    train_end_date: String(row.train_end_date),
    test_start_date: String(row.test_start_date),
    test_end_date: String(row.test_end_date),
    best_params_json: row.best_params_json || {},
    train_composite_score: numOrNull(row.train_composite_score),
    train_sharpe: numOrNull(row.train_sharpe),
    test_sharpe: numOrNull(row.test_sharpe),
    test_return: numOrNull(row.test_return),
    test_drawdown: numOrNull(row.test_drawdown),
    test_total_return: numOrNull(row.test_total_return),
    test_win_rate: numOrNull(row.test_win_rate),
    test_trade_count: numOrNull(row.test_trade_count),
    train_run_id: numOrNull(row.train_run_id),
    train_combos_count: numOrNull(row.train_combos_count),
    train_failed_combos: numOrNull(row.train_failed_combos),
    status: row.status as WalkForwardWindowResult['status'],
    error_message: row.error_message ?? null,
    duration_seconds: numOrNull(row.duration_seconds),
  };
}

// Default singleton (same convention as gridSearchOptimizer / bayesianOptimizer)
export const walkForwardValidator = new WalkForwardValidator();
