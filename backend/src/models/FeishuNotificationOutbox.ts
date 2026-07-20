import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

/**
 * 飞书通知唯一投递事实源。
 *
 * 业务代码只能 enqueue，不直接访问 webhook。发送成功、失败、重试和最终 dead
 * 都记录在这里，避免进程重启后丢消息或重复刷屏。
 */
@Table({
  tableName: 'feishu_notification_outbox',
  timestamps: true,
  indexes: [
    {
      name: 'idx_feishu_outbox_due',
      fields: ['status', 'next_attempt_at'],
    },
    {
      name: 'idx_feishu_outbox_topic_created',
      fields: ['topic_key', 'created_at'],
    },
    {
      name: 'idx_feishu_outbox_correlation',
      fields: ['correlation_id'],
    },
  ],
})
export class FeishuNotificationOutbox extends Model {
  @Column({
    type: DataType.BIGINT,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Index({ name: 'uq_feishu_outbox_idempotency', unique: true })
  @Column({
    type: DataType.STRING(255),
    allowNull: false,
    field: 'idempotency_key',
  })
  declare idempotency_key: string;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'topic_key' })
  declare topic_key: string;

  @Column({
    type: DataType.STRING(32),
    allowNull: false,
    comment: 'ops | business | live | user',
  })
  declare audience: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'recipient_user_id' })
  declare recipient_user_id: number | null;

  @Column({ type: DataType.STRING(64), allowNull: false })
  declare kind: string;

  @Column({ type: DataType.STRING(16), allowNull: false, defaultValue: 'INFO' })
  declare severity: string;

  @Column({ type: DataType.STRING(500), allowNull: false })
  declare title: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare payload: Record<string, unknown>;

  @Column({ type: DataType.STRING(32), allowNull: false, defaultValue: 'pending' })
  declare status: 'pending' | 'sending' | 'retry' | 'sent' | 'dead' | 'suppressed';

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare attempts: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 6, field: 'max_attempts' })
  declare max_attempts: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'next_attempt_at' })
  declare next_attempt_at: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'locked_at' })
  declare locked_at: Date | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'sent_at' })
  declare sent_at: Date | null;

  @Column({ type: DataType.DATE, allowNull: true, field: 'dead_at' })
  declare dead_at: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'last_error' })
  declare last_error: string | null;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'last_status_code' })
  declare last_status_code: number | null;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare response: Record<string, unknown>;

  @Column({ type: DataType.STRING(255), allowNull: true, field: 'correlation_id' })
  declare correlation_id: string | null;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
