import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * IndustryAttributionResult — 分行业归因分析（US-046）
 *
 * 一行 = 一次回测结果（QuantBacktestResult.id）vs **一个行业** 的归因结果。
 * 把策略收益拆到每个行业的贡献，一眼回答「这个策略的 alpha 是哪些行业贡献的」。
 *
 * **`run_id` 语义**：
 *   - `NOT NULL` 时引用 QuantBacktestResult.id（被归因的父回测）。
 *   - 仅在 IndustryAttributionService.computeAttribution(persist: true) 时落库
 *     （in-memory dry-run 场景不写本表）。
 *
 * **4-tuple PK (run_id, industry_code, period_start, period_end)**：
 *   - 同一回测对同一行业在相同区间重跑时 idempotent upsert（覆盖最新统计）。
 *   - 若 caller 想保留多次重算的历史，period_start / period_end 已经写在 PK 里 →
 *     不同 caller-提供的日期 = 不同行。
 *   - 与 US-041 FactorICResult / US-042 FactorCorrelationResult / US-045
 *     BenchmarkAttributionResult 同款 4-tuple PK 范式 — 都是「事后分析」类型，
 *     PK 包含分析窗口。
 *
 * **`industry_code` 语义**（US-046 当前实现）：
 *   - Stock 模型当前只有 `industry` (中文名) 字段，没有 industry_code (如 BK1024)；
 *     因此 industry_code = industry_name = Stock.industry 字段值（中文名）。
 *   - 未来如 Stock 引入独立的 industry_code 字段（来自 IndustryFlow 的 BK 编码），
 *     直接换 DataSource 内部 join 逻辑即可，本表 schema 不变。
 *   - 未识别行业（Stock.industry 为 null/empty）统一归类为 "其他"。
 *
 * **指标定义**：
 *   - `contribution_pct`：该行业的累计盈亏 / 初始资本 × 100（百分数）。
 *     这是「绝对贡献」—— 所有行业相加 = 策略总收益率（近似）。
 *     正值 = 该行业贡献了 X% 的总收益；负值 = 该行业拖累了 X%。
 *   - `win_rate`：该行业内已完成交易（sell_date 非空）的胜率（0..1 小数）。
 *     `pnl > 0` 算胜；`pnl ≤ 0` 算负；缺 pnl 不计入。
 *   - `avg_hold_days`：该行业内已完成交易的平均持仓天数（自然数）。
 *   - `trade_count`：该行业内已完成交易数（用于看「这个数字是不是 1-2 笔噪音」）。
 *   - `total_pnl`：该行业累计盈亏（元，绝对值），便于排序与展示。
 *
 * **诊断字段**（让 ops 看到底是真信号还是噪音）：
 *   - `winning_count` / `losing_count`：胜负分布（trade_count = winning + losing + neutral）。
 *   - `total_volume`：该行业累计成交金额（元），用于看交易活跃度。
 *
 * **strategy_key 物化**：让「multi_factor_alpha 在 银行 行业的 contribution 历次回测平均」
 * 跨 run 聚合查询不必 JOIN 父表；冗余几十字节换查询效率（与 RegimeBacktestResult /
 * BenchmarkAttributionResult 同款判据）。
 *
 * 主要消费方：
 *   - IndustryAttributionService.computeAttribution()（US-046）
 *   - QuantBacktestService 完成 hook（每次回测完成后自动触发，与 US-045 并列）
 *   - 未来 US-016 策略实验室 "行业归因" tab（行业 alpha 雷达图 / 贡献柱状图）
 *   - 未来 US-085 行业集中度告警 用历史 contribution 序列判定是否过度依赖某行业
 *
 * **设计取舍 — 不复用 OptimizationRun 父表**（与 US-040/US-041/US-042/US-043/US-044/US-045 判据一致）：
 *   - 行业归因是「对一次已完成回测做事后统计」，不是新的优化任务；
 *   - 通过 `run_id` 直接引用 QuantBacktestResult.id，关联清晰；
 *   - 不需要 status='pending'→'running'→'completed' 状态机（归因是同步本地算法，几十 ms）。
 */
@Table({
  tableName: 'industry_attribution_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['run_id'] },
    { fields: ['run_id', 'industry_code'] },
    {
      fields: ['run_id', 'industry_code', 'period_start', 'period_end'],
      unique: true,
      name: 'industry_attribution_results_pk_idx',
    },
    { fields: ['strategy_key', 'industry_code'] },
    { fields: ['industry_code'] },
    { fields: ['period_end'] },
  ],
})
export class IndustryAttributionResult extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'run_id',
    comment: '关联 QuantBacktestResult.id（被归因的父回测）',
  })
  declare run_id: number;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'strategy_key',
    comment: '被回测的 strategy_key（物化避免 JOIN 父表的跨 run 聚合）',
  })
  declare strategy_key: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'industry_code',
    comment:
      '行业代码（US-046 当前 = industry_name 中文；未来 Stock 引入 BK 码后可换为 BK1024 形式）',
  })
  declare industry_code: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'industry_name',
    comment: '行业中文名（如 银行 / 半导体 / 医药生物 / 其他）',
  })
  declare industry_name: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_start',
    comment: '归因区间起始日（YYYY-MM-DD，闭区间）',
  })
  declare period_start: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_end',
    comment: '归因区间结束日（YYYY-MM-DD，闭区间）',
  })
  declare period_end: string;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'contribution_pct',
    defaultValue: 0,
    comment: '行业贡献百分比 = industry_pnl / initial_capital × 100（正=贡献 / 负=拖累）',
  })
  declare contribution_pct: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    field: 'total_pnl',
    defaultValue: 0,
    comment: '该行业累计盈亏（元；正=盈利 / 负=亏损）',
  })
  declare total_pnl: number;

  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: true,
    field: 'win_rate',
    comment: '该行业内已完成交易胜率（0..1 小数；trade_count=0 时 null）',
  })
  declare win_rate?: number;

  @Column({
    type: DataType.DECIMAL(8, 2),
    allowNull: true,
    field: 'avg_hold_days',
    comment: '该行业内已完成交易平均持仓天数（trade_count=0 时 null）',
  })
  declare avg_hold_days?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'trade_count',
    defaultValue: 0,
    comment: '该行业内已完成交易数（sell_date 非空）',
  })
  declare trade_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'winning_count',
    defaultValue: 0,
    comment: '盈利交易数（pnl > 0）',
  })
  declare winning_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'losing_count',
    defaultValue: 0,
    comment: '亏损交易数（pnl ≤ 0；pnl=0 算 losing 偏保守）',
  })
  declare losing_count: number;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: false,
    field: 'total_volume',
    defaultValue: 0,
    comment: '该行业累计成交金额（元；buy + sell 总和）',
  })
  declare total_volume: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'computed_at',
    comment: '计算完成时间（ops 看刷新时间）',
  })
  declare computed_at?: Date;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'industry_attribution_service',
    comment: '产出来源（默认 industry_attribution_service；可自定义如 backtest_hook）',
  })
  declare source: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
