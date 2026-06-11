import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

/**
 * Bridge HMAC 请求 nonce 去重表。
 *
 * 设计：append-only；(bridge_key, nonce) 复合 PRIMARY KEY 保证插入冲突=同 bridge 重放；
 * 不同 bridge_key 之间的 nonce 命名空间隔离，避免攻击者枚举占用其他 bridge 的 nonce。
 *
 * 与 bridgeAuthMiddleware 配合：先验签 + bridge_key 绑定通过后才尝试 INSERT，冲突即拒绝。
 *
 * 这样做的好处：
 * - 跨进程多实例去重（之前内存 Map 在水平扩展下失效）
 * - 重启不丢窗口（之前进程重启等于 nonce 窗口清零，可在 5 分钟内重放历史请求）
 * - 命名空间隔离（review 修订）
 */
@Table({
  tableName: 'live_bridge_nonces',
  timestamps: true,
  underscored: true,
  indexes: [{ fields: ['expires_at'] }],
})
export class LiveBridgeNonce extends Model {
  @Column({ type: DataType.STRING(120), primaryKey: true, allowNull: false, field: 'bridge_key' })
  declare bridge_key: string;

  @Column({ type: DataType.STRING(80), primaryKey: true, allowNull: false })
  declare nonce: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'expires_at' })
  declare expires_at: Date;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;
}
