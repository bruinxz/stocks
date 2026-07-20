import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { User } from './User';

/**
 * MorningRiskCheckup — US-054
 *
 * **每日开盘前风险体检报告** —— 一行 = 一次完整的"持仓体检"快照（per user / per date），
 * 每天 8:30 由 SchedulerService 触发 `MorningRiskCheckupService.runMorningCheckup`
 * 计算并写入。报告内容覆盖 6 大维度（AC 指定）：
 *
 *   1. **positions_count**     — 当前持仓只数（quantity > 0 的 PaperTradingPosition）；
 *   2. **max_single_pct**      — 单股最大占比（按 market_value / total_position_value，
 *                                 与 US-052 IndustryConcentrationGuard 相同分母：
 *                                 *持仓市值之和*，不含 cash）；
 *   3. **max_industry_pct**    — 行业最大占比（同 US-052 aggregateByIndustry，
 *                                 Stock.industry 缺失走 UNKNOWN_INDUSTRY_SENTINEL bucket）；
 *   4. **drawdown_pct**        — 当前组合回撤（复用 US-049 computePeakValue +
 *                                 computeDrawdownPct，peak_value = max(snapshots, current)）；
 *   5. **weekly_return_pct**   — 本周净值变化（= (current - last_week_start_total) /
 *                                 last_week_start_total，找 ≥ 7 日前 snapshot 的
 *                                 总值；若 < 7 日 snapshot 历史则 null）；
 *   6. **unresolved_alerts_count** — 未读 RiskAlert 计数（is_read=false 全 level）；
 *
 * **设计取舍**：
 *   - **PK = (user_id, date) 复合唯一索引** — 同一用户同一天最多一行；UPSERT 时
 *     若上午跑过 + 下午手动重跑（admin 重发）会覆盖既有行（updated_at 反映最新计算）；
 *   - **portfolio_id 单一字段** — 当前 AC 一个用户一个组合（quant only 模式），未来
 *     扩多组合时可加 portfolio_id 进入 PK 形成 3-tuple，schema 不破坏向后兼容；
 *   - **drawdown / weekly_return / max_industry_pct 全 nullable** — 数据不足
 *     （新账户 snapshot 历史 < 7 日 / 0 持仓时无行业聚合）时落 null 而非 0，
 *     与 US-049/US-052 风控信号"数据缺失 → 信号 null → 安全 HOLD"范式一致；
 *   - 通知交付状态统一由 `feishu_notification_outbox` 管理，本表只保存体检业务快照；
 *   - **timestamps 'underscored'** — 与 US-040+ models 一致（避免 createdAt/updatedAt
 *     camelCase 与 Sequelize 默认 snake_case 不匹配产生 'column "createdAt" does not exist' 报错）。
 *
 * **消费方**：
 *   - GET /api/risk/morning-checkup/today — UI 早盘开盘前展示"今日体检"；
 *   - `FeishuNotificationService` 以 user/date 幂等键投递体检摘要；
 *   - 未来 US-082 周报 / 月报 服务可拉历史 checkups 做趋势可视化。
 */
@Table({
  tableName: 'morning_risk_checkups',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['user_id', 'date'], unique: true, name: 'morning_risk_checkups_user_date_uniq' },
    { fields: ['date'] },
  ],
})
export class MorningRiskCheckup extends Model {
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
    comment: '所属用户 ID',
  })
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'portfolio_id',
    comment: '关联的 paper-trading portfolio ID（无 portfolio 时 null）',
  })
  declare portfolio_id: number | null;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    comment: '体检日期（YYYY-MM-DD，本地交易日）',
  })
  declare date: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'positions_count',
    comment: '当前持仓只数（quantity > 0）',
  })
  declare positions_count: number;

  @Column({
    type: DataType.DECIMAL(8, 6),
    allowNull: true,
    field: 'max_single_pct',
    comment: '单股最大占比 0-1（market_value / total_position_value，不含 cash；0 持仓时 null）',
  })
  declare max_single_pct: number | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'max_single_symbol',
    comment: '占比最大的股票 symbol（与 max_single_pct 对应；0 持仓时 null）',
  })
  declare max_single_symbol: string | null;

  @Column({
    type: DataType.DECIMAL(8, 6),
    allowNull: true,
    field: 'max_industry_pct',
    comment: '行业最大占比 0-1（同 US-052 aggregateByIndustry；0 持仓时 null）',
  })
  declare max_industry_pct: number | null;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'max_industry_name',
    comment: '占比最大的行业名（未分类时 "__UNKNOWN__"；0 持仓时 null）',
  })
  declare max_industry_name: string | null;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: true,
    field: 'current_total_value',
    comment: '当前组合总市值（资金 + 持仓），快照刻',
  })
  declare current_total_value: number | null;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: true,
    field: 'peak_value',
    comment: '历史峰值（max(snapshots.total_value, current_total_value)）— US-049 范式',
  })
  declare peak_value: number | null;

  @Column({
    type: DataType.DECIMAL(8, 6),
    allowNull: true,
    field: 'drawdown_pct',
    comment: '当前回撤 0-1 ((peak - current) / peak)；peak ≤ 0 或新账户为 null',
  })
  declare drawdown_pct: number | null;

  @Column({
    type: DataType.DECIMAL(10, 6),
    allowNull: true,
    field: 'weekly_return_pct',
    comment:
      '近 7 日净值变化 ((current - last_week_total) / last_week_total)；snapshot 历史 < 7 日为 null',
  })
  declare weekly_return_pct: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'unresolved_alerts_count',
    comment: '未读 RiskAlert 数（is_read=false 全 level）',
  })
  declare unresolved_alerts_count: number;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    field: 'breakdown',
    comment: '可选明细 JSON：per-symbol pct / per-industry pct / 触发的告警 ID 列表等',
  })
  declare breakdown: Record<string, unknown> | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'message',
    comment: '人类可读的中文摘要（推送通道直接使用）',
  })
  declare message: string | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'error',
    comment: '执行出错时填入错误消息；正常情况为 null',
  })
  declare error: string | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
