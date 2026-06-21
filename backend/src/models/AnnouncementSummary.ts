import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * AnnouncementSummary — US-059 AI 公告 NLP 关键信息提取.
 *
 * 一行 = `(announce_date, stock_code, original_title)` 的一条公司公告摘要：
 * 系统拉取某天某公司发布的公告标题, 调用 AI (TradingAgents 或 OpenAI 兼容)
 * 抽取人类可读的中文摘要 + 情绪 (正面/中性/负面) + 涉及金额 / 业务主题列表。
 *
 * AC 字段：
 *   - announce_date         公告日期 (YYYY-MM-DD)
 *   - stock_code            股票代码 (6 位纯代码, 与 NorthboundHolding / LimitUpStock 一致)
 *   - original_title        AKShare 返回的公告原始标题
 *   - summary               AI 抽取的中文一句话摘要
 *   - sentiment             AI 判定情绪 ('正面' / '中性' / '负面')
 *   - key_amounts_json      涉及金额 [{label, amount, unit}] (亿元 / 万元 / 元 / 股)
 *   - key_topics_json       涉及业务 / 主题 ['新能源', '光伏', '海外订单', ...]
 *   - event_type            US-026 ANN-002 classifyEventType 输出: 7 大事件分类
 *                           (业绩 / 重组 / 减持 / 担保 / 处罚 / 解禁 / 其它), NULL = 未分类
 *   - priority              US-029 ANN-005 computePriority 输出: critical / high / medium / low
 *                           critical → ANN-007 (US-031) 5min 飞书 push; 默认 'low'
 *   - entities              US-027 ANN-003 extractEntities 输出: [{name, role, holding_pct?, ...}]
 *                           JSONB array, 默认 []; 涉及人名 / 持股变动 / 关联方
 *
 * 数据源 (AKShare `stock_notice_report`):
 *   - 东方财富网-数据中心-公告大全-沪深京 A 股公告
 *     https://data.eastmoney.com/notices/hsa/5.html
 *   - 参数: symbol ('全部' / '重大事项' / '财务报告' / '融资公告' / '风险提示' /
 *           '资产重组' / '信息变更' / '持股变动'), date (YYYYMMDD 格式)
 *   - 返回字段: 代码 / 名称 / 公告标题 / 公告类型 / 公告日期 / 网址
 *
 * **NLP 抽取契约** (与 US-055 AIAdvisorService 同款 6 项 checklist):
 *   - AI 调用走 `AnnouncementNLPService.summarize(title, options)` → fail-OPEN 走
 *     启发式 fallback (关键词匹配判情绪 + 抽取金额数字 + topic 关键词字典) 而非抛错;
 *   - status = 'completed' (AI 调用成功) / 'partial' (启发式 fallback) /
 *     'failed' (AI throw 且 fallback 也未拿到 sentiment);
 *   - 失败仍 persist 让 UI 看到 "曾尝试过", 避免反复触发同一标题的 NLP.
 *
 * 主键设计:
 *   - PK = `id` autoIncrement;
 *   - UNIQUE (announce_date, stock_code, original_title) 防重复同步 — 同一天可能多份
 *     公告 (季报 / 分红 / 调研记录), 标题区分 + 复合 UNIQUE 保证 upsert 不冲突.
 *
 * 设计取舍:
 *   - **stock_code 用 6 位纯代码** (无 sh./sz. 前缀, 与 NorthboundHolding 一致),
 *     便于 GET /api/announcements?stock_code=000001 直接查询;
 *   - **summary / sentiment / key_amounts_json / key_topics_json 都允许 null** —
 *     AI 调用失败 + 启发式也无法识别时仍能落库 original_title 让用户手动查看;
 *   - **announcement_type 单独冗余列** 便于按类型过滤 (e.g. "只看重大事项"),
 *     原始字段在 raw_payload.公告类型 也保留.
 *
 * 消费方:
 *   - GET /api/announcements?stock_code=000001&days=30 — 前端公告抽屉/股票详情页;
 *   - 未来 US-067 KOL 观点对比 / US-074 黑天鹅监测可关联同表查询.
 */
@Table({
  tableName: 'announcement_summaries',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['announce_date', 'stock_code', 'original_title'],
      unique: true,
      name: 'announcement_summaries_date_code_title_uniq',
    },
    { fields: ['stock_code', 'announce_date'] },
    { fields: ['announce_date'] },
    { fields: ['sentiment'] },
    { fields: ['announcement_type'] },
    // US-025 ANN-001: 新增两条复合索引服务 ANN-007 critical push + KOL/黑天鹅按事件类型聚合.
    { fields: ['priority', 'announce_date'], name: 'idx_announcement_summaries_priority_date' },
    { fields: ['event_type', 'announce_date'], name: 'idx_announcement_summaries_event_type_date' },
  ],
})
export class AnnouncementSummary extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'announce_date',
    comment: '公告日期 (YYYY-MM-DD)',
  })
  declare announce_date: string;

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
    comment: '股票名称 (公告时点的简称, 便于 UI 展示无需 JOIN)',
  })
  declare stock_name: string | null;

  @Column({
    type: DataType.STRING(500),
    allowNull: false,
    field: 'original_title',
    comment: '公告原始标题 (东方财富/AKShare 返回)',
  })
  declare original_title: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'announcement_type',
    comment:
      '公告类型 (重大事项 / 财务报告 / 融资公告 / 风险提示 / 资产重组 / 信息变更 / 持股变动)',
  })
  declare announcement_type: string | null;

  @Column({
    type: DataType.STRING(500),
    allowNull: true,
    comment: '原始公告 URL (东财详情页, 用户点击可查看 PDF)',
  })
  declare url: string | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: 'AI 抽取的中文一句话摘要 (失败时为 null, UI 显示 original_title)',
  })
  declare summary: string | null;

  @Column({
    type: DataType.STRING(10),
    allowNull: true,
    comment: 'AI 判定情绪: 正面 / 中性 / 负面 (启发式 fallback 同样维度), null = 未识别',
  })
  declare sentiment: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'key_amounts_json',
    comment: '涉及金额 [{label, amount, unit}]; AI 抽取或启发式正则匹配, 默认空数组',
  })
  declare key_amounts_json: Array<{
    label: string;
    amount: number;
    unit: string;
  }>;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'key_topics_json',
    comment: '涉及业务/主题字符串数组 (e.g. ["新能源", "光伏", "海外订单"]), 默认空数组',
  })
  declare key_topics_json: string[];

  // -------------------------------------------------------------------------
  // US-025 ANN-001: 新增 event_type / priority / entities 三列
  // 配套迁移: backend/scripts/migrations/2026-06-19-announcement-nlp-event-priority-entities.sql
  // 实际抽取逻辑由 ANN-002 (US-026) ~ ANN-006 (US-030) 的 pure helper 填充;
  // 本 story 仅落 schema + 默认值, 历史行 event_type=NULL / priority='low' / entities=[].
  // -------------------------------------------------------------------------

  @Column({
    type: DataType.STRING(40),
    allowNull: true,
    field: 'event_type',
    comment:
      'AI 事件分类 (US-026 classifyEventType): 业绩|重组|减持|担保|处罚|解禁|其它; NULL=未分类',
  })
  declare event_type: string | null;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'low',
    comment:
      'AI 优先级 (US-029 computePriority): critical|high|medium|low; critical 触发 5min 飞书 push (US-031)',
  })
  declare priority: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    comment:
      'AI 实体抽取 (US-027 extractEntities): [{name, role, holding_pct?, ...}] JSONB array, 默认 []',
  })
  declare entities: Array<Record<string, unknown>>;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'completed',
    comment: 'NLP 状态: completed (AI 成功) / partial (启发式 fallback) / failed / pending',
  })
  declare status: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    comment: 'NLP 引擎标签 (e.g. "trading_agents" / "heuristic_fallback" / "openai")',
  })
  declare nlp_engine: string | null;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: 'AI 调用失败时的错误描述 (status=failed/partial 时填充)',
  })
  declare error: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '原始 AKShare 行 (便于事后回溯字段映射变化)',
  })
  declare raw_payload: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
