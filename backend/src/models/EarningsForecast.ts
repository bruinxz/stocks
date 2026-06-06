import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 业绩预告 (Earnings Forecast / 预告) 入库表 — A 股上市公司在正式公布定期
 * 报告前，按规则需对净利润、营收等关键指标作"预增/预减/扭亏/首亏/续盈/
 * 续亏/略增/略减/不确定"等定性 + 区间定量的事前披露。
 *
 * 主键 (announce_date, stock_code, report_period)：
 *   一只股票在同一日可以同时披露多个 report_period 的预告（如年报 + Q1），
 *   也可能在不同公告日多次修订同一 report_period（修订公告日不同就是
 *   不同主键行；同一公告日的修订则覆盖原行 — 这正是 upsert 期望行为）。
 *
 * 数据源：AKShare `stock_yjyg_em(date)`
 *   - 输入 `date` 是 **报告期末** (e.g. "20240930" = 2024 Q3)，不是公告日。
 *   - 输出 dataframe 列出该报告期所有已发布预告的股票，每行含 公告日期、
 *     预测指标 (净利润上下限 / 净利润变动幅度上下限) 与定性 forecast_type。
 *
 * 字段说明：
 *   announce_date         公告日期（YYYY-MM-DD，作为时序入口）
 *   report_period         报告期末日期（YYYY-MM-DD，e.g. 2024-09-30）
 *   forecast_type         预告类型字符串（预增/预减/扭亏/首亏/续盈/续亏/
 *                         略增/略减/不确定）
 *   profit_change_low     预告净利润同比变动幅度下限 (%)
 *   profit_change_high    预告净利润同比变动幅度上限 (%)
 *   profit_low            预告净利润下限（元）
 *   profit_high           预告净利润上限（元）
 *   forecast_reason       业绩变动原因（短文本）
 *   is_surprise           是否超预期（forecast_type ∈ {预增,扭亏,续盈} 且
 *                         profit_change_low ≥ 50% — 在 SyncService 阶段标定）
 *
 * 事件驱动策略关注 (US-013)：is_surprise=true 的股票 + 过去 5 日北向加仓。
 */
@Table({
  tableName: 'earnings_forecasts',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['announce_date'] },
    { fields: ['stock_code'] },
    { fields: ['report_period'] },
    { fields: ['forecast_type'] },
    { fields: ['is_surprise'] },
    { fields: ['announce_date', 'is_surprise'] },
    { fields: ['stock_code', 'announce_date'] },
  ],
})
export class EarningsForecast extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'announce_date',
    comment: '公告日期 (YYYY-MM-DD)',
  })
  declare announce_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '股票代码，例如 600519 / 000001 (无市场前缀)',
  })
  declare stock_code: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'report_period',
    comment: '报告期末日期 (YYYY-MM-DD, e.g. 2024-09-30 = Q3 2024)',
  })
  declare report_period: string;

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
    field: 'forecast_type',
    comment: '预告类型: 预增 / 预减 / 扭亏 / 首亏 / 续盈 / 续亏 / 略增 / 略减 / 不确定',
  })
  declare forecast_type?: string;

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'profit_change_low',
    comment: '净利润同比变动幅度下限 (%)',
  })
  declare profit_change_low?: number;

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'profit_change_high',
    comment: '净利润同比变动幅度上限 (%)',
  })
  declare profit_change_high?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'profit_low',
    comment: '预告净利润下限 (元)',
  })
  declare profit_low?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'profit_high',
    comment: '预告净利润上限 (元)',
  })
  declare profit_high?: number;

  @Column({
    type: DataType.STRING(500),
    allowNull: true,
    field: 'forecast_reason',
    comment: '业绩变动原因（短文本，AKShare 原样存）',
  })
  declare forecast_reason?: string;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_surprise',
    comment: '是否超预期 (forecast_type ∈ {预增/扭亏/续盈} 且 profit_change_low ≥ 50%)',
  })
  declare is_surprise: boolean;

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
