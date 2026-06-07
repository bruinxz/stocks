import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * WalkForwardResult — 单个 walk-forward 窗口的 train+test 结果（US-039）
 *
 * 一行 = 一个滚动窗口（train_start..train_end → test_start..test_end）的完整结果：
 *   1. train 窗口跑了一次嵌入式 GridSearchOptimizer（或注入的 optimizer）
 *      找到最优参数
 *   2. test 窗口用该参数跑了一次 backtest，得到样本外的 sharpe / return / drawdown
 *   3. 完整数据回写本表
 *
 * **关联**：通过 `run_id` 共享一个 `OptimizationRun` 行（与 US-037 / US-038 共享
 * 同一张 optimization_runs 表，optimizer_type='walk_forward'）。在父 run 行上，
 * `param_grid_json` 存的是 walk-forward 配置（trainMonths/testMonths/paramBounds），
 * `backtest_config_json` 存的是通用 baseConfig（initial_capital / universe / ...）。
 *
 * **best_params_json** 是 train 窗口胜出的具体参数（e.g. `{topN:30, stopLossPct:-7}`）。
 * **test_sharpe/test_return/test_drawdown** 是 test 窗口实际跑出的指标（已与 base
 * config 一致按小数存储；drawdown 为绝对值 >= 0）。
 *
 * **train_*_id** （nullable）保留了 train 窗口的 OptimizationRun.id，方便后续
 * 关联追溯 "本窗口的最优参数是从哪 N 个 combo 里挑出来的"；若调用方禁用了 train
 * persist 则为 NULL。
 *
 * `status` 反映本窗口的执行：
 *   - `pending` 占位（未开始）
 *   - `completed` train + test 都成功
 *   - `train_failed` train 窗口全部 combo 失败，无法得到 best_params
 *   - `test_failed` train 成功但 test 窗口 backtest 抛错（可能数据不足）
 *
 * 主要消费方：
 *   - WalkForwardValidator.validate()（US-039）
 *   - run-walk-forward.ts CLI
 *   - 未来 US-016 策略实验室 "walk-forward 验证" tab
 *   - 未来 US-040 RegimeSegmentedBacktest 可能会 join 本表把 test 窗口落到 regime
 */
@Table({
  tableName: 'walk_forward_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['run_id'] },
    { fields: ['run_id', 'window_index'] },
    { fields: ['run_id', 'status'] },
    { fields: ['test_start_date'] },
  ],
})
export class WalkForwardResult extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'run_id',
    comment: '关联 OptimizationRun.id（optimizer_type=walk_forward）',
  })
  declare run_id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'window_index',
    comment: '本 run 内的窗口序号（0-based，按 train_start 升序）',
  })
  declare window_index: number;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'train_start_date',
    comment: 'train 窗口起始日（YYYY-MM-DD）',
  })
  declare train_start_date: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'train_end_date',
    comment: 'train 窗口结束日（YYYY-MM-DD，闭区间）',
  })
  declare train_end_date: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'test_start_date',
    comment: 'test 窗口起始日（YYYY-MM-DD，紧接 train_end_date 之后）',
  })
  declare test_start_date: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'test_end_date',
    comment: 'test 窗口结束日（YYYY-MM-DD，闭区间）',
  })
  declare test_end_date: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'best_params_json',
    comment: 'train 窗口 GridSearch 选出的最优参数 e.g. { topN: 30, stopLossPct: -7 }',
  })
  declare best_params_json: Record<string, any>;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'train_composite_score',
    comment: 'train 窗口最优 combo 的 composite_score（参考，让 caller 看出过拟合幅度）',
  })
  declare train_composite_score?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'train_sharpe',
    comment: 'train 窗口最优 combo 的样本内夏普率',
  })
  declare train_sharpe?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'test_sharpe',
    comment: 'test 窗口实际跑出的样本外夏普率',
  })
  declare test_sharpe?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'test_return',
    comment: 'test 窗口实际年化收益率（小数，e.g. 0.18 = 18%）',
  })
  declare test_return?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'test_drawdown',
    comment: 'test 窗口实际最大回撤（绝对值，正数）',
  })
  declare test_drawdown?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'test_total_return',
    comment: 'test 窗口区间总收益率（小数）',
  })
  declare test_total_return?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'test_win_rate',
    comment: 'test 窗口胜率（小数）',
  })
  declare test_win_rate?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'test_trade_count',
    comment: 'test 窗口区间内总成交笔数',
  })
  declare test_trade_count?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'train_run_id',
    comment:
      '本窗口 train 阶段创建的 OptimizationRun.id（nullable，若禁用 train persist 则为 NULL）',
  })
  declare train_run_id?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'train_combos_count',
    comment: 'train 阶段实际跑的 combo 数（便于诊断 train 是否充分覆盖参数空间）',
  })
  declare train_combos_count?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'train_failed_combos',
    comment: 'train 阶段失败 combo 数（便于诊断 train 数据是否足够）',
  })
  declare train_failed_combos?: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'pending',
    comment: '执行状态：pending / completed / train_failed / test_failed',
  })
  declare status: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'error_message',
    comment: '若 status=*_failed 时的错误消息',
  })
  declare error_message?: string;

  @Column({
    type: DataType.DECIMAL(10, 3),
    allowNull: true,
    field: 'duration_seconds',
    comment: '本窗口（train + test）的总耗时（秒）',
  })
  declare duration_seconds?: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
