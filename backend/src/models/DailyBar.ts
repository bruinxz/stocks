import {
  Table,
  Column,
  Model,
  DataType,
  ForeignKey,
  BelongsTo,
  Index,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';
import { Stock } from './Stock';

@Table({
  tableName: 'daily_bars',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      name: 'idx_daily_bars_stock_id',
      fields: ['stock_id'],
    },
    {
      name: 'idx_daily_bars_time_desc',
      fields: ['time'],
    },
    {
      name: 'idx_daily_bars_stock_time',
      fields: ['stock_id', 'time'],
      unique: true,
    },
  ],
})
export class DailyBar extends Model {
  @Column({
    type: DataType.DATE,
    allowNull: false,
    primaryKey: true,
    comment: '交易时间',
  })
  declare time: Date;

  @ForeignKey(() => Stock)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    primaryKey: true,
    field: 'stock_id',
    comment: '股票ID',
  })
  declare stock_id: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '开盘价',
  })
  declare open: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '最高价',
  })
  declare high: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '最低价',
  })
  declare low: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '收盘价',
  })
  declare close: number;

  @Column({
    type: DataType.BIGINT,
    allowNull: false,
    comment: '成交量（股）',
  })
  declare volume: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    comment: '成交额（元）',
  })
  declare turnover?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'adj_close',
    comment: '复权收盘价',
  })
  declare adj_close?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'turnover_rate',
    comment: '换手率(%)',
  })
  declare turnover_rate?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'change_percent',
    comment: '涨跌幅(%)',
  })
  declare change_percent?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '振幅(%)',
  })
  declare amplitude?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '市盈率(PE)',
  })
  declare pe?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '市净率(PB)',
  })
  declare pb?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '市销率(PS)',
  })
  declare ps?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'market_cap',
    comment: '总市值(元)',
  })
  declare market_cap?: number;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: true,
    field: 'is_trading_day',
    comment: '是否交易日',
  })
  declare is_trading_day: boolean;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: false,
    field: 'is_suspended',
    comment: '是否停牌',
  })
  declare is_suspended: boolean;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  // 关联关系
  @BelongsTo(() => Stock)
  declare stock: Stock;
}
