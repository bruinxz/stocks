import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 实盘 kill switch 自动/手动触发状态。
 * 任何"未 resolved"的活跃记录都会让 LiveTradingSafetyService.getStatus().global_kill_switch=true，
 * 与环境变量 LIVE_TRADING_KILL_SWITCH 是 OR 关系（任一为真即熔断）。
 *
 * 表结构故意保持 append-only：不再 update 已 resolved 的记录，新一轮触发要插新行，
 * 保留完整时间序便于审计与复盘。
 *
 * "同一时间只允许一条 active=true" 由 runtime schema 的 partial unique 索引保证
 * （idx_live_kill_switch_states_active_unique WHERE active=true）。
 */
@Table({
  tableName: 'live_kill_switch_states',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['triggered_at'] },
    { fields: ['reason_code'] },
  ],
})
export class LiveKillSwitchState extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare active: boolean;

  /**
   * 触发原因码：
   *   bridge_heartbeat_lost / order_failure_streak / order_failure_rate
   *   / daily_loss_breach / order_count_breach / account_anomaly
   *   / manual / external_compliance / smoke_test
   */
  @Column({ type: DataType.STRING(60), allowNull: false, field: 'reason_code' })
  declare reason_code: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'auto' })
  declare source: string; // auto | manual | external

  @Column({ type: DataType.TEXT, allowNull: false })
  declare reason_detail: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @Column({ type: DataType.DATE, allowNull: false, field: 'triggered_at' })
  declare triggered_at: Date;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'triggered_by' })
  declare triggered_by?: string;

  @Column({ type: DataType.DATE, allowNull: true, field: 'resolved_at' })
  declare resolved_at?: Date;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'resolved_by' })
  declare resolved_by?: string;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'resolved_note' })
  declare resolved_note?: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
