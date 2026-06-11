import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * bridge 心跳记录。本地桥每 N 秒推一条 heartbeat 到服务端，服务端用于：
 *  - 显示在线状态、版本、QMT/PTrade 登录状态；
 *  - kill switch 自动巡检"心跳丢失超过 5 分钟"。
 *
 * 设计：保留全部历史心跳；查询"最新"用 ORDER BY received_at DESC LIMIT 1。
 */
@Table({
  tableName: 'live_broker_bridge_heartbeats',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['bridge_key'] },
    { fields: ['received_at'] },
  ],
})
export class LiveBrokerBridgeHeartbeat extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.STRING(120), allowNull: false, field: 'bridge_key' })
  declare bridge_key: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'account_id' })
  declare account_id?: number;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'unknown' })
  declare status: string; // online / degraded / offline

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'bridge_version' })
  declare bridge_version?: string;

  @Column({ type: DataType.STRING(40), allowNull: true, field: 'broker_client_status' })
  declare broker_client_status?: string; // logged_in / logged_out / unknown

  @Column({ type: DataType.DATE, allowNull: false, field: 'received_at' })
  declare received_at: Date;

  @Column({ type: DataType.DATE, allowNull: true, field: 'bridge_local_time' })
  declare bridge_local_time?: Date;

  /** wall_clock 偏差秒数（bridge 上报 vs 服务端） */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'clock_skew_seconds' })
  declare clock_skew_seconds?: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
