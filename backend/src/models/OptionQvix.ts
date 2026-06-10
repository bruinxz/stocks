import { Table, Column, Model, DataType, PrimaryKey, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 期权波动率指数 QVIX (类似 VIX) — 4 个标的 (2026-06-11 新增).
 *
 * 标的: 50ETF / 300ETF / 500ETF / 创业板. 计算方法类似 CBOE VIX.
 * 单一表存所有 series, PK = (underlying, observation_date).
 *
 * 用途:
 *   - **大盘择时核心信号**：QVIX 上行 → 隐含波动率提升 → 市场恐慌 / 暴跌前兆
 *   - MarketEnvironmentService volatile regime 检测加这个维度
 *   - EnsembleStrategy.volatile 子策略组合切换的领先指标
 *
 * 数据源 AKShare `index_option_50etf_qvix()` 等 4 个 fn.
 * 日度 cron 拉一次 (盘后 15:30 之后).
 */
@Table({
  tableName: 'option_qvix',
  indexes: [
    { fields: ['underlying'] },
    { fields: ['observation_date'] },
  ],
  comment: '期权波动率指数 QVIX (50ETF/300ETF/500ETF/创业板)',
})
export class OptionQvix extends Model<OptionQvix> {
  @PrimaryKey
  @Column({ type: DataType.STRING(20), allowNull: false, field: 'underlying' })
  declare underlying: string; // '50etf' | '300etf' | '500etf' | 'cyb'

  @PrimaryKey
  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'observation_date' })
  declare observation_date: string;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'open' })
  declare open: number | null;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'high' })
  declare high: number | null;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'low' })
  declare low: number | null;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'close' })
  declare close: number | null;

  @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: 'akshare', field: 'source' })
  declare source: string;

  @CreatedAt
  declare created_at: Date;

  @UpdatedAt
  declare updated_at: Date;
}
