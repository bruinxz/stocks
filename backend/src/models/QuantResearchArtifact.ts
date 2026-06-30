import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

export type QuantResearchArtifactType =
  | 'backtest'
  | 'integrity_audit'
  | 'point_in_time_audit'
  | 'execution_audit'
  | 'audited_return_replay'
  | 'credibility_summary';

export type QuantResearchArtifactStatus =
  | 'pending'
  | 'pass'
  | 'watch'
  | 'reject'
  | 'insufficient'
  | 'error';

@Table({
  tableName: 'quant_research_artifacts',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['experiment_id', 'created_at'] },
    { fields: ['task_id'] },
    { fields: ['artifact_type'] },
    { fields: ['status'] },
    { fields: ['source_type', 'source_id'] },
  ],
})
export class QuantResearchArtifact extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'experiment_id' })
  declare experiment_id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'task_id' })
  declare task_id?: number | null;

  @Column({ type: DataType.STRING(40), allowNull: false, field: 'artifact_type' })
  declare artifact_type: QuantResearchArtifactType;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'source_type' })
  declare source_type?: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'source_id' })
  declare source_id?: number | null;

  @Column({ type: DataType.STRING(24), allowNull: false, defaultValue: 'pending' })
  declare status: QuantResearchArtifactStatus;

  @Column({ type: DataType.STRING(160), allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare summary?: string | null;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'payload_json' })
  declare payload_json: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
