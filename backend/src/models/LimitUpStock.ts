import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 涨停板股票池日度快照（含连板高度）
 *
 * 一条记录 = 某交易日 / 某只涨停股的快照。主键 (trade_date, stock_code) 用于
 * 单日 upsert，单只标的当日只有一条记录。
 *
 * 数据源：AKShare 双接口合并入库
 *   - `stock_zt_pool_em`         — 当日涨停股池（含 连板数 / 封板时间 / 炸板次数）
 *   - `stock_zt_pool_strong_em`  — 当日强势股池（含 入选理由 / 涨停价 / 涨速）
 *
 * 字段含义：
 *   limit_up_time          首次封板时间（HH:MM:SS）
 *   limit_up_amount        封板资金（元）
 *   limit_up_open_times    炸板次数（当日打开涨停的次数）
 *   continuous_days        连板天数（基于过去 5 个交易日入库记录推算，详见 LimitUpSyncService）
 *   reason                 入选理由 / 上榜原因
 *   industry               所属行业
 *   is_one_word_board      是否一字板（首次封板时间 ≤ 09:30:00 且 炸板次数 = 0）
 *
 * 短线龙头策略关注：连板数 ∈ [1,3] + is_one_word_board=false + industry 龙头。
 */
@Table({
  tableName: 'limit_up_stocks',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['stock_code'] },
    { fields: ['continuous_days'] },
    { fields: ['trade_date', 'continuous_days'] },
    { fields: ['trade_date', 'is_one_word_board'] },
    { fields: ['industry'] },
  ],
})
export class LimitUpStock extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD)',
  })
  declare trade_date: string;

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
    comment: '股票简称（冗余便于看图）',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'limit_up_time',
    comment: '首次封板时间 (HH:MM:SS)，可空（仅强势股池入选时为空）',
  })
  declare limit_up_time?: string;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'limit_up_amount',
    comment: '封板资金（元）',
  })
  declare limit_up_amount?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'limit_up_open_times',
    defaultValue: 0,
    comment: '炸板次数（当日打开涨停的次数）',
  })
  declare limit_up_open_times?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 1,
    field: 'continuous_days',
    comment: '连板天数（含当日）；首板=1，二板=2，依此类推',
  })
  declare continuous_days: number;

  @Column({
    type: DataType.STRING(255),
    allowNull: true,
    comment: '入选理由 / 上榜原因（如 "连续3日涨停"）',
  })
  declare reason?: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    comment: '所属行业（申万一级）',
  })
  declare industry?: string;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_one_word_board',
    comment: '是否一字板（首封时间 ≤ 09:30:00 且 炸板次数 = 0）',
  })
  declare is_one_word_board: boolean;

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
    comment: '原始 AKShare 行（zt_pool 与 strong_pool 合并后的完整字段）',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
