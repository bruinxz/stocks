import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 雪球热词 / 全市场关注度榜 (Snowball Hot Keyword) 入库表 — US-058 AI 增强层.
 *
 * 一行 = (trade_date, keyword) 的一条热词条目：
 *   "某一交易日,某只股票（关键词 = 股票简称 / 股票代码）在雪球热度榜上的快照"。
 *
 * 数据源（AC 期望 vs 实际可得）：
 *
 *   AC 文字："新增模型 SnowballHotKeyword（trade_date、keyword、heat_score、related_stocks_json）"
 *   AC 文字："新增 SnowballHotKeywordClient 抓取雪球热门话题"
 *
 *   **实际数据源**：AKShare `stock_hot_follow_xq(symbol='最热门' | '本周新增')`
 *       雪球-沪深股市-热度排行榜-关注排行榜
 *       https://xueqiu.com/hq
 *       返回当下时刻全市场被雪球用户关注最多的股票排行 (~ 5600 行)。
 *
 *       字段：股票代码 (SH600519 / SZ000001) / 股票简称 / 关注 (整数, 关注人数) / 最新价
 *
 *   **设计抉择**: AC 字面理解是"热门话题"(theme/topic) — 但雪球公开 API 暴露的是
 *     "热门股票"(按关注人数排行), 没有任何 "话题" 维度的 endpoint。
 *
 *     **选定代理 (US-034 同款 endpoint 替代范式)**:
 *     - **keyword = 股票简称** ("贵州茅台" / "比亚迪" / "京东方A")
 *       —— 雪球用户关注/讨论的对象本身就是"股票", 关注度可视为对该股票
 *       (作为"市场热词")的全网热议程度代理。
 *     - **heat_score = 关注人数** (整数, 雪球原始字段)
 *       —— 直接代表"市场关注度", 跨日比较时单位一致, 无须 scaling。
 *     - **related_stocks_json = [{stock_code, stock_name, latest_price}]**
 *       —— 单一关键词当下对应一只股票, JSONB 数组始终长度 1 (设计上保留
 *          数组形态以兼容未来"一个话题关联多只股票"的真热词数据源升级)。
 *
 *   **升级路径**:
 *     - 若未来引入第三方 (Wind 资讯 / 雪球开放 API / Tushare Pro) 提供真正的
 *       "话题"维度数据 (e.g. "#新能源板块走强#") → keyword 改为话题字符串,
 *       related_stocks_json 自然成为一个话题关联的多只股票列表; sync 服务
 *       插入新 endpoint 即可, 模型 schema 不变 (JSONB 字段已天然扩展)。
 *     - 若引入 AKShare `stock_hot_tweet_xq` (讨论排行) / `stock_hot_deal_xq`
 *       (分享交易排行), 可作为 source 字段细分: 'follow' / 'tweet' / 'deal'。
 *
 * **"新进关键词" 判定**: AC 要求"看到雪球热词榜每日**新进**的关键词"。
 *   `SnowballHotKeywordSyncService.syncDate` 会同时计算 `is_new` boolean —
 *   若该 keyword 在上一交易日 (lookback_days=1) 不存在则标 true。读端 GET
 *   endpoint 提供 `?only_new=true` 过滤参数让 UI 直接展示当日"新进"列表。
 *
 * 主键 (trade_date, keyword) —— 一天一行 per keyword (雪球热度榜 ~ 5600 股,
 * 每日全量 upsert 替换)。`rank` 字段记录当日榜单内排名 (1-based 排序由关注
 * 人数 desc) 便于按位次过滤 (e.g. "前 100 名热词").
 *
 * 字段说明：
 *   trade_date           交易日 (YYYY-MM-DD), 主键之一
 *   keyword              热词 / 股票简称, 主键之一 (e.g. "贵州茅台" / "比亚迪")
 *   heat_score           热度分 (关注人数, 整数)
 *   rank                 当日榜内排名 (1-based)
 *   related_stocks_json  关联股票列表 [{stock_code, stock_name, latest_price}]
 *   source               数据源标签 ('xueqiu_follow' / 'xueqiu_tweet' 等, 默认 follow)
 *   is_new               是否为相对上一交易日的新进关键词 (true 表示前一交易日无此 keyword)
 *   raw_payload          原始 AKShare 行
 *
 * 用途：
 *   - GET /api/sentiment/snowball-keywords?date=2026-06-06 —— 前端 TodayWorkspace
 *     "热词榜" / "新进热词" 卡片;
 *   - 未来 US-068 (情绪冲击检测) 可消费 is_new + heat_score 变化做"突发热度告警"。
 */
@Table({
  tableName: 'snowball_hot_keywords',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['keyword'] },
    { fields: ['trade_date', 'rank'] },
    { fields: ['trade_date', 'is_new'] },
  ],
})
export class SnowballHotKeyword extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD)',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(120),
    allowNull: false,
    primaryKey: true,
    comment: '热词 (雪球热度榜下当前是股票简称, 如 "贵州茅台" / "京东方A")',
  })
  declare keyword: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'heat_score',
    comment: '热度分 (雪球关注人数, 整数)',
  })
  declare heat_score: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    comment: '当日榜内排名 (1-based, 按 heat_score desc)',
  })
  declare rank?: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'related_stocks_json',
    comment:
      '关联股票列表 [{stock_code, stock_name, latest_price}] — 当前数据源每个 keyword 对应一只股票, 长度 1; 未来真热词数据源可扩展到多只',
  })
  declare related_stocks_json: Array<{
    stock_code: string;
    stock_name: string;
    latest_price?: number | null;
  }>;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'xueqiu_follow',
    comment:
      '数据源标签: xueqiu_follow (雪球关注排行 默认) / xueqiu_tweet (讨论排行) / xueqiu_deal (分享交易)',
  })
  declare source: string;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_new',
    comment: '是否为相对上一交易日的新进关键词 (true = 前一交易日榜内无此 keyword)',
  })
  declare is_new: boolean;

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
