import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'paper_trading_order_intent_outcomes',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      name: 'uniq_order_intent_outcomes_intent',
      unique: true,
      fields: ['intent_id'],
    },
    {
      name: 'idx_order_intent_outcomes_portfolio',
      fields: ['portfolio_id'],
    },
    {
      name: 'idx_order_intent_outcomes_symbol',
      fields: ['symbol'],
    },
    {
      name: 'idx_order_intent_outcomes_reason_category',
      fields: ['reason_category'],
    },
    {
      name: 'idx_order_intent_outcomes_status',
      fields: ['evaluation_status'],
    },
    {
      name: 'idx_order_intent_outcomes_intent_date',
      fields: ['intent_date'],
    },
  ],
})
export class PaperTradingOrderIntentOutcome extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'intent_id' })
  declare intent_id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'portfolio_id' })
  declare portfolio_id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'signal_id' })
  declare signal_id?: number;

  @Index
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.ENUM('BUY', 'SELL'), allowNull: false })
  declare side: 'BUY' | 'SELL';

  @Column({ type: DataType.STRING(30), allowNull: false })
  declare status: string;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'reason_category' })
  declare reason_category?: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'intent_date' })
  declare intent_date: string;

  @Column({ type: DataType.STRING(30), allowNull: false, field: 'evaluation_status' })
  declare evaluation_status: string;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'benchmark_horizon' })
  declare benchmark_horizon?: string;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'benchmark_intended_return_pct',
  })
  declare benchmark_intended_return_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'benchmark_raw_return_pct' })
  declare benchmark_raw_return_pct?: number;

  @Column({ type: DataType.STRING(255), allowNull: true, field: 'benchmark_conclusion' })
  declare benchmark_conclusion?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare horizons: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @Column({ type: DataType.DATE, allowNull: false, field: 'evaluated_at' })
  declare evaluated_at: Date;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
