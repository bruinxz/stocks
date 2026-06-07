import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * GridSearchOptimizer 单参数组合的回测结果（US-037）
 *
 * 一行 = 一个参数组合对应一次 backtest 的核心指标。每个 OptimizationRun 通常
 * 关联 N 行 OptimizationResult（N = cartesian product 大小，截断到 max_combos）。
 *
 * `params_json` 是该组合的具体参数赋值，e.g. `{ topN: 20, stopLossPct: -7 }`。
 * `composite_score` 是按多目标排序公式聚合的综合分数（见 GridSearchOptimizer.
 * computeCompositeScore 定义），run 结束后 sort DESC 拿到冠军。
 *
 * `status='failed'` 时三大指标全部 NULL，`error_message` 记录失败原因（数据
 * 不足 / 策略抛错 / DB timeout 等）；UI 应将其与正常结果区分展示。
 */
@Table({
  tableName: 'optimization_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['run_id'] },
    { fields: ['run_id', 'composite_score'] },
    { fields: ['run_id', 'status'] },
  ],
})
export class OptimizationResult extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'run_id',
    comment: '关联 OptimizationRun.id',
  })
  declare run_id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'combo_index',
    comment: '该 run 内该参数组合的序号（0-based），方便复算与日志关联',
  })
  declare combo_index: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'params_json',
    comment: '具体参数赋值，e.g. { topN: 20, stopLossPct: -7 }',
  })
  declare params_json: Record<string, any>;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    comment: '夏普率（年化），失败时 NULL',
  })
  declare sharpe?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'annual_return',
    comment: '年化收益率（小数，e.g. 0.18 = 18%），失败时 NULL',
  })
  declare annual_return?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'max_drawdown',
    comment: '最大回撤（绝对值，正数，e.g. 0.22 = 22%），失败时 NULL',
  })
  declare max_drawdown?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'total_return',
    comment: '区间总收益率（小数），辅助参考',
  })
  declare total_return?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'win_rate',
    comment: '胜率（小数）',
  })
  declare win_rate?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'trade_count',
    comment: '区间内总成交笔数',
  })
  declare trade_count?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'composite_score',
    comment: '多目标综合排序分数：sharpe * w1 + annual * w2 - drawdown * w3',
  })
  declare composite_score?: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'pending',
    comment: '状态：pending / running / completed / failed',
  })
  declare status: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'error_message',
    comment: '若 status=failed 时的错误消息',
  })
  declare error_message?: string;

  @Column({
    type: DataType.DECIMAL(10, 3),
    allowNull: true,
    field: 'duration_seconds',
    comment: '该组合的回测耗时（秒）',
  })
  declare duration_seconds?: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
