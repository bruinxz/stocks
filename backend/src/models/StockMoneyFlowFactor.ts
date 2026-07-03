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
  tableName: 'stock_money_flow_factors',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['stock_id'] },
    { fields: ['symbol'] },
    { fields: ['factor_date'] },
    {
      name: 'uniq_stock_money_flow_factor_symbol_date_source',
      unique: true,
      fields: ['symbol', 'factor_date', 'source'],
    },
  ],
})
export class StockMoneyFlowFactor extends Model {
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

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true, field: 'net_inflow_amount' })
  declare net_inflow_amount?: number;

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true, field: 'main_net_inflow' })
  declare main_net_inflow?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'main_net_inflow_pct' })
  declare main_net_inflow_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'volume_ratio' })
  declare volume_ratio?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'turnover_rate' })
  declare turnover_rate?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'momentum_5d' })
  declare momentum_5d?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'momentum_20d' })
  declare momentum_20d?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'money_flow_score',
  })
  declare money_flow_score: number;

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
