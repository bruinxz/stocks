import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 龙虎榜（Dragon-Tiger Board）每日营业部明细
 *
 * 一条记录 = 某交易日 / 某只股票 / 某个买入营业部 / 某个卖出营业部的撮合行。
 * 单只股票当日通常会出现 ~10 个买入席位 + ~10 个卖出席位，AKShare 会按
 * (买入席位 × 卖出席位) 的笛卡尔展开返回，因此主键采用四元复合键。
 *
 * 数据源：AKShare `stock_lhb_detail_em` 及 `stock_lhb_stock_detail_em`
 *
 * 字段对应：
 *   reason         上榜原因（"日涨幅偏离值达7%" / "连续三个交易日内日收盘价格涨幅偏离值累计达20%" 等）
 *   buyer_seat     买入营业部全称
 *   seller_seat    卖出营业部全称
 *   buy_amount     买方营业部当日合计买入金额（元）
 *   sell_amount    卖方营业部当日合计卖出金额（元）
 *   net_amount     该买方-卖方组合的净买入金额（元，可正可负）
 *   is_famous_yz   是否命中知名游资白名单（buyer_seat 命中即 true）
 *
 * 短线策略关注 is_famous_yz=true 的行 + net_amount>0 用以识别 "游资抢筹"。
 */
@Table({
  tableName: 'dragon_tiger_board',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['stock_code'] },
    { fields: ['buyer_seat'] },
    { fields: ['seller_seat'] },
    { fields: ['is_famous_yz'] },
    { fields: ['seat_type'] }, // US-088: 按归属机构类型筛查（公募/外资/私募/游资）
    { fields: ['trade_date', 'stock_code'] },
    { fields: ['trade_date', 'is_famous_yz'] },
    { fields: ['stock_code', 'seat_type'] }, // US-088: 单股归属机构维度过滤
  ],
})
export class DragonTigerBoard extends Model {
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
    type: DataType.STRING(255),
    allowNull: false,
    primaryKey: true,
    field: 'buyer_seat',
    comment: '买方营业部全称',
  })
  declare buyer_seat: string;

  @Column({
    type: DataType.STRING(255),
    allowNull: false,
    primaryKey: true,
    field: 'seller_seat',
    comment: '卖方营业部全称',
  })
  declare seller_seat: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票简称（冗余便于看图）',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.STRING(255),
    allowNull: true,
    comment: '上榜原因',
  })
  declare reason?: string;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'buy_amount',
    comment: '买方营业部合计买入金额（元）',
  })
  declare buy_amount?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'sell_amount',
    comment: '卖方营业部合计卖出金额（元）',
  })
  declare sell_amount?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'net_amount',
    comment: '净买入金额（buy_amount - sell_amount，元，可负）',
  })
  declare net_amount?: number;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_famous_yz',
    comment: '买方营业部是否命中知名游资白名单',
  })
  declare is_famous_yz: boolean;

  /**
   * US-088: 买方营业部归属机构类型 — public_fund / foreign / private_fund /
   * famous_yz / unknown。
   *
   * 由 `famousSeats.getSeatType(buyer_seat)` 在 sync 时计算并落库。
   * 短线策略可按 `seat_type='public_fund'` 跟随机构、`seat_type='foreign'`
   * 跟随外资、`seat_type='famous_yz'` 跟随游资。
   *
   * 注意：这是 `buyer_seat` 的归属类型；`seller_seat` 的类型未存储 —
   * 卖方席位的"跟随"信号意义有限（卖出 = 出货），暂不需要。
   */
  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'unknown',
    field: 'seat_type',
    comment: '买方营业部归属机构类型 (public_fund/foreign/private_fund/famous_yz/unknown)',
  })
  declare seat_type: string;

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
    comment: '原始 AKShare 行（保留所有字段，便于以后回溯）',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
