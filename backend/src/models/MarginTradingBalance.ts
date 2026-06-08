import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 融资融券余额 (Margin Trading Balance) 入库表 — US-091 数据层.
 *
 * 一行 = (trade_date, stock_code) 二元 PK 的一份 per-stock 日度融资融券余额记录.
 *
 * 数据源: AKShare `stock_margin_detail_szse(date)` + `stock_margin_detail_sse(date)`
 *   深交所 / 上交所 - 融资融券数据 - 融资融券交易明细
 *   - 深交所: https://www.szse.cn/disclosure/margin/margin/index.html
 *   - 上交所: https://www.sse.com.cn/market/othersdata/margin/detail/
 *
 *   注意两交易所列名不一致 (Python helper 内统一映射):
 *     - 深交所 (szse): 证券代码 / 证券简称 / 融资买入额 / 融资余额 /
 *                     融券卖出量 / 融券余量 / 融券余额 / 融资融券余额
 *     - 上交所 (sse):  信用交易日期 / 标的证券代码 / 标的证券简称 /
 *                     融资余额 / 融资买入额 / 融资偿还额 / 融券余量 /
 *                     融券卖出量 / 融券偿还量
 *
 *   关键差异:
 *     - 深交所有 "融券余额" 列 (元), 上交所无 (只有融券余量 ×股数);
 *     - 上交所有 "融资偿还额" 列 (元), 深交所无 (只有融资买入额);
 *     - Python helper 把两交易所对齐到统一 schema: 缺失字段写 null.
 *
 *   AC 字段映射:
 *     trade_date         交易日 (YYYY-MM-DD, PK 一半, caller 传入)
 *     stock_code         6 位股票代码 (无后缀, PK 一半 = "证券代码" / "标的证券代码")
 *     fin_balance        融资余额 (元, AC 必需 = AKShare "融资余额")
 *     fin_buy_amt        融资买入额 (元, AC 必需 = AKShare "融资买入额")
 *     fin_repay_amt      融资偿还额 (元, AC 必需 = AKShare 上交所 "融资偿还额"
 *                        + 深交所 backfill = max(0, prev_fin_balance + fin_buy_amt - fin_balance);
 *                        深交所无显式偿还列, 由 service 层 day-to-day diff 推算
 *                        — 同款"day-to-day diff 推算累计型流量"模式见 US-057
 *                        MarginBalance net buy 计算)
 *     short_balance      融券余额 (元, AC 必需 = AKShare 深交所 "融券余额";
 *                        上交所 NULL — 端点限制, 不强行 backfill)
 *     short_sell_vol     融券卖出量 (股, AC 必需 = AKShare "融券卖出量")
 *
 * 扩展字段:
 *     stock_name                  股票简称 (冗余便于人工排查)
 *     short_repay_vol             融券偿还量 (股, 仅上交所)
 *     short_volume                融券余量 (股, 两市都有)
 *     total_margin_balance        融资融券余额 (元, 仅深交所 = AKShare "融资融券余额";
 *                                上交所通常 = fin_balance + short_balance, NULL 兜底)
 *     exchange                    交易所 'SZSE' | 'SSE' (debug / 分流统计)
 *
 * 用途:
 *   - MarginFlowFactor (US-091): 近 5 日融资余额变化 = (fin_balance[T] - fin_balance[T-5])
 *     / fin_balance[T-5] → 杠杆资金跟随策略 alpha 信号. 大幅增加 → 杠杆资金看多;
 *     大幅减少 → 杠杆资金撤退. 经济意义已被国内实证认可 (参考: 招商证券《融资融券与个股表现
 *     相关性研究》2018).
 *   - 未来扩展: 个股融资买入额 / 流通市值 比作"今日新增杠杆", 配合涨停股池
 *     (US-007) 识别"游资 + 杠杆共振"信号.
 *
 * 与既有模型的关系:
 *   - 与 US-057 引入的 MarginBalanceClient (stock_margin_account_info, 市场级日度
 *     聚合) 完全不同: 后者是全市场单行汇总 (融资余额 / 融券余额 / 融资买入额 /
 *     融券卖出额), 用于 MarketSentimentIndex 市场情绪打分; 本表是 per-stock 明细,
 *     用于个股级因子. 两个数据互补不冲突.
 *   - 与 NorthboundHolding (US-005) 都属于"资金跟随类"信号源, 一个跟外资 (北向),
 *     一个跟杠杆资金 (融资融券); 两者预计相关性 0.2-0.4, 可同时启用.
 */
@Table({
  tableName: 'margin_trading_balances',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['stock_code'] },
    { fields: ['stock_code', 'trade_date'] },
    { fields: ['trade_date', 'stock_code'] },
    { fields: ['exchange'] },
  ],
})
export class MarginTradingBalance extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD), PK 一半',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '6 位股票代码 (无市场前缀), 例如 600519 / 000001, PK 一半',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票简称 (冗余便于人工排查)',
  })
  declare stock_name?: string;

  // ===== AC 必需 5 字段 =====
  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'fin_balance',
    comment: 'AC 必需字段: 融资余额 (元) — AKShare "融资余额"',
  })
  declare fin_balance?: number;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'fin_buy_amt',
    comment: 'AC 必需字段: 融资买入额 (元) — AKShare "融资买入额"',
  })
  declare fin_buy_amt?: number;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'fin_repay_amt',
    comment:
      'AC 必需字段: 融资偿还额 (元) — 上交所直接来自 AKShare "融资偿还额"; ' +
      '深交所无原始列, 由 service 层 day-to-day diff 推算 (见 jsdoc)',
  })
  declare fin_repay_amt?: number;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'short_balance',
    comment: 'AC 必需字段: 融券余额 (元) — 仅深交所提供; 上交所端点不返回, NULL 兜底',
  })
  declare short_balance?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'short_sell_vol',
    comment: 'AC 必需字段: 融券卖出量 (股) — AKShare "融券卖出量"',
  })
  declare short_sell_vol?: number;

  // ===== 扩展字段 =====
  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'short_repay_vol',
    comment: '融券偿还量 (股) — 仅上交所提供',
  })
  declare short_repay_vol?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'short_volume',
    comment: '融券余量 (股) — 两市都有',
  })
  declare short_volume?: number;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'total_margin_balance',
    comment: '融资融券余额 (元) — 深交所原始 "融资融券余额"; 上交所端点无此字段, NULL',
  })
  declare total_margin_balance?: number;

  @Column({
    type: DataType.STRING(10),
    allowNull: false,
    defaultValue: 'UNKNOWN',
    field: 'exchange',
    comment: '交易所标识: SZSE (深交所) | SSE (上交所)',
  })
  declare exchange: 'SZSE' | 'SSE' | 'UNKNOWN';

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
    comment: '原始 AKShare 行 (保留所有字段, 便于事后回溯)',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
