import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * IndustrySentimentIndex — PR-M3 (2026-06-29)
 *
 * **板块情绪指数日度聚合**. 一行 = (trade_date, industry) 二元组, 由
 * IndustrySentimentAggregator 每日 16:00 (工作日) 跑出, 把 4 大龙头战法核心因子
 * (涨停数 / 连板高度 / 封板率 / 炸板率) + 30 日板块动量打包成 composite_score, 给
 * 推荐 service 消费做 "龙头板块加权 / 弱势板块直接 skip" 决策.
 *
 * 数据源:
 *   - limit_up_stocks (涨停板每日 sync, 来自 AKShare zt_pool_em + zt_pool_strong_em)
 *   - stocks (industry 字段, 申万一级)
 *   - daily_bars (30 日板块均涨幅, 用于 industry_momentum_30d_zscore)
 *
 * 与 risk/ 风控 service 的关系:
 *   - 这是 **soft decision layer**, 给推荐打分加权 / 过滤用; 不阻塞下单
 *   - composite_score > +2 → 'leader_industry' 推荐 +20% 加权
 *   - composite_score < -1 → 'weak_industry' 直接 skip (避免亏损板块)
 *
 * composite_score 计算 (在 IndustrySentimentAggregator.computeCompositeScore):
 *   weighted_lim_up = min(lim_up_count / 5, 1) * 0.3         # 最多 5 只就饱和
 *   weighted_max    = min(consecutive_max / 5, 1) * 0.3      # 最多 5 板饱和
 *   weighted_seal   = seal_rate * 0.2
 *   weighted_fail   = -lim_up_failure_rate * 0.1             # 炸板率高负贡献
 *   weighted_mom    = (industry_momentum_30d_zscore || 0) * 0.1
 *   composite_score = sum(above) * 10                        # 放大到约 [-5, +5]
 */
@Table({
  tableName: 'industry_sentiment_indices',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date', 'composite_score'] },
    { fields: ['industry', 'trade_date'] },
  ],
})
export class IndustrySentimentIndex extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD)',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    primaryKey: true,
    comment: '申万一级行业名 (与 stocks.industry 同口径)',
  })
  declare industry: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'lim_up_count',
    comment: '当日涨停只数',
  })
  declare lim_up_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'consecutive_max',
    comment: '当日最高连板数 (0 = 无涨停)',
  })
  declare consecutive_max: number;

  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'seal_rate',
    comment: '封板率 = (一字板 + 收盘封板) / 总涨停数; [0, 1]',
  })
  declare seal_rate: number;

  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'lim_up_failure_rate',
    comment: '炸板率 = 至少炸过一次 / 总涨停数; [0, 1]',
  })
  declare lim_up_failure_rate: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'industry_momentum_30d',
    comment: '30 日动量 z-score (相对全市场), NULL = 数据不足无法算',
  })
  declare industry_momentum_30d?: number | null;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'composite_score',
    comment: '综合分 weighted sum, 大约 [-5, +5] 区间, > +2 = leader, < -1 = weak',
  })
  declare composite_score: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'constituent_count',
    comment: '当日涨停股票数 (与 lim_up_count 同, 冗余便于审计)',
  })
  declare constituent_count: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'top_codes',
    comment: '涨停代表股 JSONB string[] (前 3 只按连板高到低)',
  })
  declare top_codes: string[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '调试 / 审计透传 JSONB',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
