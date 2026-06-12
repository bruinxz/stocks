/**
 * EquityCurveGovernorState — Sprint 3 资金曲线 governor 状态
 *
 * 每次 EquityCurveGovernor.evaluate() 写一行（每日 cron + 每次平仓后触发）。
 * 让用户看到健康度档位的时间序列，以及哪个指标触发了降档。
 *
 * 单行 = 单次 evaluation 快照（不 upsert）。
 */
import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

export type GovernorHealthTier = 'healthy' | 'cautious' | 'defensive' | 'critical' | 'observe_only';

@Table({
  tableName: 'equity_curve_governor_states',
  timestamps: true,
  underscored: true,
  updatedAt: false,
  indexes: [
    { fields: ['portfolio_id', 'created_at'] },
    { fields: ['tier'] },
    { fields: ['as_of_date'] },
  ],
})
export class EquityCurveGovernorState extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'portfolio_id' })
  declare portfolio_id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Column({ type: DataType.STRING(10), allowNull: false, field: 'as_of_date' })
  declare as_of_date: string;

  /** healthy | cautious | defensive | critical | observe_only */
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare tier: GovernorHealthTier;

  /** Kelly 倍数 (1.0 / 0.7 / 0.4 / 0.2 / 0.0) */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: false, field: 'kelly_multiplier' })
  declare kelly_multiplier: number;

  /** 30 日实盘 sharpe */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: true, field: 'recent_sharpe_30d' })
  declare recent_sharpe_30d?: number | null;

  /** 当前回撤百分比（正数，e.g. 12.5 = 12.5%） */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: true, field: 'current_drawdown_pct' })
  declare current_drawdown_pct?: number | null;

  /** 30 日 win_rate（小数 0-1） */
  @Column({ type: DataType.DECIMAL(8, 6), allowNull: true, field: 'recent_winrate_30d' })
  declare recent_winrate_30d?: number | null;

  /** 触发降档的主因 */
  @Column({ type: DataType.STRING(60), allowNull: true, field: 'trigger_reason' })
  declare trigger_reason?: string | null;

  /** 上一档（用于 UI 显示状态变化） */
  @Column({ type: DataType.STRING(20), allowNull: true, field: 'previous_tier' })
  declare previous_tier?: GovernorHealthTier | null;

  /** 是否本次 evaluation 发生了档位切换 */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare tier_changed: boolean;

  /** 自然语言总结 */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare summary?: string | null;

  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: {} })
  declare metadata?: Record<string, any>;

  @CreatedAt
  declare created_at: Date;
}
