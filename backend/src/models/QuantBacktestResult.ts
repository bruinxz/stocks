import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_backtest_results',
  timestamps: true,
  underscored: true,
  indexes: [{ fields: ['task_id'] }, { fields: ['strategy_key'] }],
})
export class QuantBacktestResult extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'task_id' })
  declare task_id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'strategy_name' })
  declare strategy_name?: string;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'total_return_pct',
  })
  declare total_return_pct: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'annual_return_pct',
  })
  declare annual_return_pct: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'max_drawdown_pct',
  })
  declare max_drawdown_pct: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'sharpe_ratio',
  })
  declare sharpe_ratio: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, defaultValue: 0, field: 'win_rate' })
  declare win_rate: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'profit_factor',
  })
  declare profit_factor: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'trade_count' })
  declare trade_count: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'avg_holding_days',
  })
  declare avg_holding_days: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'benchmark_return_pct' })
  declare benchmark_return_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'excess_return_pct' })
  declare excess_return_pct?: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'metrics_json' })
  declare metrics_json: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'equity_curve_json' })
  declare equity_curve_json: any[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'drawdown_curve_json',
  })
  declare drawdown_curve_json: any[];

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
