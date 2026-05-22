import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'paper_trading_canary_review_snapshots',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      name: 'idx_canary_review_snapshots_generated_at',
      fields: ['generated_at'],
    },
    {
      name: 'idx_canary_review_snapshots_user',
      fields: ['user_id', 'username'],
    },
    {
      name: 'idx_canary_review_snapshots_audit',
      fields: ['audit_id'],
    },
    {
      name: 'idx_canary_review_snapshots_action',
      fields: ['action'],
    },
  ],
})
export class PaperTradingCanaryReviewSnapshot extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.DATE, allowNull: false, field: 'generated_at' })
  declare generated_at: Date;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'snapshot_date' })
  declare snapshot_date: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare user_id?: number;

  @Index
  @Column({ type: DataType.STRING(80), allowNull: true })
  declare username?: string;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'audit_id' })
  declare audit_id?: number;

  @Column({ type: DataType.DATE, allowNull: true, field: 'canary_applied_at' })
  declare canary_applied_at?: Date;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'inactive' })
  declare status: string;

  @Index
  @Column({ type: DataType.STRING(40), allowNull: true })
  declare action?: string;

  @Column({ type: DataType.STRING(80), allowNull: true, field: 'action_label' })
  declare action_label?: string;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'review_score' })
  declare review_score?: number;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'ready_for_review' })
  declare ready_for_review: boolean;

  @Column({ type: DataType.STRING(40), allowNull: true, field: 'outcome_tone' })
  declare outcome_tone?: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'closed_count' })
  declare closed_count: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'open_count' })
  declare open_count: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'avg_excess_return_pct' })
  declare avg_excess_return_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'avg_closed_return_pct' })
  declare avg_closed_return_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'avg_mae_pct' })
  declare avg_mae_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'worst_adverse_excursion_pct' })
  declare worst_adverse_excursion_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'win_rate' })
  declare win_rate?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'profit_factor' })
  declare profit_factor?: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: true, field: 'total_pnl' })
  declare total_pnl?: number;

  @Column({ type: DataType.BOOLEAN, allowNull: true, field: 'drawdown_guard_passed' })
  declare drawdown_guard_passed?: boolean;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'selected_parameter_keys' })
  declare selected_parameter_keys: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'evidence_sources' })
  declare evidence_sources: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'observation' })
  declare observation: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'outcome_summary' })
  declare outcome_summary: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'review' })
  declare review: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'attribution' })
  declare attribution: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'evidence' })
  declare evidence: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'rollback_plan' })
  declare rollback_plan: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'recent_outcomes' })
  declare recent_outcomes: any[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
