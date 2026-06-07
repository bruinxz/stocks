import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * KOL 观点 / 行业大 V 言论 (KOL Opinion) 入库表 — US-056 AI 增强层。
 *
 * 一行 = (stock_code, kol_name, opinion_date) 的一条观点条目：
 *   "某位 KOL（券商分析师 / 雪球大 V / 财经记者 / 股吧高赞作者）
 *    在某一天发表了一段对某只股票的多 / 空 / 中性观点"。
 *
 * 数据源（聚合 3 大类，每类落到一行 kol_source）：
 *
 *   1. **research_report**（券商研报 — AKShare `stock_research_report_em`）
 *      - kol_name        = 机构名（如 "中信证券" / "诚通证券"）
 *      - kol_source      = 'research_report'
 *      - opinion_date    = 研报发布日期
 *      - opinion_summary = 报告名称 + 东财评级（如 "Q3 业绩点评：业绩超预期，维持买入"）
 *      - sentiment_score = 评级映射到 [-1, +1] 区间：
 *                          买入=+1.0 / 增持=+0.6 / 持有=0 / 中性=0 /
 *                          减持=-0.6 / 卖出=-1.0 / 未评级=null
 *      - url             = 报告 PDF 链接
 *      AC 命名 "券商研报标题与摘要" → 我们用 AnalystForecast 已落库数据二次聚合，
 *      不再单独 fetch（同一数据源不要拉两次的复用范式）。
 *
 *   2. **east_money_news**（个股新闻 — AKShare `stock_news_em`）
 *      - kol_name        = 文章来源（"上海证券报" / "证券时报" / "财联社" 等）
 *                          —— 注：东财个股新闻按"作者"维度不暴露，"来源"机构名是
 *                          最接近 KOL 概念的字段（财经记者 / 媒体团队代表观点）。
 *      - kol_source      = 'east_money_news'
 *      - opinion_date    = 发布时间（YYYY-MM-DD，时分秒丢弃）
 *      - opinion_summary = 新闻标题 + （可选）摘要前 200 字
 *      - sentiment_score = 标题关键词字典打分：
 *                          强多关键词 +1.0 / 弱多 +0.5 / 中性 0 / 弱空 -0.5 / 强空 -1.0
 *      - url             = 原文链接
 *
 *   3. **xq_hot_concept**（雪球 / 东财热门概念 — AKShare `stock_hot_keyword_em`）
 *      - kol_name        = "市场热议·" + 概念名（如 "市场热议·白酒"）
 *                          —— 雪球 / 东财股吧高赞评论作者维度 AKShare 不提供，
 *                          以"热度排行 top 3 概念"作为"市场集体观点"代理
 *                          （US-034 同款代理范式：原 endpoint 不可得时用替代）。
 *      - kol_source      = 'xq_hot_concept'
 *      - opinion_date    = 抓取日期（concept 热度是当下快照）
 *      - opinion_summary = "<时点> 该股位列 <概念名> 概念中热度第 N，热度值 H"
 *      - sentiment_score = 热度排名映射到 [0, +0.5]（无空头方向，仅"被关注"信号）：
 *                          排名 1 → +0.5 / 排名 2 → +0.4 / ... / 排名 5+ → +0.1
 *      - url             = null（聚合源无单条 URL）
 *
 * 主键 (stock_code, kol_name, opinion_date)：
 *   同一 KOL 同一天对同一股票通常只发一次有代表性的观点。如确有同日多条，
 *   按"信息量更丰富的优先"覆盖（同 AnalystForecast dedup 范式 US-030）。
 *
 * ── 三大数据源缺失字段 / 代理范式（US-031 / US-032 / US-034 一致）──
 *
 * AC 原定数据源（雪球热门评论 / 股吧高赞）在 AKShare 中 **不可得**：
 *   - 雪球 (XueQiu) 评论数据 AKShare 无任何 endpoint 暴露；
 *     直爬 https://xueqiu.com/<user_id>/<post_id> 反爬严格、字段易变。
 *   - 东方财富股吧高赞作者 AKShare 同样无 endpoint；stock_guba_em 是空架子。
 *
 * 选定代理：
 *   - **雪球热门评论代理 = stock_hot_keyword_em（热门概念 top）**
 *     理论根据：雪球用户聚集讨论的热点话题与东财热门概念高度相关；用"该股
 *     被关注的热门概念"反映"市场对该股的集体关注角度"，间接代理"KOL 集体观点"。
 *   - **股吧高赞代理 = stock_news_em（个股新闻头条）**
 *     理论根据：财经新闻的"文章来源"机构（财联社 / 证券时报 / 上证报等）
 *     代表该机构的专业财经记者团队，其报道角度接近"KOL 立场"
 *     （新闻媒体对个股的报道本身就是市场叙事的重要部分）。
 *
 * 升级路径：
 *   - 若我们引入第三方 API (雪球开放数据 / Wind 资讯 / TuShare Pro 新闻情感)
 *     提供真实雪球评论 / 股吧高赞作者，将 KOLAggregatorService 内的 fetcher
 *     插入对应 source，模型 / 因子 / endpoint 不变（kol_source 列扩展 union）。
 *   - 若决定剔除某数据源，sync 时跳过即可，历史行保留作回溯。
 *
 * 字段说明：
 *   stock_code        6 位股票代码（无后缀），主键之一
 *   kol_name          KOL 名称（机构名 / 媒体源 / "市场热议·<concept>"）
 *   opinion_date      观点日期（YYYY-MM-DD），主键之一
 *   kol_source        来源标签 (research_report / east_money_news / xq_hot_concept)
 *   opinion_summary   观点摘要（短文本，~ 200 字内）
 *   sentiment_score   情绪打分 [-1, +1]：正向为多头 / 负向为空头 / 0 为中性
 *   url               原始链接（research / news）；xq_hot_concept 为 null
 *   raw_payload       原始来源行（便于事后回溯）
 *
 * 用途：US-056 KOL 观点聚合，前端 stock-profile 详情页 "他人在看" 卡片 +
 * 未来 US-067 (KOL 观点告警) / US-082 (周报 KOL 摘要) 复用。
 */
@Table({
  tableName: 'kol_opinions',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['stock_code'] },
    { fields: ['opinion_date'] },
    { fields: ['stock_code', 'opinion_date'] },
    { fields: ['kol_source'] },
    { fields: ['stock_code', 'kol_source'] },
    { fields: ['stock_code', 'opinion_date', 'kol_source'] },
  ],
})
export class KOLOpinion extends Model {
  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '6 位股票代码（无市场前缀），例如 600519 / 000001',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(160),
    allowNull: false,
    primaryKey: true,
    field: 'kol_name',
    comment: 'KOL 名称（机构如 "中信证券" / 媒体源如 "财联社" / "市场热议·<概念名>" 代理）',
  })
  declare kol_name: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'opinion_date',
    comment: '观点日期 (YYYY-MM-DD)',
  })
  declare opinion_date: string;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    field: 'kol_source',
    comment:
      '来源标签：research_report (券商研报) / east_money_news (个股新闻) / xq_hot_concept (热门概念代理)',
  })
  declare kol_source: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'opinion_summary',
    comment: '观点摘要（短文本，~ 200 字内）',
  })
  declare opinion_summary: string;

  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: true,
    field: 'sentiment_score',
    comment: '情绪打分 [-1, +1]：正向多头 / 负向空头 / 0 中性；未评级 / 无法判定 = null',
  })
  declare sentiment_score?: number;

  @Column({
    type: DataType.STRING(500),
    allowNull: true,
    field: 'url',
    comment: '原始链接（研报 PDF / 新闻原文 URL）；热门概念代理 source 为 null',
  })
  declare url?: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '原始来源行（保留所有字段，便于事后回溯）',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
