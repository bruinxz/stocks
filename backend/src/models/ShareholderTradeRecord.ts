import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 股东增减持公告 (Shareholder Increase/Decrease Trade Record) — US-090 数据层.
 *
 * 一行 = (announce_date, stock_code, shareholder_name, trade_direction,
 *         change_start_date) 五元 PK 的一份股东增减持公告.
 *
 * 5 元 PK 选择理由:
 *   - 同一只股票一份公告里常包含 N 个股东 (尤其多名董监高同步减持) → shareholder_name in PK;
 *   - 同一股东可能 N 月内多次增持 + 减持交替, announce_date 已含日期但同股东
 *     同日同公告反复增减罕见, trade_direction (增持/减持) 进 PK 防混淆;
 *   - 同一股东同一公告里若分批 (start_date 不同) 也算独立 batch → change_start_date in PK.
 *   - announce_date 进 PK (作为时序入口, 与 DividendHistory / EarningsForecast 同款).
 *
 * 数据源: AKShare `stock_ggcg_em(symbol='全部')`
 *   东方财富网 - 数据中心 - 特色数据 - 高管持股
 *   https://data.eastmoney.com/executive/gdzjc.html
 *
 *   AKShare 返回列:
 *     代码 / 名称 / 最新价 / 涨跌幅 / 股东名称 / 持股变动信息-增减 /
 *     持股变动信息-变动数量 / 持股变动信息-占总股本比例 / 持股变动信息-占流通股比例 /
 *     变动后持股情况-持股总数 / 变动后持股情况-占总股本比例 / 变动后持股情况-持流通股数 /
 *     变动后持股情况-占流通股比例 / 变动开始日 / 变动截止日 / 公告日
 *
 *   注意: 该端点是"快照型"(返回当下时点近 N 个月全市场增减持公告), 无日期参数,
 *   只能拉"今天可见的全集"; 与 US-008 IndustryFlow / US-058 SnowballHotKeyword
 *   同款 real-time-only 模式. trade_date 概念在本表里就是 announce_date (公告日).
 *
 * AC 字段映射:
 *   announce_date         公告日期 (YYYY-MM-DD, PK 一半 = AKShare "公告日")
 *   stock_code            6 位股票代码 (无后缀, PK 一半 = AKShare "代码")
 *   shareholder_name      股东名称 (PK 一半 = AKShare "股东名称")
 *   trade_direction       '增持' | '减持' (PK 一半 = AKShare "持股变动信息-增减")
 *   trade_shares          变动股数 (股, AC 必需字段 = AKShare "持股变动信息-变动数量" × 10000;
 *                         AKShare 单位是万股, 内部统一存储为股 (与 release_shares 同款))
 *   trade_amount          变动金额 (元, **代理字段** = trade_shares × latest_price;
 *                         AKShare 不提供成交均价, 只有最新价 + 变动股数, 用最新价 ×
 *                         shares 作为粗略市值代理. 真实公告日价格回测期内不可得,
 *                         此代理用作横截面排序 / 量级判断, 不要做精确金额报表.)
 *   shareholder_type      股东类型: '机构投资者' | '自然人' | '高管' | '其他'
 *                         (由 TS 服务从 shareholder_name 模式启发式归类; AKShare
 *                         本身只给名称无 type 字段, 同款 "TS 业务推理 + Python dumb fetcher"
 *                         分工见 US-006 is_famous_yz / US-088 seat_type)
 *
 * 扩展字段 (raw_payload 之外的解析字段, 可选):
 *   stock_name                   股票简称 (冗余便于人工排查)
 *   latest_price                 最新价 (元, 用于回算 trade_amount)
 *   pct_of_total_shares          占总股本比例 (%) — 用于"占比"维度因子
 *   pct_of_float_shares          占流通股比例 (%)
 *   post_hold_shares             变动后持股总数 (股)
 *   change_start_date            变动开始日 (YYYY-MM-DD, PK 一半)
 *   change_end_date              变动截止日 (YYYY-MM-DD)
 *
 * 用途:
 *   - InsiderTradeFactor (US-090): 最近 60 日内部人净买入 / 总市值 → 多因子模型
 *     "内部人买卖"信号源; 经济意义实证已证 — 大股东 + 高管增持往往是中线 alpha 信号.
 *   - 未来扩展: 持仓 watchdog (董监高密集减持 → 风控告警), 复盘日记 (公告类型摘要).
 *
 * 与既有模型的关系:
 *   - 与 ShareholderCount (US-035) 都是"股东"维度数据但口径不同: ShareholderCount
 *     是 per-stock 季度披露的散户/机构总户数, 本表是 per-event 公告披露的
 *     特定股东买卖事件; 一个是"截面广度"一个是"事件强度", 维度互补.
 *   - 与 RestrictedShareRelease (US-089) 同为"事件型"表, 但 US-089 是被动的
 *     解禁日历 (锁定期到期), US-090 是主动的股东行为 (主动增持 / 主动减持).
 *     都按 N 元复合 PK 建模 (RestrictedShareRelease 三元 / 本表五元).
 */
@Table({
  tableName: 'shareholder_trade_records',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['announce_date'] },
    { fields: ['stock_code'] },
    { fields: ['stock_code', 'announce_date'] },
    { fields: ['announce_date', 'stock_code'] },
    { fields: ['shareholder_type'] },
    { fields: ['trade_direction'] },
  ],
})
export class ShareholderTradeRecord extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'announce_date',
    comment: '公告日 (YYYY-MM-DD), PK 一半',
  })
  declare announce_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '6 位股票代码 (无市场前缀), 例如 600519 / 000001, PK 一半',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: false,
    primaryKey: true,
    field: 'shareholder_name',
    comment: '股东名称 (e.g. 高管姓名 / 机构全称), PK 一半',
  })
  declare shareholder_name: string;

  @Column({
    type: DataType.STRING(10),
    allowNull: false,
    primaryKey: true,
    field: 'trade_direction',
    comment: '增减方向: 增持 / 减持 (AC 必需字段, PK 一半)',
  })
  declare trade_direction: '增持' | '减持';

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    defaultValue: '1970-01-01',
    field: 'change_start_date',
    comment: '变动开始日 (YYYY-MM-DD), PK 一半; 缺失时用 1970-01-01 占位',
  })
  declare change_start_date: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票简称 (冗余便于人工排查)',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'trade_shares',
    comment: 'AC 必需字段: 变动股数 (股, AKShare 万股 × 10000)',
  })
  declare trade_shares: number;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'trade_amount',
    comment:
      'AC 必需字段: 变动金额 (元, 代理 = trade_shares × latest_price; ' +
      'AKShare 无成交均价, 此值为粗略市值代理)',
  })
  declare trade_amount: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: '其他',
    field: 'shareholder_type',
    comment:
      'AC 必需字段: 股东类型 (机构投资者 / 自然人 / 高管 / 其他, ' +
      '由 TS 服务从 shareholder_name 模式启发式归类)',
  })
  declare shareholder_type: '机构投资者' | '自然人' | '高管' | '其他';

  @Column({
    type: DataType.DECIMAL(14, 4),
    allowNull: true,
    field: 'latest_price',
    comment: '最新价 (元, 用于回算 trade_amount; AKShare "最新价")',
  })
  declare latest_price?: number;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'pct_of_total_shares',
    comment: '占总股本比例 (%)',
  })
  declare pct_of_total_shares?: number;

  @Column({
    type: DataType.DECIMAL(14, 6),
    allowNull: true,
    field: 'pct_of_float_shares',
    comment: '占流通股比例 (%)',
  })
  declare pct_of_float_shares?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'post_hold_shares',
    comment: '变动后持股总数 (股)',
  })
  declare post_hold_shares?: number;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'change_end_date',
    comment: '变动截止日 (YYYY-MM-DD)',
  })
  declare change_end_date?: string;

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
