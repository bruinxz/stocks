import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * IntradayOpportunityPush — CE-C 实时机会推送审计表
 *
 * 一行 = 一次 "实时买入机会"飞书推送的审计记录. 由 IntradayOpportunityPusher.push
 * 在每次"实际/虚拟"推送之后写入 (含 skipped / dry_run / circuit_breaker 留痕).
 *
 * 设计意图:
 *   1. **dedup 回查** — push_result.dedup_signature 落库后, 任何时刻可用 SQL 查
 *      "近 N 分钟 同 symbol+rule 推过几次", 与 in-process LRU 互补 (后者重启清空).
 *   2. **后置归因** — forward_return_1d / forward_return_5d 由 cron 收盘后回填,
 *      用于评估 trigger_rule 的 hit rate / 收益分布, 反哺规则参数调优.
 *   3. **运营追溯** — 飞书消息群里出问题时, 按 symbol/trigger_rule 查同时段
 *      所有推送记录及触发理由, 看是规则误报还是数据异常.
 *
 * **强制 fail-OPEN 写库**: push() 内 try/catch 包裹, DB 写库失败仅 warn 不抛错,
 * 主推送链路不受影响 (与 RiskAlert.afterCreate hook fail-OPEN 范式一致).
 *
 * **索引设计**:
 *   - (symbol, trigger_time DESC)        热点查询: "茅台最近 1 小时所有触发"
 *   - (trigger_rule, trigger_time DESC) 规则维度: "近 24h breakout_60d_high 推了几次"
 *   - 部分索引 (pushed_at) WHERE forward_return_5d IS NULL — cron 找待回填行,
 *     大幅缩小扫表范围 (已回填的不进索引).
 *
 * SQL migration: backend/scripts/migrations/2026-06-25-intraday-opportunity-pushes.sql
 */
@Table({
  tableName: 'intraday_opportunity_pushes',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: [{ name: 'symbol' }, { name: 'trigger_time', order: 'DESC' }], name: 'idx_iop_symbol_time' },
    {
      fields: [{ name: 'trigger_rule' }, { name: 'trigger_time', order: 'DESC' }],
      name: 'idx_iop_rule_time',
    },
    {
      fields: ['pushed_at'],
      name: 'idx_iop_pending_forward',
      where: { forward_return_5d: null },
    },
  ],
})
export class IntradayOpportunityPush extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: '股票代码 (sh.600519 / 600519 / SZ000001 等 caller 自定义)',
  })
  declare symbol: string;

  @Column({
    type: DataType.STRING(80),
    allowNull: true,
    comment: '股票名称',
  })
  declare name: string | null;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    field: 'trigger_rule',
    comment: '触发规则 ID (breakout_60d_high / volume_spike / rapid_rise / ...)',
  })
  declare trigger_rule: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'trigger_time',
    comment: '机会触发的真实时间 (UTC 存储, 与 pushed_at 区分)',
  })
  declare trigger_time: Date;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'pushed_at',
    defaultValue: DataType.NOW,
    comment: '推送写库时间',
  })
  declare pushed_at: Date;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    comment:
      '决策快照 JSONB: {action, confidence_score, risk_level, suggested_position_pct, entry_zone, stop_loss, take_profit}',
  })
  declare decision: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    comment: '触发理由 string[] (top 3 evidence)',
  })
  declare reasons: string[];

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'source_signal_id',
    comment: '关联 AIInvestmentSignal.id 用于前端深页跳转',
  })
  declare source_signal_id: number | null;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'target_groups',
    defaultValue: 'business',
    comment: '推送目标分组逗号分隔: business,ops,user',
  })
  declare target_groups: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'push_result',
    defaultValue: {},
    comment: '推送结果 JSONB: {ok, dedup_signature, pushed_groups, skipped_reason, channels}',
  })
  declare push_result: Record<string, unknown>;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'forward_return_1d',
    comment: 'T+1 收盘后回填的 forward return (百分比, 4 位小数)',
  })
  declare forward_return_1d: number | null;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'forward_return_5d',
    comment: 'T+5 收盘后回填的 forward return',
  })
  declare forward_return_5d: number | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'forward_return_updated_at',
    comment: '最近一次 forward return 回填的时间戳',
  })
  declare forward_return_updated_at: Date | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
