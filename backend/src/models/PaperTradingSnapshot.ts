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
  tableName: 'paper_trading_snapshots',
  timestamps: true,
})
export class PaperTradingSnapshot extends Model {
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
    type: DataType.DATEONLY,
    allowNull: false,
    comment: '快照日期',
  })
  declare date: string;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    field: 'total_value',
  })
  declare totalValue: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    field: 'current_cash',
  })
  declare currentCash: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    field: 'position_value',
  })
  declare positionValue: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updatedAt: Date;
}
