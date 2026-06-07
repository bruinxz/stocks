import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * StrategyPortfolioResult — 多策略组合优化结果（US-044）
 *
 * 一行 = 一次"输入 N 个策略各自的日收益序列 → 求解最大化夏普的权重组合"。
 * 与 MonteCarloResult / RegimeBacktestResult 同款 — 不是新的优化任务（不复用
 * OptimizationRun 父表），而是"对一组已完成回测做事后组合权重求解"。
 *
 * **`strategy_keys_json` + `weights_json` 严格对齐**：
 *   - `strategy_keys_json: string[]`：N 个被组合策略的 key（按求解输入顺序）。
 *   - `weights_json: number[]`：长度 = N 的最优权重，sum=1 ± epsilon，每个 ∈ [0, max_weight]。
 *   - **两数组按 index 对齐**；前端 zip 显示"策略 X 权重 Y%"。
 *
 * **求解器元信息**：
 *   - `solver`：本次使用的求解算法标签（'projected_gradient' / 'grid_search' / 'random_search'
 *     等。AC 只允许梯度下降 / lp 解；当前实现是 projected gradient 兜底 + 网格搜索精化）。
 *   - `iterations`：求解器迭代次数（梯度法）；调试用，让 ops 看收敛快慢。
 *   - `converged`：求解是否收敛到 tolerance 内（false → ops 看是否需要调超参）。
 *
 * **约束元信息（物化）**：
 *   - `max_weight`：单策略权重上限（AC 默认 0.4 = 40%）。
 *   - `min_weight`：单策略权重下限（默认 0 = 允许策略权重 0；未来扩展 long-only / long-short）。
 *
 * **诊断字段**：
 *   - `lookback_days`：求解所用日收益窗口；NULL = 用全部传入日。
 *   - `period_start / period_end`：组合求解所用日收益的实际起止日期（覆盖 align 后实际有数据的范围）。
 *   - `daily_return_count`：求解所用对齐后的日收益数（不是某单策略长度，是 ∩ 后）。
 *   - `notes`：调用方自由文本，写"为什么跑这个组合"（"对照 grid 优化前后"等）。
 *
 * **设计取舍 — 不复用 OptimizationRun 父表**（同 US-040/US-041/US-042/US-043 判据）：
 *   - 组合优化是"对一组已完成 backtest 做事后求解"，不是新的优化任务；
 *   - 直接通过 `strategy_keys_json` + `period_start / end` 关联源回测，关联清晰；
 *   - 不需要 status='pending'→'running'→'completed' 状态机（求解是同步本地算法，几秒到几十秒）。
 *
 * 主要消费方：
 *   - PortfolioOptimizer.optimize()（US-044）
 *   - optimize-portfolio.ts CLI
 *   - 未来 US-016 策略实验室 "组合优化" tab
 *   - 未来 US-086 仓位再平衡引擎用 weights 作为目标配比
 */
@Table({
  tableName: 'strategy_portfolio_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['solver'] },
    { fields: ['converged'] },
    { fields: ['created_at'] },
    { fields: ['computed_at'] },
  ],
})
export class StrategyPortfolioResult extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'strategy_keys_json',
    defaultValue: [],
    comment: '被组合的策略 key 数组（按求解输入顺序，与 weights_json 严格 index 对齐）',
  })
  declare strategy_keys_json: string[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'weights_json',
    defaultValue: [],
    comment: '最优权重数组（sum=1 ± epsilon，每个 ∈ [min_weight, max_weight]）',
  })
  declare weights_json: number[];

  // === 组合的整体指标（AC 必须）===
  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'annual_return',
    comment: '组合年化收益（百分数；e.g. 18.5 = 18.5%）；样本不足时 NULL',
  })
  declare annual_return?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    comment: '组合夏普（mean / std * sqrt(252)）；样本不足时 NULL',
  })
  declare sharpe?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'max_drawdown',
    comment: '组合权益曲线最大回撤的绝对值（正数百分数；e.g. 15.5 = -15.5% 回撤）',
  })
  declare max_drawdown?: number | null;

  // === 求解器元信息 ===
  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'projected_gradient',
    comment: '本次使用的求解算法标签：projected_gradient / grid_search / equal_weight',
  })
  declare solver: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: '求解器迭代次数（梯度法）；非梯度法 = 0',
  })
  declare iterations: number;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    comment: '是否在 tolerance 内收敛；false 时 ops 需要调超参',
  })
  declare converged: boolean;

  // === 约束元信息 ===
  @Column({
    type: DataType.DECIMAL(5, 4),
    allowNull: false,
    field: 'max_weight',
    defaultValue: 0.4,
    comment: '单策略权重上限（AC 默认 0.4 = 40%）',
  })
  declare max_weight: number;

  @Column({
    type: DataType.DECIMAL(5, 4),
    allowNull: false,
    field: 'min_weight',
    defaultValue: 0.0,
    comment: '单策略权重下限（默认 0 = 允许策略权重 0）',
  })
  declare min_weight: number;

  // === 诊断字段 ===
  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'lookback_days',
    comment: '求解所用日收益窗口；NULL = 用全部传入日',
  })
  declare lookback_days?: number | null;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'period_start',
    comment: '求解所用日收益的实际起始日期（align 后实际有数据的范围）',
  })
  declare period_start?: string | null;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'period_end',
    comment: '求解所用日收益的实际结束日期',
  })
  declare period_end?: string | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'daily_return_count',
    defaultValue: 0,
    comment: '求解所用对齐后的日收益数（不是某单策略长度，是 ∩ 后）',
  })
  declare daily_return_count: number;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '调用方自由文本，写"为什么跑这个组合"',
  })
  declare notes?: string | null;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'computed_at',
    comment: '最近一次跑的时间（每次重跑覆盖更新）',
  })
  declare computed_at: Date;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'portfolio_optimizer',
    comment: '写入来源标识（默认 portfolio_optimizer；离线脚本可写 batch_portfolio）',
  })
  declare source: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
