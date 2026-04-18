import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
  HasMany,
} from 'sequelize-typescript';
import { User } from './User';
import { PaperTradingPosition } from './PaperTradingPosition';
import { PaperTradingTrade } from './PaperTradingTrade';
import { PaperTradingSnapshot } from './PaperTradingSnapshot';

@Table({
  tableName: 'paper_trading_portfolios',
  timestamps: true,
})
export class PaperTradingPortfolio extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
  })
  declare userId: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    comment: '模拟盘名称',
  })
  declare name: string;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 1000000.0,
    comment: '初始资金',
  })
  declare initialCapital: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 1000000.0,
    comment: '当前可用资金',
  })
  declare currentCash: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 1000000.0,
    comment: '当前总资产 (资金 + 持仓市值)',
  })
  declare totalValue: number;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: true,
    comment: '是否处于激活状态',
  })
  declare isActive: boolean;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  @HasMany(() => PaperTradingPosition)
  declare positions: PaperTradingPosition[];

  @HasMany(() => PaperTradingTrade)
  declare trades: PaperTradingTrade[];

  @HasMany(() => PaperTradingSnapshot)
  declare snapshots: PaperTradingSnapshot[];
}
