import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * WebhookFallbackLog — L0-Ops / US-095 [OPS-006] 飞书 webhook fail-open 兜底表
 *
 * 一行 = 一次飞书 webhook POST 失败 (504 / timeout / SSRF guard 拒绝 / 任意 Error).
 *
 * 数据生产路径:
 *   - backend/src/services/webhookFailOpen.ts 主入口
 *     `wrapFeishuWebhookFailOpen(args, sender)` — 失败时 INSERT 一行 status='pending';
 *     主流程仍拿 `{success:false, message}` 不阻塞.
 *   - WEBHOOK_FALLBACK_RETRY cron (5min/次) 调
 *     `retryPendingFallbacks({source, limit, now})` 扫 status='pending' AND
 *     next_retry_at <= NOW() 的行, 透传 sender 重投递; 成功标 status='sent',
 *     失败 attempts +=1 + 指数 backoff 更新 next_retry_at; attempts >= max_attempts
 *     标 status='dead' (人工介入).
 *
 * 与既有 model 边界:
 *   - RiskAlert (US-005) — 业务告警事实源; webhook fan-out 失败时**此表**留痕,
 *     RiskAlert 本身已 inbox 写入, 不会因为 webhook 失败丢告警.
 *   - 本表只兜 **webhook 通道**; email / SMS / SMS 各有独立兜底策略
 *     (email 有 SMTP queue, SMS 有阿里云重发) 不重复造轮子.
 *
 * **status 字段三态**:
 *   - 'pending' — 默认; cron 扫得到, 等待重试
 *   - 'sent'    — 重试成功; cron 不再扫
 *   - 'dead'    — attempts >= max_attempts; 人工介入 (ops dashboard / 飞书 ops 群报警)
 *
 * **attempts 字段语义**:
 *   - INSERT 时 attempts=1 (首次失败本身已计入)
 *   - cron 重试一次 attempts +=1 (无论成功失败)
 *   - sent: attempts 是"成功前共投递了几次"
 *   - dead: attempts === max_attempts
 *
 * **next_retry_at 指数 backoff** (与 webhookFailOpen.ts 同源):
 *   - 第 1 次失败 INSERT 时: next_retry_at = NOW + 5min
 *   - cron 重试失败: next_retry_at = NOW + 5min * 2^(attempts-1) clamp 4h
 *     (即 5/10/20/40/80min, 80min 后封顶)
 *
 * **webhook_url in-DB 透明存储**: retry 时直接读 row 不依赖 env 重读 (env 改了
 * 不影响在飞历史告警的重投递, 也让 ops 排查 "这条到底发到哪里" 不需要 join
 * 系统配置. 与 RiskAlertService feishu_webhook_url 同款 in-DB 约定).
 *
 * **payload 复原**: cron 重试时按 sender (sendRecommendationSummary /
 * sendDailyDigestCard / etc) 调对应方法, payload 字段就是首次调用的 args 序列化.
 * 不能直接 axios.post(url, payload.body) — 不同 sender 有不同 card schema / msg
 * 包装逻辑, 必须走原方法.
 */
@Table({
  tableName: 'webhook_fallback_log',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['status', 'next_retry_at'],
      name: 'idx_webhook_fallback_log_status_next_retry',
    },
    { fields: ['channel'], name: 'idx_webhook_fallback_log_channel' },
    { fields: ['created_at'], name: 'idx_webhook_fallback_log_created_at' },
  ],
})
export class WebhookFallbackLog extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    field: 'channel',
    comment: '通道: feishu / feishu_ops (与 RiskAlertService channel 同源)',
  })
  declare channel: string;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'scenario',
    comment: 'caller 自报场景 (sendRecommendationSummary / sendDailyDigestCard / etc)',
  })
  declare scenario: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'webhook_url',
    comment: 'POST 目标 URL (in-DB; retry 不依赖 env 重读)',
  })
  declare webhook_url: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'payload',
    defaultValue: {},
    comment: '原始 send 参数 + sender 名 + caller hint',
  })
  declare payload: Record<string, unknown>;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'last_error',
    defaultValue: '',
    comment: '最近一次失败原因 (HTTP 504 / timeout / SSRF guard rejected)',
  })
  declare last_error: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'last_status_code',
    comment: 'HTTP code (区分 4xx vs 5xx; 非 HTTP 错误 NULL)',
  })
  declare last_status_code: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'attempts',
    defaultValue: 1,
    comment: '已尝试次数 (含首次失败; 1 = 仅原始失败)',
  })
  declare attempts: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'max_attempts',
    defaultValue: 5,
    comment: '上限 (默认 5; cron 透传 caller 覆盖)',
  })
  declare max_attempts: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'status',
    defaultValue: 'pending',
    comment: '生命周期: pending / sent / dead',
  })
  declare status: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'next_retry_at',
    comment: '下次 retry 时间; 指数 backoff (5/10/20/40/80min)',
  })
  declare next_retry_at: Date;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_attempt_at',
    comment: '最近一次 retry 时间戳 (NULL = 还没 cron retry 过, 只有首次失败 INSERT)',
  })
  declare last_attempt_at: Date | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'sent_at',
    comment: '成功投递时间戳 (与 status=sent 配对; 默认 NULL)',
  })
  declare sent_at: Date | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'dead_at',
    comment: '进入 dead 时间戳 (与 status=dead 配对; 默认 NULL)',
  })
  declare dead_at: Date | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata',
    defaultValue: {},
    comment: '调用 metadata (caller_module / cron_run_id / etc)',
  })
  declare metadata: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
