import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_signals',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['symbol', 'trade_date'] },
    { fields: ['strategy_key'] },
    { fields: ['signal'] },
    { fields: ['score'] },
  ],
})
export class QuantSignal extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'trade_date' })
  declare trade_date: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.STRING(30), allowNull: false })
  declare signal: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, defaultValue: 0 })
  declare score: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, defaultValue: 0 })
  declare confidence: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'entry_price' })
  declare entry_price?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'stop_loss_price' })
  declare stop_loss_price?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'take_profit_price' })
  declare take_profit_price?: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'risk_flags' })
  declare risk_flags: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'raw_factors' })
  declare raw_factors: Record<string, any>;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'agent_eligible',
  })
  declare agent_eligible: boolean;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'pending',
    field: 'agent_status',
  })
  declare agent_status: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
