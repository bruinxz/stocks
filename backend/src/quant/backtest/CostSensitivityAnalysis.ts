/**
 * CostSensitivityAnalysis — 交易成本敏感性分析（US-085）
 *
 * 对一次已完成的回测（QuantBacktestTask.id），按 3 档佣金费率（万 1.5 / 万 2.5 /
 * 万 5）逐档重跑 quantBacktestEngine.run()，把各档的 annual_return / sharpe /
 * turnover / 其他核心指标 落到 CostSensitivityResult 表，方便策略验证者一眼看出
 * "策略对手续费有多敏感"。
 *
 * **为什么需要敏感性**：
 *   多因子策略 sharpe=1.5 在万 2.5 下成立 ≠ 万 5 下仍成立。高频/换手频繁的策略
 *   (CTA100 / GameTraderRelay / Breakout) 对佣金极敏感；低频长线策略 (HighDividend /
 *   GARP) 对佣金不敏感。本分析让用户主动量化这种敏感度 — alpha 是否被券商吃光，
 *   一目了然。
 *
 * **设计判据：不复用 OptimizationRun 父表（US-040 同款）**：
 *   - US-037/038/039 共享 OptimizationRun，因为他们都是"任务"（status 状态机）。
 *   - 本模块对一个已完成 backtest 做派生统计，不是新的任务；通过 FK 引用源
 *     QuantBacktestResult.id 即可，关联清晰。详见 backend/src/quant/backtest/
 *     CLAUDE.md "事后分析 vs 优化任务" 一节。
 *
 * **核心模式**：
 *   1. **DataSource 注入**（loadTask / loadResults / loadContexts / runEngine /
 *      destroyExisting / persistRows）—— 生产实现走真实 DB + quantBacktestEngine；
 *      测试注入 fake 完全脱 DB。
 *   2. **COST_LEVELS 固定 3 档 Object.freeze**（avoid mutation），同 US-037
 *      DEFAULT_*_CONFIG 模板。新增档位修常量。
 *   3. **plain-object 返回类型** CostSensitivityAnalysisResult（含 persisted:
 *      boolean）—— persist=true / dry_run=true 都返回同一 shape，与 US-037
 *      OptimizationResultRecord 范式一致。
 *   4. **persist=true 时先 destroy 后 bulkCreate**——同 (base_run_id, strategy_key,
 *      cost_level) 重跑同一分析时干净 upsert，避免脏读。
 *   5. **per-level 串行 await**（不 Promise.all）——回测引擎本身是 CPU-heavy 同步
 *      循环，并行不加速；串行让进度日志 / 内存占用都可控。
 *
 * **公共接口**：
 *   - `analyze(base_task_id, options?)` — 异步执行一次完整分析；选择性写入
 *     CostSensitivityResult；返回 { rows, summary }。
 *   - `getRunRows(base_run_id)` — 按 cost_level 升序查询某 base run 的全部档结果。
 *   - `deleteRun(base_run_id)` — 删除某 base run 的全部档结果（保留父 backtest）。
 *   - `cleanupOlderThan(days)` — 删除 N 天前的全部行。
 *
 * **三个纯函数 helper（独立单测）**：
 *   - `computeTurnover(trades)` — 总成交额 = sum(buy_amount + sell_amount)，
 *     未平仓 trade 只算 buy_amount。
 *   - `buildRowsFromEngineResult(...)` — 把 engine.run() 的输出 + cost level
 *     映射到 CostSensitivityResult row shape。
 *   - `summarizeSensitivity(rows)` — 给 (strategy_key → [3 档 rows])，输出
 *     return_drop_pct / sharpe_drop_pct（从最低费率档到最高费率档的衰减）。
 *
 * **错误隔离 per-level**：
 *   - 某档 engine.run 抛错 → 该档 row 落入 errors[] 但其他档继续；
 *   - persist 阶段抛错 → 返回 result 仍含 rows + persisted=false + persist_error
 *     字段，让 ops 事后查（与 US-055 fail-OPEN on saveReport 同款）。
 *
 * **关键约束**：
 *   - 只重跑 commission_rate，**不变**印花税 / 过户费 / 滑点 / 涨跌停 / T+1
 *     等其他约束 —— 单变量敏感性分析，避免多变量混杂。
 *   - 一个 task 的多策略各自独立分析；每个 (strategy × level) 一行。
 *   - benchmark_return 不重算 —— 基准是策略外生变量，3 档佣金不影响基准。
 *   - turnover 单位是 RMB 元（与 trades[].amount 同单位）。
 *
 * 主要消费方：
 *   - QuantController.runCostSensitivityAnalysis endpoint（US-085）
 *   - 未来 US-016 策略实验室 "成本敏感性" tab
 *   - run-cost-sensitivity.ts CLI（潜在 US-098 扩展）
 */

import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { CostSensitivityResult } from '../../models/CostSensitivityResult';
import { QuantBacktestResult } from '../../models/QuantBacktestResult';
import { QuantBacktestTask } from '../../models/QuantBacktestTask';
import {
  QuantBacktestOptions,
  QuantBacktestStrategyResult,
  QuantBacktestTradeResult,
  QuantStockContext,
} from '../types/QuantTypes';

// ============================================================
// 常量 — 3 档费率
// ============================================================

export interface CostLevelDefinition {
  /** 档位标签（万 1.5 / 万 2.5 / 万 5） */
  readonly level: string;
  /** 佣金率（小数） */
  readonly commission_rate: number;
}

/**
 * AC 指定的 3 档费率档位。
 *
 * - 万 1.5（0.00015）：互联网券商折扣（少数特殊渠道）
 * - 万 2.5（0.00025）：主流互联网券商 2024-2026 报价（默认）
 * - 万 5（0.0005）：传统券商标准费率
 *
 * Object.freeze 防外部意外 mutation（US-037 范式）。
 * 顺序由低到高 — summarize 计算 drop_pct 时假设最低档在 [0] 最高档在末位。
 */
export const COST_LEVELS: ReadonlyArray<CostLevelDefinition> = Object.freeze([
  Object.freeze({ level: '万1.5', commission_rate: 0.00015 }),
  Object.freeze({ level: '万2.5', commission_rate: 0.00025 }),
  Object.freeze({ level: '万5', commission_rate: 0.0005 }),
]);

// ============================================================
// 类型
// ============================================================

/**
 * 单个 (strategy_key × cost_level) 的分析结果 — 与 CostSensitivityResult 模型
 * 字段对齐。**plain-object** 不依赖 Sequelize 实例化（持久化前后都用此 shape）。
 */
export interface CostSensitivityRow {
  base_run_id: number;
  base_task_id: number;
  strategy_key: string;
  cost_level: string;
  commission_rate: number;
  annual_return_pct: number;
  sharpe_ratio: number;
  total_return_pct: number;
  max_drawdown_pct: number;
  win_rate: number | null;
  trade_count: number;
  turnover: number;
  metadata_json: Record<string, any>;
}

/**
 * per-strategy 摘要 — 从最低费率档到最高费率档的衰减幅度。
 * - return_drop_pct: 年化收益降低多少百分点（正数 = 高费率下衰退）
 * - sharpe_drop:     夏普降低多少（正数 = 高费率下衰退）
 * - turnover_avg:    3 档平均成交额（费率本身不影响成交决策，3 档应近似相等）
 */
export interface CostSensitivitySummary {
  strategy_key: string;
  levels_count: number;
  return_drop_pct: number | null;
  sharpe_drop: number | null;
  turnover_avg: number;
}

/**
 * analyze() 的返回类型。
 * - rows: 持久化 / dry_run 都返回同 shape（与 OptimizationResultRecord 范式一致）
 * - summary: per-strategy 衰减摘要（便于上层 UI 直接展示）
 * - persisted: true = 已写入 CostSensitivityResult；false = dry_run 或 persist 失败
 * - persist_error: 持久化失败时附错误消息（fail-OPEN，rows 仍可用）
 * - errors: per-level 失败时附错误（不阻塞其他档）
 */
export interface CostSensitivityAnalysisResult {
  base_task_id: number;
  base_run_ids: number[];
  rows: CostSensitivityRow[];
  summary: CostSensitivitySummary[];
  persisted: boolean;
  persist_error?: string;
  errors?: Array<{ cost_level: string; strategy_key?: string; message: string }>;
}

/**
 * analyze() 选项。
 */
export interface CostSensitivityAnalyzeOptions {
  /** 是否落库（默认 true）。dry_run=true 用于 UI 预览。 */
  persist?: boolean;
  /** 仅分析指定 cost_level（默认全部 3 档）—— 用于增量补跑或调试。 */
  cost_levels?: string[];
  /** 元数据写入 metadata_json（生成时间 / 触发用户 / etc）。 */
  metadata?: Record<string, any>;
}

// ============================================================
// 纯函数 helper
// ============================================================

/**
 * 计算总成交额（turnover） = sum(buy_amount + sell_amount) over all trades。
 *
 * **定义**：
 *   - 完整 round-trip trade（buy + sell 都完成）：算 2× amount（买入 + 卖出各算一次）
 *   - 未平仓 trade（sell_date is null）：只算 buy_amount = buy_price * quantity
 *   - quantity / price 为非有限数 / 负值 → 跳过该 trade（防御性）
 *
 * **为什么 turnover 是费率敏感性的关键指标**：
 *   - 佣金 = turnover * commission_rate（双边）
 *   - 高 turnover 策略（CTA / 短线）对佣金敏感度 = turnover × Δcommission_rate
 *   - 低 turnover 策略（HighDividend / GARP）即使费率翻倍年化也不变
 *
 * trades[].amount 是 sell amount（QuantBacktestEngine.executeSellOrder 把 sellPrice
 * × quantity 写到 amount 字段，buy_price × quantity 没有单独存）。
 */
export function computeTurnover(trades: QuantBacktestTradeResult[]): number {
  if (!Array.isArray(trades) || !trades.length) return 0;
  let total = 0;
  for (const trade of trades) {
    const quantity = Number(trade?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    const buyPrice = Number(trade?.buy_price);
    if (Number.isFinite(buyPrice) && buyPrice > 0) {
      total += buyPrice * quantity;
    }
    // amount 字段 = sellPrice * quantity（仅 round-trip 完成的 trade 有）
    const sellAmount = Number(trade?.amount);
    if (
      Number.isFinite(sellAmount) &&
      sellAmount > 0 &&
      trade?.sell_date // 仅完整 round-trip 才计入 sell 端
    ) {
      total += sellAmount;
    }
  }
  return Math.round(total * 100) / 100; // round 到分
}

/**
 * 把一档 engine.run() 的 per-strategy 输出映射到 CostSensitivityRow。
 *
 * 输入：
 *   - engineResult: 单策略的 engine.run 返回行（含 trades / metrics）
 *   - costLevel: { level, commission_rate }
 *   - context: { base_task_id, base_run_id, metadata }
 *
 * **base_run_id 解析**：
 *   - 调用方按 strategy_key 在 baseResults Map 里找匹配的 QuantBacktestResult.id；
 *   - 找不到（罕见，e.g. 用户重命名策略 key）→ throw（不应静默落库错误 FK）。
 */
export function buildRowFromEngineResult(
  engineResult: QuantBacktestStrategyResult,
  costLevel: CostLevelDefinition,
  context: {
    base_task_id: number;
    base_run_id: number;
    metadata?: Record<string, any>;
  }
): CostSensitivityRow {
  const turnover = computeTurnover(engineResult.trades || []);
  const trade_count = Array.isArray(engineResult.trades) ? engineResult.trades.length : 0;

  // win_rate = NULL 当 trade_count = 0（与模型 jsdoc 对齐）
  const winRate =
    trade_count === 0 ? null : Math.max(0, Math.min(1, Number(engineResult.win_rate || 0) / 100));
  // engineResult.win_rate 已是百分数（0..100）；除以 100 转 0..1 小数。

  return {
    base_task_id: context.base_task_id,
    base_run_id: context.base_run_id,
    strategy_key: engineResult.strategy_key,
    cost_level: costLevel.level,
    commission_rate: costLevel.commission_rate,
    annual_return_pct: Number(engineResult.annual_return_pct || 0),
    sharpe_ratio: Number(engineResult.sharpe_ratio || 0),
    total_return_pct: Number(engineResult.total_return_pct || 0),
    max_drawdown_pct: Math.abs(Number(engineResult.max_drawdown_pct || 0)),
    win_rate: winRate,
    trade_count,
    turnover,
    metadata_json: {
      ...(context.metadata || {}),
      generated_at: new Date().toISOString(),
      profit_factor: Number(engineResult.profit_factor || 0),
      avg_holding_days: Number(engineResult.avg_holding_days || 0),
      benchmark_return_pct:
        engineResult.benchmark_return_pct != null
          ? Number(engineResult.benchmark_return_pct)
          : null,
    },
  };
}

/**
 * 把 N 档 × M 策略 = N×M 行汇总成 per-strategy 衰减摘要。
 *
 * 算法：
 *   1. 按 strategy_key group rows
 *   2. 对每组按 commission_rate 升序排序
 *   3. drop_pct = first.annual_return_pct - last.annual_return_pct（高费率衰退多少）
 *   4. 不足 2 档 → drop_pct = null（无法对比）
 *
 * 注：drop 字段是绝对差不是比率 — "年化从 12% 跌到 8% = drop 4%" 比 "跌 33%" 直观。
 */
export function summarizeSensitivity(rows: CostSensitivityRow[]): CostSensitivitySummary[] {
  if (!Array.isArray(rows) || !rows.length) return [];

  const byStrategy = new Map<string, CostSensitivityRow[]>();
  for (const row of rows) {
    if (!byStrategy.has(row.strategy_key)) byStrategy.set(row.strategy_key, []);
    byStrategy.get(row.strategy_key)!.push(row);
  }

  const summaries: CostSensitivitySummary[] = [];
  for (const [strategy_key, strategyRows] of byStrategy.entries()) {
    const sorted = [...strategyRows].sort((a, b) => a.commission_rate - b.commission_rate);
    const turnover_avg = sorted.length
      ? sorted.reduce((sum, r) => sum + Number(r.turnover || 0), 0) / sorted.length
      : 0;

    let return_drop_pct: number | null = null;
    let sharpe_drop: number | null = null;
    if (sorted.length >= 2) {
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      return_drop_pct = Number(first.annual_return_pct) - Number(last.annual_return_pct);
      sharpe_drop = Number(first.sharpe_ratio) - Number(last.sharpe_ratio);
    }

    summaries.push({
      strategy_key,
      levels_count: sorted.length,
      return_drop_pct,
      sharpe_drop,
      turnover_avg: Math.round(turnover_avg * 100) / 100,
    });
  }
  // strategy_key 字典序稳定输出（前端表格友好）
  summaries.sort((a, b) => a.strategy_key.localeCompare(b.strategy_key));
  return summaries;
}

/**
 * 过滤 cost_levels 选项 — 大小写不敏感 + 静默忽略未知 level（与 US-055
 * normalizeAnalysisDimensions 模式一致：用户输入容错优先于 4xx）。
 */
export function filterCostLevels(
  levels: string[] | undefined,
  available: ReadonlyArray<CostLevelDefinition>
): CostLevelDefinition[] {
  if (!Array.isArray(levels) || !levels.length) return [...available];
  const wanted = new Set(levels.map(l => String(l).trim()).filter(Boolean));
  if (!wanted.size) return [...available];
  const matched = available.filter(l => wanted.has(l.level));
  return matched.length ? matched : [...available];
}

// ============================================================
// DataSource — 抽象依赖 quantBacktestEngine / quantDataService / DB
// ============================================================

/**
 * 抽象本模块运行所需的所有 IO。生产实现走真实 backtest engine + DB；
 * 测试注入 fake 完全脱 DB。
 */
export interface CostSensitivityDataSource {
  /** 拉父 task；找不到返回 null */
  loadTask(base_task_id: number): Promise<QuantBacktestTask | null>;
  /** 拉父 task 的全部 QuantBacktestResult（per-strategy） */
  loadResults(base_task_id: number): Promise<QuantBacktestResult[]>;
  /** 拉策略需要的 stock contexts（与 QuantBacktestService.processBacktestTask 同样的 universe / date_range） */
  loadContexts(options: QuantBacktestOptions, user_id?: number): Promise<QuantStockContext[]>;
  /** 跑一次回测引擎（注入 cost-overridden options） */
  runEngine(
    contexts: QuantStockContext[],
    options: QuantBacktestOptions
  ): QuantBacktestStrategyResult[];
  /** 删除已存在的 (base_run_id, cost_level) 行 — 用于 idempotent upsert */
  destroyExisting(base_run_ids: number[], cost_levels: string[]): Promise<number>;
  /** 批量写入 — Sequelize bulkCreate 等价 */
  persistRows(rows: CostSensitivityRow[]): Promise<CostSensitivityResult[]>;
}

class DefaultCostSensitivityDataSource implements CostSensitivityDataSource {
  loadTask(base_task_id: number): Promise<QuantBacktestTask | null> {
    return QuantBacktestTask.findByPk(base_task_id) as Promise<QuantBacktestTask | null>;
  }

  loadResults(base_task_id: number): Promise<QuantBacktestResult[]> {
    return QuantBacktestResult.findAll({ where: { task_id: base_task_id } });
  }

  async loadContexts(
    options: QuantBacktestOptions,
    user_id?: number
  ): Promise<QuantStockContext[]> {
    // lazy require 避免顶层 import quantDataService 让测试启动整个 quant/engine/
    // 子系统（同 US-037 BenchmarkSelector default DataSource 模式）。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { quantDataService } = require('../../services/QuantDataService');
    return quantDataService.getContexts({
      universe: options.universe || 'market',
      user_id,
      symbols: options.symbols,
      start_date: options.start_date,
      end_date: options.end_date,
      warmup_days: 160,
      limit: options.candidate_limit || 120,
      include_realtime_quote: false,
    });
  }

  runEngine(
    contexts: QuantStockContext[],
    options: QuantBacktestOptions
  ): QuantBacktestStrategyResult[] {
    // lazy require 避免顶层 import 让 ts-node 单测加载 160+ files
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { quantBacktestEngine } = require('./internal/QuantBacktestEngine');
    return quantBacktestEngine.run(contexts, options);
  }

  async destroyExisting(base_run_ids: number[], cost_levels: string[]): Promise<number> {
    if (!base_run_ids.length || !cost_levels.length) return 0;
    return CostSensitivityResult.destroy({
      where: {
        base_run_id: { [Op.in]: base_run_ids },
        cost_level: { [Op.in]: cost_levels },
      },
    });
  }

  persistRows(rows: CostSensitivityRow[]): Promise<CostSensitivityResult[]> {
    if (!rows.length) return Promise.resolve([]);
    return CostSensitivityResult.bulkCreate(rows as any);
  }
}

export const PRODUCTION_COST_SENSITIVITY_DATA_SOURCE: CostSensitivityDataSource =
  new DefaultCostSensitivityDataSource();

// ============================================================
// 主流程
// ============================================================

export interface CostSensitivityAnalyzerOptions {
  data_source?: CostSensitivityDataSource;
}

export class CostSensitivityAnalysis {
  constructor(
    private dataSource: CostSensitivityDataSource = PRODUCTION_COST_SENSITIVITY_DATA_SOURCE
  ) {}

  /**
   * 对 base_task_id 的回测按 3 档佣金重跑并落库（默认 persist=true）。
   *
   * 步骤：
   *   1. 拉 base task + 全部 QuantBacktestResult（per-strategy 行）
   *   2. 重建 QuantBacktestOptions（同 QuantBacktestService.getCleanBacktestOptions）
   *   3. 拉 contexts（同原回测的 universe / date_range / candidate_limit）
   *   4. 对每个 cost_level：override commission_rate，跑 engine，把每策略输出
   *      映射成 CostSensitivityRow，错误隔离
   *   5. persist=true 时先 destroy 后 bulkCreate
   *   6. summarize → 返回 { rows, summary, persisted }
   */
  async analyze(
    base_task_id: number,
    options: CostSensitivityAnalyzeOptions = {}
  ): Promise<CostSensitivityAnalysisResult> {
    const persist = options.persist !== false;
    const task = await this.dataSource.loadTask(base_task_id);
    if (!task) {
      throw new Error(`基础回测任务不存在: ${base_task_id}`);
    }

    const results = await this.dataSource.loadResults(base_task_id);
    if (!results.length) {
      throw new Error(`基础回测无 per-strategy 结果可分析: ${base_task_id}`);
    }

    const resultByStrategy = new Map<string, QuantBacktestResult>();
    for (const r of results) {
      resultByStrategy.set(r.strategy_key, r);
    }
    const baseRunIds = results.map(r => r.id);

    const baseOptions: QuantBacktestOptions = this.rebuildBacktestOptions(task);
    const levels = filterCostLevels(options.cost_levels, COST_LEVELS);

    // contexts 在 3 档之间共享 — 同样的 universe / dates 拉一次就够
    let contexts: QuantStockContext[];
    try {
      contexts = await this.dataSource.loadContexts(baseOptions, task.user_id);
    } catch (err: any) {
      throw new Error(
        `加载 stock contexts 失败: ${err?.message || err} (universe=${baseOptions.universe} ${
          baseOptions.start_date
        }..${baseOptions.end_date})`
      );
    }

    const rows: CostSensitivityRow[] = [];
    const errors: Array<{ cost_level: string; strategy_key?: string; message: string }> = [];

    for (const level of levels) {
      const overriddenOptions: QuantBacktestOptions = {
        ...baseOptions,
        commission_rate: level.commission_rate,
      };

      let engineResults: QuantBacktestStrategyResult[];
      try {
        engineResults = this.dataSource.runEngine(contexts, overriddenOptions);
      } catch (err: any) {
        errors.push({
          cost_level: level.level,
          message: `engine 抛错: ${err?.message || err}`,
        });
        continue;
      }

      for (const engineResult of engineResults) {
        const baseResult = resultByStrategy.get(engineResult.strategy_key);
        if (!baseResult) {
          // 罕见：原回测无该策略行（数据漂移 / strategy_key 重命名）
          errors.push({
            cost_level: level.level,
            strategy_key: engineResult.strategy_key,
            message: '未在基础回测中找到匹配 strategy_key 的 QuantBacktestResult',
          });
          continue;
        }
        try {
          rows.push(
            buildRowFromEngineResult(engineResult, level, {
              base_task_id,
              base_run_id: baseResult.id,
              metadata: options.metadata,
            })
          );
        } catch (err: any) {
          errors.push({
            cost_level: level.level,
            strategy_key: engineResult.strategy_key,
            message: `row 构造失败: ${err?.message || err}`,
          });
        }
      }
    }

    let persisted = false;
    let persist_error: string | undefined;

    if (persist && rows.length) {
      try {
        const runIdsToClean = Array.from(new Set(rows.map(r => r.base_run_id)));
        const levelsToClean = Array.from(new Set(rows.map(r => r.cost_level)));
        await this.dataSource.destroyExisting(runIdsToClean, levelsToClean);
        await this.dataSource.persistRows(rows);
        persisted = true;
      } catch (err: any) {
        // fail-OPEN：rows 仍返回让 caller 拿到数据；写入失败的 metadata 标识，ops 事后查
        persist_error = err?.message || String(err);
        logger.warn('CostSensitivityAnalysis.analyze: persist failed but returning rows', {
          base_task_id,
          row_count: rows.length,
          error: persist_error,
        });
      }
    }

    return {
      base_task_id,
      base_run_ids: baseRunIds,
      rows,
      summary: summarizeSensitivity(rows),
      persisted,
      ...(persist_error ? { persist_error } : {}),
      ...(errors.length ? { errors } : {}),
    };
  }

  /**
   * 查询某 base run 的全部档行（按 commission_rate 升序）。
   */
  async getRunRows(base_run_id: number): Promise<CostSensitivityResult[]> {
    return CostSensitivityResult.findAll({
      where: { base_run_id },
      order: [['commission_rate', 'ASC']],
    });
  }

  /**
   * 删除某 base run 的全部档行（保留父 backtest）。
   */
  async deleteRun(base_run_id: number): Promise<number> {
    return CostSensitivityResult.destroy({ where: { base_run_id } });
  }

  /**
   * 删除 N 天前的全部行（用于 ops cleanup）。
   */
  async cleanupOlderThan(days: number): Promise<number> {
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86400000);
    return CostSensitivityResult.destroy({ where: { created_at: { [Op.lt]: cutoff } } });
  }

  /**
   * 把 QuantBacktestTask 重建为 QuantBacktestOptions —— 与 QuantBacktestService.
   * getCleanBacktestOptions 等价的精简版（去掉 runtime 字段如 last_stage /
   * run_started_at 等不影响 backtest 结果的元数据）。
   *
   * 关键约束：commission_rate / slippage_rate 从 task 取 —— 后续 analyze() 会
   * override commission_rate；slippage_rate 保留原值（单变量分析）。
   */
  private rebuildBacktestOptions(task: QuantBacktestTask): QuantBacktestOptions {
    const parameters = task.parameters || {};
    const runtimeKeys = new Set([
      'queue_job_id',
      'retry_count',
      'retried_at',
      'run_started_at',
      'run_completed_at',
      'run_failed_at',
      'last_stage',
      'last_error',
      'scanned_stocks',
      'benchmark_return',
      'result_count',
      'best_strategy_key',
      'best_return_pct',
      'best_excess_return_pct',
    ]);
    const cleanParameters = Object.fromEntries(
      Object.entries(parameters).filter(([key]) => !runtimeKeys.has(key))
    );
    return {
      ...cleanParameters,
      task_name: task.task_name,
      universe: task.universe,
      strategy_keys: task.strategy_keys,
      symbols: task.symbols,
      start_date: String(task.start_date).slice(0, 10),
      end_date: String(task.end_date).slice(0, 10),
      initial_capital: Number(task.initial_capital || 200000),
      commission_rate: Number(task.commission_rate || 0.00025),
      slippage_rate: Number(task.slippage_rate || 0.0005),
    } as QuantBacktestOptions;
  }
}

export const costSensitivityAnalysis = new CostSensitivityAnalysis();
