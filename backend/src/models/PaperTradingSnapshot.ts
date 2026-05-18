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
  declare portfolio_id: number;

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
  declare total_value: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    field: 'current_cash',
  })
  declare current_cash: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    field: 'position_value',
  })
  declare position_value: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
