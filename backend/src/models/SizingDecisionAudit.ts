/**
 * SizingDecisionAudit — Phase 2+ 每次 sizing 决策的审计行
 *
 * 每次 PaperTradingAutomationService 触发 decideSizing 都写一行：
 *   - 不论 shadow / hard cutover 模式都写
 *   - 包含完整 decision 上下文 (method / policy / context / decision)
 *   - 后续 ShadowSizingComparisonService 用此表生成 A/B 报告
 *
 * 用途：
 *   1. 用户切换 hard_cutover 前查"如果当时用 Kelly 会下多少钱"
 *   2. 出问题时回溯"那笔奇怪交易的 sizing 决策是什么逻辑"
 *   3. ops 看每个 method 的 delta 分布是否合理
 */
import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'sizing_decision_audits',
  timestamps: true,
  underscored: true,
  updatedAt: false,
  indexes: [
    { fields: ['portfolio_id', 'created_at'] },
    { fields: ['strategy_key'] },
    { fields: ['method'] },
    { fields: ['symbol'] },
  ],
})
export class SizingDecisionAudit extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'portfolio_id' })
  declare portfolio_id: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'signal_id' })
  declare signal_id?: number;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(60), allowNull: true, field: 'strategy_key' })
  declare strategy_key?: string;

  /** equal_pct / vol_target / atr_based / kelly */
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare method: string;

  /** true=hard cutover (decision 真正生效); false=shadow (只 log) */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare hard_cutover: boolean;

  /** 用户实际下单的 position_pct (硬模式下=decision_pct, shadow 下=原 equal_pct) */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: false, field: 'actual_pct' })
  declare actual_pct: number;

  /** decideSizing 计算出的 position_pct (理论值) */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: false, field: 'decision_pct' })
  declare decision_pct: number;

  /** decision_pct - actual_pct (硬模式下=0; shadow 下=两种方法的差异) */
  @Column({ type: DataType.DECIMAL(8, 4), allowNull: false })
  declare delta: number;

  /** decision 的人类可读 reason */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason?: string;

  /** true if decision 被 max_position_pct cap 触顶 */
  @Column({ type: DataType.BOOLEAN, allowNull: true, field: 'capped_by_max' })
  declare capped_by_max?: boolean;

  /** true if decision 被 available_cash cap 触顶 */
  @Column({ type: DataType.BOOLEAN, allowNull: true, field: 'capped_by_cash' })
  declare capped_by_cash?: boolean;

  /** 完整 context + policy 快照 (debug 用) */
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  declare created_at: Date;
}
