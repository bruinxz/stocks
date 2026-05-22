import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'live_positions',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['account_id', 'symbol'] },
    { fields: ['user_id'] },
    { fields: ['account_id'] },
    { fields: ['symbol'] },
    { fields: ['account_id', 'symbol'] },
  ],
})
export class LivePosition extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'account_id' })
  declare account_id: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare quantity: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'available_quantity' })
  declare available_quantity: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, defaultValue: 0, field: 'avg_cost' })
  declare avg_cost: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: false, defaultValue: 0, field: 'current_price' })
  declare current_price: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'market_value' })
  declare market_value: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'unrealized_pnl' })
  declare unrealized_pnl: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: false, defaultValue: 0, field: 'unrealized_pnl_pct' })
  declare unrealized_pnl_pct: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: false, defaultValue: 0, field: 'position_pct' })
  declare position_pct: number;

  @Column({ type: DataType.DATE, allowNull: true, field: 'quote_time' })
  declare quote_time?: Date;

  @Column({ type: DataType.STRING(80), allowNull: false, defaultValue: 'manual' })
  declare source: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'raw_payload' })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
