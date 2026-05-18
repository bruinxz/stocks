import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_backtest_tasks',
  timestamps: true,
  underscored: true,
  indexes: [{ fields: ['user_id'] }, { fields: ['status'] }, { fields: ['created_at'] }],
})
export class QuantBacktestTask extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare user_id?: number;

  @Column({ type: DataType.STRING(160), allowNull: false, field: 'task_name' })
  declare task_name: string;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'market' })
  declare universe: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'strategy_keys' })
  declare strategy_keys: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare symbols: string[];

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'start_date' })
  declare start_date: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'end_date' })
  declare end_date: string;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    defaultValue: 200000,
    field: 'initial_capital',
  })
  declare initial_capital: number;

  @Column({
    type: DataType.DECIMAL(10, 6),
    allowNull: false,
    defaultValue: 0.0003,
    field: 'commission_rate',
  })
  declare commission_rate: number;

  @Column({
    type: DataType.DECIMAL(10, 6),
    allowNull: false,
    defaultValue: 0.0005,
    field: 'slippage_rate',
  })
  declare slippage_rate: number;

  @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: 'PENDING' })
  declare status: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare progress: number;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'error_message' })
  declare error_message?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare parameters: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
