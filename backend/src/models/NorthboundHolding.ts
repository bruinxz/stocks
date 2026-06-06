import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 北向资金每日持股明细（沪股通 + 深股通）
 *
 * 主键 (trade_date, stock_code) 用于按交易日 upsert，
 * 北向单只标的每日只有一条快照。
 *
 * 数据源：AKShare `stock_hsgt_hold_stock_em`
 *   - 字段："持股市值变化-1日 / 持股市值变化-5日 / 持股数 / 持股市值 / 持股占流通股比 / ..."
 *
 * market_type: SH = 沪股通，SZ = 深股通
 */
@Table({
  tableName: 'northbound_holdings',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['stock_code'] },
    { fields: ['market_type'] },
    { fields: ['trade_date', 'market_type'] },
  ],
})
export class NorthboundHolding extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD)',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '股票代码，例如 600519 / 000001 (无市场前缀)',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票名称',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.BIGINT,
    allowNull: true,
    field: 'hold_volume',
    comment: '北向持股数（股）',
  })
  declare hold_volume?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'hold_amount',
    comment: '北向持股市值（元）',
  })
  declare hold_amount?: number;

  @Column({
    type: DataType.DECIMAL(10, 6),
    allowNull: true,
    field: 'hold_ratio',
    comment: '北向持股占流通股比 (%)',
  })
  declare hold_ratio?: number;

  @Column({
    type: DataType.ENUM('SH', 'SZ'),
    allowNull: false,
    field: 'market_type',
    comment: '通道：SH=沪股通，SZ=深股通',
  })
  declare market_type: 'SH' | 'SZ';

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'akshare',
    comment: '数据源标识，便于多数据源比较',
  })
  declare source: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '原始 AKShare 行（保留所有字段，便于以后回溯）',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
