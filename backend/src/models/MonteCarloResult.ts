import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * MonteCarloResult — 蒙特卡洛压力测试结果（US-043）
 *
 * 一行 = 一次"对某次完成的回测（QuantBacktestResult.id）做 N 次交易重排模拟，
 * 聚合各模拟的最终收益 / 最大回撤 / 夏普分位数"。
 *
 * **`base_run_id` 语义**：
 *   - 引用 QuantBacktestResult.id（被 stress-test 的源回测）；NOT NULL。
 *   - 仅在 MonteCarloStressTest.run(persist:true) 时落库；in-memory 干跑不写本表。
 *
 * **复合主键 2-tuple `(base_run_id, seed)`**：
 *   - 同一份源回测 + 同一 seed → idempotent upsert（最新参数为准），让 ops 可
 *     直接重跑覆盖；
 *   - 不同 seed 互不冲突（用户可同时跑 seed=42 + seed=100 做对比）；
 *   - simulation_count / 分位数等都是 "summary 性质"，不进入 PK。
 *
 * **分位数语义**（AC 指定 + 量化界惯例）：
 *   - `return_p5`：最差 5% 模拟最终收益（百分数；e.g. -25.0 表示 5% 概率最终亏损 25%）
 *   - `return_p50`：中位数（best estimate of expected final return）
 *   - `return_p95`：最好 5% 模拟最终收益
 *   - `drawdown_p95`：95% 分位数的最大回撤（绝对值正数；e.g. 18.0 表示 5% 概率回撤 ≥ 18%）
 *   - `sharpe_p5`：最差 5% 分位的 sharpe（量化策略稳健性下沿）
 *
 * **诊断字段（非 AC 必须，但 ops 看分布形态用）**：
 *   - `return_mean / return_std`：N 次模拟最终收益的均值 / 标准差
 *   - `drawdown_mean`：N 次模拟最大回撤均值
 *   - `sharpe_mean`：N 次模拟 sharpe 均值
 *   - `trade_count`：源回测的成交数 (= 每次模拟用来重排的 returns 数量)
 *   - `positive_simulation_ratio`：N 次模拟里 final_return > 0 的占比，0..1 小数；
 *     远低于 0.5 说明策略"靠运气" — 历史成功是少数高赢交易撑起来的
 *   - `var_p5`：与 return_p5 等价（CVaR 行业惯称 'value at risk'），便于 SQL 查询者
 *     按 finance 命名直接 SELECT；冗余的几十字节换查询便利
 *   - `computed_at`：最近一次跑的时间（每次重跑覆盖更新；让 ops 看到"我看到的统计
 *     可不可信"）
 *
 * **设计取舍 — 不复用 OptimizationRun 父表**（同 US-040/US-041/US-042 判据）：
 *   - 蒙特卡洛是"对已完成 backtest 做事后分析"，不是新的优化任务；
 *   - 直接通过 `base_run_id` 引用 QuantBacktestResult.id，关联清晰；
 *   - 不需要 status='pending'→'running'→'completed' 状态机（蒙特卡洛是同步本地
 *     算法，几秒钟到 1 分钟跑完，不是后台异步任务）。
 *
 * 主要消费方：
 *   - MonteCarloStressTest.run()（US-043）
 *   - run-monte-carlo.ts CLI
 *   - 未来 US-016 策略实验室 "稳健性测试" tab
 *   - 未来 US-049 DrawdownCircuitBreaker 用 drawdown_p95 作为组合熔断阈值参考
 */
@Table({
  tableName: 'monte_carlo_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['base_run_id'] },
    { fields: ['base_run_id', 'seed'], unique: true },
    { fields: ['created_at'] },
  ],
})
export class MonteCarloResult extends Model {
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    primaryKey: true,
    field: 'base_run_id',
    comment: '关联 QuantBacktestResult.id（被 stress-test 的源回测）',
  })
  declare base_run_id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    primaryKey: true,
    comment: '本次模拟使用的 RNG seed（Park-Miller LCG；同 seed + 同 trades → 完全可复现）',
  })
  declare seed: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'simulation_count',
    defaultValue: 1000,
    comment: '本次跑的模拟次数（AC 默认 N=1000；用户可调）',
  })
  declare simulation_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'trade_count',
    defaultValue: 0,
    comment: '源回测的成交数（= 每次模拟用来重排的 return_pct 数量）',
  })
  declare trade_count: number;

  // === 最终收益分位数（AC 必须）===
  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'return_p5',
    comment: 'N 次模拟最终收益的 5% 分位（百分数；e.g. -25.0 = -25%）；trade_count=0 时 NULL',
  })
  declare return_p5?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'return_p50',
    comment: 'N 次模拟最终收益的中位数（百分数）',
  })
  declare return_p50?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'return_p95',
    comment: 'N 次模拟最终收益的 95% 分位（百分数）',
  })
  declare return_p95?: number | null;

  // === 最大回撤分位数（AC 必须）===
  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'drawdown_p95',
    comment: 'N 次模拟最大回撤的 95% 分位（绝对值正数；e.g. 18.5 表示 -18.5% 回撤）',
  })
  declare drawdown_p95?: number | null;

  // === 夏普分位数（AC 必须）===
  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'sharpe_p5',
    comment: 'N 次模拟 sharpe 的 5% 分位（下沿；量化策略稳健性参考）',
  })
  declare sharpe_p5?: number | null;

  // === 诊断字段（非 AC 必须）===
  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'return_mean',
    comment: 'N 次模拟最终收益均值（百分数）；trade_count=0 时 NULL',
  })
  declare return_mean?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'return_std',
    comment: 'N 次模拟最终收益 n-1 样本标准差（百分数）',
  })
  declare return_std?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'drawdown_mean',
    comment: 'N 次模拟最大回撤均值（绝对值正数）',
  })
  declare drawdown_mean?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'sharpe_mean',
    comment: 'N 次模拟 sharpe 均值',
  })
  declare sharpe_mean?: number | null;

  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: true,
    field: 'positive_simulation_ratio',
    comment: 'N 次模拟里 final_return > 0 的占比（0..1 小数）；远低于 0.5 → 策略靠运气',
  })
  declare positive_simulation_ratio?: number | null;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'strategy_key',
    defaultValue: 'unknown',
    comment: '被回测的 strategy_key（物化避免 JOIN 父表的跨 run 聚合）',
  })
  declare strategy_key: string;

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
    defaultValue: 'monte_carlo_stress_test',
    comment: '写入来源标识（默认 monte_carlo_stress_test；离线脚本可写 batch_monte_carlo）',
  })
  declare source: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
