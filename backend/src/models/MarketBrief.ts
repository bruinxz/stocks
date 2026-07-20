import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * MarketBrief — US-073 AI 大盘速读卡片日度快照。
 *
 * **一行 = 一个交易日的"开盘前一图速读"**：
 *   - prev_close              上日收盘指数（沪深300，AC: "上日收盘"）；
 *   - today_open              今日开盘指数（同基准指数）；
 *   - open_change_pct         今日开盘相对上日收盘的涨跌幅 (%)；
 *   - northbound_net_amount   北向资金昨日净买入（亿元，正=流入，负=流出）；
 *   - limit_up_count          昨日全市场涨停股数（LimitUpStock 行数）；
 *   - ai_view                 AI 生成的一句话观点（中文 1-2 句）；
 *   - nlp_engine              生成 AI view 的引擎（trading_agents / heuristic_fallback）；
 *   - status                  ok / partial（某些维度缺数据） / failed（全部缺失）；
 *   - message                 中文人类可读摘要（与 SentimentIndex 同款）。
 *
 * **设计参考** （与 MarketSentimentIndex US-057 / AIStockAnalysisReport US-055 同款）：
 *   - **PK = trade_date 单一字段** —— 大盘速读每日全市场一行，UPSERT 覆盖
 *     (admin 重跑 / 数据 backfill 时不需要历史多版本)；
 *   - **components_json JSONB** —— 让前端 UI drill-down 看到各数据源的 raw 值
 *     + 该数据源是否成功；同时给未来 US-080+ 推送策略消费完整 components 留
 *     扩展空间，不强制 schema 迁移；
 *   - **status 字段** —— 与 MarketSentimentIndex 一致：`ok` / `partial` /
 *     `failed`；fail-OPEN —— 部分缺失走 partial 不阻塞写入，让 UI 还能
 *     展示已有维度（用户体感是"今日北向数据未到"而非"页面挂了"）；
 *   - **timestamps 'underscored'** —— 与 US-040+ 模型一致。
 *
 * **消费方**：
 *   - GET /api/ai/market-brief/today —— TodayWorkspace 顶部 AI 大盘速读卡片；
 *   - 早盘前推送若启用，必须通过 FeishuNotificationService 统一 outbox 投递。
 */
@Table({
  tableName: 'market_briefs',
  timestamps: true,
  underscored: true,
  indexes: [{ fields: ['trade_date'] }],
})
export class MarketBrief extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD) — PK，一日一行',
  })
  declare trade_date: string;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'prev_close',
    comment: '上日收盘指数（沪深300基准）',
  })
  declare prev_close: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'today_open',
    comment: '今日开盘指数（沪深300基准）',
  })
  declare today_open: number | null;

  @Column({
    type: DataType.DECIMAL(8, 4),
    allowNull: true,
    field: 'open_change_pct',
    comment: '今日开盘 vs 上日收盘 涨跌幅 (%)',
  })
  declare open_change_pct: number | null;

  @Column({
    type: DataType.DECIMAL(14, 2),
    allowNull: true,
    field: 'northbound_net_amount',
    comment: '北向资金昨日净买入（亿元，正=流入，负=流出）',
  })
  declare northbound_net_amount: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'limit_up_count',
    comment: '昨日全市场涨停股数（LimitUpStock 行数）',
  })
  declare limit_up_count: number | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'ai_view',
    comment: 'AI 一句话观点（中文 1-2 句）',
  })
  declare ai_view: string | null;

  @Column({
    type: DataType.STRING(40),
    allowNull: true,
    field: 'nlp_engine',
    comment: '生成 AI view 的引擎：trading_agents / heuristic_fallback',
  })
  declare nlp_engine: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    field: 'components_json',
    comment: '5 维分量明细 + 数据源成功失败 (前端 UI drill-down 用)',
  })
  declare components_json: Record<string, unknown> | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'ok',
    comment: '状态：ok / partial（部分缺失）/ failed（全部缺失）',
  })
  declare status: 'ok' | 'partial' | 'failed';

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '人类可读的中文摘要',
  })
  declare message: string | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
