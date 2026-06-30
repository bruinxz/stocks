import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

export type QuantResearchExperimentStatus =
  | 'draft'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'archived';

export type QuantResearchExperimentVerdict =
  | 'pending'
  | 'pass'
  | 'watch'
  | 'reject'
  | 'insufficient';

@Table({
  tableName: 'quant_research_experiments',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['experiment_key'] },
    { fields: ['user_id', 'created_at'] },
    { fields: ['strategy_key'] },
    { fields: ['status'] },
    { fields: ['verdict'] },
    { fields: ['task_id'] },
  ],
})
export class QuantResearchExperiment extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare user_id?: number | null;

  @Column({ type: DataType.STRING(160), allowNull: false, field: 'experiment_key' })
  declare experiment_key: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare hypothesis?: string | null;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.STRING(80), allowNull: true, field: 'template_id' })
  declare template_id?: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'task_id' })
  declare task_id?: number | null;

  @Column({ type: DataType.STRING(24), allowNull: false, defaultValue: 'draft' })
  declare status: QuantResearchExperimentStatus;

  @Column({ type: DataType.STRING(24), allowNull: false, defaultValue: 'pending' })
  declare verdict: QuantResearchExperimentVerdict;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'start_date' })
  declare start_date: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'end_date' })
  declare end_date: string;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'market' })
  declare universe: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare symbols: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'params_json' })
  declare params_json: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'data_policy_json' })
  declare data_policy_json: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'cost_policy_json' })
  declare cost_policy_json: Record<string, any>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'constraint_policy_json',
  })
  declare constraint_policy_json: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'summary_json' })
  declare summary_json: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
