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
  declare portfolio_id: number;

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
  declare execute_price: number;

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
  declare realized_pnl: number;

  /**
   * AL-3 (2026-06-21): 操作理由 JSONB. 见 backend/src/portfolio/internal/tradeReasonBuilder.ts
   * 中的 TradeReason 类型. 6+ 写入入口 (facade BUY/SELL × 2, automation create*Trade × 2,
   * GuardSellExecutor 透传, IndustryConcentrationGuard / RebalanceEngine 透传) 必须传值,
   * 缺省 '{}' 兼容历史行.
   */
  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'trade_reason',
    comment:
      'AL-3 操作理由 { source, strategy_key?, signal_id?, ai_report_id?, evidence[], confidence?, key_reasons[], risk_trigger?, ai_summary? }',
  })
  declare trade_reason: Record<string, any>;

  /** AL-3 (2026-06-21): 一句话总结, UI 列表展示, 详情看 trade_reason JSONB. */
  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'trade_reason_summary',
    comment: 'AL-3 操作理由一句话总结',
  })
  declare trade_reason_summary: string | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
