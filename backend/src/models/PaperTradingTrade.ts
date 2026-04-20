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
  tableName: 'paper_trading_trades',
  timestamps: true,
})
export class PaperTradingTrade extends Model {
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
  declare portfolioId: number;

  @BelongsTo(() => PaperTradingPortfolio)
  declare portfolio: PaperTradingPortfolio;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
  })
  declare symbol: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
  })
  declare name: string;

  @Column({
    type: DataType.ENUM('BUY', 'SELL'),
    allowNull: false,
  })
  declare direction: 'BUY' | 'SELL';

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    field: 'execute_price',
  })
  declare executePrice: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
  })
  declare quantity: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    comment: '交易金额（不含手续费）',
  })
  declare amount: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    comment: '手续费',
  })
  declare commission: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: true,
    field: 'realized_pnl',
    comment: '如果是卖出，记录本次交易的实现盈亏',
  })
  declare realizedPnl: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updatedAt: Date;
}
