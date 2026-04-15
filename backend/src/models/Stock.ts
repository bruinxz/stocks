import { Table, Column, Model, DataType, HasMany, CreatedAt, UpdatedAt } from 'sequelize-typescript';
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
    comment: '上市日期',
  })
  declare listingDate?: Date;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    comment: '退市日期',
  })
  declare delistingDate?: Date;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: true,
    comment: '是否上市',
  })
  declare isListed: boolean;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    comment: '股票类型：stock, index, fund, bond',
  })
  declare type?: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    comment: '数据状态：complete, incomplete, no_data, conflict',
  })
  declare dataStatus?: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  // 关联关系
  @HasMany(() => DailyBar)
  dailyBars!: DailyBar[];
}