import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * MarketSentimentIndex — US-057
 *
 * **每日全市场情绪量化指数** —— 一行 = 一个交易日 (per trade_date) 的综合指数快照。
 * 每天收盘后 (~16:30) 由 SchedulerService 触发 `MarketSentimentIndexService.computeAndPersist`
 * 计算并写入。指数公式 (AC 指定 4 维加权)：
 *
 *   raw_score = (涨停数 - 跌停数)          × 0.3
 *             + 北向净买入 z-score          × 0.3
 *             + 融资净买入 z-score          × 0.2
 *             + 全市场问答热度 z-score      × 0.2
 *
 *   index_value = normalize_to_0_100(raw_score)
 *
 * 其中：
 *   - **涨停数**          —— 当日 LimitUpStock 行数 (US-007)；
 *   - **跌停数**          —— AKShare stock_zt_pool_dtgc_em 当日行数 (US-057 新加)；
 *   - **北向净买入**       —— NorthboundHolding 当日全市场 sum(hold_value_change_1d)，
 *                            走 lookback_days (默认 60) 横截面 z-score 归一化；
 *   - **融资净买入**       —— stock_margin_account_info 当日 (融资买入额 - 融券卖出额)，
 *                            同样走 lookback_days 横截面 z-score；
 *   - **全市场问答热度**   —— StockSentiment 当日 sum(post_count)，走 lookback_days
 *                            横截面 z-score (post_count 是 EastMoney 人气排名代理，
 *                            US-034 数据层范式)；
 *
 * **归一化到 0-100**：
 *   - raw_score 理论无界 (3 个 z-score 加权 + 1 个 count 差)，实际 95% 范围在
 *     [-50, +50] 之间；用 sigmoid 类压扁: `1 / (1 + exp(-raw / scale))` × 100
 *     得 0-100 区间值。scale 默认 30 让中等极端 (raw=±30) 落在 ~25 / ~75 附近。
 *   - 50 = 中性，> 60 偏多，< 40 偏空，> 80 / < 20 视为极值信号。
 *
 * **设计取舍**：
 *   - **PK = trade_date 单一字段** —— 全市场指数，一日一行 (与 per-stock 模型 PK
 *     不同)；UPSERT 时若当日已存在则覆盖 (admin 重跑 / 数据 backfill)。
 *   - **components_json JSONB 存原始值** —— 让 UI 可以 drill-down 看到 4 个分量
 *     的 raw / z-score / weight / contribution；同时给未来 US-058+ 趋势分析
 *     (z-score 衰减系数) 留下扩展空间，不需要 schema migration。
 *   - **`status` 字段** —— `ok` 正常 / `partial` 部分维度数据缺失 (e.g. 跌停接口
 *     当日返回空)；fail-OPEN —— 部分缺失走 partial 不阻塞写入，让 UI 还能展示
 *     已有维度。`failed` 留给完全跑不出来的情况 (4 个数据源全失败)。
 *   - **timestamps 'underscored'** —— 与 US-040+ models 一致。
 *
 * **消费方**：
 *   - GET /api/sentiment/index?days=30 —— 前端时序图 (TodayWorkspace 顶 KPI 卡片
 *     + 单股详情页 "市场温度" 副信号)；
 *   - 未来 US-080 NotificationService 当 index_value > 80 / < 20 时推送 (极端
 *     情绪告警)；
 *   - 未来 US-049 DrawdownCircuitBreaker 可消费此指数作为"市场背景信号"叠加 LEVEL_3
 *     额外暂停。
 */
@Table({
  tableName: 'market_sentiment_indices',
  timestamps: true,
  underscored: true,
  indexes: [{ fields: ['trade_date'] }],
})
export class MarketSentimentIndex extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD) — PK，一日一行',
  })
  declare trade_date: string;

  @Column({
    type: DataType.DECIMAL(6, 3),
    allowNull: false,
    field: 'index_value',
    comment: '综合情绪指数 (0-100，50=中性)',
  })
  declare index_value: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'raw_score',
    comment: '加权前的 raw score (未归一化，便于审计与历史回溯)',
  })
  declare raw_score: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'limit_up_count',
    comment: '当日涨停数 (LimitUpStock 行数)',
  })
  declare limit_up_count: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'limit_down_count',
    comment: '当日跌停数 (stock_zt_pool_dtgc_em 行数)',
  })
  declare limit_down_count: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'northbound_net_buy_zscore',
    comment: '北向净买入 z-score (lookback_days 横截面)',
  })
  declare northbound_net_buy_zscore: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'margin_net_buy_zscore',
    comment: '融资净买入 z-score (lookback_days 横截面)',
  })
  declare margin_net_buy_zscore: number | null;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'qa_heat_zscore',
    comment: '全市场问答热度 z-score (lookback_days 横截面)',
  })
  declare qa_heat_zscore: number | null;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    field: 'components_json',
    comment:
      '4 维分量明细 JSON：{limit_diff, north_raw/z/w, margin_raw/z/w, qa_raw/z/w, scale, lookback_days}',
  })
  declare components_json: Record<string, unknown> | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'ok',
    comment: '状态：ok（4 维度齐全） / partial（部分缺失） / failed（全部缺失）',
  })
  declare status: 'ok' | 'partial' | 'failed';

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '人类可读的中文摘要 / 警告信息',
  })
  declare message: string | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
