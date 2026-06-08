import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * CostSensitivityResult — 交易成本敏感性分析结果（US-085）
 *
 * 一行 = 一个 (base_run_id × strategy_key × cost_level) 三元组的回测重跑结果：
 *   1. CostSensitivityAnalysis.analyze(base_run_id) 取出原回测的 options + universe，
 *   2. 对每个 COST_LEVELS 档（万 1.5 / 万 2.5 / 万 5）重置 commission_rate，
 *      重跑 quantBacktestEngine.run() 得到 per-strategy 结果，
 *   3. 把 annual_return_pct / sharpe / turnover / total_return_pct / max_drawdown_pct
 *      / win_rate / trade_count 落到本表。
 *
 * **`base_run_id` 语义**：
 *   - 引用 QuantBacktestResult.id（不是 QuantBacktestTask.id）——分析粒度是 per-策略
 *     per-cost_level；同一个 task 含多个策略时会跨多行。
 *   - 与 US-040 RegimeBacktestResult.run_id 同款"事后分析 vs 优化任务" 判据：本
 *     模块是"对已完成 backtest 做派生统计"，所以**不复用 OptimizationRun 父表**，
 *     直接通过 FK 引用源 QuantBacktestResult.id（详见 backend/src/quant/backtest/
 *     CLAUDE.md "事后分析 vs 优化任务" 一节）。
 *
 * **cost_level 三档**（AC 指定）：
 *   - `万1.5` (commission_rate=0.00015)：互联网券商折扣（少数特殊渠道）
 *   - `万2.5` (commission_rate=0.00025)：当前主流互联网券商 2024-2026 报价（默认）
 *   - `万5`   (commission_rate=0.0005)：传统券商标准费率
 *   - 印花税 / 过户费 / 滑点保持原回测设置不变 —— 本分析**只看佣金敏感度**，
 *     避免多变量混杂。
 *
 * **`turnover` 定义**：sum(buy_amount + sell_amount) over all trades；
 *   一笔完整的 round-trip 算 2× amount（买入 + 卖出各算一次成交额）。
 *   未平仓 trade（sell_date is NULL）只算 buy_amount。
 *
 * **指标定义**（与 QuantBacktestResult 字段对齐）：
 *   - `annual_return_pct`：年化收益（百分数）；e.g. 12.34 = +12.34%
 *   - `sharpe_ratio`：年化夏普；可负值
 *   - `total_return_pct`：总收益（百分数）
 *   - `max_drawdown_pct`：最大回撤绝对值（正数 ≥ 0）
 *   - `win_rate`：胜率（0..1 小数）；0 笔时 NULL
 *   - `trade_count`：成交笔数
 *   - `turnover`：总成交额（元，含买入 + 卖出）
 *
 * **UNIQUE 索引** `(base_run_id, strategy_key, cost_level)`：
 *   - 同一 base_run + 同一策略 + 同一档费率只会有一行；
 *   - 重跑同一分析 → upsert（service 层用 destroy + bulkCreate 而非 updateOnDuplicate
 *     因为字段全是 numeric 度量，destroy + create 比 onConflict update 更直观）。
 *
 * 主要消费方：
 *   - CostSensitivityAnalysis.analyze() （US-085）
 *   - QuantController.runCostSensitivityAnalysis endpoint（US-085）
 *   - 未来 US-016 策略实验室 "成本敏感性" tab
 */
@Table({
  tableName: 'cost_sensitivity_results',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['base_run_id'] },
    { fields: ['base_run_id', 'strategy_key', 'cost_level'], unique: true },
    { fields: ['strategy_key'] },
    { fields: ['cost_level'] },
  ],
})
export class CostSensitivityResult extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'base_run_id',
    comment: '关联 QuantBacktestResult.id（被分析的原回测）',
  })
  declare base_run_id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'base_task_id',
    comment: '关联 QuantBacktestTask.id（物化避免 JOIN 父表查 strategy_keys / universe）',
  })
  declare base_task_id: number;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'strategy_key',
    comment: '被分析的 strategy_key（物化避免 JOIN 父表）',
  })
  declare strategy_key: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'cost_level',
    comment: '费率档位标签：万1.5 / 万2.5 / 万5',
  })
  declare cost_level: string;

  @Column({
    type: DataType.DECIMAL(10, 6),
    allowNull: false,
    field: 'commission_rate',
    comment: '本档对应的佣金率（小数）；e.g. 0.00025 = 万 2.5',
  })
  declare commission_rate: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'annual_return_pct',
    defaultValue: 0,
    comment: '年化收益百分比（e.g. 12.34 = +12.34%；亏损为负）',
  })
  declare annual_return_pct: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'sharpe_ratio',
    defaultValue: 0,
    comment: '年化夏普率；可负值',
  })
  declare sharpe_ratio: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'total_return_pct',
    defaultValue: 0,
    comment: '总收益百分比',
  })
  declare total_return_pct: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'max_drawdown_pct',
    defaultValue: 0,
    comment: '最大回撤百分比（正数；e.g. 8.50 表示 -8.50% 回撤）',
  })
  declare max_drawdown_pct: number;

  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: true,
    field: 'win_rate',
    comment: '胜率（0..1 小数）；0 笔时 NULL',
  })
  declare win_rate?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'trade_count',
    defaultValue: 0,
    comment: '成交笔数',
  })
  declare trade_count: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    field: 'turnover',
    defaultValue: 0,
    comment: '总成交额（元，含买入 + 卖出，未平仓 trade 只算买入端）',
  })
  declare turnover: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata_json',
    defaultValue: {},
    comment: '可选元数据（生成时间 / 滑点 / 执行 timing 等审计信息）',
  })
  declare metadata_json: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
