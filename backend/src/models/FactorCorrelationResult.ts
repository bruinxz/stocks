import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * FactorCorrelationResult — 因子两两相关性矩阵的统计结果（US-042）
 *
 * 一行 = 一次"在 [period_start, period_end] 区间上算 factor_a 与 factor_b 在
 * (trade_date, stock_code) 横截面层面 Spearman 秩相关 → 区间内每个 trade_date
 * 一个相关 → 跨日聚合的相关均值"。
 *
 * **复合主键 4-tuple `(factor_a, factor_b, period_start, period_end)`**（与
 * US-041 FactorICResult 同款判据）：
 *   - ops 重跑同一对因子、同一区间时直接 idempotent upsert 覆盖（最新统计为准），
 *     而非堆 N 行；
 *   - **本表只保存 factor_a < factor_b 的"上三角"对** —— 减半行数，下游
 *     UI 拼"对称矩阵"时 `factor_b vs factor_a` 反向查同一行即可；
 *   - `computed_at` 是"什么时候跑的"信息，而不是唯一性键 —— ops 通过它看到
 *     "我这次看到的相关是几小时前算的"。
 *
 * **指标语义**：
 *   - `correlation`：sample_count 个交易日 Spearman 秩相关的算术均值（[-1, 1]）。
 *     |correlation| > 0.7 → 标记 is_redundant=true 触发 RiskAlert（高度共线）；
 *     |correlation| ∈ [0.5, 0.7] → 注意，但仍可同时使用；
 *     |correlation| < 0.5 → 因子独立性好。
 *   - `sample_count`：实际进入聚合的"有效日数"（双因子横截面 ≥ MIN_PAIR_SIZE）。
 *   - `universe_avg_size`：每个有效日的平均双有效股票数（factor_a & factor_b 都有 z_score 的股票数）。
 *
 * **诊断字段**：
 *   - `is_redundant`：bool；|correlation| > REDUNDANCY_THRESHOLD（默认 0.7）时为 true，
 *     方便 UI 直接按此字段筛选高相关对。
 *
 * 主要消费方：
 *   - FactorCorrelationReport.generate()（US-042）
 *   - compute-factor-correlation.ts CLI
 *   - 未来 US-016 FactorWorkspace 因子相关性热力图
 *   - 未来 US-044 PortfolioOptimizer 加因子组合优化时排除高相关对
 *
 * **不复用 OptimizationRun 父表**（与 US-041 FactorICResult 同款"事后分析 vs
 * 优化任务" 判据）：相关性矩阵是 "对已有 FactorScore 做事后分析"，不是优化
 * 任务，直接 4-tuple PK 独立写本表。
 */
@Table({
  tableName: 'factor_correlation_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['factor_a'] },
    { fields: ['factor_b'] },
    { fields: ['factor_a', 'factor_b'] },
    { fields: ['period_end'] },
    { fields: ['is_redundant'] },
    { fields: ['period_end', 'is_redundant'] },
  ],
})
export class FactorCorrelationResult extends Model {
  @Column({
    type: DataType.STRING(64),
    allowNull: false,
    primaryKey: true,
    field: 'factor_a',
    comment:
      '因子 A 名（必须 < factor_b 字典序；本表只保存上三角对避免重复 — 下游查 b vs a 反向 lookup 即可）',
  })
  declare factor_a: string;

  @Column({
    type: DataType.STRING(64),
    allowNull: false,
    primaryKey: true,
    field: 'factor_b',
    comment: '因子 B 名（必须 > factor_a 字典序）',
  })
  declare factor_b: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'period_start',
    comment:
      '聚合区间起始交易日（YYYY-MM-DD，闭区间；= 实际入参 start_date 截至此日双因子都有 factor_score 的最早一天）',
  })
  declare period_start: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'period_end',
    comment: '聚合区间结束交易日（YYYY-MM-DD，闭区间；= 实际入参 end_date 之内最晚一天有效相关日）',
  })
  declare period_end: string;

  @Column({
    type: DataType.DECIMAL(12, 6),
    allowNull: true,
    field: 'correlation',
    comment:
      'sample_count 个交易日横截面 Spearman 秩相关的算术均值（无量纲，-1..1）；sample_count=0 时 NULL',
  })
  declare correlation?: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'sample_count',
    defaultValue: 0,
    comment: '实际进入聚合的"有效日数"（双因子横截面交集 ≥ MIN_PAIR_SIZE 的天数）',
  })
  declare sample_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'universe_avg_size',
    defaultValue: 0,
    comment: '每个有效日平均的双有效（factor_a & factor_b 都有 z_score）股票数',
  })
  declare universe_avg_size: number;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    field: 'is_redundant',
    defaultValue: false,
    comment:
      '|correlation| > REDUNDANCY_THRESHOLD（默认 0.7）→ true；UI 高相关对热力图直接按此字段筛选',
  })
  declare is_redundant: boolean;

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
    defaultValue: 'factor_correlation_report',
    comment: '写入来源标识（默认 factor_correlation_report；离线脚本可写 batch_corr）',
  })
  declare source: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
