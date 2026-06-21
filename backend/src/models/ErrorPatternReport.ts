import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { User } from './User';

/**
 * ErrorPatternReport — L8-Postmortem / US-092 [PM-021] 90 天错误模式聚合报告
 *
 * 一行 = 单个用户 + 一个 90 天窗口 的 bias / outcome / attribution 模式聚合.
 * 由 ErrorPatternAggregator.aggregateForUser (US-092 同 story) 生成,
 * 后续 WEEKLY_ERROR_PATTERN_AGGREGATE cron (US-093 PM-022) 周日 10:00 触发.
 *
 * **(user_id, period_end) 业务唯一**:
 *   - PRD US-092 AC: 字段含 (user_id, period, patterns JSONB, summary TEXT, generated_at).
 *   - "周日生成" 语义下 period_end 每周仅一行, idempotent upsert 覆盖最新结果.
 *   - 历史保留靠 created_at / updated_at 时间戳 + 不同 period_end 的多行.
 *
 * **period_start / period_end / lookback_days 三字段冗余**:
 *   - 业务上 period_start = period_end - lookback_days (默认 90).
 *   - 物化三个字段让 SQL 查询不需要算偏移 (ops 看板 / UI 历史曲线直接 read).
 *   - 与 [[BenchmarkAttributionResult.run_id + start_date]] 同款"业务键冗余"思想.
 *
 * **JSONB patterns 字段** —— 给 ops / UI / 改进建议 service (US-094) 消费的核心数据:
 *   - bias_patterns[]            — 按 bias_type 聚合 90 天频次 + 平均严重度 + 时间趋势
 *     { bias_type: string, total_count: number, avg_severity: number, weeks_active: number,
 *       trending: 'up'|'down'|'flat', sample_trades: string[3] }
 *   - outcome_patterns[]         — 按 outcome 维度 (e.g. chase_high / stop_loss_too_late)
 *     聚合命中频次 + 平均亏损
 *     { outcome_type: string, total_count: number, avg_loss_pct: number, total_loss: number,
 *       worst_examples: Array<{symbol, date, loss}> }
 *   - attribution_patterns[]     — 按 dim (industry/timing/sizing/selection/factor) 累计贡献
 *     { dimension: string, total_contrib: number, avg_per_day: number, worst_day: string,
 *       worst_day_contrib: number, sign_consistency: number }  // sign_consistency: 0..1
 *   - top_findings              — 综合 top N (≤ 5) 最值得关注的模式
 *
 * **JSONB summary_stats 字段** —— 给 LLM summary / 飞书 push 直接引用的数字:
 *   - total_bias_count          — 90 天 bias finding 总条数
 *   - total_outcome_count       — 90 天 outcome (含 closed_trades) 总条数
 *   - total_attribution_days    — 90 天内有 DailyAttributionReport (status=ok) 的天数
 *   - avg_pnl_pct               — 90 天平均日盈亏 % (基于 attribution.total_pnl_pct)
 *   - win_rate                  — 90 天日胜率 (= 盈利天数 / 总有效天数)
 *   - data_completeness         — 'full' (≥ 60 天有数据) / 'partial' (30~59) / 'sparse' (< 30)
 *
 * **summary 字段** —— ≤ 500 字 LLM / heuristic 摘要 (与 AIDiaryEntry.text 同思想, 默认 heuristic):
 *   - 描述本期最显著的 bias_type / 最严重的 outcome / 主要 attribution 失分维度
 *   - PM-023 ImprovementSuggestion service (US-094) 会消费本 summary 作 prompt 上文
 *
 * **status 字段反映生成状态** (与 DailyAttributionReport / AIDiaryEntry 同款 fail-OPEN):
 *   - 'ok'       — 正常生成 (含真实 patterns 或经 fallback 也算合规)
 *   - 'skipped'  — 数据太稀疏 (90 天内 < MIN_DATA_DAYS 天有数据)
 *   - 'failed'   — 计算异常 (aggregator throw, 上层 cron 仍尝试落留痕)
 *
 * **与既有 model 的边界**:
 *   - DailyAttributionReport (PM-003) = 每日 6 维归因 (账户级 / per-day 真值)
 *   - AIDiaryEntry (PM-018) = 每日反思 (用户认知 / per-day 叙事)
 *   - BehaviorBiasDetector findings (PM-008) = per-day 增量 bias 数组 (落 DailyAttributionReport.bias_findings)
 *   - 本表 = per-user per-window 模式聚合 (跨 90 天)
 *   - 后续 ImprovementSuggestion (US-094 PM-023) = 从 patterns + summary 生成可执行建议
 *
 * 主要消费方:
 *   - US-093 PM-022 WEEKLY_ERROR_PATTERN_AGGREGATE cron 周日 10:00 upsert
 *   - US-094 PM-023 ImprovementSuggestionService 读最近 1 行作 prompt 上下文
 *   - EV-014 前端 /review/diary tab 错误模式趋势 (后续接入)
 */
@Table({
  tableName: 'error_pattern_reports',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['user_id', 'period_end'],
      unique: true,
      name: 'error_pattern_reports_user_period_uniq',
    },
    { fields: ['user_id'] },
    { fields: ['period_end'] },
    { fields: ['status'] },
    { fields: ['generated_at'] },
  ],
})
export class ErrorPatternReport extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: '所属用户 ID (一对一聚合 = 一个 user 一个 period 一行)',
  })
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_start',
    comment: '聚合窗口起点 (YYYY-MM-DD; 默认 period_end - 90 天)',
  })
  declare period_start: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_end',
    comment: '聚合窗口终点 (YYYY-MM-DD; cron 跑这周日时 = 周日; 业务键)',
  })
  declare period_end: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'lookback_days',
    defaultValue: 90,
    comment: '聚合窗口天数 (默认 90; PM-021 AC; ops 可调)',
  })
  declare lookback_days: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'patterns',
    defaultValue: {},
    comment:
      '聚合后的模式数据 (bias_patterns[] / outcome_patterns[] / attribution_patterns[] / top_findings[])',
  })
  declare patterns: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'summary_stats',
    defaultValue: {},
    comment:
      '聚合统计 (total_bias_count / total_outcome_count / total_attribution_days / avg_pnl_pct / win_rate / data_completeness)',
  })
  declare summary_stats: Record<string, unknown>;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'summary',
    defaultValue: '',
    comment:
      '≤ 500 字 LLM / heuristic 摘要 (本 story 仅 heuristic; US-094 ImprovementSuggestion service 可消费)',
  })
  declare summary: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'source',
    defaultValue: 'heuristic',
    comment: '生成来源: llm / heuristic / manual',
  })
  declare source: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'status',
    defaultValue: 'ok',
    comment: '生成状态: ok / skipped / failed (与 DailyAttributionReport 对齐, fail-OPEN)',
  })
  declare status: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: true,
    field: 'reason',
    comment:
      'skipped / failed 时的简短原因 (e.g. data_too_sparse / aggregator_threw / no_attribution_in_period)',
  })
  declare reason: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata',
    defaultValue: {},
    comment:
      '调用 metadata (cron_run_id / data_sources_used[] / bias_findings_loaded / attribution_days_loaded / errors[])',
  })
  declare metadata: Record<string, unknown>;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'generated_at',
    comment: '报告生成时间戳 (落库瞬间)',
  })
  declare generated_at: Date;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
