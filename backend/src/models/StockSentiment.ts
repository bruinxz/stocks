import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 个股情绪 / 散户人气 (Stock Sentiment / Retail Heat) 入库表 — US-034 数据层。
 *
 * 一行 = (trade_date, stock_code) 的人气快照 (one stock per trading day)。
 *
 * 数据源：AKShare `stock_hot_rank_detail_em(symbol=<EXCHANGE><6-digit>)`
 *   东方财富网 - 个股人气榜 - 历史趋势及粉丝特征
 *   https://guba.eastmoney.com/rank/stock?code=000725
 *   按股票拉一次返回近 365 个交易日的 (日期, 人气排名, 新晋粉丝占比, 铁杆粉丝占比) 时间序列。
 *
 * AKShare 返回列：时间 / 排名 / 证券代码 / 新晋粉丝 / 铁杆粉丝
 *
 *   - 排名（rank）        ：当日东财个股人气榜的实际名次（1 = 全市场最热门股，越大越冷门，可达 5000+）
 *   - 新晋粉丝（new_fan_ratio）：[0, 1] 区间，"近期新关注的粉丝" 占比
 *   - 铁杆粉丝（hardcore_fan_ratio）：[0, 1] 区间，"长期关注的粉丝" 占比
 *     —— new_fan_ratio + hardcore_fan_ratio ≈ 1.0
 *
 * ── 重要：双重代理 (AC 字段不可得时的范式 US-031/US-032 同款) ──
 *
 * AC 期望字段 (post_count / view_count / heat_score) 在 AKShare 上 **不可得**：
 *   - 东方财富股吧的 post_count（发帖数）与 view_count（浏览量）只在网页前端展示，
 *     **没有任何公开 API** 暴露；stock_guba_em 在 AKShare 中根本不存在；
 *     爬取 https://guba.eastmoney.com/list,<code>.html 风险大（反爬严格、字段易变）。
 *   - stock_hot_rank_em 只返回**当日 top 100**实时榜单（无历史），不足以建因子。
 *
 * 选定代理：
 *   - **post_count 代理 = (1 / rank) × 100000**
 *       表示"全市场关注热度排名"的倒数刻度。越前排（rank↓）越热门 → post_count↑。
 *       理论根据：股吧发帖数与人气排名高度相关，rank 是 EastMoney 综合用户活跃度
 *       (含 click / post / fav / search) 后给出的排序结果，正比于发帖热度的合理代理。
 *       × 100000 是为了让数值落在 100-100000 区间，因子计算 5d/30d 比率时与原始
 *       post_count 同量纲（无须额外标准化）。
 *
 *   - **view_count 代理 = (new_fan_ratio + hardcore_fan_ratio) × 1000**
 *       表示"总粉丝活跃度"的标量。AKShare 返回的是占比 (求和 ≈ 1.0)，没有绝对值；
 *       × 1000 让数值落在 1000 上下方便阅读；对因子的 5d/30d 比率计算无影响
 *       （ratio 内 scale 相消）。
 *
 *   - **heat_score**: 综合分 = 0.7 × (1/rank × 100000) + 0.3 × (粉丝总和 × 1000)
 *       70/30 加权：人气排名是主导信号，粉丝活跃度是次要。给定外部一个标量便于
 *       未来分位排名 / 异常告警，但因子层不直接用 heat_score（因子用 post_count
 *       做 5d/30d 滑动比率）。
 *
 * 升级路径（如果未来引入新数据源）：
 *   - 若我们引入第三方 API (XQ / TuShare Pro / Wind) 提供真实 post_count / view_count，
 *     直接在 sync 时填入这两列，因子计算无需改动 (PostCount 是物化字段)。
 *   - 若我们决定不再支持 EastMoney 数据源，rank 列保留供历史回溯，其他列可置 NULL。
 *
 * 字段说明：
 *   trade_date           交易日 (YYYY-MM-DD)
 *   stock_code           6 位股票代码（无后缀）
 *   post_count           AC 字段：发帖数代理 (1 / rank × 100000，整数)
 *   view_count           AC 字段：浏览量代理 (粉丝总和 × 1000，整数)
 *   heat_score           AC 字段：综合热度分 (浮点)
 *   rank                 原始 EastMoney 人气榜排名（1 = 全市场最热）
 *   new_fan_ratio        新晋粉丝占比 [0, 1]
 *   hardcore_fan_ratio   铁杆粉丝占比 [0, 1]
 *
 * 用途：EastMoneyQAFactor (US-034) 计算近 5 日 / 近 30 日 post_count 比率
 * 作为散户关注度变化因子；将来 US-058 (异常情绪监测) 可用 heat_score 做组合
 * 风控告警。
 */
@Table({
  tableName: 'stock_sentiments',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['stock_code'] },
    { fields: ['stock_code', 'trade_date'] },
    { fields: ['trade_date', 'rank'] },
    { fields: ['trade_date', 'heat_score'] },
  ],
})
export class StockSentiment extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD)',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '6 位股票代码 (无市场前缀)，例如 600519 / 000001',
  })
  declare stock_code: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'post_count',
    comment:
      '发帖数代理：1/rank × 100000，整数 (AC 字段；AKShare 无原始 post_count，用 EastMoney 人气榜排名倒数代理)',
  })
  declare post_count?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'view_count',
    comment:
      '浏览量代理：(new_fan_ratio + hardcore_fan_ratio) × 1000，整数 (AC 字段；AKShare 无原始 view_count)',
  })
  declare view_count?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'heat_score',
    comment:
      '综合热度分：0.7 × (1/rank × 100000) + 0.3 × (粉丝总和 × 1000) — 单标量便于排名 / 告警',
  })
  declare heat_score?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    comment: '原始 EastMoney 人气榜排名 (1 = 全市场最热门股；越大越冷门，可达 5000+)',
  })
  declare rank?: number;

  @Column({
    type: DataType.DECIMAL(10, 6),
    allowNull: true,
    field: 'new_fan_ratio',
    comment: '新晋粉丝占比 [0, 1] (AKShare 原始 "新晋粉丝" 字段)',
  })
  declare new_fan_ratio?: number;

  @Column({
    type: DataType.DECIMAL(10, 6),
    allowNull: true,
    field: 'hardcore_fan_ratio',
    comment: '铁杆粉丝占比 [0, 1] (AKShare 原始 "铁杆粉丝" 字段)',
  })
  declare hardcore_fan_ratio?: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'akshare',
    comment: '数据源标识',
  })
  declare source: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '原始 AKShare 行 (保留所有字段，便于事后回溯 / 升级到真实 post_count)',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
