import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'task_parameter_audit_logs',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      name: 'idx_task_parameter_audit_logs_task_id',
      fields: ['task_id'],
    },
    {
      name: 'idx_task_parameter_audit_logs_event_type',
      fields: ['event_type'],
    },
    {
      name: 'idx_task_parameter_audit_logs_created_at',
      fields: ['created_at'],
    },
  ],
})
export class TaskParameterAuditLog extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'task_id' })
  declare task_id: number;

  @Column({ type: DataType.STRING(120), allowNull: false, field: 'task_name' })
  declare task_name: string;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'task_type' })
  declare task_type: string;

  @Index
  @Column({ type: DataType.STRING(80), allowNull: false, field: 'event_type' })
  declare event_type: string;

  @Column({ type: DataType.STRING(80), allowNull: true, field: 'source_loop_run_id' })
  declare source_loop_run_id?: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'operator_user_id' })
  declare operator_user_id?: number;

  @Column({ type: DataType.STRING(80), allowNull: true, field: 'operator_username' })
  declare operator_username?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'changed_keys' })
  declare changed_keys: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'diffs' })
  declare diffs: Array<{
    key: string;
    before: any;
    after: any;
  }>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'before_parameters' })
  declare before_parameters: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'after_parameters' })
  declare after_parameters: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
