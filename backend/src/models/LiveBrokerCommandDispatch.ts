import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * bridge 命令派发审计：每次服务端把 command 推给 bridge（长轮询 GET 返回 / SSE event）
 * 都写一条；bridge ack 时回填 acked_at；TTL 内未 ack 即视为"漏单"。
 *
 * 路线图 §7.4：服务端"已派发"但 bridge 未 ack 必须能事后回放，避免重复派发。
 */
@Table({
  tableName: 'live_broker_command_dispatches',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['command_id'] },
    { fields: ['bridge_key'] },
    { fields: ['acked_at'] },
    { fields: ['dispatched_at'] },
  ],
})
export class LiveBrokerCommandDispatch extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'command_id' })
  declare command_id: number;

  @Column({ type: DataType.STRING(120), allowNull: false, field: 'bridge_key' })
  declare bridge_key: string;

  /** long_poll / sse / replay */
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'long_poll' })
  declare channel: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'dispatched_at' })
  declare dispatched_at: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'acked_at' })
  declare acked_at?: Date;

  /** ack 失败时记录原因 */
  @Column({ type: DataType.TEXT, allowNull: true, field: 'failure_reason' })
  declare failure_reason?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
