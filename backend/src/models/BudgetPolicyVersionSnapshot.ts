import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'budget_policy_version_snapshots',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      name: 'uniq_budget_policy_version_snapshots_version',
      unique: true,
      fields: ['version_id'],
    },
    {
      name: 'idx_budget_policy_version_snapshots_generated_at',
      fields: ['generated_at'],
    },
    {
      name: 'idx_budget_policy_version_snapshots_guard',
      fields: ['guard_action'],
    },
    {
      name: 'idx_budget_policy_version_snapshots_champion',
      fields: ['champion_version_id'],
    },
  ],
})
export class BudgetPolicyVersionSnapshot extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.STRING(80), allowNull: false, field: 'version_id' })
  declare version_id: string;

  @Column({ type: DataType.STRING(40), allowNull: false, field: 'version_hash' })
  declare version_hash: string;

  @Column({
    type: DataType.STRING(60),
    allowNull: false,
    defaultValue: 'budget_policy_weight_v1',
  })
  declare schema: string;

  @Index
  @Column({ type: DataType.DATE, allowNull: false, field: 'generated_at' })
  declare generated_at: Date;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'lookback_days' })
  declare lookback_days?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'action_count' })
  declare action_count?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'audit_feedback_applied_count' })
  declare audit_feedback_applied_count?: number;

  @Column({ type: DataType.STRING(40), allowNull: true, field: 'guard_action' })
  declare guard_action?: string;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'guard_severity' })
  declare guard_severity?: string;

  @Column({ type: DataType.STRING(80), allowNull: true, field: 'guarded_from_version_id' })
  declare guarded_from_version_id?: string;

  @Column({ type: DataType.STRING(80), allowNull: true, field: 'champion_version_id' })
  declare champion_version_id?: string;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'champion_avg_excess_return_pct',
  })
  declare champion_avg_excess_return_pct?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'champion_capital_efficiency_score',
  })
  declare champion_capital_efficiency_score?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'comparison_efficiency_gap' })
  declare comparison_efficiency_gap?: number;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'comparison_excess_gap' })
  declare comparison_excess_gap?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'current_closed_count' })
  declare current_closed_count?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'current_avg_excess_return_pct',
  })
  declare current_avg_excess_return_pct?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'current_capital_efficiency_score',
  })
  declare current_capital_efficiency_score?: number;

  @Column({ type: DataType.STRING(1000), allowNull: true })
  declare reason?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'action_weights' })
  declare action_weights: any[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'underperformance_guard',
  })
  declare underperformance_guard: Record<string, any>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'current_version_outcome',
  })
  declare current_version_outcome: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'version_rankings' })
  declare version_rankings: any[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare payload: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
