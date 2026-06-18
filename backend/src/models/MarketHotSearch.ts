import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * MarketHotSearch — Batch AH (2026-06-18) 百度 A 股搜索热度榜日度快照.
 *
 * 一行 = (trade_date, keyword) 一日一关键词. 主键 (trade_date, keyword).
 *
 * 数据源:
 *   - `ak.stock_hot_search_baidu(symbol='A股')` — 百度搜索 A 股热度榜
 *     当前时刻 top 50 (或 N 由 caller 指定).
 *
 * 实时快照特性 (同 US-058 SnowballHotKeyword): trade_date 是 caller 服务层
 * 贴的标签, 不能历史回填.
 *
 * keyword 字段语义: 通常是股票简称 (e.g. "贵州茅台") 或公司名. 极少数情况下
 * 可能是行业 / 概念词. caller 可做 best-effort 模糊匹配填 related_stock_code.
 *
 * 用途:
 *   - /api/factors/sentiment-board → 舆情雷达 Card 2 "百度热搜榜"
 *   - 与 SocialSentimentSnapshot left-join 给个股填 baidu_search_rank
 *   - 未来事件检测: 某 keyword 一日突现 top 5 → "突发热度告警"
 */
@Table({
  tableName: 'market_hot_searches',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['trade_date', 'rank'] },
    { fields: ['keyword'] },
    { fields: ['trade_date', 'related_stock_code'] },
  ],
})
export class MarketHotSearch extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD), caller 贴标签',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(120),
    allowNull: false,
    primaryKey: true,
    comment: '搜索词条 (通常是股票简称)',
  })
  declare keyword: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    comment: '当日榜内排名 (1-based)',
  })
  declare rank: number;

  @Column({
    type: DataType.BIGINT,
    allowNull: true,
    field: 'search_index',
    comment: '百度搜索指数原始值',
  })
  declare search_index?: number;

  @Column({
    type: DataType.DECIMAL(8, 4),
    allowNull: true,
    field: 'change_rate',
    comment: '较前一日变化率 (% 或纯比例; AKShare 内部不一致, 入库前 normalize)',
  })
  declare change_rate?: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'related_stock_code',
    comment: 'best-effort 股票代码映射 (6 位; null = 未能匹配到上市股)',
  })
  declare related_stock_code?: string;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'baidu_a',
    comment: '数据源标签',
  })
  declare source: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '原始 AKShare 行',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
