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
import { PaperTradingPortfolio } from './PaperTradingPortfolio';

@Table({
  tableName: 'paper_trading_positions',
  timestamps: true,
})
export class PaperTradingPosition extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @ForeignKey(() => PaperTradingPortfolio)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'portfolio_id',
  })
  declare portfolio_id: number;

  @BelongsTo(() => PaperTradingPortfolio)
  declare portfolio: PaperTradingPortfolio;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: '股票代码',
  })
  declare symbol: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    comment: '股票名称',
  })
  declare name: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: '持有股数 (股)',
  })
  declare quantity: number;

  @Column({
    type: DataType.DECIMAL(10, 3),
    allowNull: false,
    defaultValue: 0,
    field: 'avg_cost',
    comment: '平均建仓成本价',
  })
  declare avg_cost: number;

  @Column({
    type: DataType.DECIMAL(10, 3),
    allowNull: false,
    defaultValue: 0,
    field: 'current_price',
    comment: '最新价格',
  })
  declare current_price: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'market_value',
    comment: '当前持仓市值',
  })
  declare market_value: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'unrealized_pnl',
    comment: '浮动盈亏',
  })
  declare unrealized_pnl: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
