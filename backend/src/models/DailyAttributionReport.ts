import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * DailyAttributionReport — L8-Postmortem / US-080 [PM-003] 每日归因报告落库
 *
 * 一行 = 单个 portfolio + 一个交易日 的 6 维归因报告.
 * 由 DailyAttributionService.generateDailyReport (US-078 / PM-001) 生成,
 * 经 AttributionEngine (US-079 / PM-002) 填 Brinson-Fachler 真值, 最终
 * 由 DAILY_ATTRIBUTION_GENERATE cron (PM-006) 在 17:00 工作日触发持久化.
 *
 * **(date, portfolio_id) 业务唯一**:
 *   - PRD US-080 AC: 字段含 (date, portfolio_id, breakdown JSONB, ai_summary TEXT).
 *   - 当日重跑 (e.g. 数据迟到 / 手动触发) 走 idempotent upsert 覆盖最新结果.
 *   - 历史保留靠 created_at / updated_at 时间戳, 不依赖多版本行.
 *
 * **JSONB 字段对应 DailyAttributionService 主入口 buildDailyAttributionReport 输出**:
 *   - `breakdown`        — DailyAttributionBreakdown (6 维 + industry top + factor top)
 *   - `best_trades`      — top 3 winners (BestWorstTradeSummary[])
 *   - `worst_trades`     — top 3 losers
 *   - `bias_findings`    — PM-008 BehaviorBiasDetector 增量产物 (本 story 先 [] 占位)
 *   - `recommendations`  — PM-005 + PM-008 文本建议数组
 *   - `metadata`         — 调用 metadata (data_source / engine_input 是否传入 / cron_run_id 等)
 *
 * **AC §E.2 不变量 (容差 ±5%)**:
 *   sum(breakdown.industry_contrib.pnl) + breakdown.selection_contrib +
 *   breakdown.timing_contrib + breakdown.sizing_contrib +
 *   breakdown.factor_contrib_total + breakdown.execution_cost +
 *   breakdown.residual ≈ total_pnl.
 *   service 端保证, 本 model 仅落库不再校验.
 *
 * **status 字段反映 DailyAttributionRunResult**:
 *   - `ok`       — 正常生成 (含 6 维真值 / placeholder)
 *   - `skipped`  — snapshot 不足等业务跳过 (cron 仍写一行做"今日未跑"留痕)
 *   - `failed`   — 计算异常 (fail-OPEN 落库错误原因, 不阻塞下次 cron)
 *
 * **strategy_key 与 BenchmarkAttributionResult / IndustryAttributionResult 的差异**:
 *   - 二者 = 一次回测 vs 基准 / 行业, key=(run_id, ...).
 *   - 本表 = 一个 portfolio 一天 的实盘归因, key=(portfolio_id, date).
 *   - 没有 strategy_key 物化字段, 因为 portfolio 可同时跑多策略, 归因覆盖整账户.
 *
 * 主要消费方:
 *   - DailyAttributionService.persistReport (PM-003 同 story 内可选挂接口)
 *   - DAILY_ATTRIBUTION_GENERATE cron (PM-006)
 *   - GET /api/portfolio/:id/attribution/daily (PM-007 route)
 *   - 飞书 push (PM-009)
 *   - 前端 PortfolioWorkspace /review tab (US-055 已上, 接口待 PM-007)
 */
@Table({
  tableName: 'daily_attribution_reports',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['portfolio_id', 'date'],
      unique: true,
      name: 'daily_attribution_reports_portfolio_date_uniq',
    },
    { fields: ['portfolio_id'] },
    { fields: ['date'] },
    { fields: ['status'] },
    { fields: ['generated_at'] },
  ],
})
export class DailyAttributionReport extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'portfolio_id',
    comment: '关联 PaperTradingPortfolio.id (或 LiveBrokerAccount.id, 取归因主账户)',
  })
  declare portfolio_id: number;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'date',
    comment: '归因目标交易日 (YYYY-MM-DD, Asia/Shanghai)',
  })
  declare date: string;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    field: 'total_pnl',
    defaultValue: 0,
    comment: '当日总盈亏 (元; = 当日 EOD total_value - 前一交易日 EOD total_value)',
  })
  declare total_pnl: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'total_pnl_pct',
    comment: '当日盈亏百分比 (= total_pnl / prev_total_value × 100; null 表示 prev_total<=0)',
  })
  declare total_pnl_pct: number | null;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    field: 'realized_pnl',
    defaultValue: 0,
    comment: '当日已实现盈亏 (Σ SELL.realized_pnl)',
  })
  declare realized_pnl: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    field: 'unrealized_delta',
    defaultValue: 0,
    comment: '当日未实现盈亏变动 (= total_pnl - realized_pnl)',
  })
  declare unrealized_delta: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'trade_count',
    defaultValue: 0,
    comment: '当日成交笔数 (BUY + SELL)',
  })
  declare trade_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'buy_count',
    defaultValue: 0,
    comment: '当日 BUY 笔数',
  })
  declare buy_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'sell_count',
    defaultValue: 0,
    comment: '当日 SELL 笔数',
  })
  declare sell_count: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    comment:
      '6 维归因拆解 (factor / industry / timing / selection / sizing / execution_cost / residual + factor_contrib_total + factor_contrib[] + industry_contrib[])',
  })
  declare breakdown: Record<string, unknown>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'best_trades',
    defaultValue: [],
    comment: '当日盈利 top N 笔交易 (BestWorstTradeSummary[]; 默认 3)',
  })
  declare best_trades: Array<Record<string, unknown>>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'worst_trades',
    defaultValue: [],
    comment: '当日亏损 top N 笔交易 (BestWorstTradeSummary[]; 默认 3)',
  })
  declare worst_trades: Array<Record<string, unknown>>;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'ai_summary',
    defaultValue: '',
    comment: 'AI / heuristic 摘要 (≤ 200 字; PM-005 替换成 LLM, 当前 heuristicSummary 静态拼接)',
  })
  declare ai_summary: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'bias_findings',
    defaultValue: [],
    comment: '行为偏差告警数组 (PM-008 BehaviorBiasDetector.detectIncremental 填; 本 story 先空)',
  })
  declare bias_findings: Array<Record<string, unknown>>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    comment: '明日改进建议 (字符串数组; PM-005 / PM-008 填; 本 story 先空)',
  })
  declare recommendations: string[];

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'ok',
    comment: '生成状态: ok / skipped / failed (与 DAILY_ATTRIBUTION_STATUS 对齐)',
  })
  declare status: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: true,
    comment: 'skipped / failed 时的原因 (e.g. no_prev_snapshot / db_error)',
  })
  declare reason: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    comment:
      '调用 metadata (data_source / engine_input 是否传入 / cron_run_id / heuristic vs llm summary 来源等)',
  })
  declare metadata: Record<string, unknown>;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'generated_at',
    comment: '报告生成时间戳 (落库瞬间)',
  })
  declare generated_at: Date;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'daily_attribution_service',
    comment: '产出来源 (daily_attribution_service / cron / manual_replay)',
  })
  declare source: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
