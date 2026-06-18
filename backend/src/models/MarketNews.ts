import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * MarketNews — Batch AG (2026-06-18) 市场新闻 / 财经事件入库表.
 *
 * 一条记录 = 某条市场要闻 (财联社电报 / 东财全球新闻 / 新浪全球新闻 等).
 *
 * 主键 (publish_time, title_hash):
 *   - publish_time: ISO 'YYYY-MM-DD HH:mm:ss' 发布时间
 *   - title_hash:   MD5(title.trim()) 前 16 字符, 唯一标识同一标题 (避免不同源
 *                   发布同一标题时重复入库)
 *
 * 数据源 (按 `source` 字段区分): 'cls' (财联社电报) / 'em' (东财全球) /
 *   'sina' (新浪全球) / 'baidu' (百度财经)
 *
 * 用途:
 *   - 行业决策面板右侧 '今日要闻' 时间线
 *   - TradingAgents prompt 注入 recent_news[] (Batch AE buildAnalyzeContext 已预留)
 *   - 未来 US 可消费 title + content 做事件分类 (并购/政策/业绩快报) 与影响个股关联
 *
 * 数据保留: 30 天 (前端时间线只看近 7 天, 提供 23 天的回溯余量).
 */
@Table({
  tableName: 'market_news',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['publish_time'] },
    { fields: ['source'] },
    { fields: ['publish_date'] },
    { fields: ['publish_date', 'source'] },
  ],
})
export class MarketNews extends Model {
  @Column({
    type: DataType.STRING(64),
    allowNull: false,
    primaryKey: true,
    field: 'title_hash',
    comment: 'MD5(title.trim()) 前 16 字符 — 同一标题不重复入库',
  })
  declare title_hash: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    primaryKey: true,
    field: 'publish_time',
    comment: '发布时刻 ISO YYYY-MM-DD HH:mm:ss',
  })
  declare publish_time: Date;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'publish_date',
    comment: 'publish_time 的日期部分 — 用于按日查询时避免 DATE() 函数失去索引',
  })
  declare publish_date: string;

  @Column({
    type: DataType.STRING(512),
    allowNull: false,
    comment: '新闻标题',
  })
  declare title: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '正文 / 摘要 (财联社电报通常较短, 直接全量入库; 长文截断到 4KB)',
  })
  declare content?: string;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'cls',
    comment: '数据源: cls (财联社电报) / em (东财全球) / sina (新浪全球) / baidu (百度财经)',
  })
  declare source: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    comment: '新闻分类 (电报 / 财经 / 宏观 / 公司 等)',
  })
  declare category?: string;

  @Column({
    type: DataType.STRING(1000),
    allowNull: true,
    comment: '原文链接 (可空)',
  })
  declare url?: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '原始 AKShare 行 (便于事后回溯)',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
