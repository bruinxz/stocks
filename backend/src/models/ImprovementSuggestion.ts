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
 * ImprovementSuggestion — L8-Postmortem / US-094 [PM-023] 改进建议落表
 *
 * 一行 = 单个用户 + 一条改进建议 (来源: 90 天 ErrorPatternReport.top_findings /
 * bias / outcome / attribution patterns 各自展开为 actionable suggestion).
 *
 * 数据生产路径:
 *   - PM-023 ImprovementSuggestionService.generateForUser(user_id, {date, ...}) 主入口
 *     → 读最近 1 行 ErrorPatternReport (status=ok) → 把 bias / outcome / attribution
 *       / top_findings 各路转成 ImprovementSuggestion 行 → bulkUpsert
 *   - 后续 PM-024 (US-188) ImprovementSuggestion apply route 给前端
 *     POST /api/me/improvement-suggestions/:id/apply (本 story 不接, 仅落表 + service)
 *
 * **(user_id, period_end, category, key) 业务唯一**:
 *   - PRD US-094 AC: bias / pattern / factor 汇集 → 落表; 必须 idempotent
 *     (cron 周一重跑 / 手动 replay 走 ON CONFLICT 覆盖最新).
 *   - 单一用户在同一 period_end 的"chase_high bias"建议只该有一行, 多次跑覆盖.
 *   - 历史保留靠 created_at / updated_at + 不同 period_end 的多行.
 *
 * **category 三类枚举** (与 ErrorPatternReport.patterns 三类对齐):
 *   - 'bias'        — 来源 bias_patterns[] (e.g. category=bias, key=chase_high)
 *   - 'outcome'     — 来源 outcome_patterns[] (e.g. category=outcome, key=loss_trade)
 *   - 'attribution' — 来源 attribution_patterns[] 负贡献维度 (e.g. dimension=execution_cost)
 *   - 'top'         — 来源 top_findings[] 高优先级 (合并 bias/outcome/attribution top N)
 *
 * **key 字段语义** — 唯一标识同 category 下不同建议来源:
 *   - bias        → bias_type (e.g. 'chase_high', 'sunk_cost', 'fomo')
 *   - outcome     → outcome_type (e.g. 'loss_trade', 'stop_loss_too_late')
 *   - attribution → dimension (e.g. 'execution_cost', 'industry', 'timing')
 *   - top         → 同上但带 prefix (e.g. 'bias:chase_high', 'attribution:industry')
 *
 * **priority 数字** (0..100, 高 = 优先):
 *   - 来源于 ErrorPatternReport.patterns 排序位置 + score (count*severity / |loss| / |contrib|)
 *   - top_findings 第一条 = 100; 其余按 score 归一化
 *   - 给前端 SettingsWorkspace 待办建议 tab 排序用
 *
 * **status 字段四态**:
 *   - 'open'        — 已生成, 用户未处理 (默认; 显示在前端待办列表顶)
 *   - 'applied'     — 用户已 apply (PM-024 apply route 标记)
 *   - 'dismissed'   — 用户标记忽略 (snooze / 关闭)
 *   - 'expired'     — 下次 cron 跑时上一周期未处理 → 自动过期 (本 story 不接, 留枚举)
 *
 * **title / body 文案** (heuristic 生成):
 *   - title ≤ 60 字  — 一行摘要 ("近 90 天 chase_high 偏差命中 12 次, 趋势上升")
 *   - body  ≤ 500 字 — 具体建议 ("建议: ① 入场前强制查 RSI > 70 限速; ②
 *                       worst 案例 600519 / 000725 复盘.")
 *   - source = 'heuristic' (LLM 路径留给后续 story, 同 ErrorPatternReport 范式)
 *
 * **evidence JSONB** — 给"建议可解释 / 可回溯"的 snapshot:
 *   - error_pattern_report_id   — 引用 ErrorPatternReport.id
 *   - period_start / period_end — 冗余 (便于 UI 直接 read 不 JOIN)
 *   - sample_items[]            — 命中 trades / examples 数组 (≤ 3)
 *   - metric                    — 数字指标 (e.g. count=12, total_loss=-3200)
 *
 * **action 字段** (可选 JSONB) — 给 PM-024 apply route 消费的可执行参数:
 *   - type: 'tune_risk_param' | 'enable_kill_switch' | 'open_workspace_tab' | 'noop'
 *   - payload: { ... } — apply route 透传给目标 module
 *   - 本 story 默认 {type:'noop'} (apply 仅标 status; PM-024 后续接入实际动作)
 *
 * **status 字段反映落表后用户行为** (与 RiskAlert / AlertItem 同款 lifecycle):
 *   - generated_at = service 跑的瞬间
 *   - applied_at / dismissed_at 由 apply route (PM-024) 写
 *
 * **与既有 model 边界**:
 *   - ErrorPatternReport (PM-021) = per-user-per-window 的 patterns 聚合 (上游)
 *   - 本表 = per-user-per-period-per-suggestion 的可操作建议 (展开后)
 *   - RiskAlert / AlertItem = 实时风险告警 (与建议正交; 后者非诊断性)
 *
 * 主要消费方:
 *   - PM-024 apply route (US-188): POST /api/me/improvement-suggestions/:id/apply
 *   - 前端 SettingsWorkspace 待办建议 tab (US-068, 当前接 alerts; 后续接本表)
 *   - 飞书 push (与 PM-009 同款 dispatcher, 后续 story 接入)
 */
@Table({
  tableName: 'improvement_suggestions',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['user_id', 'period_end', 'category', 'key'],
      unique: true,
      name: 'improvement_suggestions_user_period_cat_key_uniq',
    },
    { fields: ['user_id'] },
    { fields: ['period_end'] },
    { fields: ['category'] },
    { fields: ['status'] },
    { fields: ['priority'] },
    { fields: ['generated_at'] },
    // US-146 PM-027 — tracker cron 按 (status='applied', effect_tracked_at IS NULL) 高频查
    { fields: ['status', 'effect_tracked_at'], name: 'idx_improvement_suggestions_status_tracked' },
  ],
})
export class ImprovementSuggestion extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: '所属用户 ID',
  })
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_start',
    comment: '建议依据的窗口起点 (来自 ErrorPatternReport.period_start; 冗余便于 read)',
  })
  declare period_start: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'period_end',
    comment: '建议依据的窗口终点 (业务键; 来自 ErrorPatternReport.period_end)',
  })
  declare period_end: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'category',
    comment: '建议分类: bias / outcome / attribution / top',
  })
  declare category: string;

  @Column({
    type: DataType.STRING(80),
    allowNull: false,
    field: 'key',
    comment:
      '同 category 下唯一标识 (bias_type / outcome_type / dimension / "bias:xx" 等); (user, period_end, category, key) UNIQUE',
  })
  declare key: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: false,
    field: 'title',
    defaultValue: '',
    comment: '一行摘要 (≤ 60 字; cap 由 service 守, model 不校验)',
  })
  declare title: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'body',
    defaultValue: '',
    comment: '具体改进建议 (≤ 500 字; cap 由 service 守, model 不校验)',
  })
  declare body: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'priority',
    defaultValue: 0,
    comment: '优先级 0..100, 高 = 优先; 来自 patterns 排序位置 / score 归一化',
  })
  declare priority: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'evidence',
    defaultValue: {},
    comment:
      '证据 snapshot (error_pattern_report_id / period_start / period_end / sample_items / metric)',
  })
  declare evidence: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'action',
    defaultValue: { type: 'noop' },
    comment:
      'apply 路径可执行参数 ({type: noop | tune_risk_param | enable_kill_switch | open_workspace_tab, payload}); 本 story 默认 noop',
  })
  declare action: Record<string, unknown>;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'source',
    defaultValue: 'heuristic',
    comment: '生成来源: heuristic / llm / manual (本 story 仅 heuristic)',
  })
  declare source: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    field: 'status',
    defaultValue: 'open',
    comment: '生命周期: open / applied / dismissed / expired',
  })
  declare status: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata',
    defaultValue: {},
    comment:
      '调用 metadata (cron_run_id / error_pattern_report_generated_at / heuristic_engine 等)',
  })
  declare metadata: Record<string, unknown>;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'generated_at',
    comment: '建议生成时间戳 (落库瞬间; cron 重跑覆盖)',
  })
  declare generated_at: Date;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'applied_at',
    comment: 'apply route (PM-024) 标记时间戳; 默认 null',
  })
  declare applied_at: Date | null;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'dismissed_at',
    comment: 'dismiss 时间戳; 默认 null',
  })
  declare dismissed_at: Date | null;

  // ─── US-146 PM-027 apply 后效果跟踪 ────────────────────────────────────────
  //
  // tracker (ImprovementEffectTracker) 在 apply 满 effect_window_days (默认 30) 天后,
  // 采集该用户 PaperTradingPortfolio DailyAttributionReport 期间 pnl / pnl_pct / sharpe /
  // 样本天数, 写回本字段; UI 展示 "建议 apply 后实际效果", ops 用以评估 heuristic 质量.
  //
  // effect_metrics JSONB schema (与 ImprovementEffectMetrics 类型对齐):
  //   { window_days, sample_days, total_pnl_sum, total_pnl_pct_avg,
  //     total_pnl_pct_sharpe, trade_count_sum, start_date, end_date,
  //     portfolios_covered, source }
  // 未跟踪态 = {} (default), tracker 跑完后填齐.

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'effect_metrics',
    defaultValue: {},
    comment:
      'US-146 PM-027 apply 后效果指标 (window_days / sample_days / total_pnl_sum / total_pnl_pct_avg / sharpe / etc); 默认 {} = 未跟踪',
  })
  declare effect_metrics: Record<string, unknown>;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'effect_tracked_at',
    comment: 'US-146 PM-027 tracker 写入时间戳; NULL = 未跑过',
  })
  declare effect_tracked_at: Date | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
