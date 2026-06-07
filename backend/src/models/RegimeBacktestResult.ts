import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * RegimeBacktestResult — 分段市场环境回测结果（US-040）
 *
 * 一行 = 一次完成的回测内的一个连续 regime 段（如 2022-01-01..2022-06-15 = bull
 * 段，2022-06-16..2022-09-30 = volatile 段）。一次回测会产生 1..N 行，N 是该回测
 * 期间内 regime 变化的段数。
 *
 * **`run_id` 语义**：
 *   - `NOT NULL` 时引用 QuantBacktestResult.id（被 segment 的父回测）。
 *   - 仅在 RegimeSegmentedBacktest.segment(persist:true) 时落库（不持久化的
 *     dry-run 场景不写本表）。
 *
 * **regime 四分类**（与 EnsembleStrategy.EnsembleMarketRegime 一致）：
 *   - `bull` 趋势上涨
 *   - `bear` 趋势下跌
 *   - `range` 震荡（含 raw 'rebound' / 'unknown'，按"趋势未确认"折叠到 range）
 *   - `volatile` 高波动 / 压力（raw 'stress' 折叠到 volatile）
 *
 * **指标定义**（每段独立计算，与 GridSearchOptimizer.BacktestSummary 字段对齐）：
 *   - `return_pct`：段末/段始权益 - 1，百分数（不是小数；e.g. 12.34 = 12.34%）
 *   - `sharpe`：段内日收益 mean / stddev * sqrt(252)；不足 5 个日收益时为 NULL
 *   - `drawdown_pct`：段内最大回撤的绝对值（正数，与 WalkForwardResult 一致）
 *   - `win_rate`：sell_date ∈ 段内的成交里盈利笔数 / 总成交，0..1 小数；0 笔时 NULL
 *   - `trade_count`：sell_date ∈ 段内的成交数（含亏损与盈利）
 *
 * **strategy_key + benchmark_symbol 物化**：让"看 multi_factor_alpha 在 bull regime
 * 历次回测的平均表现"这种跨 run 聚合查询不必 JOIN 父表；冗余的几十字节换查询效率。
 *
 * 主要消费方：
 *   - RegimeSegmentedBacktest.segment()（US-040）
 *   - run-regime-backtest.ts CLI
 *   - 未来 US-016 策略实验室 "环境分段表现" tab
 *   - 未来 US-046 IndustryAttributionService 可能联表
 */
@Table({
  tableName: 'regime_backtest_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['run_id'] },
    { fields: ['run_id', 'segment_index'], unique: true },
    { fields: ['run_id', 'regime'] },
    { fields: ['strategy_key', 'regime'] },
    { fields: ['regime'] },
    { fields: ['start_date'] },
  ],
})
export class RegimeBacktestResult extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'run_id',
    comment: '关联 QuantBacktestResult.id（被 segment 的父回测）',
  })
  declare run_id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'segment_index',
    comment: '本 run 内的段序号（0-based，按 start_date 升序）',
  })
  declare segment_index: number;

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
    comment: 'regime 检测所用的基准代码（e.g. sh.000300）',
  })
  declare benchmark_symbol: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: 'regime 标签：bull / bear / range / volatile（4 分类）',
  })
  declare regime: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'start_date',
    comment: '段起始交易日（YYYY-MM-DD，闭区间）',
  })
  declare start_date: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'end_date',
    comment: '段结束交易日（YYYY-MM-DD，闭区间）',
  })
  declare end_date: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'day_count',
    comment: '段内交易日数（含起始与结束日）',
  })
  declare day_count: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'return_pct',
    comment: '段内总收益百分比（e.g. 12.34 = +12.34%；亏损为负）',
  })
  declare return_pct: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    comment: '段内夏普率（年化）；不足 5 个日收益时为 NULL',
  })
  declare sharpe?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'drawdown_pct',
    comment: '段内最大回撤百分比（正数；e.g. 8.50 表示 -8.50% 回撤）',
  })
  declare drawdown_pct: number;

  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: true,
    field: 'win_rate',
    comment: '段内胜率（0..1 小数）；0 笔时 NULL',
  })
  declare win_rate?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'trade_count',
    defaultValue: 0,
    comment: '段内成交笔数（sell_date ∈ 段内）',
  })
  declare trade_count: number;

  @Column({
    type: DataType.DECIMAL(18, 2),
    allowNull: false,
    field: 'equity_start',
    comment: '段起始日的账户权益',
  })
  declare equity_start: number;

  @Column({
    type: DataType.DECIMAL(18, 2),
    allowNull: false,
    field: 'equity_end',
    comment: '段结束日的账户权益',
  })
  declare equity_end: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
