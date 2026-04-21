import {
  Table,
  Column,
  Model,
  DataType,
  HasMany,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';
import { DailyBar } from './DailyBar';

@Table({
  tableName: 'stocks',
  timestamps: true,
  indexes: [
    {
      unique: true,
      fields: ['symbol'],
    },
    {
      fields: ['market'],
    },
    {
      fields: ['industry'],
    },
  ],
})
export class Stock extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(10),
    allowNull: false,
    comment: '股票代码，如 600000.SH',
  })
  declare symbol: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    comment: '股票名称',
  })
  declare name: string;

  @Column({
    type: DataType.STRING(10),
    allowNull: true,
    comment: '市场类型：SH, SZ, BJ',
  })
  declare market?: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    comment: '所属行业',
  })
  declare industry?: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'listing_date',
    comment: '上市日期',
  })
  declare listing_date?: Date;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'delisting_date',
    comment: '退市日期',
  })
  declare delisting_date?: Date;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: true,
    field: 'is_listed',
    comment: '是否上市',
  })
  declare is_listed: boolean;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    comment: '股票类型：stock, index, fund, bond',
  })
  declare type?: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'data_status',
    comment: '数据状态：complete, incomplete, no_data, conflict',
  })
  declare data_status?: string;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'total_market_cap',
    comment: '最新总市值(元)',
  })
  declare total_market_cap?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'circulating_market_cap',
    comment: '最新流通市值(元)',
  })
  declare circulating_market_cap?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'pe_dynamic',
    comment: '最新动态市盈率',
  })
  declare pe_dynamic?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '最新市净率',
  })
  declare pb?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'turnover_rate',
    comment: '最新换手率(%)',
  })
  declare turnover_rate?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    comment: '最新价',
  })
  declare price?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'change_percent',
    comment: '最新涨跌幅(%)',
  })
  declare change_percent?: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  // 关联关系
  @HasMany(() => DailyBar)
  declare daily_bars: DailyBar[];
}
