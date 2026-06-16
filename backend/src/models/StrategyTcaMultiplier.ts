/**
 * StrategyTcaMultiplier — Sprint 43-B 交易成本归因 (TCA) per-strategy 周报
 *
 * 每周一晚 19:30 cron (TCA_WEEKLY_REPORT) 跑一次 TCAService.runAttribution()
 * 后 upsert 一行 per-strategy. 用 (strategy_key, report_date) 作 unique 约束:
 * 同一周的报告覆盖 (允许人工补跑而不重复).
 *
 * 下游消费方:
 *   - StrategyAllocationPolicy: getAllocationPolicy() 时按 recommended_weight_multiplier
 *     乘到 per-strategy weight, 让实盘买不到/滑点大的策略自动降权
 *   - Dashboard: TCA 周报 UI 直接读此表展示 per-strategy attribution
 *
 * 设计要点:
 *   1. (strategy_key, report_date) unique → upsert 语义, 防一周重复行
 *   2. warning 字段三档 ('ok'/'high_cost'/'severe') 给 UI 用颜色标识
 *   3. metadata JSONB 留扩展余地 (未来加 dimensional break-down)
 *   4. 不存 per-trade detail (per_trade 在 TCAService 内存中已算, 不需持久化全部)
 */
import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

export type TcaWarning = 'ok' | 'high_cost' | 'severe';

@Table({
  tableName: 'strategy_tca_multipliers',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['strategy_key'] },
    { fields: ['report_date'] },
    { fields: ['warning'] },
    { fields: ['strategy_key', 'report_date'], unique: true },
  ],
})
export class StrategyTcaMultiplier extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  /** 报告日期 (ISO YYYY-MM-DD) - 一般是 weekly cron 跑当天 */
  @Column({ type: DataType.STRING(10), allowNull: false, field: 'report_date' })
  declare report_date: string;

  /** 本次 attribution 的 lookback 天数 (默认 30) */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 30, field: 'lookback_days' })
  declare lookback_days: number;

  /** lookback 内该策略已 closed trade 数 */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'trade_count' })
  declare trade_count: number;

  /** 平均 realized pnl % (小数, e.g. 0.05 = 5%) */
  @Column({ type: DataType.DECIMAL(10, 6), allowNull: true, field: 'avg_realized_pnl_pct' })
  declare avg_realized_pnl_pct?: number | null;

  /** 平均 tracking error % (signal expected - realized) */
  @Column({ type: DataType.DECIMAL(10, 6), allowNull: true, field: 'avg_tracking_error_pct' })
  declare avg_tracking_error_pct?: number | null;

  /** 平均 entry slippage % */
  @Column({ type: DataType.DECIMAL(10, 6), allowNull: true, field: 'avg_entry_slippage_pct' })
  declare avg_entry_slippage_pct?: number | null;

  /** 平均 impact cost % */
  @Column({ type: DataType.DECIMAL(10, 6), allowNull: true, field: 'avg_impact_cost_pct' })
  declare avg_impact_cost_pct?: number | null;

  /** 建议权重 multiplier (0.5 / 0.7 / 1.0) */
  @Column({
    type: DataType.DECIMAL(8, 4),
    allowNull: false,
    defaultValue: 1.0,
    field: 'recommended_weight_multiplier',
  })
  declare recommended_weight_multiplier: number;

  /** 'ok' | 'high_cost' | 'severe' */
  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'ok' })
  declare warning: TcaWarning;

  /** 人工可读的诊断说明 */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason?: string | null;

  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: {} })
  declare metadata?: Record<string, any>;

  @CreatedAt
  declare created_at: Date;

  @UpdatedAt
  declare updated_at: Date;
}
