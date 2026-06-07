import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 分红派息历史 (Dividend History) 入库表 — A 股上市公司的每次分红派息事件
 * 含 "10 派 X 元" / "10 送 N 股" / "10 转 M 股" 的明细。
 *
 * 主键 (announce_date, stock_code, ex_date)：
 *   一只股票一年可能多次分红（年度 + 中期），同一公告日可能涉及多次（少见
 *   但理论可能：当公司在同一份公告里宣布利润分配 + 资本公积转增方案时）。
 *   ex_date 是除权除息日，是分红"生效"的关键日期。
 *
 * 数据源：AKShare `stock_history_dividend_detail(symbol)`
 *   - 输入 symbol 是 6 位股票代码（无市场前缀）
 *   - 输出 dataframe 列出该股票全部历史分红记录
 *   - 字段：公告日期 / 除权除息日 / 派息（10 派 X 元）/ 送转方案 / 派息日 / 进度
 *
 * 字段说明：
 *   announce_date         公告日期 (YYYY-MM-DD)
 *   ex_date               除权除息日 (YYYY-MM-DD，事件生效日)
 *   stock_code            股票代码 (6 位，无市场前缀)
 *   stock_name            股票名称（冗余便于人工排查）
 *   dividend_per_share    每股派息金额（元），即 "10 派 X" 中 X/10
 *   bonus_per_10          10 股送股数（股）
 *   transfer_per_10       10 股转增股数（股）
 *   yield_pct             派息率 (%) = dividend_per_share / ex_date 前一日收盘价 * 100
 *                         在 SyncService 阶段计算（依赖 DailyBar），缺数据时为 null
 *   progress              进度（董事会预案 / 股东大会决议 / 实施 等）
 *   record_date           股权登记日（可选，部分数据源带）
 *   pay_date              派息日（可选）
 *
 * 高分红价值策略关注 (US-022)：近 3 年（按 ex_date 排序）的 yield_pct 均值
 * ≥ 4%；与 PE/ROE/总市值过滤一起做长线选股。
 */
@Table({
  tableName: 'dividend_histories',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['stock_code'] },
    { fields: ['ex_date'] },
    { fields: ['announce_date'] },
    { fields: ['stock_code', 'ex_date'] },
    { fields: ['stock_code', 'announce_date'] },
  ],
})
export class DividendHistory extends Model {
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
    field: 'ex_date',
    comment: '除权除息日 (YYYY-MM-DD, 事件生效日)',
  })
  declare ex_date: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票简称（冗余便于人工排查）',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'dividend_per_share',
    comment: '每股派息金额（元），即 "10 派 X" 中 X/10',
  })
  declare dividend_per_share?: number;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'bonus_per_10',
    comment: '10 股送股数（股），即 "10 送 N" 中 N',
  })
  declare bonus_per_10?: number;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'transfer_per_10',
    comment: '10 股转增股数（股），即 "10 转 M" 中 M',
  })
  declare transfer_per_10?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'yield_pct',
    comment: '派息率 (%) = dividend_per_share / ex_date 前一日收盘价 * 100',
  })
  declare yield_pct?: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'progress',
    comment: '进度: 董事会预案 / 股东大会决议 / 实施 等',
  })
  declare progress?: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'record_date',
    comment: '股权登记日 (可选)',
  })
  declare record_date?: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'pay_date',
    comment: '派息日 (可选)',
  })
  declare pay_date?: string;

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
