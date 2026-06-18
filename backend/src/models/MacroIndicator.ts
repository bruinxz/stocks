import {
  Table,
  Column,
  Model,
  DataType,
  PrimaryKey,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';

/**
 * 宏观经济指标日度 / 月度数据 (2026-06-11 新增).
 *
 * 单一表存所有 macro series: PMI / CPI / M2 / SHIBOR / 国债收益率 / GDP.
 * PK = (indicator_key, observation_date). 不同 indicator 频率不同
 * (PMI/CPI/M2/GDP 月度，SHIBOR/Treasury 日度).
 *
 * 用途:
 *   - MarketEnvironmentService regime detection 加宏观维度
 *   - EnsembleStrategy 子策略切换更准确
 *   - 未来加 cyclical sector timing (PMI 上行 → 周期股、CPI 上行 → 消费/资源)
 *
 * 数据源:
 *   - AKShare macro_china_* 系列 (东财数据中心)
 *   - 每日 cron 拉一次 (data 本身月度更新但 daily 拉成本极低)
 */
@Table({
  tableName: 'macro_indicators',
  indexes: [{ fields: ['indicator_key'] }, { fields: ['observation_date'] }],
  comment: '宏观经济指标 (PMI/CPI/M2/SHIBOR/十年期国债/GDP)',
})
export class MacroIndicator extends Model<MacroIndicator> {
  @PrimaryKey
  @Column({ type: DataType.STRING(50), allowNull: false, field: 'indicator_key' })
  declare indicator_key: string; // 'pmi' | 'cpi' | 'm2' | 'shibor_overnight' | 'treasury_10y_china' | 'gdp_yearly' | ...

  @PrimaryKey
  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'observation_date' })
  declare observation_date: string; // 该指标该期发布日期 / 数据期

  @Column({ type: DataType.DECIMAL(18, 6), allowNull: true, field: 'value' })
  declare value: number | null; // 主值

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'yoy_pct' })
  declare yoy_pct: number | null; // 同比 (% — m2/cpi/pmi 等)

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'mom_pct' })
  declare mom_pct: number | null; // 环比

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'raw_payload' })
  declare raw_payload: object; // 原始所有字段 (国债 7 个 maturity / m2+m1 多列 / 等)

  @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: 'akshare', field: 'source' })
  declare source: string;

  @CreatedAt
  declare created_at: Date;

  @UpdatedAt
  declare updated_at: Date;
}
