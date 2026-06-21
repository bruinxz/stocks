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
 * AIDiaryEntry — L8-Postmortem / US-089 [PM-018] AI 投资日记落库
 *
 * 一行 = 单个用户 + 一个交易日 的 AI 生成投资日记 (≤ 500 字).
 *
 * 数据生产路径 (PM-019 / PM-020 将于后续 story 接入):
 *   - PM-019 AIDiaryService.generateForUser(user_id, date) 主入口
 *     → LLM (TradingAgents / OpenAI) 主路径 + heuristic fallback
 *   - PM-020 AI_DIARY_GENERATE cron 每日 18:00 工作日触发
 *     → 对所有 active user 调 generateForUser → upsert 本表
 *
 * **(user_id, date) 业务唯一**:
 *   - PRD US-089 AC: 字段含 (user_id, date, text, evidence JSONB).
 *   - 当日重跑 (LLM 失败 + heuristic 补 / 手动重发 / ops replay) 走 idempotent
 *     upsert 覆盖最新结果. 历史保留靠 created_at / updated_at 时间戳.
 *
 * **JSONB evidence 字段** —— 给"日记可解释 / 可回溯"的关键证据 snapshot:
 *   - daily_attribution_report_id  — 关联当日 DailyAttributionReport.id (引用而非内嵌, 避免冗余)
 *   - total_pnl / total_pnl_pct    — 当日盈亏数字 (LLM 引用时直接展示)
 *   - bias_findings_count          — 当日 BehaviorBias 命中条数 (PM-008 接入后填)
 *   - best_trades_codes            — 当日盈利 top N 股票 code 数组 (≤ 3)
 *   - worst_trades_codes           — 当日亏损 top N 股票 code 数组 (≤ 3)
 *   - factor_review_id             — 关联当日 FactorReview (PM-010 后续接入)
 *   - data_sources                 — 字符串数组, e.g. ['attribution', 'bias', 'sentiment']
 *
 * **text ≤ 500 字 cap (PRD US-090 AC)**:
 *   - DataType.TEXT 不强制长度 (model 层只落库), cap 由 AIDiaryService
 *     主入口 enforceXxxConstraints + heuristic fallback 三层守约
 *     (与 [[AI_VIEW_MAX_CHARS 5 件套]] / DailyAttribution AI summary 同款思想).
 *   - 默认值 '' 让"未跑过 service" 时也能 INSERT 不破坏 NOT NULL.
 *
 * **source 字段三态**:
 *   - 'llm'         — LLM 主路径生成 (TradingAgents / OpenAI 返值通过 enforce 校验)
 *   - 'heuristic'   — 启发式 fallback (LLM 失败 / 超时 / 不达标契约)
 *   - 'manual'      — admin 手动 replay / 编辑覆盖 (留痕)
 *
 * **status 字段反映生成状态** (与 DailyAttributionReport 同款 fail-OPEN 范式):
 *   - 'ok'       — 正常生成 (LLM 或 heuristic 都算成功)
 *   - 'skipped'  — 前提缺数据 (e.g. 当日无 attribution / 用户 0 持仓 / 非交易日)
 *   - 'failed'   — 计算异常 (LLM 抛错 + heuristic 也抛错, 极少发生)
 *
 * **与 BenchmarkAttributionResult / IndustryAttributionResult / DailyAttributionReport 差异**:
 *   - 二者 = per-portfolio per-date 的策略归因 (账户级)
 *   - 本表 = per-user per-date 的"投资者认知" (人本身的反思 / 总结)
 *   - 一对一关系: 一个 user 一天一行, 多 portfolio 时 evidence.daily_attribution_report_id
 *     取主账户 (用户 active portfolio) 即可, 不强制全跑.
 *
 * 主要消费方 (后续 story 接入):
 *   - PM-019 AIDiaryService.generateForUser → upsert
 *   - PM-020 AI_DIARY_GENERATE cron
 *   - EV-014 GET /api/me/diary/recent (取最近 N 天日记)
 *   - 前端 PortfolioWorkspace /review/diary tab (日历 view)
 *   - 飞书 push (PM-009 同款 dispatcher 范式, 当前 story 不接)
 */
@Table({
  tableName: 'ai_diary_entries',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['user_id', 'date'],
      unique: true,
      name: 'ai_diary_entries_user_date_uniq',
    },
    { fields: ['user_id'] },
    { fields: ['date'] },
    { fields: ['status'] },
    { fields: ['source'] },
    { fields: ['generated_at'] },
  ],
})
export class AIDiaryEntry extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: '所属用户 ID (一对一日记 = 一个 user 一天一条)',
  })
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'date',
    comment: '日记目标交易日 (YYYY-MM-DD, Asia/Shanghai)',
  })
  declare date: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'text',
    defaultValue: '',
    comment:
      'AI 生成的日记正文 (≤ 500 字; cap 由 AIDiaryService enforceXxxConstraints 守, model 层不校验)',
  })
  declare text: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'evidence',
    defaultValue: {},
    comment:
      '证据 snapshot (daily_attribution_report_id / total_pnl / bias_findings_count / best_trades_codes / worst_trades_codes / factor_review_id / data_sources[])',
  })
  declare evidence: Record<string, unknown>;

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
      'skipped / failed 时的原因 (e.g. no_attribution_today / llm_timeout / heuristic_failed)',
  })
  declare reason: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'metadata',
    defaultValue: {},
    comment:
      '调用 metadata (llm_engine / llm_latency_ms / prompt_version / cron_run_id / heuristic_fallback_reason 等)',
  })
  declare metadata: Record<string, unknown>;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'generated_at',
    comment: '日记生成时间戳 (落库瞬间)',
  })
  declare generated_at: Date;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
