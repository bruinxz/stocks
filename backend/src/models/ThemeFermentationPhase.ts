import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * ThemeFermentationPhase — PR-O5 (2026-06-30)
 *
 * **题材发酵 5 阶段日度分类**. 一行 = (trade_date, industry) 二元组, 由
 * `ThemeFermentationDetector` 每日 16:30 (工作日) 跑 — IndustrySentimentAggregator
 * 16:00 把 industry_sentiment_indices 写完后, 本服务再消费它做"5 阶段分类 + 主线切换检测".
 *
 * **5 阶段语义** (PR-I-v2 §6.4 板块/题材轮动战法):
 *   - germinate (萌芽): 1-3 只票轻微异动, 无涨停; 信号弱不推
 *   - launch    (启动): 首只涨停, 涨停数 1-3, 板块涨幅 +2~5%; 推次龙头 + 跟风
 *   - outbreak  (爆发): 涨停数 5+, 连板高度 ≥ 2, 板块涨幅 +5~10%; 推中军 + 龙头接力
 *   - climax    (高潮): 涨停数 10+, 连板高度 ≥ 4, 涨幅 +10%+; **不推, 持仓 reduce**
 *   - recession (退潮): 涨停数 < 5, 炸板率 > 50% 或较昨日明显回落; 推主线切换
 *
 * **数据来源**:
 *   - industry_sentiment_indices (PR-M3 — lim_up_count / consecutive_max / seal_rate /
 *     lim_up_failure_rate / industry_momentum_30d / composite_score)
 *   - 同一表昨日行 (用于 phase_changed_from 跟踪 + 主线切换检测)
 *
 * **与推荐 service 关系** (soft decision layer):
 *   - launch / outbreak → 推荐 + 20% 加权 (top_codes 次龙头优先)
 *   - climax → 推荐降权 (-30%) 或直接 skip
 *   - recession → 推荐 skip (避免追退潮主线)
 *
 * **fail-OPEN**: 整个 service 失败不阻塞主流程, 推荐 service 直接走 PR-M3 industry_sentiment 兜底.
 */
@Table({
  tableName: 'theme_fermentation_phases',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date', 'phase'] },
    { fields: ['industry', 'trade_date'] },
    { fields: ['trade_date', 'is_mainline'] },
  ],
})
export class ThemeFermentationPhase extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD)',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    primaryKey: true,
    comment: '申万一级行业名 (与 stocks.industry / industry_sentiment_indices.industry 同口径)',
  })
  declare industry: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: '5 阶段: germinate / launch / outbreak / climax / recession',
  })
  declare phase: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'lim_up_count',
    comment: '当日涨停只数 (透传自 industry_sentiment_indices)',
  })
  declare lim_up_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'consecutive_max',
    comment: '当日最高连板数',
  })
  declare consecutive_max: number;

  @Column({
    type: DataType.DECIMAL(8, 4),
    allowNull: true,
    field: 'lim_up_failure_rate',
    comment: '炸板率 [0,1]',
  })
  declare lim_up_failure_rate: number | null;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'composite_heat',
    comment: 'composite_score 透传 (大约 [-5, +5])',
  })
  declare composite_heat: number | null;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'momentum_30d_z',
    comment: '30 日动量 z-score (透传); NULL = 数据不足',
  })
  declare momentum_30d_z: number | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'phase_changed_from',
    comment: '昨日相位; NULL = 第一日 / 昨日无数据 (与今日相同也写, 便于审计)',
  })
  declare phase_changed_from: string | null;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_mainline',
    comment: '是否当日热点主线 (composite_score 当日 top-3 且 phase ∈ {launch, outbreak, climax})',
  })
  declare is_mainline: boolean;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'top_codes',
    comment: '涨停代表股 string[] (透传自 industry_sentiment_indices.top_codes)',
  })
  declare top_codes: string[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '调试 / 审计透传 (含 mainline_switch_event 等)',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
