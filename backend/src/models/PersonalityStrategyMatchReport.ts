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
 * PersonalityStrategyMatchReport — L8-Postmortem / US-127 [PM-025] 性格 vs 策略匹配度
 *
 * 一行 = 单个用户 + 一个 period_end 的"性格画像 + 策略画像 + 匹配度评分"快照.
 * 由 PersonalityStrategyMatcher.matchForUser (US-127 同 story) 生成,
 * 后续 MONTHLY_PERSONALITY_MATCH cron (EV-011 / 后续 story) 每月 1 号 09:00 触发.
 *
 * **(user_id, period_end) 业务唯一**:
 *   - 与 [[ErrorPatternReport]] / [[AIDiaryEntry]] / [[ImprovementSuggestion]] 同款
 *     (user_id, period_end) UNIQUE 索引 + service upsert 走 ON CONFLICT.
 *   - "每月 1 号 09:00" 语义下 period_end 月度仅一行, idempotent.
 *   - 历史保留靠 created_at / updated_at + 不同 period_end 的多行.
 *
 * **JSONB personality 字段** —— 用户性格画像 (从近 lookback_days 的 trade/holding 反推):
 *   - preferred_industries[]  — 按交易额加权 top N 行业
 *     { industry: string, share: number }   // share 0..1
 *   - risk_tolerance          — 'low' | 'medium' | 'high' (从持仓 vol 推断)
 *   - trade_frequency         — 'low' | 'medium' | 'high' (近 N 天日均 trade 次数)
 *   - holding_period          — 'short' | 'medium' | 'long' (平均持有天数分档)
 *   - avg_hold_days           — 数值 (持仓平均持有天数)
 *   - estimated_volatility    — 数值 (近 lookback_days 日 pnl 标准差, 百分点)
 *
 * **JSONB strategies 字段** —— 当前 active 策略列表 + 每个策略画像:
 *   - items[]: {
 *       strategy_key: string,
 *       strategy_name: string,
 *       weight: number,
 *       industries_focus: string[],    // 策略主打行业 (从 tags / category 推断, 缺则空)
 *       expected_vol: 'low'|'medium'|'high',
 *       turnover_class: 'low'|'medium'|'high',
 *       hold_class: 'short'|'medium'|'long',
 *       quality_score: number | null,
 *       match_score: number,           // 0..100 单策略 vs 用户画像
 *       match_reasons: string[]        // ≤ 3 条 (匹配/失配点)
 *     }
 *
 * **JSONB matches 字段** —— 顶层匹配度评分 + 建议:
 *   - overall_score: number    // 0..100 (加权平均, 权重 = strategy.weight)
 *   - best_match: { strategy_key, score } | null
 *   - worst_match: { strategy_key, score } | null
 *   - suggestions: Array<{ severity: 'low'|'medium'|'high',
 *                          category: 'add'|'reduce'|'remove'|'tune',
 *                          strategy_key: string | null,
 *                          text: string }>  // PRD AC: 至少 1 条
 *
 * **summary 字段** —— ≤ 500 字 heuristic 文本 (与 [[ErrorPatternReport.summary]] / [[AIDiaryEntry.text]]
 * 同款 cap, 默认 heuristic):
 *   - "您是低频价值型 (持仓中位 12 天, 偏好白酒+消费), 但 60% 资金跑 CTA100 (日频动量),
 *      匹配度 32%, 建议: 关 CTA100, 加 HighDividendValue."
 *
 * **status 字段反映生成状态** (与 [[ErrorPatternReport.status]] 同款 fail-OPEN 三态):
 *   - 'ok'       — 正常生成 (含真实 score 或经 heuristic fallback 也算合规)
 *   - 'skipped'  — 数据太稀疏 (近 lookback_days 无 trade / 无 active 策略)
 *   - 'failed'   — 计算异常 (matcher throw, 上层 cron 仍尝试落留痕)
 *
 * **与既有 model 的边界**:
 *   - [[ErrorPatternReport]] (PM-021) = per-user per-90-day 错误模式 (bias/outcome/attribution)
 *   - [[ImprovementSuggestion]] (PM-023) = per-user per-period per-category 单条改进建议
 *     (本表 matches.suggestions 是匹配维度的轻量建议, 不替代; 后续 PM-027 可把
 *      matches.suggestions 倒灌入 ImprovementSuggestion 表)
 *   - [[PaperTradingTrade]] / [[PaperTradingPosition]] = 真实持仓/交易 (本表的输入)
 *   - [[QuantStrategyModel]] / [[QuantStrategyWeight]] = 策略 + 当前权重 (本表的输入)
 *   - 本表 = per-user per-month 性格 ⇄ 策略匹配快照
 *
 * 主要消费方:
 *   - EV-011 MONTHLY_PERSONALITY_MATCH cron 每月 1 号 09:00 upsert (后续 story 接入)
 *   - EV-014 前端 /review/diary tab 性格匹配卡片 (后续接入)
 *   - PM-023 ImprovementSuggestionService 后续可读最近一行作 prompt 上下文 / 倒灌建议
 */
@Table({
  tableName: 'personality_strategy_match_reports',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['user_id', 'period_end'],
      unique: true,
      name: 'personality_strategy_match_reports_user_period_uniq',
    },
    { fields: ['user_id'] },
    { fields: ['period_end'] },
    { fields: ['status'] },
    { fields: ['generated_at'] },
  ],
})
export class PersonalityStrategyMatchReport extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: '所属用户 ID (一对一匹配 = 一个 user 一个 period 一行)',
  })
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_start',
    comment: '画像窗口起点 (YYYY-MM-DD; 默认 period_end - lookback_days)',
  })
  declare period_start: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_end',
    comment: '画像窗口终点 (YYYY-MM-DD; cron 每月 1 号跑时 = 本月 1 号; 业务键)',
  })
  declare period_end: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'lookback_days',
    defaultValue: 90,
    comment: '画像窗口天数 (默认 90; ops 可调)',
  })
  declare lookback_days: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'personality',
    defaultValue: {},
    comment:
      '用户性格画像 (preferred_industries[] / risk_tolerance / trade_frequency / holding_period / avg_hold_days / estimated_volatility)',
  })
  declare personality: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'strategies',
    defaultValue: {},
    comment:
      '当前 active 策略 + 每策略画像 + 单策略 match_score (items[]: strategy_key, weight, industries_focus[], expected_vol, turnover_class, hold_class, quality_score, match_score, match_reasons[])',
  })
  declare strategies: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'matches',
    defaultValue: {},
    comment: '匹配度评分 + 建议 (overall_score 0..100 / best_match / worst_match / suggestions[])',
  })
  declare matches: Record<string, unknown>;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'summary',
    defaultValue: '',
    comment: '≤ 500 字 heuristic 摘要 (本 story 仅 heuristic; cap 由 service 守, model 不校验)',
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
    comment: '生成状态: ok / skipped / failed (与 [[ErrorPatternReport.status]] 对齐, fail-OPEN)',
  })
  declare status: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: true,
    field: 'reason',
    comment:
      'skipped / failed 时的简短原因 (e.g. no_trades / no_active_strategies / matcher_threw / load_threw)',
  })
  declare reason: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata',
    defaultValue: {},
    comment:
      '调用 metadata (cron_run_id / lookback_days / data_sources_used[] / trade_count / strategy_count / errors[])',
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
