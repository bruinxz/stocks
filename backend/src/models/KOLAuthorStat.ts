import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * KOLAuthorStat — US-140 KOL-007 研报机构 (analyst_firm) 历史命中率快照.
 *
 * 一行 = `(analyst_firm, as_of_date)` 的一份"截至某天"的胜率快照:
 *   "中信证券 截至 2026-06-21 在过去 90 天内发了 12 份评级 ≥'增持' 或 ≤'减持'
 *    的研报, 其中 8 份方向正确, 命中率 66.7%".
 *
 * 与 AnalystForecast (US-030) 关系:
 *   - AnalystForecast: N rows per (stock, firm, date) — 一行一份研报;
 *   - KOLAuthorStat:   1 row per (firm, as_of_date) — 按 firm 维度聚合统计.
 *
 * 数据源: AnalystForecast JOIN DailyBar (forward return 计算).
 *   - lookback_days = 90 (统计窗口);
 *   - forward_window_days = 30 (T+30 trading days 的 close 与 T-1 close 比);
 *   - 评级 ≥ '增持' (买入/推荐/增持/超配/审慎推荐) → 看多预测;
 *   - 评级 ≤ '减持' (减持/低配/卖出/回避) → 看空预测;
 *   - 评级 == '持有/中性/观望' → **不计入** sample (无方向信号).
 *
 * **命中规则**:
 *   - 看多研报 + forward_return > 0 → win;
 *   - 看空研报 + forward_return < 0 → win;
 *   - 看多研报 + forward_return ≤ 0 → loss;
 *   - 看空研报 + forward_return ≥ 0 → loss;
 *   - forward return 无法计算 (停牌 / 数据缺失) → 跳过, 不计 sample.
 *
 * **fail-safe 默认值**:
 *   - sample_size / win_count / loss_count 默认 0 (NOT NULL);
 *   - win_rate 默认 0;
 *   - avg_forward_return_pct / latest_report_date 默认 NULL.
 *
 * **AC §8** (PRD): "90 天后 ≥ 3 author 胜率 ≥ 60%" — 由 KOLAuthorTrackingService
 * 的 identifyTopAuthors(stats, {min_samples, min_win_rate}) 输出 top N 满足条件的
 * analyst_firm; 前端 (未来 KOL-014) /factors/kol tab 直接读本表渲染榜单.
 *
 * 主键与 UNIQUE:
 *   - PK: id autoIncrement;
 *   - UNIQUE (analyst_firm, as_of_date) — 同 firm 同天一行, bulkCreate
 *     updateOnDuplicate 直接刷.
 *
 * 字段说明:
 *   analyst_firm             机构名 (与 AnalystForecast.analyst_firm 对齐)
 *   as_of_date               统计截止日 (YYYY-MM-DD)
 *   sample_size              过去 lookback_days 内该 firm "有方向预测"研报数
 *   win_count                命中数
 *   loss_count               未命中数 (sample_size = win_count + loss_count)
 *   win_rate                 win_count / sample_size ∈ [0, 1]
 *   avg_forward_return_pct   有方向校正后的 forward return 均值
 *                            (看空研报的 forward return 取负, 让"猜对方向" 一致为正)
 *   lookback_days            统计窗口 (默认 90)
 *   forward_window_days      forward return 计算窗口 (默认 30 自然日)
 *   latest_report_date       最近一份研报日期
 *   raw_payload              审计 (sample_stock_codes / 评级分布 / skipped reasons 等)
 */
@Table({
  tableName: 'kol_author_stats',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['analyst_firm', 'as_of_date'],
      unique: true,
      name: 'kol_author_stats_firm_asof_uniq',
    },
    { fields: ['as_of_date'], name: 'idx_kol_author_stats_as_of_date' },
    { fields: ['win_rate', 'sample_size'], name: 'idx_kol_author_stats_win_rate' },
  ],
})
export class KOLAuthorStat extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'analyst_firm',
    comment: '研报机构名 (与 analyst_forecasts.analyst_firm 对齐)',
  })
  declare analyst_firm: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'as_of_date',
    comment: '统计截止日 (YYYY-MM-DD) — 每跑一次 tracker 一行',
  })
  declare as_of_date: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'sample_size',
    comment: '过去 lookback_days 内该 firm 的"有方向预测"研报数 (排除持有/中性)',
  })
  declare sample_size: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'win_count',
    comment: '命中数 (看多 + return>0 / 看空 + return<0)',
  })
  declare win_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'loss_count',
    comment: '未命中数',
  })
  declare loss_count: number;

  @Column({
    type: DataType.DECIMAL(5, 4),
    allowNull: false,
    defaultValue: 0,
    field: 'win_rate',
    comment: 'win_count / sample_size ∈ [0, 1]',
  })
  declare win_rate: number;

  @Column({
    type: DataType.DECIMAL(8, 4),
    allowNull: true,
    field: 'avg_forward_return_pct',
    comment: '有方向校正后的 forward return 均值 ∈ [-1, +∞)',
  })
  declare avg_forward_return_pct: number | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 90,
    field: 'lookback_days',
    comment: '统计窗口 (默认 90 天)',
  })
  declare lookback_days: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 30,
    field: 'forward_window_days',
    comment: 'forward return 窗口 (默认 30 自然日)',
  })
  declare forward_window_days: number;

  @Column({
    type: DataType.DATEONLY,
    allowNull: true,
    field: 'latest_report_date',
    comment: '最近一份研报日期 (YYYY-MM-DD)',
  })
  declare latest_report_date: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '审计辅助 (sample_stock_codes / rating_distribution / skipped_reasons 等)',
  })
  declare raw_payload: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
