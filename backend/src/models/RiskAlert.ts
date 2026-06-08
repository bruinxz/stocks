import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
  AfterCreate,
} from 'sequelize-typescript';
import { User } from './User';
import { logger } from '../utils/logger';

@Table({
  tableName: 'risk_alerts',
  timestamps: true,
})
export class RiskAlert extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'user_id',
  })
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: '触发告警的股票代码',
  })
  declare symbol: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    comment: '触发告警的股票名称',
  })
  declare name: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    comment: '告警级别 (e.g., HIGH, MEDIUM, LOW)',
  })
  declare level: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    comment: '告警详细内容，如 AI 建议卖出或跌破支撑位等',
  })
  declare message: string;

  @Column({
    type: DataType.STRING(64),
    allowNull: true,
    field: 'rule_id',
    comment:
      'US-067 — 触发的 risk rule 标识（e.g., position_limit / trailing_stop / drawdown_breaker），用于 RealtimeAlertDispatcher dedup 签名；旧行可空',
  })
  declare rule_id: string | null;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: false,
    field: 'is_read',
    comment: '是否已读',
  })
  declare is_read: boolean;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  /**
   * US-067 — RiskAlert.afterCreate hook 把 level=HIGH 的告警 fire-and-forget
   * 转给 RealtimeAlertDispatcher 并行触发飞书/邮件/短信。
   *
   * 设计点：
   *  - **lazy-require dispatcher**：避免 RiskAlert model 反向依赖 services 层，
   *    也让 jest / 单测的 model loading 不被 dispatcher 副作用污染。
   *  - **fail-OPEN 顶层 try/catch**：dispatcher 内部已 fail-OPEN，这里再兜一层
   *    保证 RiskAlert.create() 主流程绝不被推送错误阻塞。
   *  - **level=HIGH 才触发**：MEDIUM / LOW 走 SchedulerService 聚合 cron（未来扩展）。
   *  - **不 await**：保持 RiskAlert.create 调用方的 await 语义不被阻塞 — 推送
   *    延迟（飞书 webhook ~ 数百 ms、SMTP ~ 秒、SMS ~ 秒）不能拖慢交易主路径。
   */
  @AfterCreate
  static dispatchRealtimeAlert(instance: RiskAlert): void {
    try {
      if (!instance || String(instance.level || '').toUpperCase() !== 'HIGH') return;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { realtimeAlertDispatcher } = require('../services/RealtimeAlertDispatcher');
      realtimeAlertDispatcher.fireAndForget({
        alert_id: instance.id,
        user_id: instance.user_id,
        symbol: instance.symbol,
        name: instance.name,
        level: instance.level,
        message: instance.message,
        rule_id: instance.rule_id || undefined,
        triggered_at: instance.created_at
          ? new Date(instance.created_at).toISOString()
          : new Date().toISOString(),
      });
    } catch (err: any) {
      // 顶层吞错 — model hook 抛出会让 RiskAlert.create() 失败，那是事故级 regression
      logger.warn(
        `[RiskAlert.afterCreate] dispatchRealtimeAlert 异常 (吞错保护): ${err?.message || err}`
      );
    }
  }
}
