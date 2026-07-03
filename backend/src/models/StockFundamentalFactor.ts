import {
  Table,
  Column,
  Model,
  DataType,
  ForeignKey,
  BelongsTo,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';
import { Stock } from './Stock';

@Table({
  tableName: 'stock_fundamental_factors',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['stock_id'] },
    { fields: ['symbol'] },
    { fields: ['factor_date'] },
    {
      name: 'uniq_stock_fundamental_factor_symbol_date_source',
      unique: true,
      fields: ['symbol', 'factor_date', 'source'],
    },
  ],
})
export class StockFundamentalFactor extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @ForeignKey(() => Stock)
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'stock_id' })
  declare stock_id: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'factor_date' })
  declare factor_date: string;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'report_period' })
  declare report_period?: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true })
  declare roe?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'gross_margin' })
  declare gross_margin?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'net_profit_growth' })
  declare net_profit_growth?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'revenue_growth' })
  declare revenue_growth?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'debt_asset_ratio' })
  declare debt_asset_ratio?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true })
  declare eps?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'book_value_per_share' })
  declare book_value_per_share?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'quality_score',
  })
  declare quality_score: number;

  @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: 'local_derived' })
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
