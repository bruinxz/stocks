import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 财务报告 (Financial Report) 入库表 — A 股上市公司的定期报告（年报 / 半年报 / Q1 / Q3）
 * 关键基本面指标快照。
 *
 * 主键 (report_date, stock_code)：
 *   一只股票每年最多 4 份报告（Q1/H1/Q3/Annual），由 report_date 区分；同一报告
 *   被修订（罕见）时通过 upsert 覆盖原行（report_date 不变 → 同一主键）。
 *
 * 数据源：AKShare `stock_financial_abstract`(`symbol`) 或类似端点
 *   - 输入 symbol 是 6 位股票代码（无市场前缀）
 *   - 输出 dataframe 列出该股票全部历史定期报告，每行对应一个 report_date
 *   - 关键字段：归母净利润 / 营业收入 / 净利润同比 / 营收同比 / ROE / 资产负债率
 *
 * 字段说明：
 *   report_date           报告期末日期 (YYYY-MM-DD, e.g. 2024-12-31 = 2024 年报)
 *   stock_code            股票代码 (6 位，无市场前缀)
 *   stock_name            股票简称（冗余便于人工排查）
 *   report_type           报告类型: '年报' / '半年报' / '一季报' / '三季报'（按 report_date
 *                         月份推断；2024-12-31 = 年报）
 *   net_profit            归母净利润（元，可负）
 *   net_profit_yoy        归母净利润同比 (%)
 *   revenue               营业收入（元）
 *   revenue_yoy           营业收入同比 (%)
 *   roe                   净资产收益率 (%) - 即 ROE
 *   debt_ratio            资产负债率 (%)
 *   source                数据源标识 (akshare)
 *   raw_payload           原始 AKShare 行
 *
 * GARP 策略关注 (US-024)：
 *   - 连续 3 年（按 report_date 取年报） net_profit_yoy ≥ 15%
 *   - ROE 5 年均值 ≥ 12%
 *   - 资产负债率 ≤ 60%
 *   - 配合 valuation.pe_ttm 计算 PEG = pe / 净利润增速
 */
@Table({
  tableName: 'financial_reports',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['stock_code'] },
    { fields: ['report_date'] },
    { fields: ['report_type'] },
    { fields: ['stock_code', 'report_date'] },
    { fields: ['stock_code', 'report_type'] },
  ],
})
export class FinancialReport extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'report_date',
    comment: '报告期末日期 (YYYY-MM-DD, e.g. 2024-12-31 = 2024 年报)',
  })
  declare report_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '股票代码，例如 600519 / 000001 (无市场前缀)',
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
    type: DataType.STRING(20),
    allowNull: true,
    field: 'report_type',
    comment: '报告类型: 年报 / 半年报 / 一季报 / 三季报',
  })
  declare report_type?: string;

  @Column({
    type: DataType.DECIMAL(22, 4),
    allowNull: true,
    field: 'net_profit',
    comment: '归母净利润（元，可负）',
  })
  declare net_profit?: number;

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'net_profit_yoy',
    comment: '归母净利润同比 (%)',
  })
  declare net_profit_yoy?: number;

  @Column({
    type: DataType.DECIMAL(22, 4),
    allowNull: true,
    field: 'revenue',
    comment: '营业收入（元）',
  })
  declare revenue?: number;

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'revenue_yoy',
    comment: '营业收入同比 (%)',
  })
  declare revenue_yoy?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'roe',
    comment: '净资产收益率 ROE (%)',
  })
  declare roe?: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: true,
    field: 'debt_ratio',
    comment: '资产负债率 (%)',
  })
  declare debt_ratio?: number;

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
    comment: '原始 AKShare 行（保留所有字段便于事后回溯）',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
