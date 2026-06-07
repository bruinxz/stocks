import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * BenchmarkAttributionResult — 基准比较与超额收益拆解（US-045）
 *
 * 一行 = 一次回测结果（QuantBacktestResult.id）vs **一个基准** 的归因结果。
 * 一次回测对默认 3 个基准（HS300 / CSI500 / CSI1000）会产生 3 行；UI 可一次
 * 取出展示「策略 X 对沪深 300 alpha=12% / 中证 500 alpha=8% / 中证 1000
 * alpha=5%」的多基准对比表。
 *
 * **`run_id` 语义**：
 *   - `NOT NULL` 时引用 QuantBacktestResult.id（被归因的父回测）。
 *   - 仅在 BenchmarkAttributionService.computeAttribution(persist: true) 时落库
 *     （in-memory dry-run 场景不写本表）。
 *
 * **4-tuple PK (run_id, benchmark_symbol, period_start, period_end)**：
 *   - 同一回测对同一基准在相同区间重跑时 idempotent upsert（覆盖最新统计）。
 *   - 若 caller 想保留多次重算的历史（"3 月 1 日跑过一次，5 月 1 日重跑"），
 *     period_start / period_end 已经写在 PK 里 → 不同 caller-提供的日期 = 不同行。
 *   - 与 US-041 FactorICResult / US-042 FactorCorrelationResult 同款 4-tuple PK
 *     范式 — 都是「事后分析」类型，PK 包含分析窗口。
 *
 * **指标定义**（CAPM 回归 + 超额收益）：
 *   - `alpha_annual_pct`：年化 alpha (%) = CAPM 回归截距 * 252（年化）。
 *     公式：r_strategy - r_benchmark = alpha + beta * r_benchmark + epsilon
 *     正值表示策略相对基准有超额；负值表示跑输基准。
 *   - `beta`：CAPM 回归斜率（无量纲）。
 *     beta = 1 表示策略与基准等比例波动；
 *     beta > 1 表示策略波动放大基准（高敏感）；
 *     beta < 1 表示策略波动小于基准（低敏感，可能是防御性策略）。
 *   - `information_ratio`：(策略 - 基准) 超额收益的 Sharpe = mean(excess) / std(excess) * sqrt(252)。
 *     IR > 0.5 通常被认为是「值得继续跑」的策略；
 *     IR > 1.0 是「优秀」级别。
 *   - `excess_return_pct`：策略累计收益 - 基准累计收益（百分数，整段差值）。
 *   - `excess_drawdown_pct`：基于「策略-基准」逐日 excess return 序列算的最大回撤
 *     （正数）。代表「相对基准最差的连续相对回撤」。
 *
 * **诊断字段**（让 ops 看到底是真信号还是噪音）：
 *   - `sample_count`：用于回归的对齐后日收益数（不是策略 / 基准各自长度，是 ∩ 后）。
 *   - `r_squared`：CAPM 回归的 R² (0..1)；接近 1 = 策略基本就是基准 + alpha；
 *     接近 0 = 策略与基准无关（alpha 反而更纯）。
 *   - `strategy_return_pct` / `benchmark_return_pct`：分别的累计收益（百分数）。
 *
 * **strategy_key 物化**：让「multi_factor_alpha 在沪深 300 上的 alpha 历次回测平均」
 * 跨 run 聚合查询不必 JOIN 父表；冗余几十字节换查询效率（与 RegimeBacktestResult
 * 同款判据）。
 *
 * 主要消费方：
 *   - BenchmarkAttributionService.computeAttribution()（US-045）
 *   - QuantBacktestService 完成 hook（每次回测完成后自动触发）
 *   - 未来 US-016 策略实验室 "基准对比" tab（多基准 alpha/beta 雷达图）
 *   - 未来 US-046 IndustryAttributionService 可能联表（行业 alpha vs 整体 alpha）
 *
 * **设计取舍 — 不复用 OptimizationRun 父表**（与 US-040/US-041/US-042/US-043/US-044 判据一致）：
 *   - 基准归因是「对一次已完成回测做事后统计」，不是新的优化任务；
 *   - 通过 `run_id` 直接引用 QuantBacktestResult.id，关联清晰；
 *   - 不需要 status='pending'→'running'→'completed' 状态机（归因是同步本地算法，几百 ms）。
 */
@Table({
  tableName: 'benchmark_attribution_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['run_id'] },
    { fields: ['run_id', 'benchmark_symbol'] },
    {
      fields: ['run_id', 'benchmark_symbol', 'period_start', 'period_end'],
      unique: true,
      name: 'benchmark_attribution_results_pk_idx',
    },
    { fields: ['strategy_key', 'benchmark_symbol'] },
    { fields: ['benchmark_symbol'] },
    { fields: ['period_end'] },
  ],
})
export class BenchmarkAttributionResult extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'run_id',
    comment: '关联 QuantBacktestResult.id（被归因的父回测）',
  })
  declare run_id: number;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'strategy_key',
    comment: '被回测的 strategy_key（物化避免 JOIN 父表的跨 run 聚合）',
  })
  declare strategy_key: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'benchmark_symbol',
    comment: '基准代码（e.g. sh.000300 / sh.000905 / sh.000852）',
  })
  declare benchmark_symbol: string;

  @Column({
    type: DataType.STRING(40),
    allowNull: true,
    field: 'benchmark_name',
    comment: '基准名称（e.g. 沪深 300 / 中证 500 / 中证 1000）',
  })
  declare benchmark_name?: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_start',
    comment: '归因区间起始日（YYYY-MM-DD，闭区间）',
  })
  declare period_start: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_end',
    comment: '归因区间结束日（YYYY-MM-DD，闭区间）',
  })
  declare period_end: string;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'alpha_annual_pct',
    comment: '年化 alpha 百分比（CAPM 回归截距 × 252；正值=跑赢基准）',
  })
  declare alpha_annual_pct?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: 'CAPM 回归 beta（无量纲；1=同步波动 / >1=高敏感 / <1=低敏感）',
  })
  declare beta?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'information_ratio',
    comment: '信息比率 = mean(excess_return) / std(excess_return) × sqrt(252)',
  })
  declare information_ratio?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'excess_return_pct',
    comment: '超额收益百分比（策略累计 - 基准累计；正值=跑赢）',
  })
  declare excess_return_pct?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'excess_drawdown_pct',
    comment: '超额回撤百分比（基于策略-基准逐日差的最大回撤，正数）',
  })
  declare excess_drawdown_pct?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'sample_count',
    defaultValue: 0,
    comment: '用于回归的对齐后日收益数（策略 ∩ 基准 ∩ 有效）',
  })
  declare sample_count: number;

  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: true,
    field: 'r_squared',
    comment: 'CAPM 回归 R²（0..1；接近 1 = 策略基本是基准 + alpha）',
  })
  declare r_squared?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'strategy_return_pct',
    comment: '策略整段累计收益百分比',
  })
  declare strategy_return_pct?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'benchmark_return_pct',
    comment: '基准整段累计收益百分比',
  })
  declare benchmark_return_pct?: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'computed_at',
    comment: '计算完成时间（ops 看刷新时间）',
  })
  declare computed_at?: Date;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'benchmark_attribution_service',
    comment: '产出来源（默认 benchmark_attribution_service；可自定义如 backtest_hook）',
  })
  declare source: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
