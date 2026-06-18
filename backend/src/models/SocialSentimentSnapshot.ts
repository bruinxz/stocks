import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * SocialSentimentSnapshot — Batch AH (2026-06-18) 社媒/舆情综合日度快照.
 *
 * 一行 = (trade_date, stock_code) 一日一股. 主键 (trade_date, stock_code).
 *
 * 数据源 (4 处文档同步范式, US-034 同款):
 *   - `stock_hot_rank_em()` — 东财个股人气榜 top 100 (实时 rank, 无 date 参数)
 *   - `stock_comment_em()`  — 全市场每股一行综合评分 (实时, 无 date 参数)
 *
 * 实时快照特性: trade_date 由 caller 服务层在盘后调度时贴上的标签,
 * 不能历史回填 (同 US-008 IndustryFlow). caller 必须在盘后调用.
 *
 * AC ↔ 实现映射:
 *   - hot_rank_em (1-100 / null): stock_hot_rank_em 全市场只有 top 100 有 rank,
 *     之外的股票 None. 用户 UI Card 1 只展示 top-20 (rank <= 20 的子集).
 *   - comment_score (0-100): stock_comment_em '综合得分' / '综合评分' / '评分'
 *     字段多版本兼容 (柔性 col_map).
 *   - institution_participation (%): stock_comment_em '机构参与度'.
 *   - retail_desire (%): AKShare stock_comment_em 不直接 expose. 留 None,
 *     未来若 user-level "散户意愿"数据上 (e.g. stock_comment_detail_scrd_desire_em
 *     per-stock 调用) 可填充.
 *   - focus_index: stock_comment_em '关注指数' (东财内部综合关注度).
 *   - baidu_search_rank: 从 MarketHotSearch left-join 而来 (TS 服务层 join).
 *
 * 跨日衍生字段 (TS-side 同 US-007 continuous_days 范式):
 *   - rank_5d_avg: 该股近 5 个交易日 hot_rank_em 均值 (排除 null).
 *   - rank_breakout_delta: rank_5d_avg - hot_rank_em (>0 = 今日跃升, 异动股).
 *
 * 用途:
 *   - GET /api/factors/sentiment-board → 舆情雷达 UI
 *   - rank_breakouts top-N 给"今日发现的异动股"卡片
 *   - sentiment scatter (机构参与 vs 散户意愿) 散点图
 */
@Table({
  tableName: 'social_sentiment_snapshots',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['stock_code'] },
    { fields: ['trade_date', 'hot_rank_em'] },
    { fields: ['trade_date', 'comment_score'] },
    { fields: ['trade_date', 'rank_breakout_delta'] },
  ],
})
export class SocialSentimentSnapshot extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD), 由 caller 服务层贴标签',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '股票代码, 6 位无后缀',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(40),
    allowNull: true,
    field: 'stock_name',
    comment: '股票简称 (denormalize 避免 board 读 JOIN stocks)',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'hot_rank_em',
    comment: '东财人气榜实时排名 (1 = 最热, top 100 外为 null)',
  })
  declare hot_rank_em?: number;

  @Column({
    type: DataType.DECIMAL(6, 2),
    allowNull: true,
    field: 'comment_score',
    comment: '东财综合评分 0-100 (stock_comment_em 综合得分)',
  })
  declare comment_score?: number;

  @Column({
    type: DataType.DECIMAL(6, 2),
    allowNull: true,
    field: 'institution_participation',
    comment: '机构参与度 % (stock_comment_em 机构参与度)',
  })
  declare institution_participation?: number;

  @Column({
    type: DataType.DECIMAL(6, 2),
    allowNull: true,
    field: 'retail_desire',
    comment: '散户投资意愿 % (v1 占位 null; 未来用 scrd_desire_em 填充)',
  })
  declare retail_desire?: number;

  @Column({
    type: DataType.DECIMAL(10, 2),
    allowNull: true,
    field: 'focus_index',
    comment: '关注指数 (stock_comment_em 关注指数)',
  })
  declare focus_index?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'baidu_search_rank',
    comment: '百度搜索热度榜排名 (null = 未上榜)',
  })
  declare baidu_search_rank?: number;

  @Column({
    type: DataType.DECIMAL(8, 2),
    allowNull: true,
    field: 'rank_5d_avg',
    comment: '近 5 个交易日 hot_rank_em 均值 (TS 服务层 derived)',
  })
  declare rank_5d_avg?: number;

  @Column({
    type: DataType.DECIMAL(8, 2),
    allowNull: true,
    field: 'rank_breakout_delta',
    comment: 'rank_5d_avg - hot_rank_em, >0 = 今日跃升 (TS 服务层 derived)',
  })
  declare rank_breakout_delta?: number;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'eastmoney',
    comment: '数据源标签 (eastmoney / eastmoney+baidu)',
  })
  declare source: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '原始 AKShare 行合并 (hot_rank_em 行 + comment_em 行)',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
