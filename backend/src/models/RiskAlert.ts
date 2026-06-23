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
      if (!instance) return;
      // US-073 [FE-034] /ws/alerts 实时广播 — level=HIGH 优先, MEDIUM/LOW 也广播
      // (WebSocket fanout 进程内 O(1) cost, 不像飞书/邮件那样有外部网络代价),
      // 让前端 AlertsPanel 可以即时刷新而不仅靠 60s polling.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const broadcasterMod = require('../realtime/alertsBroadcaster');
        const payload = broadcasterMod.buildBroadcastPayload({
          alert_id: instance.id,
          user_id: instance.user_id,
          symbol: instance.symbol,
          name: instance.name,
          level: instance.level,
          message: instance.message,
          rule_id: instance.rule_id || undefined,
          created_at: instance.created_at,
        });
        broadcasterMod.alertsBroadcaster.broadcast(payload);
      } catch (wsErr: any) {
        // ws broadcast 内层失败不应阻塞 dispatcher 飞书/邮件/短信
        logger.warn(
          `[RiskAlert.afterCreate] alertsBroadcaster.broadcast 异常 (吞错保护): ${
            wsErr?.message || wsErr
          }`
        );
      }

      // 既有 US-067 RealtimeAlertDispatcher (飞书/邮件/短信), HIGH + CRITICAL 触发
      // Batch BF-1 (2026-06-23): 加 CRITICAL — 之前只 HIGH 触发, 类似 MarketRegimeAlertService
      // 用的 level='CRITICAL' 一条都不推, 用户原话"凌晨出问题没人知道". 推送通道复用
      // dispatcher 4 channel (Lark webhook / 邮件 / 系统 admin 通道); dedup 已经升级到
      // 1h (REALTIME_ALERT_DEDUP_WINDOW_MS = 60min) 防告警风暴.
      const lvl = String(instance.level || '').toUpperCase();
      if (lvl !== 'HIGH' && lvl !== 'CRITICAL') return;
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

      // Batch BF-1 (2026-06-23): 额外触发 system-level admin 推送 (Lark OPS 群 +
      // admin email) — RealtimeAlertDispatcher 走 per-user notification config,
      // 但 prod 多数 user `feishu.enabled=false` → 仍然 0 条推送. SystemAdminAlertPusher
      // 走 env 配置 (OPS_ALERT_FEISHU_WEBHOOK / ADMIN_ALERT_EMAILS) 兜底, 凌晨出
      // 真问题时运维群一定收得到. 1h dedup 防告警风暴.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const sysMod = require('../services/SystemAdminAlertPusher');
        const triggered = instance.created_at
          ? new Date(instance.created_at).toISOString()
          : new Date().toISOString();
        const frontend = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
        const dedupKey = `risk:${instance.symbol}:${lvl}`;
        const truncatedMsg = String(instance.message || '').slice(0, 1500);
        sysMod.pushSystemAdminAlertFireAndForget({
          dedup_key: dedupKey,
          level: lvl as 'HIGH' | 'CRITICAL',
          title: `[${lvl}] ${instance.symbol} ${instance.name} 风控告警`,
          body_markdown:
            `**用户**: ${instance.user_id}\n` +
            `**触发规则**: ${instance.rule_id || 'unknown'}\n` +
            `**告警详情**:\n${truncatedMsg}`,
          triggered_at: triggered,
          deeplink: `${frontend}/workspace/portfolio?ai=${encodeURIComponent(instance.symbol)}&alert=${instance.id}`,
        });
      } catch (sysErr: any) {
        logger.warn(
          `[RiskAlert.afterCreate] SystemAdminAlertPusher 异常 (吞错保护): ${sysErr?.message || sysErr}`
        );
      }
    } catch (err: any) {
      // 顶层吞错 — model hook 抛出会让 RiskAlert.create() 失败，那是事故级 regression
      logger.warn(
        `[RiskAlert.afterCreate] dispatchRealtimeAlert 异常 (吞错保护): ${err?.message || err}`
      );
    }
  }
}
