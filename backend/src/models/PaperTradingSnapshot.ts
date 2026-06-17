import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
  Index,
} from 'sequelize-typescript';
import { PaperTradingPortfolio } from './PaperTradingPortfolio';

@Table({
  tableName: 'paper_trading_snapshots',
  timestamps: true,
  indexes: [
    {
      // Batch K (2026-06-17): 防 syncLatestPricesAndSnapshot 并发 upsert 一天写
      // 2 条 snapshot (equity 曲线翻倍点). dev `sync({alter:true})` 会自动创建.
      // 修复后旧 dup row 需 ops 一次性 DELETE OLDER OF DUPLICATES — 见
      // scripts/sql/dedupe_paper_trading_snapshots.sql (待创建).
      name: 'uniq_paper_trading_snapshot_portfolio_date',
      unique: true,
      fields: ['portfolio_id', 'date'],
    },
  ],
})
export class PaperTradingSnapshot extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @ForeignKey(() => PaperTradingPortfolio)
  @Index('uniq_paper_trading_snapshot_portfolio_date')
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'portfolio_id',
  })
  declare portfolio_id: number;

  @BelongsTo(() => PaperTradingPortfolio)
  declare portfolio: PaperTradingPortfolio;

  @Index('uniq_paper_trading_snapshot_portfolio_date')
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
