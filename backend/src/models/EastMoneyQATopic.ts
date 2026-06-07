import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * EastMoneyQATopic — US-060 AI 东财问答 NLP 与个股关注度.
 *
 * 一行 = `(stock_code, week_start, topic)` 的一条按周聚合的散户问答主题快照：
 *   "某只股票本周（周一起算）问答中，分类为 <topic> 的问题数量及平均情绪倾向"。
 *
 * 数据源 (AC 期望 vs 实际可得 — US-034/US-035 同款 endpoint 替代范式):
 *
 *   AC 文字: "东财问答" (东方财富股吧 Q&A);
 *
 *   **实际数据源**: AKShare `stock_irm_cninfo(symbol=<6-digit>)`
 *       巨潮资讯-互动易-投资者问答 (投资者向上市公司提问，公司可选回答)
 *       https://irm.cninfo.com.cn/ircs/question/questionDetail
 *       返回某只股票全部历史互动易问答 (typically 300-2000 行).
 *
 *       字段: 股票代码 / 公司简称 / 行业 / 问题 / 提问者 / 来源 / 提问时间 /
 *             更新时间 / 提问者编号 / 问题编号 / 回答ID / 回答内容 / 回答者
 *
 *   **设计抉择 — 为何用 cninfo 互动易而非东财股吧?**:
 *     - AC 文字"东财问答" 字面指 https://guba.eastmoney.com 的 Q&A;
 *     - 东方财富股吧 (guba) 在 AKShare 中 **无任何 per-stock Q&A endpoint**:
 *       * `stock_guba_em` 在 AKShare 中根本不存在 (US-034 已验证);
 *       * `stock_news_em` 只返回新闻不返回问答;
 *     - 巨潮资讯互动易 (cninfo IRM) 与东财股吧同属"投资者-上市公司 Q&A"领域,
 *       数据语义 100% 对齐 (用户提问 → 公司回答, 关注的话题域相同);
 *     - **类名 / 表名保留 EastMoney 命名** 与 AC 一致, 注释清晰说明实际数据源.
 *
 *   **升级路径**:
 *     - 若未来 AKShare 增加 `stock_guba_qa_em` per-stock Q&A endpoint, 直接换
 *       Python helper 内 endpoint, sync / 模型 / 因子 / 测试都不动 (raw_payload
 *       字段差异在 buildHeuristicTopic 内已通过 fallback 兜底);
 *     - 若引入 SSE 上证 e 互动 (`stock_sns_sseinfo`), 加 source 字段细分;
 *
 * **主题分类** (AC 6 类 + 1 兜底):
 *   - 财务 (FINANCE): 营收 / 利润 / 净利 / 毛利 / 现金流 / 资产 / 负债 / 财报 / 业绩
 *   - 产品 (PRODUCT): 产品 / 新品 / 技术 / 研发 / 工艺 / 性能 / 规格 / 销量
 *   - 订单 (ORDER):   订单 / 合同 / 中标 / 采购 / 客户 / 大客户 / 交付 / 出货
 *   - 人事 (PERSONNEL): 高管 / 总裁 / 董事 / 离职 / 任命 / 招聘 / 团队 / 员工
 *   - 政策 (POLICY):   政策 / 监管 / 补贴 / 法规 / 调控 / 规划 / 准入 / 资质
 *   - 其它 (OTHER):    未命中以上字典 → 兜底
 *
 *   分类规则按 "命中数 desc + 字典优先级 (FINANCE > ORDER > PRODUCT > POLICY >
 *   PERSONNEL > OTHER)" 决定 — 同问题命中多类时, 命中数多者胜; 平手按优先级.
 *
 * **情绪打分** (sentiment_score ∈ [-1, +1] 浮点):
 *   - 与 AnnouncementNLPService.heuristicSentiment 同款字典 (强空 / 弱空 / 弱多
 *     / 强多 / 中性), 但输出连续标量便于聚合;
 *   - 强空 = -1.0, 弱空 = -0.5, 中性 = 0, 弱多 = +0.5, 强多 = +1.0;
 *   - 一周内同 topic 多条问题的平均值 = sentiment_score 字段.
 *
 * **按周聚合 (week_start)**:
 *   - week_start 取该周周一的 ISO 日期 (YYYY-MM-DD UTC);
 *   - mention_count = 该周该 topic 的问题数;
 *   - 周边界用 ISO-8601 weekday: 周一 day=1 / 周日 day=7.
 *
 * **主键与 UNIQUE**:
 *   - PK: id autoIncrement;
 *   - UNIQUE (stock_code, week_start, topic) — 防重复同步, 同一只股票同一周
 *     同一 topic 只一行, bulkCreate updateOnDuplicate 可直接刷新 mention_count
 *     与 sentiment_score.
 *
 * 字段说明:
 *   stock_code        6 位股票代码 (无前缀, 与 NorthboundHolding / LimitUpStock 一致)
 *   week_start        该周周一 ISO 日期 (YYYY-MM-DD)
 *   topic             主题分类 (财务 / 产品 / 订单 / 人事 / 政策 / 其它)
 *   mention_count     该周该 topic 的问题数 (整数, ≥ 1)
 *   sentiment_score   该周该 topic 的平均情绪分 ∈ [-1, +1]
 *   nlp_engine        NLP 引擎标签 (heuristic_fallback / trading_agents / openai)
 *   raw_payload       聚合时的辅助统计 ({total_questions, sentiment_breakdown})
 *
 * 用途:
 *   - GET /api/sentiment/qa-topics?stock_code=000001 — 前端 StockDetail 关注度
 *     侧栏 / TodayWorkspace 单股深度问答模块;
 *   - 未来 US-061 K 线 AI 解读 / US-067 情绪冲击告警可复用此表统计散户关注变化.
 *
 * **6 项 AI feature checklist** (US-055 范式同款 — 实施在 EastMoneyQATopicService):
 *   1. DataSource DI;
 *   2. pure helpers 全 export (classifyTopic / scoreSentiment / computeWeekStart /
 *      aggregateWeekly);
 *   3. plain-object 返回类型 (EastMoneyQATopicRecord);
 *   4. status='partial' / 'failed' 仍 persist 让 UI 看到 "曾尝试过";
 *   5. fail-OPEN on saveTopics — DB 故障不阻塞 caller;
 *   6. 双重防御 try/catch — DataSource 层 catch + service 层再 catch.
 */
@Table({
  tableName: 'east_money_qa_topics',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['stock_code', 'week_start', 'topic'],
      unique: true,
      name: 'east_money_qa_topics_stock_week_topic_uniq',
    },
    { fields: ['stock_code', 'week_start'] },
    { fields: ['week_start'] },
    { fields: ['topic'] },
  ],
})
export class EastMoneyQATopic extends Model {
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
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'week_start',
    comment: '该周周一 ISO 日期 (YYYY-MM-DD, UTC)',
  })
  declare week_start: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: '主题分类: 财务 / 产品 / 订单 / 人事 / 政策 / 其它',
  })
  declare topic: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'mention_count',
    comment: '该周该 topic 的问题数 (整数, ≥ 1)',
  })
  declare mention_count: number;

  @Column({
    type: DataType.DECIMAL(5, 3),
    allowNull: false,
    defaultValue: 0,
    field: 'sentiment_score',
    comment: '该周该 topic 的平均情绪分 ∈ [-1, +1] (3 位小数)',
  })
  declare sentiment_score: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'nlp_engine',
    comment: 'NLP 引擎标签 (heuristic_fallback / trading_agents / openai)',
  })
  declare nlp_engine: string | null;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'stock_name',
    comment: '股票名称 (聚合时点的简称, 便于 UI 展示无需 JOIN)',
  })
  declare stock_name: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment:
      '聚合辅助统计 {total_questions, sentiment_breakdown: {strong_neg, weak_neg, neutral, weak_pos, strong_pos}}',
  })
  declare raw_payload: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
