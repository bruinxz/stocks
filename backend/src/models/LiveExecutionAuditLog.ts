import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'live_execution_audit_logs',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['account_id'] },
    { fields: ['draft_id'] },
    { fields: ['order_id'] },
    { fields: ['event_type'] },
    { fields: ['created_at'] },
  ],
})
export class LiveExecutionAuditLog extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare user_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'account_id' })
  declare account_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'draft_id' })
  declare draft_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'order_id' })
  declare order_id?: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'event_type' })
  declare event_type: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'info' })
  declare severity: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare message: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'before_state' })
  declare before_state: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'after_state' })
  declare after_state: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
