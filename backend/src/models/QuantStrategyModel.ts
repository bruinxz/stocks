import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_strategies',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['strategy_key'] },
    { fields: ['category'] },
    { fields: ['enabled'] },
  ],
})
export class QuantStrategyModel extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description?: string;

  @Column({ type: DataType.STRING(40), allowNull: false })
  declare category: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'default_params' })
  declare default_params: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'execution_policy' })
  declare execution_policy: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'environment_policy' })
  declare environment_policy: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'lifecycle_policy' })
  declare lifecycle_policy: Record<string, any>;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare enabled: boolean;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'risk_level' })
  declare risk_level?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare tags: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'latest_metrics' })
  declare latest_metrics: Record<string, any>;

  /**
   * Phase 4: Edge Hypothesis — 策略 "为什么应该有 alpha" 的可证伪假设
   *
   * 结构示例:
   *   ```jsonc
   *   {
   *     "thesis": "短期超跌反弹：RSI<30 且成交量缩量到 20 日均量 60% 以下时，反弹概率 > 60%",
   *     "category": "mean_reversion",  // mean_reversion / momentum / sentiment / event / structural
   *     "expected_edge_pct": 1.5,       // 预期年化 alpha
   *     "expected_holding_days": 5,     // 预期持仓周期
   *     "key_factors": ["rsi_14", "volume_ratio_20d"],
   *     "evidence_link": "https://...",  // 学术论文 / 研报 / backtest 链接
   *     "failure_modes": [               // 已知该 edge 失效的场景
   *       "牛市末期 RSI 长期低位",
   *       "成交量结构性萎缩 (例：节假日前)"
   *     ],
   *     "kill_switch_metric": "win_rate_30d",  // 哪个指标低于阈值就回滚
   *     "kill_switch_threshold": 0.45,
   *     "created_at": "2026-06-12",
   *     "last_validated_at": "2026-06-10"  // 最近一次验证（可关联 WF run）
   *   }
   *   ```
   *
   * 为什么需要这个字段:
   *   - 没有 edge hypothesis 的策略 = 数据挖掘的过拟合垃圾
   *   - 强制策略作者写出来 → 同行 review 时能挑战逻辑
   *   - kill_switch_metric 让 lifecycle policy 能精确指标驱动回滚（不只是看 sharpe）
   *   - Phase 4 promotion 门禁会要求该字段非空
   */
  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'edge_hypothesis',
    comment: 'Phase 4: 可证伪 edge 假设 (thesis / failure_modes / kill_switch_metric)',
  })
  declare edge_hypothesis: Record<string, any>;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes?: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'display_order' })
  declare display_order?: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
