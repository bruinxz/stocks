/**
 * GridSearchOptimizer — 多维参数网格搜索回测调优引擎（US-037）
 *
 * 给定一个策略 + 参数网格 + 通用回测配置，cartesian product 展开所有组合，
 * 在内存里跑 N 次 backtest（默认走 quantBacktestEngine.run；可注入自定义 runner
 * 让单测脱离 DB / 网络）。每次结果按 composite_score 排序得出冠军参数。
 *
 * 公共接口：
 *   - `optimize(input, options?)` — 异步执行一次完整网格搜索，写入 OptimizationRun
 *     + 多条 OptimizationResult；返回 { run, results, best }。
 *   - `generateGrid(paramGrid)` — 纯函数，展开 cartesian product；可独立单测。
 *   - `computeCompositeScore({sharpe, annual_return, max_drawdown}, weights)` —
 *     多目标排序公式；可独立单测 + 让 UI 也能复算分数。
 *
 * **DataSource 注入模式**（与 strategies/ 的 DataSource 接口对齐）：
 * `BacktestRunner` 是一个 `(combo) => Promise<BacktestSummary>` 函数式接口，
 * 默认实现走 `quantBacktestEngine.run()` + `quantDataService.getContexts()`，
 * 测试时传入自定义 fake runner 完全脱离 DB / 策略注册表。
 *
 * **排序规则（多目标）**：
 *   composite_score = sharpe * w_sharpe + annual_return_pct * w_annual
 *                   - max_drawdown_pct * w_drawdown
 * 默认权重 { sharpe: 1.0, annual: 0.4, drawdown: 0.5 }。让 sharpe（夏普率）
 * 当主导项；年化收益贡献为副；回撤减分。weights 可通过 options.weights 覆盖。
 *
 * 当 sharpe / annual_return / max_drawdown 缺失（失败组合）时 composite_score = null，
 * 排序时这些行被推到最末。
 *
 * **失败隔离**：单个 combo 抛错时记录 OptimizationResult.status='failed' +
 * error_message，不中断其余 combo —— 与 strategies/ 中"per-block error fallback"
 * 模式保持一致。
 *
 * **持久化（可选）**：默认 persist=true 写 DB（OptimizationRun + per-combo
 * OptimizationResult）。Set persist=false 让 CLI dry-run / 单测跳过 DB。
 *
 * **并发**：默认串行跑 backtest（concurrency=1），因 backtest 本身已是 CPU-bound +
 * DB-heavy；可通过 options.concurrency 调高（用 simple chunk batching，不引入
 * Bull queue 依赖让 CLI / 单测 / 嵌入式调用都能透明跑）。
 *
 * 主要消费方：
 *   - run-grid-search.ts CLI
 *   - 未来 US-016 策略实验室 "参数调优" tab
 *   - WalkForwardValidator (US-039) train 窗口内的嵌套 grid
 *   - BayesianOptimizer (US-038) 的 baseline 对照
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { OptimizationRun } from '../../models/OptimizationRun';
import { OptimizationResult } from '../../models/OptimizationResult';
import { strategyRegistry } from '../engine/StrategyRegistry';
import { QuantBacktestOptions } from '../types/QuantTypes';

// ============================================================
// Types
// ============================================================

/**
 * 输入参数网格。键 = 被优化的参数名；值 = 该参数的离散候选值列表。
 *
 * 示例：
 *   { topN: [10, 20, 30, 50], stopLossPct: [-5, -7, -10] }
 *   → 4 × 3 = 12 个组合
 */
export type ParamGrid = Record<string, any[]>;

/**
 * 单次 backtest 跑完后必须能从中萃取的 5 个核心指标。
 * 与 QuantBacktestStrategyResult 字段对齐（sharpe_ratio / annual_return_pct /
 * max_drawdown_pct / total_return_pct / win_rate）。
 */
export interface BacktestSummary {
  sharpe: number;
  annual_return: number;
  /** 绝对值；正数 e.g. 0.22 = 22% 回撤 */
  max_drawdown: number;
  total_return?: number;
  win_rate?: number;
  trade_count?: number;
}

/**
 * 单条 OptimizationResult 的 plain-object 形态。**与 Sequelize 模型 `OptimizationResult`
 * 字段一一对应**，但避免 build() 的 Model 初始化依赖 —— 让单测可以脱离 DB
 * 直接构造 / 排序 / 断言。
 *
 * 在 `optimize(persist=true)` 时 Sequelize 会持久化并把 model.dataValues 转回
 * 同样形态返回；在 `optimize(persist=false)` 时 GridSearchOptimizer 直接构造
 * 这个对象返回，**永远不调用 OptimizationResult.build()**。
 */
export interface OptimizationResultRecord {
  /** 持久化模式下 = DB 主键；in-memory 模式下 = 0 */
  id: number;
  run_id: number;
  combo_index: number;
  params_json: Record<string, any>;
  sharpe: number | null;
  annual_return: number | null;
  max_drawdown: number | null;
  total_return: number | null;
  win_rate: number | null;
  trade_count: number | null;
  composite_score: number | null;
  status: 'pending' | 'completed' | 'failed';
  error_message: string | null;
  duration_seconds: number | null;
}

/**
 * `optimize()` 输入。`baseConfig` 是除被优化参数外的所有回测配置：
 * start_date / end_date / initial_capital / universe / benchmark_symbol 等。
 *
 * `strategy_key` 必须存在于 StrategyRegistry，否则 optimize() 拒绝运行；
 * 这是为了避免 typo 跑出十几个空回测才发现。
 */
export interface GridSearchInput {
  strategy_key: string;
  /** 被优化参数维度，cartesian product 展开 */
  param_grid: ParamGrid;
  /** 通用回测配置（除被优化参数外） */
  base_config: Omit<QuantBacktestOptions, 'strategy_keys' | 'params_by_strategy'>;
}

/**
 * 多目标排序权重。让 sharpe 主导排序（默认 1.0），年化收益副贡献，回撤减分。
 * 用户可通过 options.weights 覆盖让某些场景偏向"低回撤"或"高年化"。
 */
export interface CompositeScoreWeights {
  /** 夏普率权重，默认 1.0 */
  sharpe: number;
  /** 年化收益率权重，默认 0.4 */
  annual: number;
  /** 最大回撤权重（减分，>0 让回撤越大综合分越低），默认 0.5 */
  drawdown: number;
}

export const DEFAULT_COMPOSITE_WEIGHTS: CompositeScoreWeights = Object.freeze({
  sharpe: 1.0,
  annual: 0.4,
  drawdown: 0.5,
});

/**
 * `BacktestRunner` 是注入式的回测执行函数，签名让 GridSearchOptimizer 和
 * 真正的 quantBacktestEngine 解耦：
 *
 *   - 默认实现 `defaultBacktestRunner` 走 `quantBacktestEngine.run()` +
 *     `quantDataService.getContexts()`（需要 DB / network）。
 *   - 单测可注入纯内存 fake runner，例如：
 *     ```ts
 *     const fakeRunner = async (combo, options) => ({
 *       sharpe: combo.params.topN === 30 ? 1.8 : 0.9,
 *       annual_return: 0.18,
 *       max_drawdown: 0.12,
 *     });
 *     ```
 */
export type BacktestRunner = (
  combo: { params: Record<string, any>; index: number },
  options: QuantBacktestOptions
) => Promise<BacktestSummary>;

export interface OptimizeOptions {
  /** 多目标权重，默认 DEFAULT_COMPOSITE_WEIGHTS */
  weights?: Partial<CompositeScoreWeights>;
  /** 是否写库，默认 true。CLI dry-run / 单测可置 false */
  persist?: boolean;
  /** 并发度，默认 1（串行）。> 1 时用 chunked batching，不引入 Bull 依赖 */
  concurrency?: number;
  /** 安全上限：单次 grid search 最多跑的组合数，默认 256（防止 5 维 × 6 取值=15625 误用） */
  max_combos?: number;
  /** 触发用户 ID（落库 OptimizationRun.created_by） */
  user_id?: number;
  /** 自定义 backtest runner（默认走 quantBacktestEngine）；测试时注入 fake */
  runner?: BacktestRunner;
}

export interface OptimizeResult {
  run: OptimizationRun | null;
  results: OptimizationResultRecord[];
  /** 按 composite_score DESC 排序后的第一行（None 若全部失败） */
  best: OptimizationResultRecord | null;
  /** ranked 视图（已排序），方便 caller 不再二次 sort */
  ranked: OptimizationResultRecord[];
  /** 实际跑了多少组合（受 max_combos / 网格大小限制） */
  combos_run: number;
  /** 失败组合数 */
  failed_combos: number;
}

// ============================================================
// Pure helpers — independently unit-testable
// ============================================================

/**
 * 展开参数网格的 cartesian product。维度顺序 = `Object.keys(paramGrid)` 顺序。
 *
 * 失败模式：
 *   - 空 grid `{}` → `[{}]`（"什么都不调"的 1-combo 占位，allowed by AC）
 *   - 任一维度是空数组 → 返回 `[]`（不可能产生有效组合）
 *   - 单维度 `{topN: [10,20]}` → `[{topN:10}, {topN:20}]`
 *
 * 输出 combo 的键顺序遵守 `Object.keys(paramGrid)` 的插入顺序，让 combo 哈希
 * 在 callers 之间稳定可比较。
 */
export function generateGrid(paramGrid: ParamGrid): Array<Record<string, any>> {
  if (paramGrid === null || paramGrid === undefined) return [{}];
  const keys = Object.keys(paramGrid);
  if (keys.length === 0) return [{}];

  // 任一维度空数组 → 整个 product 为空
  for (const key of keys) {
    if (!Array.isArray(paramGrid[key]) || paramGrid[key].length === 0) {
      return [];
    }
  }

  let combos: Array<Record<string, any>> = [{}];
  for (const key of keys) {
    const values = paramGrid[key];
    const next: Array<Record<string, any>> = [];
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [key]: value });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * 多目标综合排序分数。让 sharpe 主导，年化副贡献，回撤减分。
 *
 *   composite = sharpe * w_sharpe + annual_return * w_annual - max_drawdown * w_drawdown
 *
 * 其中 sharpe / annual_return / max_drawdown 都使用小数（不是百分点；
 * annual=0.18 = 18%）。失败组合（任一指标 NaN / null / undefined）返回 null，
 * 让 ranking 把它推到最末。
 *
 * `weights` 是 Partial，部分字段缺失时回退到 DEFAULT_COMPOSITE_WEIGHTS。
 */
export function computeCompositeScore(
  metrics: Partial<BacktestSummary>,
  weights: Partial<CompositeScoreWeights> = {}
): number | null {
  const w = {
    sharpe: weights.sharpe ?? DEFAULT_COMPOSITE_WEIGHTS.sharpe,
    annual: weights.annual ?? DEFAULT_COMPOSITE_WEIGHTS.annual,
    drawdown: weights.drawdown ?? DEFAULT_COMPOSITE_WEIGHTS.drawdown,
  };
  const sharpe = Number(metrics.sharpe);
  const annual = Number(metrics.annual_return);
  const drawdown = Number(metrics.max_drawdown);
  if (!Number.isFinite(sharpe) || !Number.isFinite(annual) || !Number.isFinite(drawdown)) {
    return null;
  }
  // 回撤一律取绝对值参与减分（防止 caller 误传负数）
  const ddAbs = Math.abs(drawdown);
  const score = sharpe * w.sharpe + annual * w.annual - ddAbs * w.drawdown;
  return Number.isFinite(score) ? roundTo(score, 4) : null;
}

function roundTo(value: number, digits: number): number {
  const k = Math.pow(10, digits);
  return Math.round(value * k) / k;
}

/**
 * 把内置 chunked-concurrency 写成纯函数，单测可独立验证：
 *   - 并发 ≤ 1 → 严格顺序执行
 *   - 并发 > 1 → batch 内并发，batch 间串行（最简单的限流，无 race）
 */
async function runWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 1
): Promise<R[]> {
  const cap = Math.max(1, Math.floor(concurrency || 1));
  if (cap <= 1) {
    const out: R[] = [];
    for (let i = 0; i < items.length; i++) {
      out.push(await worker(items[i], i));
    }
    return out;
  }
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += cap) {
    const chunk = items.slice(i, i + cap);
    const results = await Promise.all(chunk.map((item, j) => worker(item, i + j)));
    for (let j = 0; j < results.length; j++) {
      out[i + j] = results[j];
    }
  }
  return out;
}

// ============================================================
// Default runner: backed by quantBacktestEngine
// ============================================================

/**
 * 默认 BacktestRunner：走 quantBacktestEngine.run() + quantDataService.getContexts()。
 *
 * 因为 quantBacktestEngine.run() 是同步 + in-memory 的（接收 contexts 数组 +
 * options，返回 results 数组），这里只负责：
 *   1. 把 combo.params 注入 options.params_by_strategy[strategy_key]
 *   2. 拉 contexts（首次拉，可以后续 cache 让多 combo 复用）
 *   3. 跑 engine 并萃取该 strategy 的 summary
 *
 * 该 runner 故意 lazy-import quantDataService / quantBacktestEngine，避免
 * 任何 CLI / 单测 import GridSearchOptimizer 时被迫加载整个 quant 子系统。
 */
let _cachedContexts: { key: string; contexts: any[] } | null = null;

export const defaultBacktestRunner: BacktestRunner = async (combo, options) => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const { quantBacktestEngine } = require('./internal/QuantBacktestEngine');
  const { quantDataService } = require('../engine/internal/QuantDataService');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const strategy_key = (options.strategy_keys || [])[0];
  if (!strategy_key) throw new Error('defaultBacktestRunner: strategy_keys 为空');

  const contextKey = JSON.stringify({
    universe: options.universe,
    symbols: options.symbols,
    start_date: options.start_date,
    end_date: options.end_date,
    candidate_limit: options.candidate_limit,
  });
  if (!_cachedContexts || _cachedContexts.key !== contextKey) {
    const contexts = await quantDataService.getContexts({
      universe: options.universe || 'market',
      symbols: options.symbols,
      start_date: options.start_date,
      end_date: options.end_date,
      warmup_days: 160,
      limit: options.candidate_limit || 120,
      include_realtime_quote: false,
    });
    _cachedContexts = { key: contextKey, contexts };
  }
  const contexts = _cachedContexts.contexts;

  const engineResults = quantBacktestEngine.run(contexts, options);
  const match = engineResults.find((r: any) => r.strategy_key === strategy_key) || engineResults[0];
  if (!match) {
    throw new Error(`defaultBacktestRunner: 引擎未返回 ${strategy_key} 的结果`);
  }
  return {
    sharpe: Number(match.sharpe_ratio || 0),
    annual_return: Number(match.annual_return_pct || 0) / 100, // engine 返回 % 单位，归一化为小数
    max_drawdown: Math.abs(Number(match.max_drawdown_pct || 0)) / 100,
    total_return: Number(match.total_return_pct || 0) / 100,
    win_rate: Number(match.win_rate || 0) / 100,
    trade_count: Number(match.trade_count || 0),
  };
};

/**
 * 测试 / 调用方需要清空 context 缓存时调用（例如换 start_date / universe 之间）。
 */
export function clearDefaultRunnerCache(): void {
  _cachedContexts = null;
}

// ============================================================
// Main optimizer class
// ============================================================

export class GridSearchOptimizer {
  /**
   * 单次完整 grid search 入口。流程：
   *   1. 校验 strategy_key ∈ StrategyRegistry（除非 options.runner 提供）
   *   2. generateGrid() 展开 cartesian product，截到 max_combos
   *   3. （可选）写 OptimizationRun.status='running'
   *   4. 按 concurrency 跑 N 次 backtest（per-combo try/catch 失败隔离）
   *   5. computeCompositeScore + sort DESC
   *   6. （可选）写 N 行 OptimizationResult + 回写 OptimizationRun.status='completed' + best_result_id
   *   7. 返回 { run, results, best, ranked }
   *
   * persist=false 时返回的 OptimizationResult 是 in-memory 对象（未触 DB），
   * caller 仍可以读取所有字段（params_json / sharpe / composite_score 等）。
   */
  async optimize(input: GridSearchInput, options: OptimizeOptions = {}): Promise<OptimizeResult> {
    const persist = options.persist !== false;
    const runner = options.runner || defaultBacktestRunner;
    const weights = {
      sharpe: options.weights?.sharpe ?? DEFAULT_COMPOSITE_WEIGHTS.sharpe,
      annual: options.weights?.annual ?? DEFAULT_COMPOSITE_WEIGHTS.annual,
      drawdown: options.weights?.drawdown ?? DEFAULT_COMPOSITE_WEIGHTS.drawdown,
    };

    // (1) 校验策略存在（让 typo 在 grid 跑起来之前就报错）
    // 如果调用方注入了自定义 runner，则信任他们的 strategy_key（可能是 fake "test_strategy"）
    if (!options.runner) {
      const exists = strategyRegistry.get(input.strategy_key);
      if (!exists) {
        throw new Error(
          `GridSearchOptimizer.optimize: strategy_key='${input.strategy_key}' 未在 StrategyRegistry 中注册`
        );
      }
    }

    // (2) 展开网格
    const allCombos = generateGrid(input.param_grid);
    const maxCombos = Math.min(Math.max(Number(options.max_combos || 256), 1), 4096);
    const combos = allCombos.slice(0, maxCombos);

    if (combos.length === 0) {
      throw new Error(
        `GridSearchOptimizer.optimize: 参数网格为空（任一维度是空数组？grid=${JSON.stringify(
          input.param_grid
        )}）`
      );
    }

    // (3) 写 OptimizationRun
    let run: OptimizationRun | null = null;
    if (persist) {
      run = await OptimizationRun.create({
        strategy_name: input.strategy_key,
        param_grid_json: input.param_grid,
        backtest_config_json: input.base_config as Record<string, any>,
        status: 'running',
        total_combos: combos.length,
        completed_combos: 0,
        failed_combos: 0,
        created_by: options.user_id,
        started_at: new Date(),
      });
    }

    // (4) 跑 N 次 backtest，失败隔离
    const results: OptimizationResultRecord[] = [];
    let failedCount = 0;

    try {
      const summaries = await runWithConcurrency(
        combos,
        async (params, index) => {
          const fullOptions: QuantBacktestOptions = {
            ...input.base_config,
            strategy_keys: [input.strategy_key],
            params_by_strategy: {
              [input.strategy_key]: params,
            },
          };
          const t0 = Date.now();
          try {
            const summary = await runner({ params, index }, fullOptions);
            const durationSeconds = (Date.now() - t0) / 1000;
            return { ok: true as const, params, index, summary, duration_seconds: durationSeconds };
          } catch (err) {
            const durationSeconds = (Date.now() - t0) / 1000;
            failedCount += 1;
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(
              `[grid-search] combo #${index} failed for ${input.strategy_key}: ${message}`
            );
            return {
              ok: false as const,
              params,
              index,
              error_message: message,
              duration_seconds: durationSeconds,
            };
          }
        },
        options.concurrency || 1
      );

      // 把内存里的 summary 算成 OptimizationResult（持久化或纯内存）
      for (const item of summaries) {
        if (item.ok) {
          const score = computeCompositeScore(item.summary, weights);
          const record: OptimizationResultRecord = {
            id: 0,
            run_id: run?.id ?? 0,
            combo_index: item.index,
            params_json: item.params,
            sharpe: roundTo(item.summary.sharpe, 4),
            annual_return: roundTo(item.summary.annual_return, 4),
            max_drawdown: roundTo(Math.abs(item.summary.max_drawdown), 4),
            total_return: isFiniteOrNull(item.summary.total_return),
            win_rate: isFiniteOrNull(item.summary.win_rate),
            trade_count: item.summary.trade_count ?? null,
            composite_score: score,
            status: 'completed',
            error_message: null,
            duration_seconds: roundTo(item.duration_seconds, 3),
          };
          if (persist && run) {
            const created = await OptimizationResult.create(record as any);
            record.id = created.id;
          }
          results.push(record);
        } else {
          const record: OptimizationResultRecord = {
            id: 0,
            run_id: run?.id ?? 0,
            combo_index: item.index,
            params_json: item.params,
            sharpe: null,
            annual_return: null,
            max_drawdown: null,
            total_return: null,
            win_rate: null,
            trade_count: null,
            composite_score: null,
            status: 'failed',
            error_message: item.error_message,
            duration_seconds: roundTo(item.duration_seconds, 3),
          };
          if (persist && run) {
            const created = await OptimizationResult.create(record as any);
            record.id = created.id;
          }
          results.push(record);
        }
      }
    } catch (err) {
      // 顶层 unexpected error（不该发生，因 worker 已包了 try/catch）
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

    // (5) 排序：composite_score DESC（null 推到最末）
    const ranked = sortByCompositeScoreDesc(results);
    const best = ranked.find(r => r.status === 'completed' && r.composite_score !== null) || null;

    // (6) 回写 OptimizationRun.completed / best_result_id
    if (persist && run) {
      await run.update({
        status: 'completed',
        completed_combos: results.length,
        failed_combos: failedCount,
        best_result_id: best?.id ?? null,
        finished_at: new Date(),
      });
    }

    return {
      run,
      results,
      best,
      ranked,
      combos_run: results.length,
      failed_combos: failedCount,
    };
  }

  /**
   * 查询一个 OptimizationRun 的所有 results，已按 composite_score 排序。
   * 让 CLI / 前端复算结果时不必重复 sort 逻辑。
   *
   * 返回 plain-object records（OptimizationResultRecord），与 optimize() 的
   * 返回类型一致；内部读 Sequelize model 后做一次 dataValues 萃取。
   */
  async getRunResults(run_id: number): Promise<OptimizationResultRecord[]> {
    const rows = await OptimizationResult.findAll({
      where: { run_id },
      order: [['combo_index', 'ASC']],
    });
    const records = rows.map(modelToRecord);
    return sortByCompositeScoreDesc(records);
  }

  /**
   * 列出指定 strategy 的最近 N 个 OptimizationRun（已完成的）。
   */
  async listRuns(
    options: { strategy_name?: string; limit?: number; user_id?: number } = {}
  ): Promise<OptimizationRun[]> {
    const where: Record<string, any> = {};
    if (options.strategy_name) where.strategy_name = options.strategy_name;
    if (options.user_id) where.created_by = options.user_id;
    return OptimizationRun.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(options.limit || 30), 1), 200),
    });
  }

  /**
   * 删除一个 run + 所有相关 results（CLI --clean 用）。
   */
  async deleteRun(run_id: number): Promise<{ deleted_results: number; deleted_run: number }> {
    const deleted_results = await OptimizationResult.destroy({ where: { run_id } });
    const deleted_run = await OptimizationRun.destroy({ where: { id: run_id } });
    return { deleted_results, deleted_run };
  }

  /**
   * 清理 N 天前的所有 OptimizationRun + 关联 results。
   */
  async cleanupOlderThan(days: number): Promise<{ deleted_runs: number; deleted_results: number }> {
    const cutoff = new Date(Date.now() - Math.max(1, days) * 24 * 3600 * 1000);
    const oldRuns = await OptimizationRun.findAll({
      where: { created_at: { [Op.lt]: cutoff } },
      attributes: ['id'],
    });
    const runIds = oldRuns.map(r => r.id);
    if (!runIds.length) return { deleted_runs: 0, deleted_results: 0 };
    const deleted_results = await OptimizationResult.destroy({
      where: { run_id: { [Op.in]: runIds } },
    });
    const deleted_runs = await OptimizationRun.destroy({ where: { id: { [Op.in]: runIds } } });
    return { deleted_runs, deleted_results };
  }
}

/**
 * 按 composite_score DESC 排序结果列表。null 推到最末，同分时按 combo_index ASC
 * 稳定 tie-break（保证音重放结果一致）。Export 让 caller / 单测都能复算同样的排序。
 *
 * 接受 plain-object record 数组（OptimizationResultRecord）；不接受
 * Sequelize Model 实例 —— 让 sort 完全脱离 Sequelize / DB 初始化。
 */
export function sortByCompositeScoreDesc(
  rows: OptimizationResultRecord[]
): OptimizationResultRecord[] {
  return [...rows].sort((a, b) => {
    const sa =
      a.composite_score === null || a.composite_score === undefined
        ? -Infinity
        : Number(a.composite_score);
    const sb =
      b.composite_score === null || b.composite_score === undefined
        ? -Infinity
        : Number(b.composite_score);
    if (sa !== sb) return sb - sa;
    return Number(a.combo_index) - Number(b.combo_index);
  });
}

/**
 * 把 Sequelize 的 OptimizationResult model 实例转成 plain record。
 * 用于 `getRunResults()`：DB 拉出的 model 转成与 in-memory 结果同型的对象，
 * 让 caller 只需关心一个返回类型。
 */
function modelToRecord(row: OptimizationResult): OptimizationResultRecord {
  return {
    id: row.id,
    run_id: row.run_id,
    combo_index: row.combo_index,
    params_json: row.params_json,
    sharpe: row.sharpe === null || row.sharpe === undefined ? null : Number(row.sharpe),
    annual_return:
      row.annual_return === null || row.annual_return === undefined
        ? null
        : Number(row.annual_return),
    max_drawdown:
      row.max_drawdown === null || row.max_drawdown === undefined ? null : Number(row.max_drawdown),
    total_return:
      row.total_return === null || row.total_return === undefined ? null : Number(row.total_return),
    win_rate: row.win_rate === null || row.win_rate === undefined ? null : Number(row.win_rate),
    trade_count:
      row.trade_count === null || row.trade_count === undefined ? null : Number(row.trade_count),
    composite_score:
      row.composite_score === null || row.composite_score === undefined
        ? null
        : Number(row.composite_score),
    status: row.status as OptimizationResultRecord['status'],
    error_message: row.error_message ?? null,
    duration_seconds:
      row.duration_seconds === null || row.duration_seconds === undefined
        ? null
        : Number(row.duration_seconds),
  };
}

function isFiniteOrNull(value: number | undefined | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? roundTo(n, 4) : null;
}

// Default singleton (使用模式同 backtestEngine / strategyEngine 等)
export const gridSearchOptimizer = new GridSearchOptimizer();
