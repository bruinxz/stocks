import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

/**
 * 告警事件的当前状态。
 *
 * source_key 一行代表一个可恢复对象（目前主要是 cron:<task_id>）。generation
 * 在每次 resolved -> open 时递增，用于生成稳定的 opened/escalated/recovered
 * 幂等键。
 */
@Table({
  tableName: 'notification_incident_states',
  timestamps: true,
  indexes: [{ name: 'idx_notification_incident_status', fields: ['status', 'last_seen_at'] }],
})
export class NotificationIncidentState extends Model {
  @Column({ type: DataType.BIGINT, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index({ name: 'uq_notification_incident_source', unique: true })
  @Column({ type: DataType.STRING(255), allowNull: false, field: 'source_key' })
  declare source_key: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'source_type' })
  declare source_type: string;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'source_id' })
  declare source_id: string;

  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'resolved' })
  declare status: 'open' | 'resolved';

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare generation: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'occurrence_count' })
  declare occurrence_count: number;

  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'WARN' })
  declare severity: string;

  @Column({ type: DataType.STRING(500), allowNull: false, defaultValue: '' })
  declare summary: string;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'last_error' })
  declare last_error: string | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'opened_at' })
  declare opened_at: Date | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'last_seen_at' })
  declare last_seen_at: Date | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'resolved_at' })
  declare resolved_at: Date | null;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare escalated: boolean;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'opened_notification_generation',
  })
  declare opened_notification_generation: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'recovered_notification_generation',
  })
  declare recovered_notification_generation: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
