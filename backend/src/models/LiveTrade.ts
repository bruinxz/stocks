import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'live_trades',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['account_id'] },
    { fields: ['order_id'] },
    { fields: ['symbol'] },
    { fields: ['trade_time'] },
  ],
})
export class LiveTrade extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'account_id' })
  declare account_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'order_id' })
  declare order_id?: number;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'broker_trade_id' })
  declare broker_trade_id?: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(10), allowNull: false })
  declare side: 'BUY' | 'SELL';

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare quantity: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, field: 'trade_price' })
  declare trade_price: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: false, field: 'trade_amount' })
  declare trade_amount: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'trade_time' })
  declare trade_time: Date;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'raw_payload' })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
