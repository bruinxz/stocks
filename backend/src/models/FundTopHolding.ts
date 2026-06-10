import { Table, Column, Model, DataType, PrimaryKey, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 公募基金重仓股 — 季报披露 (2026-06-11 新增).
 *
 * 一行 = (fund_code, stock_code, report_date) 某基金某季度的某只重仓股 (TOP 10).
 *
 * 用途:
 *   - 抱团股动量策略：被多个基金重仓的股 → 机构资金信号
 *   - 公募加仓 / 减仓追踪：环比变化 (上季报 vs 本季报)
 *   - "聪明钱" 跟随：QFII / 知名公募 (如易方达蓝筹 / 中欧医疗) 持仓变动
 *
 * 数据源 AKShare fund_portfolio_hold_em(symbol=fund_code, date=year).
 * 季度 cron 触发即可，无需日度.
 */
@Table({
  tableName: 'fund_top_holdings',
  indexes: [
    { fields: ['fund_code'] },
    { fields: ['stock_code'] },
    { fields: ['report_date'] },
    { fields: ['stock_code', 'report_date'] },
  ],
  comment: '公募基金重仓股 (TOP 10) 季报',
})
export class FundTopHolding extends Model<FundTopHolding> {
  @PrimaryKey
  @Column({ type: DataType.STRING(10), allowNull: false, field: 'fund_code' })
  declare fund_code: string;

  @PrimaryKey
  @Column({ type: DataType.STRING(10), allowNull: false, field: 'stock_code' })
  declare stock_code: string;

  @PrimaryKey
  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'report_date' })
  declare report_date: string; // 季报披露的报告期末 e.g. 2026-03-31

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'stock_name' })
  declare stock_name: string | null;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'ratio_pct' })
  declare ratio_pct: number | null; // 占净值比例 %

  @Column({ type: DataType.DECIMAL(20, 0), allowNull: true, field: 'shares' })
  declare shares: number | null; // 持股数

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true, field: 'market_value' })
  declare market_value: number | null; // 持仓市值

  @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: 'akshare', field: 'source' })
  declare source: string;

  @CreatedAt
  declare created_at: Date;

  @UpdatedAt
  declare updated_at: Date;
}
