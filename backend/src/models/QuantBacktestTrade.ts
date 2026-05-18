import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_backtest_trades',
  timestamps: true,
  underscored: true,
  indexes: [{ fields: ['task_id'] }, { fields: ['strategy_key'] }, { fields: ['symbol'] }],
})
export class QuantBacktestTrade extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'task_id' })
  declare task_id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'buy_date' })
  declare buy_date: string;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'sell_date' })
  declare sell_date?: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, field: 'buy_price' })
  declare buy_price: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'sell_price' })
  declare sell_price?: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare quantity: number;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: false })
  declare amount: number;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true })
  declare pnl?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'return_pct' })
  declare return_pct?: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'holding_days' })
  declare holding_days: number;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'entry_reason' })
  declare entry_reason?: string;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'exit_reason' })
  declare exit_reason?: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
