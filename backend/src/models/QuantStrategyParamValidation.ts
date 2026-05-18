import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_strategy_param_validations',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      name: 'uniq_qs_param_validation_version_symbol_horizon',
      unique: true,
      fields: ['version_key', 'symbol', 'signal_date', 'horizon_days'],
    },
    { fields: ['version_key'] },
    { fields: ['strategy_key'] },
    { fields: ['signal_date'] },
    { fields: ['horizon_days'] },
    { fields: ['status'] },
  ],
})
export class QuantStrategyParamValidation extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.STRING(120), allowNull: false, field: 'version_key' })
  declare version_key: string;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'quant_signal_id' })
  declare quant_signal_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'ai_signal_id' })
  declare ai_signal_id?: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'signal_date' })
  declare signal_date: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'entry_price' })
  declare entry_price?: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'horizon_days' })
  declare horizon_days: number;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'evaluation_date' })
  declare evaluation_date: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'latest_price' })
  declare latest_price?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'return_pct' })
  declare return_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'benchmark_return_pct' })
  declare benchmark_return_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'excess_return_pct' })
  declare excess_return_pct?: number;

  @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: 'pending' })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
