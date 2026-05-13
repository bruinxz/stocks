import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  Index,
} from 'sequelize-typescript';

@Table({
  tableName: 'recommendation_loop_policy_snapshots',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      name: 'idx_loop_policy_snapshots_generated_at',
      fields: ['generated_at'],
    },
    {
      name: 'idx_loop_policy_snapshots_universe_style',
      fields: ['universe', 'effective_style'],
    },
    {
      name: 'idx_loop_policy_snapshots_task_log',
      fields: ['execution_log_id'],
    },
  ],
})
export class RecommendationLoopPolicySnapshot extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.DATE, allowNull: false, field: 'generated_at' })
  declare generated_at: Date;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'execution_log_id' })
  declare execution_log_id?: number;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'record_type' })
  declare record_type?: string;

  @Column({ type: DataType.STRING(50), allowNull: true })
  declare username?: string;

  @Index
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'market' })
  declare universe: string;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'base_style' })
  declare base_style?: string;

  @Index
  @Column({ type: DataType.STRING(30), allowNull: true, field: 'effective_style' })
  declare effective_style?: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'candidate_limit' })
  declare candidate_limit?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'candidate_pool_limit' })
  declare candidate_pool_limit?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'archive_limit' })
  declare archive_limit?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'lookback_days' })
  declare lookback_days?: number;

  @Column({ type: DataType.DECIMAL(8, 2), allowNull: true, field: 'base_min_score' })
  declare base_min_score?: number;

  @Column({ type: DataType.DECIMAL(8, 2), allowNull: true, field: 'effective_min_score' })
  declare effective_min_score?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'base_default_position_pct' })
  declare base_default_position_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'effective_default_position_pct' })
  declare effective_default_position_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'base_max_position_pct' })
  declare base_max_position_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'effective_max_position_pct' })
  declare effective_max_position_pct?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'base_paper_trade_limit' })
  declare base_paper_trade_limit?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'effective_paper_trade_limit' })
  declare effective_paper_trade_limit?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'closed_samples' })
  declare closed_samples?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'min_closed_samples' })
  declare min_closed_samples?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'policy_avg_excess_return_pct' })
  declare policy_avg_excess_return_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'policy_excess_win_rate' })
  declare policy_excess_win_rate?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'position_multiplier' })
  declare position_multiplier?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'generated_total_candidates' })
  declare generated_total_candidates?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'analyzed_candidates' })
  declare analyzed_candidates?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'archive_total' })
  declare archive_total?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'agent_submitted' })
  declare agent_submitted?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'paper_executed' })
  declare paper_executed?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'paper_planned' })
  declare paper_planned?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'paper_skipped' })
  declare paper_skipped?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'tracked_trade_count' })
  declare tracked_trade_count?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'closed_trade_count' })
  declare closed_trade_count?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'total_pnl' })
  declare total_pnl?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'avg_excess_return_pct' })
  declare avg_excess_return_pct?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'excess_win_rate' })
  declare excess_win_rate?: number;

  @Column({ type: DataType.STRING(1000), allowNull: true, field: 'policy_reason' })
  declare policy_reason?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'loop_policy' })
  declare loop_policy: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'best_segments' })
  declare best_segments: any[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'weak_segments' })
  declare weak_segments: any[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'run_metrics' })
  declare run_metrics: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
