/**
 * PortfolioConstructionResult — Sprint 2B 股票级风险预算组合优化结果
 *
 * 与 StrategyPortfolioResult（US-044 策略级权重）不同：本表是**股票级**的组合
 * 构造结果。输入是 M 个候选股票 + alpha_scores + cov 矩阵 + 约束，输出是
 * M 个 weights 满足风险预算。
 *
 * 每次 PortfolioConstructionService.construct() 写一行（可选 persist）。
 */
import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'portfolio_construction_results',
  timestamps: true,
  underscored: true,
  updatedAt: false,
  indexes: [
    { fields: ['user_id', 'created_at'] },
    { fields: ['method'] },
    { fields: ['as_of_date'] },
  ],
})
export class PortfolioConstructionResult extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'user_id' })
  declare user_id?: number | null;

  @Column({ type: DataType.STRING(10), allowNull: false, field: 'as_of_date' })
  declare as_of_date: string;

  /** 'risk_parity' | 'equal_weight' | 'min_variance' | 'max_sharpe' */
  @Column({ type: DataType.STRING(40), allowNull: false })
  declare method: string;

  /** 候选 symbols 数 (M) */
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'n_assets' })
  declare n_assets: number;

  /** symbols 数组（与 weights 一一对齐） */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'symbols_json' })
  declare symbols_json: string[];

  /** weights 数组（sum ≈ 1，长度 = n_assets） */
  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'weights_json' })
  declare weights_json: number[];

  /** 每只股票的 risk_contribution（占组合 variance 的比例；与 weights 对齐） */
  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: [],
    field: 'risk_contributions_json',
  })
  declare risk_contributions_json?: number[];

  /** 行业 exposure {industry: pct} */
  @Column({
    type: DataType.JSONB,
    allowNull: true,
    defaultValue: {},
    field: 'industry_exposure_json',
  })
  declare industry_exposure_json?: Record<string, number>;

  /** 总仓位占比（< 1 表示留现金） */
  @Column({ type: DataType.DECIMAL(8, 6), allowNull: false, field: 'total_allocation' })
  declare total_allocation: number;

  /** 是否收敛（迭代算法） */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare converged: boolean;

  /** 迭代次数 */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare iterations: number;

  /** 约束 snapshot */
  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: {}, field: 'constraints_json' })
  declare constraints_json?: Record<string, any>;

  /** 自然语言总结 */
  @Column({ type: DataType.TEXT, allowNull: true })
  declare summary?: string | null;

  @Column({ type: DataType.JSONB, allowNull: true, defaultValue: {} })
  declare metadata?: Record<string, any>;

  @CreatedAt
  declare created_at: Date;
}
