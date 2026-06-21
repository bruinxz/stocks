import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * EastMoneyQAStat — US-038 QA-002 投资者问答按 (stock, week) 维度聚合.
 *
 * 一行 = `(stock_code, week_start)` 的一条按周聚合的散户问答统计:
 *   "某只股票本周 (周一起算) 全部问答的次数 / 回答率 / 主导主题 / 模板话术含量"。
 *
 * 与 EastMoneyQATopic 的关系 (互补, 不重复):
 *   - EastMoneyQATopic: N rows per (stock, week) — 一行一个 topic (财务/订单/...);
 *   - EastMoneyQAStat:  1 row per (stock, week)  — 整周聚合后的"汇总指标".
 *
 * 数据源: 沿用 EastMoneyQATopic 上游, AKShare `stock_irm_cninfo(symbol)`
 *   巨潮资讯-互动易-投资者问答 (StockQAClient.fetchForStock).
 *
 * **6 个核心指标** (与 docs/trader-system/83_ai_qa_topic.md §B.2 对齐):
 *
 *   - questions_count        — 当周该股全部提问数 (含未答)
 *   - answer_count           — 当周该股已被公司回答的提问数 (answer 非空非空白)
 *   - answer_rate            — answer_count / questions_count ∈ [0, 1]
 *   - top_subtopic           — 当周最高 mention 的 subcategory
 *                              (classifySubtopic 输出, 26 类 + other_general 兜底)
 *   - avg_question_sentiment — 当周提问情绪均值 ∈ [-1, +1] (scoreSentiment)
 *   - avg_answer_sentiment   — 当周非空回答情绪均值 ∈ [-1, +1]; NULL = 当周无回答
 *   - answer_template_score  — 当周非空回答的 detectTemplateAnswer 输出均值 ∈ [0, 1];
 *                              1 = 纯模板话术 ("感谢关注/详见公告/投资有风险"...),
 *                              0 = 高质量实质回答; NULL = 当周无回答
 *
 * **典型业务用法** (docs §B.2 leading-signal 模板):
 *   - questions_growth_pct > 200% AND answer_rate > 50%  → "公司主动 + 散户关注" → bullish
 *   - questions_growth_pct > 200% AND answer_rate < 10%  → "散户关注但公司回避" → bearish
 *   - top_subtopic='earnings_forecast' AND answer_template_score < 0.3 → 业绩预增 leading signal
 *
 * **默认值 (fail-safe — 未跑过 aggregator 的安全态)**:
 *   - questions_count / answer_count 默认 0 (NOT NULL);
 *   - answer_rate / avg_question_sentiment 默认 0 (DECIMAL);
 *   - top_subtopic 默认 'other_general' (TOPIC_SUBCATEGORIES.OTHER_GENERAL — 无 actionable 含义,
 *     不会触发 leading signal 误报);
 *   - avg_answer_sentiment / answer_template_score 默认 NULL — 这是 "当周无任何回答"
 *     的合法语义状态, 与 "回答情绪 0 分" 严格区分; 任何 downstream 比较前必须显式
 *     null-check 而非直接 ≤ 阈值 (否则 NULL=0 错以为是中性回答).
 *
 * **主键与 UNIQUE**:
 *   - PK: id autoIncrement;
 *   - UNIQUE (stock_code, week_start) — 防重复同步, 同一只股票同一周一行;
 *     bulkCreate updateOnDuplicate 可直接刷新.
 *
 * 字段说明:
 *   stock_code              6 位股票代码 (无前缀, 与 EastMoneyQATopic 一致)
 *   stock_name              股票简称 (聚合时点, 便于 UI 展示无需 JOIN)
 *   week_start              该周周一 ISO 日期 (YYYY-MM-DD)
 *   questions_count         整数, ≥ 0
 *   answer_count            整数, ≥ 0
 *   answer_rate             ∈ [0, 1] 3 位小数
 *   top_subtopic            SubtopicCategory string (含 other_general 兜底)
 *   avg_question_sentiment  ∈ [-1, +1] 3 位小数
 *   avg_answer_sentiment    ∈ [-1, +1] 3 位小数 或 NULL
 *   answer_template_score   ∈ [0, 1] 3 位小数 或 NULL
 *   nlp_engine              NLP 引擎标签 (heuristic_fallback / trading_agents / openai)
 *   raw_payload             审计辅助 (subtopic_distribution / template_hits_sample / ...)
 */
@Table({
  tableName: 'east_money_qa_stats',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['stock_code', 'week_start'],
      unique: true,
      name: 'east_money_qa_stats_stock_week_uniq',
    },
    { fields: ['week_start'], name: 'idx_east_money_qa_stats_week_start' },
    { fields: ['top_subtopic', 'week_start'], name: 'idx_east_money_qa_stats_subtopic_week' },
  ],
})
export class EastMoneyQAStat extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(10),
    allowNull: false,
    field: 'stock_code',
    comment: '股票代码 (6 位纯代码, 无 sh./sz. 前缀)',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'stock_name',
    comment: '股票名称 (聚合时点)',
  })
  declare stock_name: string | null;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'week_start',
    comment: '该周周一 ISO 日期 (YYYY-MM-DD, UTC)',
  })
  declare week_start: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'questions_count',
    comment: '当周该股全部提问数 (含未答, 整数 ≥ 0)',
  })
  declare questions_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'answer_count',
    comment: '当周该股已被公司回答的提问数',
  })
  declare answer_count: number;

  @Column({
    type: DataType.DECIMAL(5, 3),
    allowNull: false,
    defaultValue: 0,
    field: 'answer_rate',
    comment: 'answer_count / questions_count ∈ [0, 1]; 0 提问时 0',
  })
  declare answer_rate: number;

  @Column({
    type: DataType.STRING(40),
    allowNull: false,
    defaultValue: 'other_general',
    field: 'top_subtopic',
    comment: '当周最高 mention 的 subcategory (TOPIC_SUBCATEGORIES)',
  })
  declare top_subtopic: string;

  @Column({
    type: DataType.DECIMAL(5, 3),
    allowNull: false,
    defaultValue: 0,
    field: 'avg_question_sentiment',
    comment: '当周提问情绪均值 ∈ [-1, +1]',
  })
  declare avg_question_sentiment: number;

  @Column({
    type: DataType.DECIMAL(5, 3),
    allowNull: true,
    field: 'avg_answer_sentiment',
    comment: '当周非空回答情绪均值 ∈ [-1, +1]; NULL = 当周无回答',
  })
  declare avg_answer_sentiment: number | null;

  @Column({
    type: DataType.DECIMAL(5, 3),
    allowNull: true,
    field: 'answer_template_score',
    comment: 'detectTemplateAnswer 当周均值 ∈ [0,1]; 1=纯模板; NULL = 当周无回答',
  })
  declare answer_template_score: number | null;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'nlp_engine',
    comment: 'NLP 引擎标签 (heuristic_fallback / trading_agents / openai)',
  })
  declare nlp_engine: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '审计辅助 (subtopic_distribution / template_hits_sample / ...)',
  })
  declare raw_payload: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
