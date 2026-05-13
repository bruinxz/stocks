import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'recommendation_trade_outcomes',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      name: 'idx_recommendation_trade_outcomes_portfolio',
      fields: ['portfolio_id'],
    },
    {
      name: 'idx_recommendation_trade_outcomes_signal',
      fields: ['signal_id'],
    },
    {
      name: 'idx_recommendation_trade_outcomes_symbol',
      fields: ['symbol'],
    },
    {
      name: 'idx_recommendation_trade_outcomes_status',
      fields: ['trade_status'],
    },
    {
      name: 'idx_recommendation_trade_outcomes_loop_run',
      fields: ['loop_run_id'],
    },
    {
      name: 'uniq_recommendation_trade_outcomes_portfolio_signal',
      unique: true,
      fields: ['portfolio_id', 'signal_id'],
    },
  ],
})
export class RecommendationTradeOutcome extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'portfolio_id' })
  declare portfolio_id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'signal_id' })
  declare signal_id: number;

  @Index
  @Column({ type: DataType.STRING(80), allowNull: true, field: 'loop_run_id' })
  declare loop_run_id?: string;

  @Column({ type: DataType.STRING(50), allowNull: false, field: 'source_type' })
  declare source_type: string;

  @Column({ type: DataType.STRING(100), allowNull: false, field: 'source_id' })
  declare source_id: string;

  @Index
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'signal_date' })
  declare signal_date: string;

  @Column({ type: DataType.STRING(30), allowNull: true })
  declare decision?: string;

  @Column({ type: DataType.DECIMAL(8, 2), allowNull: true })
  declare score?: number;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'risk_level' })
  declare risk_level?: string;

  @Column({ type: DataType.STRING(30), allowNull: true })
  declare action?: string;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'action_label' })
  declare action_label?: string;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'agent_session' })
  declare agent_session?: string;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'recommendation_style' })
  declare recommendation_style?: string;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'recommendation_source' })
  declare recommendation_source?: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare industry?: string;

  @Column({ type: DataType.STRING(10), allowNull: true })
  declare market?: string;

  @Index
  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'open',
    field: 'trade_status',
    comment: 'open / closed',
  })
  declare trade_status: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'entry_trade_id' })
  declare entry_trade_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'exit_trade_id' })
  declare exit_trade_id?: number;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'entry_date' })
  declare entry_date?: string;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'exit_date' })
  declare exit_date?: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'entry_price' })
  declare entry_price?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'exit_price' })
  declare exit_price?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'latest_price' })
  declare latest_price?: number;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare quantity?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'position_pct' })
  declare position_pct?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'entry_amount' })
  declare entry_amount?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'exit_amount' })
  declare exit_amount?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'total_commission' })
  declare total_commission?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'realized_pnl' })
  declare realized_pnl?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'realized_pnl_pct' })
  declare realized_pnl_pct?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'unrealized_pnl' })
  declare unrealized_pnl?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'unrealized_pnl_pct' })
  declare unrealized_pnl_pct?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'total_pnl' })
  declare total_pnl?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'total_pnl_pct' })
  declare total_pnl_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'max_favorable_excursion_pct' })
  declare max_favorable_excursion_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'max_adverse_excursion_pct' })
  declare max_adverse_excursion_pct?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'holding_days' })
  declare holding_days?: number;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'benchmark_code' })
  declare benchmark_code?: string;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'benchmark_name' })
  declare benchmark_name?: string;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'benchmark_return_pct' })
  declare benchmark_return_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'excess_return_pct' })
  declare excess_return_pct?: number;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'exit_reason' })
  declare exit_reason?: string;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'exit_reason_label' })
  declare exit_reason_label?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
