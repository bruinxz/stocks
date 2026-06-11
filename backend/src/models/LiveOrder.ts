import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'live_orders',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['account_id'] },
    { fields: ['draft_id'] },
    // client_order_id 的唯一性由 ensureLiveTradingRuntimeSchema 创建的部分索引保证
    // （仅对非 NULL 行去重），这里只声明非唯一索引避免与运行时索引同名冲突
    { fields: ['client_order_id'] },
    { fields: ['broker_order_id'] },
    // P1 review：bridge ingestOrders 用 (account_id, broker_order_id) 当幂等键，
    // 但模型层没有 unique 兜底；并发推送可能产生重复 LiveOrder。
    // 真正的 partial unique（broker_order_id IS NOT NULL）由 runtime schema 创建。
    { fields: ['account_id', 'broker_order_id'] },
    { fields: ['symbol'] },
    { fields: ['status'] },
    { fields: ['bridge_status'] },
  ],
})
export class LiveOrder extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'account_id' })
  declare account_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'draft_id' })
  declare draft_id?: number;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'client_order_id' })
  declare client_order_id?: string;

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

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'bridge_status' })
  declare bridge_status?: string;

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
