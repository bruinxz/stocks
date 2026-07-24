import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * AIStockAnalysisReport — US-055
 *
 * **单股深度分析报告** — 由 `AIAdvisorService.analyzeSingleStock(stockCode, options)`
 * 生成并持久化。一行 = 一份完整的多维度 AI 解读（一只股票一次 fan-out 分析）。
 *
 * 与 `AIInvestmentSignal` (US-019..US-024 / US-040) 的关键差异：
 *   - `AIInvestmentSignal` 是 *决策信号*（BUY/SELL/HOLD），下游做后验收益验证；
 *   - `AIStockAnalysisReport` 是 *研究解读快照*（覆盖 fundamental/technical/capital/
 *     news/sentiment 5 大维度），下游做 UI 展示 / 历史回查 / KOL 对比；
 *   - 同一只股票一天内可以有多份 report（用户主动触发 → 5 次 click = 5 行），
 *     不像 signal 走 (source_type, source_id) UNIQUE upsert。
 *
 * AC 关键字段（PRD US-055）：
 *   - `report_id`        — 业务级唯一 ID（含 stock_code + 时间戳 + 随机后缀，
 *                          可被 UI 引用 / 推送 / 离线导出）；
 *   - `stock_code`       — 已规范化的股票代码（normalizeSymbol 输出："sh.600519" 等）；
 *   - `dimensions`       — 已分析的维度数组（dimensions: ['fundamental','technical',
 *                          'capital','news','sentiment']）；
 *   - `summary`          — 中文一段 markdown 摘要（前端 Modal 顶部显示）；
 *   - `recommendation`   — 标准化建议（强烈买入 / 买入 / 中性 / 减持 / 卖出 / 未知）；
 *   - `key_points_json`  — 各维度 key point 列表（{ fundamental: [...], technical: [...] }）；
 *   - `generated_at`     — 报告生成时间戳（UTC）。
 *
 * 设计取舍：
 *   - **PK = `id` autoIncrement + `report_id` UNIQUE 业务索引** —— 同款"系统主键 + 业务标识"
 *     双层模式（与 QuantBacktestTask / TaskParameterAuditLog 一致）；
 *   - **dimensions / key_points_json / metadata 全 JSONB** —— 各维度数据结构动态扩展
 *     不破坏 schema；Postgres JSONB 走 GIN 索引 by-dimension 查询日后再加；
 *   - **status 字段反映异步任务**：`completed` / `partial`（部分维度失败）/
 *     `failed`（整体失败）/ `pending`（仍在 SSE 中累积，尚未落库 final）；
 *   - **recommendation 用 string** 不用 enum —— 与 `AIInvestmentSignal.normalized_decision`
 *     字段一致，避免 schema 迁移成本（中文文案变 / 增加 "波段持有" 等中间态）。
 *
 * 消费方：
 *   - GET /api/ai/analyze-stock/reports/:report_id — UI 反查历史报告；
 *   - 未来 US-067 KOL 观点对比 / US-082 周报可拉历史 reports 做趋势可视化；
 *   - 前端 PortfolioWorkspace + FactorWorkspace 的 "AI 解读" Modal 直接消费 latest report。
 */
@Table({
  tableName: 'ai_stock_analysis_reports',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['report_id'], unique: true, name: 'ai_stock_analysis_reports_report_id_uniq' },
    { fields: ['stock_code'] },
    { fields: ['stock_code', 'generated_at'] },
    { fields: ['recommendation'] },
    { fields: ['status'] },
    { fields: ['user_id'] },
    {
      fields: ['task_id', 'user_id'],
      name: 'ai_stock_analysis_reports_task_user_idx',
    },
    { fields: ['engine_variant'] },
    { fields: ['shadow_of_report_id'] },
  ],
})
export class AIStockAnalysisReport extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'report_id',
    comment: '业务级唯一报告 ID（含 stock_code + 时间戳 + 随机后缀）',
  })
  declare report_id: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'user_id',
    comment: '触发用户 ID（匿名 / 系统触发可为 null）',
  })
  declare user_id: number | null;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    field: 'stock_code',
    comment: '已规范化的股票代码（如 sh.600519 / sz.000001）',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票名称（report 落库时已知则 snapshot；可空）',
  })
  declare stock_name: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    comment:
      '请求分析的维度数组（fundamental/technical/capital/news/sentiment 子集，按调用顺序排列）',
  })
  declare dimensions: string[];

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '中文一段 markdown 摘要（前端 Modal 顶部显示）',
  })
  declare summary: string | null;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'unknown',
    comment: '标准化建议：strong_buy / buy / hold / sell / strong_sell / unknown',
  })
  declare recommendation: string;

  @Column({
    type: DataType.DECIMAL(8, 2),
    allowNull: true,
    field: 'confidence_score',
    comment: '综合置信分 0-100（TradingAgents 返回时落库，无则 null）',
  })
  declare confidence_score: number | null;

  @Column({
    type: DataType.STRING(30),
    allowNull: true,
    field: 'risk_level',
    comment: '风险等级（低 / 中 / 高 / unknown）',
  })
  declare risk_level: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'key_points_json',
    comment: '各维度核心要点 { fundamental: [...], technical: [...] } 等',
  })
  declare key_points_json: Record<string, unknown>;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'completed',
    comment: 'completed / partial / failed / pending',
  })
  declare status: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'task_id',
    comment: 'TradingAgents 异步任务 ID（同步分析时可为 null）',
  })
  declare task_id: string | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'target_date',
    comment: '目标分析日期（YYYY-MM-DD；为空时使用当日）',
  })
  declare target_date: string | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '执行失败时的错误描述（status=failed/partial 时使用）',
  })
  declare error: string | null;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'generated_at',
    comment: '报告生成时间戳（落库瞬间）',
  })
  declare generated_at: Date;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    comment: '原始 TradingAgents payload + 调用参数 metadata',
  })
  declare metadata: Record<string, unknown>;

  /**
   * GAMMA 2026-06-18 — analysis-engine v1 shadow mode 字段.
   *
   * `engine_variant`:
   *   - 'tradingagents_legacy' (默认) = 现有 AIAdvisorService.analyzeSingleStock prod 路径
   *   - 'multi_dim_v1' = analysis-engine 新引擎 (shadow / hard 阶段)
   *
   * `shadow_of_report_id`:
   *   - 当 engine_variant='multi_dim_v1' 时, 引用其 shadow 对应的 prod report_id
   *     (= AIStockAnalysisReport.report_id), 用于 dashboard 一致率统计 / forward returns join.
   *   - 'tradingagents_legacy' 路径写 null.
   */
  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'tradingagents_legacy',
    field: 'engine_variant',
    comment: '产生本报告的分析引擎: tradingagents_legacy | multi_dim_v1',
  })
  declare engine_variant: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'shadow_of_report_id',
    comment: 'shadow mode 时引用其 prod report_id, 用于一致率/收益对比',
  })
  declare shadow_of_report_id: string | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
