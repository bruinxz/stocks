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
  tableName: 'stock_valuation_factors',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['stock_id'] },
    { fields: ['symbol'] },
    { fields: ['factor_date'] },
    {
      name: 'uniq_stock_valuation_factor_symbol_date_source',
      unique: true,
      fields: ['symbol', 'factor_date', 'source'],
    },
  ],
})
export class StockValuationFactor extends Model {
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

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'pe_ttm' })
  declare pe_ttm?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true })
  declare pb?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'ps_ttm' })
  declare ps_ttm?: number;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true, field: 'total_market_cap' })
  declare total_market_cap?: number;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true, field: 'circulating_market_cap' })
  declare circulating_market_cap?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'pe_percentile_250' })
  declare pe_percentile_250?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'pb_percentile_250' })
  declare pb_percentile_250?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'valuation_score',
  })
  declare valuation_score: number;

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
