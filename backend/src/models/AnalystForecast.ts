import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 分析师研报 / 一致预期 (Analyst Forecast / Research Report) 入库表 — US-030 数据层。
 *
 * 一行 = 一份卖方分析师研报：单家机构在某一日对某只股票发布的研报，含
 *   东财评级 (买入/增持/中性/减持/卖出) + 1-3 年度预测 EPS / PE。
 *
 * 主键 (report_date, stock_code, analyst_firm)：
 *   同一家机构在同一日通常只发一份研报；如确有同日多份（点评 / 深度），
 *   AKShare 当前只取最新（同 stock_code + 同 firm + 同 date 仅保留一行）—
 *   这正是 upsert 期望行为。改用机构名做联合 PK 的原因：
 *     - 没有"研报 ID"字段
 *     - 同公司可能在不同机构同日各发一份独立研报
 *     - 报告名称太长不适合做 PK
 *
 * 数据源：AKShare `stock_research_report_em(symbol=<6位股票代码>)`
 *   东方财富网-数据中心-研究报告-个股研报
 *   返回该股票全部历史研报（不限时间），按发布日倒序。
 *
 *   AKShare 返回的列名（2026 年版本，年份动态）：
 *     序号 / 股票代码 / 股票简称 / 报告名称 / 东财评级 / 机构 /
 *     近一月个股研报数 /
 *     {Y1}-盈利预测-收益 / {Y1}-盈利预测-市盈率 /
 *     {Y2}-盈利预测-收益 / {Y2}-盈利预测-市盈率 /
 *     {Y3}-盈利预测-收益 / {Y3}-盈利预测-市盈率 /
 *     行业 / 日期 / 报告PDF链接
 *
 *   其中 Y1/Y2/Y3 是动态的前向 1-3 年（每年 12 月跨年后 AKShare 自动滚动），
 *   Python helper 用列名正则识别 "{4 位年}-盈利预测-收益" 提取并按年排序，
 *   把 "近期向前数第 1 个年度的 EPS" 写到 forecast_eps_y1，第 2 个写到 _y2。
 *
 * 字段说明（按 AC 拆解）：
 *   report_date          研报发布日期（YYYY-MM-DD，作为时序入口）
 *   stock_code           6 位股票代码（无后缀）
 *   analyst_firm         发布机构（如 "中信证券" "诚通证券"），与日期共同唯一定位
 *   stock_name           股票简称（冗余便于排查）
 *   target_price         目标价（元）— 当前 AKShare endpoint 不提供，保留列
 *                        为 nullable 留待将来切换接口或叠加另一数据源
 *   rating               东财评级：买入 / 增持 / 中性 / 持有 / 减持 / 卖出 / 未评级
 *   forecast_eps_y1      最近期前向年度的 EPS 预测（元 / 股）
 *   forecast_eps_y2      第二近前向年度的 EPS 预测（元 / 股）
 *   forecast_eps_y3      第三近前向年度的 EPS 预测（元 / 股，常为 null）
 *   forecast_year_y1     forecast_eps_y1 对应的年份（YYYY，便于跨年度调试 / 因子）
 *   forecast_year_y2     forecast_eps_y2 对应的年份（YYYY）
 *   forecast_year_y3     forecast_eps_y3 对应的年份（YYYY）
 *   analyst_count        该股票"近一月个股研报数"（AKShare 返回的横截面计数；
 *                        非 per-row 而是 per-stock 当前值，写入做参考）
 *   report_title         报告标题（短文本，便于人工排查）
 *   industry             所属行业（东财分类，可能与 Stock.industry 不同步）
 *   report_pdf_url       报告 PDF 链接（如有）
 *
 * 用途：AnalystConsensusFactor (US-030) 计算近 90 日 forecast_eps_y1 上调幅度
 * 作为 alpha 因子；EarningsSurpriseFactor (US-032) 用 forecast_eps_yN 与实际值
 * 算超预期幅度。
 */
@Table({
  tableName: 'analyst_forecasts',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['report_date'] },
    { fields: ['stock_code'] },
    { fields: ['stock_code', 'report_date'] },
    { fields: ['report_date', 'stock_code'] },
    { fields: ['rating'] },
    { fields: ['forecast_year_y1'] },
  ],
})
export class AnalystForecast extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'report_date',
    comment: '研报发布日期 (YYYY-MM-DD)',
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
    type: DataType.STRING(120),
    allowNull: false,
    primaryKey: true,
    field: 'analyst_firm',
    comment: '发布机构名（如 "诚通证券" "中信证券"）— 与 (report_date, stock_code) 联合唯一',
  })
  declare analyst_firm: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票简称（冗余便于人工排查）',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'target_price',
    comment: '目标价 (元) — AKShare stock_research_report_em 当前不提供该字段，保留列待将来扩展',
  })
  declare target_price?: number;

  @Column({
    type: DataType.STRING(30),
    allowNull: true,
    field: 'rating',
    comment: '东财评级 (买入 / 增持 / 中性 / 持有 / 减持 / 卖出 / 未评级)',
  })
  declare rating?: string;

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'forecast_eps_y1',
    comment: '最近期前向年度的 EPS 预测 (元/股)',
  })
  declare forecast_eps_y1?: number;

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'forecast_eps_y2',
    comment: '第二近期前向年度的 EPS 预测 (元/股)',
  })
  declare forecast_eps_y2?: number;

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'forecast_eps_y3',
    comment: '第三近期前向年度的 EPS 预测 (元/股)，常为 null',
  })
  declare forecast_eps_y3?: number;

  @Column({
    type: DataType.SMALLINT,
    allowNull: true,
    field: 'forecast_year_y1',
    comment: 'forecast_eps_y1 对应的年份 (YYYY)，便于跨年度因子计算',
  })
  declare forecast_year_y1?: number;

  @Column({
    type: DataType.SMALLINT,
    allowNull: true,
    field: 'forecast_year_y2',
    comment: 'forecast_eps_y2 对应的年份 (YYYY)',
  })
  declare forecast_year_y2?: number;

  @Column({
    type: DataType.SMALLINT,
    allowNull: true,
    field: 'forecast_year_y3',
    comment: 'forecast_eps_y3 对应的年份 (YYYY)',
  })
  declare forecast_year_y3?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'analyst_count',
    comment: '该股票 "近一月个股研报数"（AKShare 返回的横截面值，非 per-row）— 反映关注度',
  })
  declare analyst_count?: number;

  @Column({
    type: DataType.STRING(500),
    allowNull: true,
    field: 'report_title',
    comment: '研报标题（短文本）',
  })
  declare report_title?: string;

  @Column({
    type: DataType.STRING(120),
    allowNull: true,
    field: 'industry',
    comment: '所属行业（东财分类）',
  })
  declare industry?: string;

  @Column({
    type: DataType.STRING(500),
    allowNull: true,
    field: 'report_pdf_url',
    comment: '研报 PDF 链接',
  })
  declare report_pdf_url?: string;

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
    comment: '原始 AKShare 行（保留所有字段，便于事后回溯）',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
