import { Table, Column, Model, DataType } from 'sequelize-typescript';

/**
 * 交易日历 (Trading Calendar) — A 股沪深两市统一日历
 *
 * 每一行为一个自然日，标注是否交易日、是否半日市，以及前/后一个交易日。
 * 消费方以此判定 walk-forward test 日期迭代、事件时序 next_trade_date lookup
 * 以及 §D4.1 α 降级公式 `COALESCE(available_at, next_trade_date(time))` 的
 * 真实交易日计算 (替代 landing 前的 INTERVAL '1 day' 日历日近似)。
 *
 * 数据源：Baostock `bs.query_trade_dates(start_date, end_date)` (主源)
 *   - 输出 date × is_trading_day 序列
 *   - is_half 需硬编 A 股节前调休名单 (春节前 / 国庆前 / 中秋前) 每年 update
 *   - 备源: AKShare `tool_trade_date_hist_sina()` (Baostock 连续 3 次 fail 后 fallback)
 *
 * 字段说明：
 *   trade_date        自然日 (YYYY-MM-DD)
 *   is_open           是否交易日 (true = 交易日，false = 周末/节假日)
 *   is_half           是否半日市 (true = 节前调休半日，false = 全日或休市)
 *   prev_trade_date   上一交易日 (nullable，历史首日无值)
 *   next_trade_date   下一交易日 (nullable，未来最后一日无值)
 *   source            数据源 (默认 'baostock'，fallback 时写 'akshare')
 *   created_at        入库时间 (Sequelize 自动)
 *   updated_at        末次更新时间 (Sequelize 自动)
 *
 * §D4.G2 shape landed @ PR #94 `ad586ef6` (docs/refactor/contracts/data.md line 306-334)
 * DDL landed @ PR #96 `6299a3d4` (backend/scripts/migrations/2026-07-08-trading-calendar-v1.sql)
 */
@Table({
  tableName: 'trading_calendar',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['is_open'], name: 'idx_trading_calendar_is_open' },
    { fields: ['is_half'], name: 'idx_trading_calendar_is_half' },
  ],
})
export class TradingCalendar extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '自然日 (YYYY-MM-DD)',
  })
  declare trade_date: string;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'is_open',
    comment: '是否交易日 (true = 交易日, false = 周末/节假日)',
  })
  declare is_open: boolean;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_half',
    comment: '是否半日市 (true = 节前调休半日)',
  })
  declare is_half: boolean;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'prev_trade_date',
    comment: '上一交易日 (nullable)',
  })
  declare prev_trade_date: string | null;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'next_trade_date',
    comment: '下一交易日 (nullable)',
  })
  declare next_trade_date: string | null;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'baostock',
    field: 'source',
    comment: '数据源 (baostock 主 / akshare 备)',
  })
  declare source: string;
}
