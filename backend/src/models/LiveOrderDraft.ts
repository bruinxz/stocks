import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'live_order_drafts',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['account_id'] },
    { fields: ['symbol'] },
    { fields: ['side'] },
    { fields: ['status'] },
    { fields: ['created_at'] },
  ],
})
export class LiveOrderDraft extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'account_id' })
  declare account_id?: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.STRING(10), allowNull: false })
  declare side: 'BUY' | 'SELL';

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'LIMIT',
    field: 'order_type',
  })
  declare order_type: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare quantity: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, field: 'limit_price' })
  declare limit_price: number;

  @Column({
    type: DataType.DECIMAL(18, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'estimated_amount',
  })
  declare estimated_amount: number;

  @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: 'preview', comment: '草稿生命周期：preview/pending/approved/rejected/submitted/expired/blocked/shadow_executed；不要复用 bridge command 状态' })
  declare status: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'manual',
    field: 'source_type',
  })
  declare source_type: string;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'source_id' })
  declare source_id?: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare rationale?: string;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'medium',
    field: 'risk_level',
  })
  declare risk_level: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'risk_check' })
  declare risk_check: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'quote_snapshot' })
  declare quote_snapshot: Record<string, any>;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    defaultValue: 'CONFIRM_LIVE_ORDER',
    field: 'confirm_text_required',
  })
  declare confirm_text_required: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'approved_by' })
  declare approved_by?: number;

  @Column({ type: DataType.DATE, allowNull: true, field: 'approved_at' })
  declare approved_at?: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'rejected_at' })
  declare rejected_at?: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'expires_at' })
  declare expires_at?: Date;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
