import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'paper_trading_order_intents',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['portfolio_id'] },
    { fields: ['signal_id'] },
    { fields: ['symbol'] },
    { fields: ['side'] },
    { fields: ['status'] },
    { fields: ['intent_date'] },
    { fields: ['portfolio_id', 'intent_date'] },
  ],
})
export class PaperTradingOrderIntent extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'portfolio_id' })
  declare portfolio_id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'signal_id' })
  declare signal_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'trade_id' })
  declare trade_id?: number;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'source_type' })
  declare source_type: string;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'source_id' })
  declare source_id?: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.ENUM('BUY', 'SELL'), allowNull: false })
  declare side: 'BUY' | 'SELL';

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'planned',
    comment: 'planned / executed / rejected / skipped / held',
  })
  declare status: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'intent_date' })
  declare intent_date: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'reference_price' })
  declare reference_price?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'execute_price' })
  declare execute_price?: number;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare quantity?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true })
  declare amount?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'target_position_pct' })
  declare target_position_pct?: number;

  @Column({ type: DataType.DECIMAL(8, 2), allowNull: true })
  declare score?: number;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'risk_level' })
  declare risk_level?: string;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'reason_category' })
  declare reason_category?: string;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'reason_text' })
  declare reason_text?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
