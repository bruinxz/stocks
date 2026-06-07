import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * Optimization 主表（US-037 GridSearch + US-038 Bayesian 共享）
 *
 * 每次优化器调用 = 一行 OptimizationRun。`optimizer_type` 区分 grid_search vs
 * bayesian（US-038 新增）；`param_grid_json` JSONB 列在两种优化器下承载不同 shape：
 *   - grid_search：参数网格 `{ topN: [10,20,30,50], stopLossPct: [-5,-7,-10] }`
 *   - bayesian：参数边界 `{ topN: {min:10, max:50, integer:true}, stopLossPct: {min:-15, max:-3} }`
 *
 * `status` 跟踪整个执行进度（pending → running → completed / failed），
 * `total_combos` 与 `completed_combos` 让 UI 可显示 `进度 3 / 12`。
 *
 * `backtest_config_json` 冷藏一份本轮的 backtest config（除参数维度外的所有字段：
 * start_date / end_date / initial_capital / universe / ...），便于事后复算或对比。
 *
 * `best_result_id` 是最高 composite_score 那条 OptimizationResult 的 FK 快捷
 * 入口（结束后回写），让"最优参数"查询不必每次都 ORDER BY 排一遍。
 *
 * 主要消费方：
 *   - run-grid-search.ts CLI（US-037）
 *   - run-bayesian-opt.ts CLI（US-038）
 *   - 未来 US-016 策略实验室 "参数调优" tab
 *   - WalkForwardValidator (US-039) 嵌入子 grid 时也会创建 run 行
 */
@Table({
  tableName: 'optimization_runs',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['strategy_name'] },
    { fields: ['status'] },
    { fields: ['created_by'] },
    { fields: ['created_at'] },
    { fields: ['optimizer_type'] },
  ],
})
export class OptimizationRun extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'grid_search',
    field: 'optimizer_type',
    comment:
      '优化器类型：grid_search (US-037) / bayesian (US-038)；DB 旧行 defaultValue 兜底为 grid_search，保证向后兼容',
  })
  declare optimizer_type: string;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'strategy_name',
    comment: '被优化的策略 key（StrategyRegistry 内注册的 strategy_key）',
  })
  declare strategy_name: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'param_grid_json',
    comment:
      'JSONB 列在两种优化器下承载不同 shape：grid_search 是参数网格 `{topN:[10,20]}`，bayesian 是参数边界 `{topN:{min:10,max:50,integer:true}}`',
  })
  declare param_grid_json: Record<string, any>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'backtest_config_json',
    comment:
      '本轮 grid search 的 backtest 通用配置（start_date / end_date / universe / 初始资金 / 基准 等），不含被优化的参数维度',
  })
  declare backtest_config_json: Record<string, any>;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'pending',
    comment: '执行状态：pending / running / completed / failed',
  })
  declare status: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'total_combos',
    comment: '本轮 grid 全部参数组合数（cartesian product 大小）',
  })
  declare total_combos: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'completed_combos',
    comment: '已完成 backtest 的参数组合数（含失败的）',
  })
  declare completed_combos: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'failed_combos',
    comment: '执行 backtest 时报错的参数组合数',
  })
  declare failed_combos: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'best_result_id',
    comment: '运行结束后回写：最高 composite_score 那条 OptimizationResult.id',
  })
  declare best_result_id?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'created_by',
    comment: '触发者 user_id，nullable 让 CLI 直接调用时可留空',
  })
  declare created_by?: number;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'error_message',
    comment: '若 status=failed 时的错误堆栈/消息',
  })
  declare error_message?: string;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'started_at',
    comment: 'optimize() 真正开始跑 backtest 的时间',
  })
  declare started_at?: Date;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'finished_at',
    comment: 'optimize() 完成时间（含失败）',
  })
  declare finished_at?: Date;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
