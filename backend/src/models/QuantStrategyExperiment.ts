import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_strategy_experiments',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['experiment_key'] },
    { fields: ['strategy_key'] },
    { fields: ['status'] },
    { fields: ['rank_score'] },
    { fields: ['created_at'] },
  ],
})
export class QuantStrategyExperiment extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.STRING(120), allowNull: false, field: 'experiment_key' })
  declare experiment_key: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'task_id' })
  declare task_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'result_id' })
  declare result_id?: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'strategy_name' })
  declare strategy_name?: string;

  @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: 'completed' })
  declare status: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'start_date' })
  declare start_date: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'end_date' })
  declare end_date: string;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'market' })
  declare universe: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare symbols: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'parameters_json' })
  declare parameters_json: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'metrics_json' })
  declare metrics_json: Record<string, any>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'execution_diagnostics',
  })
  declare execution_diagnostics: Record<string, any>;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'total_return_pct',
  })
  declare total_return_pct: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'excess_return_pct' })
  declare excess_return_pct?: number;

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

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'trade_count' })
  declare trade_count: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, defaultValue: 0, field: 'rank_score' })
  declare rank_score: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare conclusion?: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
