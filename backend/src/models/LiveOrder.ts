import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'live_orders',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['account_id'] },
    { fields: ['draft_id'] },
    { fields: ['broker_order_id'] },
    { fields: ['symbol'] },
    { fields: ['status'] },
  ],
})
export class LiveOrder extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'account_id' })
  declare account_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'draft_id' })
  declare draft_id?: number;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'broker_order_id' })
  declare broker_order_id?: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.STRING(10), allowNull: false })
  declare side: 'BUY' | 'SELL';

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare quantity: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, field: 'limit_price' })
  declare limit_price: number;

  @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: 'created' })
  declare status: string;

  @Column({ type: DataType.DATE, allowNull: true, field: 'submitted_at' })
  declare submitted_at?: Date;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'raw_payload' })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
