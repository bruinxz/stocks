import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 实盘订单命令队列。订单草稿被用户强确认后，写入这里等待 bridge 长轮询拉取。
 *
 * 路线图 §6.2.1 命令状态机：
 *   pending → dispatching → dispatched → submitted → partially_filled → filled
 *                              ↘─► cancelled / failed
 *              └─► expired (超过 TTL 未 ack)
 *
 * 严格遵守：
 *  - client_order_id 是服务端生成的幂等 UUID，全表唯一索引；
 *  - 撤单也是一条 command，parent_command_id 指向被撤的原命令；
 *  - 状态推进只允许 bridge 事件驱动（见 LiveBrokerEvent）；
 *  - filled_quantity == quantity 才允许进入 filled。
 */
@Table({
  tableName: 'live_broker_commands',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['account_id'] },
    { fields: ['bridge_key'] },
    // client_order_id NOT NULL，直接全列 unique；runtime schema 重复创建无副作用
    { unique: true, fields: ['client_order_id'], name: 'idx_live_broker_commands_client_order_id_unique' },
    { fields: ['parent_command_id'] },
    { fields: ['command_type'] },
    { fields: ['status'] },
    { fields: ['created_at'] },
    // 高频 pullPendingCommands 查询模式：(account_id, status, created_at)
    { fields: ['account_id', 'status', 'created_at'] },
  ],
})
export class LiveBrokerCommand extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'account_id' })
  declare account_id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'draft_id' })
  declare draft_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'order_id' })
  declare order_id?: number;

  /** 服务端幂等 ID（UUID），强唯一 */
  @Column({ type: DataType.STRING(100), allowNull: false, field: 'client_order_id' })
  declare client_order_id: string;

  /** bridge 端密钥 ID，命令派发时拷贝绑定，便于审计 */
  @Column({ type: DataType.STRING(120), allowNull: true, field: 'bridge_key' })
  declare bridge_key?: string;

  /** place_order / cancel_order */
  @Column({ type: DataType.STRING(30), allowNull: false, field: 'command_type' })
  declare command_type: string;

  /** 撤单命令必须指回原 place_order command id */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'parent_command_id' })
  declare parent_command_id?: number;

  /** 命令状态机 pending/dispatched/submitted/partially_filled/filled/cancelled/failed/expired */
  @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: 'pending' })
  declare status: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(10), allowNull: true })
  declare side?: 'BUY' | 'SELL';

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare quantity?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'limit_price' })
  declare limit_price?: number;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'order_type' })
  declare order_type?: string;

  /** 撤单时携带原券商委托号（可选；place_order 命令永远 null） */
  @Column({ type: DataType.STRING(100), allowNull: true, field: 'broker_order_id' })
  declare broker_order_id?: string;

  /** 服务端创建命令时的快照价，用于 bridge 端对照本地 QMT 快照做"双向价格闸门" */
  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'server_reference_price' })
  declare server_reference_price?: number;

  /** 累计成交量（partial_filled 累加） */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'filled_quantity' })
  declare filled_quantity: number;

  /** 撤单时剩余未成交量（cancelled 时回填） */
  @Column({ type: DataType.INTEGER, allowNull: true, field: 'remaining_quantity' })
  declare remaining_quantity?: number;

  /** TTL 截止时间；BridgeCommandExpiryService 扫描使用 */
  @Column({ type: DataType.DATE, allowNull: false, field: 'expires_at' })
  declare expires_at: Date;

  /** 进入 dispatched 的时间（ack 完成） */
  @Column({ type: DataType.DATE, allowNull: true, field: 'dispatched_at' })
  declare dispatched_at?: Date;

  /** 进入 submitted 的时间（bridge 提交后） */
  @Column({ type: DataType.DATE, allowNull: true, field: 'submitted_at' })
  declare submitted_at?: Date;

  /** 进入终态的时间 */
  @Column({ type: DataType.DATE, allowNull: true, field: 'finalized_at' })
  declare finalized_at?: Date;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'request_payload' })
  declare request_payload: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
