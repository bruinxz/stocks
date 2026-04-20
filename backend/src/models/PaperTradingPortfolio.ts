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
    field: 'user_id',
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
    field: 'initial_capital',
    comment: '初始资金',
  })
  declare initialCapital: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 1000000.0,
    field: 'current_cash',
    comment: '当前可用资金',
  })
  declare currentCash: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 1000000.0,
    field: 'total_value',
    comment: '当前总资产 (资金 + 持仓市值)',
  })
  declare totalValue: number;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: true,
    field: 'is_active',
    comment: '是否处于激活状态',
  })
  declare isActive: boolean;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updatedAt: Date;

  @HasMany(() => PaperTradingPosition)
  declare positions: PaperTradingPosition[];

  @HasMany(() => PaperTradingTrade)
  declare trades: PaperTradingTrade[];

  @HasMany(() => PaperTradingSnapshot)
  declare snapshots: PaperTradingSnapshot[];
}
