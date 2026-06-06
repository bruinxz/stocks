import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 因子得分日度快照（FactorScore）
 *
 * 一条记录 = 某交易日 / 某只股票 / 某个因子 的标准化得分。主键
 * (trade_date, stock_code, factor_name) 用于 idempotent upsert：同日同因子
 * 重跑会覆盖原值（FactorPipeline 整批重算后写入）。
 *
 * 字段含义：
 *   factor_name   因子名（必须与 FactorRegistry.register 时的 name 一致；
 *                 例如 'value', 'quality', 'momentum_120_20'）
 *   raw_value     因子原始值（未做横截面标准化，便于 debug；可为 null 表示
 *                 当日该股票该因子无法计算——如缺数据）
 *   z_score       横截面 winsorize(1%-99%) 后的 z-score（截面标准化）
 *   percentile    横截面百分位（0..1），便于做分组 backtest（top quintile 等）
 *
 * 设计要点：
 *   - 同一天同一因子，所有股票一起进入 FactorPipeline 才能得到 z_score
 *     与 percentile（横截面统计量）。因此 FactorPipeline.runForDate 是
 *     按 (date, factor) 批处理的。
 *   - 因子失效但仍需要保留行（便于审计 "因子覆盖了哪些股票"）时，
 *     raw_value = null，z_score = 0，percentile = 0.5（中性）。
 *   - 同名因子在不同交易日的语义可以演化（v1 vs v2），但 FactorRegistry
 *     不允许同 name 多次 register；若要语义演化，建议改名为 'value_v2'。
 *
 * 查询模式：
 *   - 单股因子时序：WHERE stock_code=? AND factor_name=? ORDER BY trade_date
 *   - 单日横截面：WHERE trade_date=? AND factor_name=? ORDER BY z_score DESC
 *   - 多因子合成 (US-011)：WHERE trade_date=? GROUP BY stock_code，
 *     SUM(z_score * weight) → 总分。
 */
@Table({
  tableName: 'factor_scores',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['stock_code'] },
    { fields: ['factor_name'] },
    { fields: ['trade_date', 'factor_name'] },
    { fields: ['stock_code', 'factor_name'] },
    { fields: ['trade_date', 'factor_name', 'z_score'] },
  ],
})
export class FactorScore extends Model {
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
    comment: '股票代码（无市场前缀，例如 600519 / 000001）',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(64),
    allowNull: false,
    primaryKey: true,
    field: 'factor_name',
    comment: '因子名（与 FactorRegistry 注册一致，例如 value / quality / momentum）',
  })
  declare factor_name: string;

  @Column({
    type: DataType.DECIMAL(20, 6),
    allowNull: true,
    field: 'raw_value',
    comment: '因子原始值（未横截面标准化）。null 表示当日该股该因子缺值',
  })
  declare raw_value?: number | null;

  @Column({
    type: DataType.DECIMAL(12, 6),
    allowNull: false,
    defaultValue: 0,
    field: 'z_score',
    comment: '横截面 winsorize(1%-99%) 后的 z-score（标准化）',
  })
  declare z_score: number;

  @Column({
    type: DataType.DECIMAL(8, 6),
    allowNull: false,
    defaultValue: 0.5,
    comment: '横截面百分位 (0..1)，便于分组回测',
  })
  declare percentile: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'pipeline',
    comment: '写入来源标识（默认 pipeline；离线脚本可写 batch）',
  })
  declare source: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
