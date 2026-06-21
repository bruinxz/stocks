import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * bridge 端回传的事件流：trader callback / 订单状态变更 / 失败回报。
 * 路线图 §7.4.1：event_seq 由 bridge 生成 (wall_clock_us * 10000 + atomic_counter)；
 * 服务端必须 (command_id, event_seq) 唯一约束顶住重复入库，并以最大 event_seq 作权威 effective state。
 */
@Table({
  tableName: 'live_broker_events',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['command_id'] },
    { fields: ['event_type'] },
    { fields: ['received_at'] },
    // 显式声明 (command_id, event_seq) UNIQUE，作为 runtime schema 兜底
    // （若 runtime schema 未跑，sequelize.sync 也会创建该唯一约束）
    {
      unique: true,
      fields: ['command_id', 'event_seq'],
      name: 'idx_live_broker_events_command_seq_unique',
    },
  ],
})
export class LiveBrokerEvent extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'command_id' })
  declare command_id: number;

  /** submitted / trade / cancelled / failed / order_error / cancel_error / heartbeat_lost */
  @Column({ type: DataType.STRING(40), allowNull: false, field: 'event_type' })
  declare event_type: string;

  /** bridge 端单调递增；服务端去重 + 仲裁 */
  @Column({ type: DataType.BIGINT, allowNull: false, field: 'event_seq' })
  declare event_seq: string; // sequelize BIGINT returns string in PG

  /** bridge 端事件时间（trader callback 触发时点） */
  @Column({ type: DataType.DATE, allowNull: false, field: 'event_time' })
  declare event_time: Date;

  /** 服务端收到的时间，仅用于审计 */
  @Column({ type: DataType.DATE, allowNull: false, field: 'received_at' })
  declare received_at: Date;

  /** bridge / system / replay */
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'bridge' })
  declare source: string;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'broker_order_id' })
  declare broker_order_id?: string;

  @Column({ type: DataType.STRING(100), allowNull: true, field: 'broker_trade_id' })
  declare broker_trade_id?: string;

  /** trade 事件本次增量成交量 */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'fill_quantity' })
  declare fill_quantity?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'fill_price' })
  declare fill_price?: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'payload' })
  declare payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
