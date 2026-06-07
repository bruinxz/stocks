import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 股东户数 (Shareholder Count / Holder Count) 历史入库表 — US-035 数据层。
 *
 * 一行 = (report_date, stock_code) 的一份股东户数快照（多数为季度末，偶有
 * 月中临时披露 — 约 50-70 条 / 上市 10+ 年的股票）。
 *
 * 主键 (report_date, stock_code)：
 *   AKShare 同一只股票在同一截止日通常只发一份快照；如有更正会沿用同
 *   截止日重发新数据 — bulkCreate + updateOnDuplicate 自然处理。
 *
 * 数据源：AKShare `stock_zh_a_gdhs_detail_em(symbol=<6-digit>)`
 *   东方财富网 - 数据中心 - 特色数据 - 股东户数详情
 *   https://data.eastmoney.com/gdhs/detail/000002.html
 *   返回该股票全部历史 "股东户数统计截止日" 为粒度的快照。
 *
 *   AKShare 返回列：
 *     股东户数统计截止日 / 区间涨跌幅 / 股东户数-本次 / 股东户数-上次 /
 *     股东户数-增减 / 股东户数-增减比例 / 户均持股市值 / 户均持股数量 /
 *     总市值 / 总股本 / 股本变动 / 股本变动原因 / 股东户数公告日期 / 代码 / 名称
 *
 * 字段说明（按 AC + 实用扩展）：
 *   report_date              股东户数统计截止日（YYYY-MM-DD，PK 一半，作为时序入口）
 *   stock_code               6 位股票代码（无后缀，PK 一半）
 *   stock_name               股票简称（冗余便于排查）
 *   holder_count             AC 必需字段：当期股东户数（"股东户数-本次"，整数 > 0）
 *   holder_count_prev        上期股东户数（AKShare 已给的 "上次"，便于审计）
 *   holder_count_change      AC 直接来源：增减值 (= holder_count - holder_count_prev)
 *   holder_count_change_pct  AKShare 已计算好的环比 %（vs 上次）
 *                            ⚠️ 因子层不依赖此字段做环比，而是自己跨 row 算
 *                            "最新一期 vs 上一期"，保持 self-contained + 可重算；
 *                            本列作 sanity check / 占位
 *   interval_change_pct      区间涨跌幅 (%)（上次到本次股价变化）— 用于关联因子
 *   avg_holder_market_cap    户均持股市值（元）
 *   avg_holder_shares        户均持股数量（股）
 *   total_market_cap         总市值（元）
 *   total_shares             总股本（股）
 *   share_change             股本变动（股）— 非零意味着送股 / 增发 / 减持，会让
 *                            holder_count 环比含噪音。因子层可酌情过滤
 *                            (share_change == 0) 才计算环比。
 *   share_change_reason      股本变动原因（短文本）
 *   announce_date            股东户数公告日期（披露 ≠ 截止日；通常滞后 7-30 日）
 *
 * 用途：
 *   - ShareholderConcentrationFactor (US-035) 计算最新一期股东户数环比变化
 *     （负值 = 集中 = 正分；正值 = 分散 = 负分）。
 *   - 未来 US-036+ 可衍生 "户均持股市值变化" 等 alpha 因子。
 *
 * 与既有模型的关系：
 *   - 与 FinancialReport (US-024) 都是 per-stock 季度级时间序列；二者 PK 一致
 *     (report_date, stock_code)。FinancialReport 是财务三表，本表是股东结构。
 *   - 与 DividendHistory / EarningsForecast 共享 per-stock 时间线 sync 模式。
 */
@Table({
  tableName: 'shareholder_counts',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['report_date'] },
    { fields: ['stock_code'] },
    { fields: ['stock_code', 'report_date'] },
    { fields: ['report_date', 'stock_code'] },
    { fields: ['announce_date'] },
  ],
})
export class ShareholderCount extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'report_date',
    comment: '股东户数统计截止日 (YYYY-MM-DD)',
  })
  declare report_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '6 位股票代码 (无市场前缀)，例如 600519 / 000001',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票简称（冗余便于人工排查）',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'holder_count',
    comment: 'AC 必需字段：当期股东户数 (整数 > 0)',
  })
  declare holder_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'holder_count_prev',
    comment: '上一期股东户数 (AKShare "股东户数-上次")',
  })
  declare holder_count_prev?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'holder_count_change',
    comment: '股东户数增减 (= holder_count - holder_count_prev)',
  })
  declare holder_count_change?: number;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'holder_count_change_pct',
    comment:
      'AKShare 提供的环比 % — 因子层不依赖（自己跨 row 算最新 vs 上一期），保留作 sanity check',
  })
  declare holder_count_change_pct?: number;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'interval_change_pct',
    comment: '区间涨跌幅 (上次到本次股价变化 %)',
  })
  declare interval_change_pct?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'avg_holder_market_cap',
    comment: '户均持股市值 (元)',
  })
  declare avg_holder_market_cap?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'avg_holder_shares',
    comment: '户均持股数量 (股)',
  })
  declare avg_holder_shares?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'total_market_cap',
    comment: '总市值 (元)',
  })
  declare total_market_cap?: number;

  @Column({
    type: DataType.BIGINT,
    allowNull: true,
    field: 'total_shares',
    comment: '总股本 (股)',
  })
  declare total_shares?: number;

  @Column({
    type: DataType.BIGINT,
    allowNull: true,
    field: 'share_change',
    comment: '股本变动 (股) — 非零代表送转股 / 增发，影响 holder_count 环比可比性',
  })
  declare share_change?: number;

  @Column({
    type: DataType.STRING(200),
    allowNull: true,
    field: 'share_change_reason',
    comment: '股本变动原因（短文本）',
  })
  declare share_change_reason?: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'announce_date',
    comment: '股东户数公告日期 (披露日 ≠ 截止日；通常滞后 7-30 日)',
  })
  declare announce_date?: string;

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
    comment: '原始 AKShare 行 (保留所有字段，便于事后回溯)',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
