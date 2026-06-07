import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * FactorICResult — 因子 IC 报告与衰减分析的统计结果（US-041）
 *
 * 一行 = 一次"在 [period_start, period_end] 区间上算 factor_name 因子在
 * look_forward_days 日 forward return 维度的 IC 聚合统计"。
 *
 * **复合主键 4-tuple `(factor_name, look_forward_days, period_start, period_end)`**：
 * ops 重跑同因子、同窗口、同区间时直接 idempotent upsert 覆盖（最新统计为准），
 * 而非堆 N 行；不同区间或不同窗口或不同因子的结果各占一行，互不干扰。AC 提到
 * `computed_at` 是"什么时候跑的"信息，而不是唯一性键 —— ops 通过它看到"我这次
 * 看到的 IC 是几小时前算的"。
 *
 * **指标语义**（与 IC / Information Coefficient / IR 量化界标准一致）：
 *   - `ic_mean`：sample_count 个交易日 Spearman 秩相关的算术均值；
 *     > 0.05 一般认为因子有 alpha；< 0.02 持续多次基本失效。
 *   - `ic_std`：n-1 样本标准差；表示 IC 的波动性。
 *   - `ic_ir = ic_mean / ic_std`：信息比率；> 0.5 算稳健、> 1.0 优秀。
 *     `ic_std = 0`（极少；通常发生在 sample_count < 2）时 `ic_ir = null`。
 *   - `ic_positive_ratio`：sample_count 中 IC > 0 的天数占比，0..1 小数；
 *     > 0.6 表示因子方向一致性强。
 *
 * **诊断字段（非 AC 必须，但 ops 重跑时一眼能看到"我这个统计可不可信"）**：
 *   - `sample_count`：实际进入聚合的"有效 IC 日数"（横截面 ≥ MIN_CROSS_SECTION_SIZE
 *     且 forward return 真实可得的天数）。区间总日数 - sample_count = 因数据不足
 *     被丢弃的天数。
 *   - `universe_avg_size`：平均每个有效 IC 日参与的双有效（factor_score & forward
 *     return 都非 NaN）的股票数。若远低于 universe 平均说明有大量缺数据。
 *
 * **跨 lookForwardDays 衰减分析的查询模式**：
 *   ```sql
 *   SELECT look_forward_days, ic_mean, ic_ir
 *   FROM factor_ic_results
 *   WHERE factor_name = 'value' AND period_start = '2024-01-01' AND period_end = '2026-06-05'
 *   ORDER BY look_forward_days;
 *   -- 把 1/5/10/20/60 日窗口的 ic_mean 画成衰减曲线
 *   ```
 *
 * 主要消费方：
 *   - FactorICReport.generate()（US-041）
 *   - compute-factor-ic.ts CLI
 *   - 未来 US-042 FactorCorrelationReport 可能 join 本表做"高 IC + 低相关"组合
 *   - 未来 US-044 PortfolioOptimizer 用 IC_IR 做因子权重先验
 *   - 未来 US-015 FactorWorkspace 在因子卡片上直接展示 IC/IC_IR
 */
@Table({
  tableName: 'factor_ic_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['factor_name'] },
    { fields: ['factor_name', 'look_forward_days'] },
    { fields: ['look_forward_days'] },
    { fields: ['period_end'] },
    { fields: ['factor_name', 'period_end'] },
  ],
})
export class FactorICResult extends Model {
  @Column({
    type: DataType.STRING(64),
    allowNull: false,
    primaryKey: true,
    field: 'factor_name',
    comment:
      '因子名（必须与 FactorRegistry.register 时的 name 一致，例如 value / quality / momentum）',
  })
  declare factor_name: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    primaryKey: true,
    field: 'look_forward_days',
    comment: 'IC 计算的 forward return 窗口长度（交易日数；AC 指定 1/5/10/20/60）',
  })
  declare look_forward_days: number;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'period_start',
    comment:
      '聚合区间起始交易日（YYYY-MM-DD，闭区间；= 实际入参 start_date 截至此日有 factor_score 的最早一天）',
  })
  declare period_start: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'period_end',
    comment:
      '聚合区间结束交易日（YYYY-MM-DD，闭区间；= 实际入参 end_date 之内 base_date+lookForward 不越界的最晚一天）',
  })
  declare period_end: string;

  @Column({
    type: DataType.DECIMAL(12, 6),
    allowNull: true,
    field: 'ic_mean',
    comment:
      '区间内 sample_count 个交易日 Spearman 秩相关的算术均值（无量纲，-1..1）；sample_count=0 时 NULL',
  })
  declare ic_mean?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 6),
    allowNull: true,
    field: 'ic_std',
    comment: '日度 IC 的 n-1 样本标准差；sample_count < 2 时 NULL',
  })
  declare ic_std?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 6),
    allowNull: true,
    field: 'ic_ir',
    comment: 'IC_IR = ic_mean / ic_std（信息比率）；ic_std=0 或 NULL 时 NULL',
  })
  declare ic_ir?: number | null;

  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: true,
    field: 'ic_positive_ratio',
    comment: 'sample_count 中 IC > 0 的天数占比（0..1 小数）；sample_count=0 时 NULL',
  })
  declare ic_positive_ratio?: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'sample_count',
    defaultValue: 0,
    comment:
      '实际进入聚合的"有效 IC 日数"（横截面 ≥ MIN_CROSS_SECTION_SIZE 且 forward return 可得的天数）',
  })
  declare sample_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'universe_avg_size',
    defaultValue: 0,
    comment: '平均每个有效 IC 日参与的双有效（factor_score & forward return 都非 NaN）的股票数',
  })
  declare universe_avg_size: number;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'computed_at',
    comment: '最近一次跑的时间（每次重跑覆盖更新；让 ops 看到"我看到的统计可不可信"）',
  })
  declare computed_at: Date;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'factor_ic_report',
    comment: '写入来源标识（默认 factor_ic_report；离线脚本可写 batch_ic）',
  })
  declare source: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
