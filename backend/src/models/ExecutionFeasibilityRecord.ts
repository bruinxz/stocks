/**
 * ExecutionFeasibilityRecord — Sprint 1B 单次执行可行性评分记录
 *
 * 每次对 (symbol, side, target_qty, target_price, as_of) 调用
 * ExecutionFeasibilityService.computeFeasibility 都写一行（可选 persist）。
 *
 * 主要消费方：
 *   - Buy Gate 决策前查"这个候选能不能 fill"
 *   - 订单草稿 UI 显示 fillable_score 让用户判断
 *   - Ops 巡检"哪些候选总是 fail to fill"找数据/策略问题
 */
import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'execution_feasibility_records',
  timestamps: true,
  underscored: true,
  updatedAt: false,
  indexes: [
    { fields: ['symbol', 'as_of_date'] },
    { fields: ['user_id', 'created_at'] },
    { fields: ['composite_score'] },
  ],
})
export class ExecutionFeasibilityRecord extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare user_id?: number | null;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(8), allowNull: false })
  declare side: 'BUY' | 'SELL';

  @Column({ type: DataType.DECIMAL(14, 2), allowNull: false, field: 'target_qty' })
  declare target_qty: number;

  @Column({ type: DataType.DECIMAL(14, 4), allowNull: true, field: 'target_price' })
  declare target_price?: number | null;

  @Column({ type: DataType.STRING(10), allowNull: false, field: 'as_of_date' })
  declare as_of_date: string;

  /** 综合 fillable_score 0-100 */
  @Column({ type: DataType.DECIMAL(6, 2), allowNull: false, field: 'composite_score' })
  declare composite_score: number;

  /** 涨跌停距离评分 0-100 */
  @Column({ type: DataType.DECIMAL(6, 2), allowNull: true, field: 'limit_proximity_score' })
  declare limit_proximity_score?: number | null;

  /** 成交额覆盖率评分 0-100 */
  @Column({ type: DataType.DECIMAL(6, 2), allowNull: true, field: 'volume_coverage_score' })
  declare volume_coverage_score?: number | null;

  /** 价差评分 0-100 */
  @Column({ type: DataType.DECIMAL(6, 2), allowNull: true, field: 'spread_score' })
  declare spread_score?: number | null;

  /** 状态硬约束评分 0-100 */
  @Column({ type: DataType.DECIMAL(6, 2), allowNull: true, field: 'status_score' })
  declare status_score?: number | null;

  /** 决策：'fillable' | 'risky' | 'blocked' */
  @Column({ type: DataType.STRING(20), allowNull: false })
  declare decision: 'fillable' | 'risky' | 'blocked';

  /** blocking reasons (hard block) — limit_up / suspended / st / t_plus_1 / negative_volume etc */
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: [], field: 'block_reasons' })
  declare block_reasons?: string[];

  /** 自然语言总结 */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare summary?: string | null;

  /** 完整 detail metadata */
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: {} })
  declare metadata?: Record<string, any>;

  @CreatedAt
  declare created_at: Date;
}
