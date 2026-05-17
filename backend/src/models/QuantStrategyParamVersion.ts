import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_strategy_param_versions',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['version_key'] },
    { fields: ['strategy_key'] },
    { fields: ['version_type'] },
    { fields: ['status'] },
    { fields: ['active_from'] },
  ],
})
export class QuantStrategyParamVersion extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.STRING(120), allowNull: false, field: 'version_key' })
  declare version_key: string;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'strategy_name' })
  declare strategy_name?: string;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'default',
    field: 'version_type',
  })
  declare version_type: string;

  @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: 'observing' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'params_json' })
  declare params_json: Record<string, any>;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'source_experiment_id' })
  declare source_experiment_id?: number;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'source_experiment_key' })
  declare source_experiment_key?: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'source_rank_score' })
  declare source_rank_score?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'source_excess_return_pct' })
  declare source_excess_return_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'source_max_drawdown_pct' })
  declare source_max_drawdown_pct?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'source_trade_count',
  })
  declare source_trade_count: number;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'adoption_reason' })
  declare adoption_reason?: string;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'active_from' })
  declare active_from?: string;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'active_to' })
  declare active_to?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
