import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { Stock } from './Stock';

@Table({
  tableName: 'realtime_quotes',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['symbol'] },
    { fields: ['quote_time'] },
    { fields: ['trade_date'] },
    { fields: ['symbol', 'quote_time'] },
    { fields: ['symbol', 'trade_date'] },
  ],
})
export class RealtimeQuote extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @ForeignKey(() => Stock)
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'stock_id' })
  declare stock_id?: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'quote_time' })
  declare quote_time: Date;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'trade_date' })
  declare trade_date: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'current_price' })
  declare current_price?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'change_percent' })
  declare change_percent?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true })
  declare open?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true })
  declare high?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true })
  declare low?: number;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true })
  declare volume?: number;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true })
  declare turnover?: number;

  @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: 'akshare' })
  declare source: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'raw_payload' })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  @BelongsTo(() => Stock)
  declare stock?: Stock;
}
