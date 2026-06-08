import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 限售解禁日历 (Restricted Share Release Calendar) 入库表 — US-089 数据层。
 *
 * 一行 = (ex_date, stock_code, shareholder_name) 的一份解禁批次记录。
 * 同一日同一股票可能因为多个限售股东 / 多种限售股类型而有多条记录
 * (e.g. 'XX 公司 首发原股东限售股份' 与 'YY 基金 定向增发机构配售股份')，
 * 因此 PK 必须含 shareholder_name 三元组才能 idempotent upsert。
 *
 * 数据源：AKShare `stock_restricted_release_detail_em(start_date, end_date)`
 *   东方财富网 - 数据中心 - 限售股解禁 - 解禁详情一览
 *   https://data.eastmoney.com/dxf/detail.html
 *
 *   AKShare 返回列：
 *     序号 / 股票代码 / 股票简称 / 解禁时间 / 限售股类型 / 解禁数量 /
 *     实际解禁数量 / 实际解禁市值 / 占解禁前流通市值比例 / 解禁前一交易日收盘价 /
 *     解禁前20日涨跌幅 / 解禁后20日涨跌幅
 *
 *   注意：该端点按"解禁时间"日期范围检索，不按 stock 检索；输入是
 *   start_date / end_date YYYYMMDD 字符串，返回该日期范围内所有解禁批次。
 *   AC 中 `stock_restricted_release_queue` 是 per-stock 历史端点（per-stock
 *   分批查询效率低 + AKShare 已被替换成 *_em 变体），本服务使用 date-range
 *   `*_detail_em` 端点 — 同款 endpoint substitution 范式见 US-034 / US-035 /
 *   US-053。4 处文档同步标注：Python helper docstring / TS Client jsdoc /
 *   SyncService jsdoc / Watchdog jsdoc。
 *
 * 字段说明 (按 AC + 实用扩展)：
 *   ex_date                  解禁日 (YYYY-MM-DD，PK 一半，作为时序入口)
 *   stock_code               6 位股票代码 (无后缀，PK 一半)
 *   shareholder_name         限售股股东 / 类型 描述 (PK 一半) —
 *                            AKShare 返回 "限售股类型" 字段 (e.g.
 *                            '首发原股东限售股份' / '定向增发机构配售股份' /
 *                            '股权激励限售股份')。同一日同一股可能有多种类型，
 *                            故进 PK。stockholder_em 端点可补股东明细，但
 *                            detail_em 端点本身只有"类型"字段。命名上沿用
 *                            AC 中的 shareholder_name 字段名。
 *   stock_name               股票简称 (冗余便于排查)
 *   release_shares           解禁数量 (股，AC 必需字段 = AKShare "解禁数量")
 *   release_actual_shares    实际解禁数量 (股，AKShare "实际解禁数量"，
 *                            部分股东可能因协议自愿延长锁定期，导致 actual < shares)
 *   release_market_value     实际解禁市值 (元，AC 必需字段 = AKShare "实际解禁市值")
 *   release_pct_of_float     占解禁前流通市值比例 (%，AKShare 已计算好) —
 *                            watchdog 直接消费此字段判 "解禁 / 流通比例 > 10%"
 *   prev_close_price         解禁前一交易日收盘价 (元)
 *   prev_20d_change_pct      解禁前20日涨跌幅 (%) — 已经/将要披露后的复盘字段
 *   post_20d_change_pct      解禁后20日涨跌幅 (%) — 历史数据才有，未来日为 null
 *
 * 用途：
 *   - RestrictedShareWatchdog (US-089 风控): 持仓股若 5 个交易日内解禁市值 >
 *     当前流通市值 10% → 写 RiskAlert(level='MEDIUM') 提示用户提前规避；
 *   - 未来扩展场景: 因子层"解禁压力"得分 / 投后复盘 "解禁日是否引发回撤" 统计。
 *
 * 与既有模型的关系：
 *   - 与 DividendHistory (US-022) 都是 per-stock 时间线事件，但 DividendHistory
 *     按 ex_date + stock_code 二元 PK 已足够；本表的多股东类型需要三元 PK；
 *   - 与 EarningsForecast (US-013) 同属"事件型"数据，但 EarningsForecast 按
 *     公告日 + 报告期检索，本表按解禁日检索。
 */
@Table({
  tableName: 'restricted_share_releases',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['ex_date'] },
    { fields: ['stock_code'] },
    { fields: ['stock_code', 'ex_date'] },
    { fields: ['ex_date', 'stock_code'] },
  ],
})
export class RestrictedShareRelease extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'ex_date',
    comment: '解禁日 (YYYY-MM-DD)',
  })
  declare ex_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '6 位股票代码 (无市场前缀)，例如 600519 / 000001',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: false,
    primaryKey: true,
    field: 'shareholder_name',
    comment: '限售股东 / 限售股类型 (e.g. 首发原股东限售股份 / 定向增发机构配售股份)',
  })
  declare shareholder_name: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票简称（冗余便于人工排查）',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'release_shares',
    comment: 'AC 必需字段：解禁数量 (股)',
  })
  declare release_shares: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'release_actual_shares',
    comment: '实际解禁数量 (股，部分股东可能自愿延长锁定期)',
  })
  declare release_actual_shares?: number;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'release_market_value',
    comment: 'AC 必需字段：实际解禁市值 (元)',
  })
  declare release_market_value: number;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'release_pct_of_float',
    comment: '占解禁前流通市值比例 (%) — watchdog 直接消费',
  })
  declare release_pct_of_float?: number;

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'prev_close_price',
    comment: '解禁前一交易日收盘价 (元)',
  })
  declare prev_close_price?: number;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'prev_20d_change_pct',
    comment: '解禁前 20 日涨跌幅 (%)',
  })
  declare prev_20d_change_pct?: number;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'post_20d_change_pct',
    comment: '解禁后 20 日涨跌幅 (%) — 历史数据才有，未来日为 null',
  })
  declare post_20d_change_pct?: number;

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
