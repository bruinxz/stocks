import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * TechnicalAnalysisReport — US-061 AI 大模型技术面 K 线解读
 *
 * 一行 = `(stock_code, lookback_days)` 的一次 AI 技术面解读快照，
 * 由 `TechnicalAnalysisService.analyze(stockCode, lookbackDays)` 生成并持久化，
 * 24 小时 TTL 缓存复用（同股 + 同窗口 24h 内重复请求直接命中缓存，避免重复
 * 调用 TradingAgents 与重新计算指标）。
 *
 * AC 关键字段（PRD US-061）：
 *   - `trend`              : 趋势判断（上升 / 下降 / 震荡 / 突破 / 反转 / unknown）
 *   - `support_levels`     : 支撑位价格数组（递减，最多 3 档）
 *   - `resistance_levels`  : 压力位价格数组（递增，最多 3 档）
 *   - `buy_zone`           : 推荐买入区间 [low, high]
 *   - `sell_zone`          : 推荐卖出区间 [low, high]
 *   - `summary`            : 中文 markdown 一段总览（前端 Modal 顶部直接渲染）
 *   - `confidence`         : 0-100 整数置信分
 *
 * 设计取舍：
 *   - **PK = `id` autoIncrement + UNIQUE (stock_code, lookback_days, expires_at)**：
 *     一行就是一次缓存条目；同 (stock_code, lookback_days) 24h 内只生成一行，
 *     `expires_at` 过期后下次请求会"未命中 + 新建一行"而非更新旧行
 *     (历史报告可被读端按 generated_at 倒序回看；旧缓存可由定时清理 job
 *      删除 expires_at < now() 的行)；
 *   - **trend / risk_level 用 string** 不用 enum —— 与 AIInvestmentSignal
 *     已有约定一致，避免 schema 迁移成本（中文标签变动 / 新增 "震荡偏强" 等中间态）；
 *   - **支撑 / 压力位用 JSONB number[]** —— 数量动态扩展（多档时直接 push），
 *     不破坏 schema；前端直接渲染数组无需 JOIN；
 *   - **buy_zone / sell_zone 用 JSONB [low, high]** —— 两元素元组语义清晰；
 *     **DECIMAL 列读出后必须 `Number()` 包装** (US-040 codebase pattern：
 *     Sequelize JSONB 中数字经 PostgreSQL 协议可能被序列化成 string)，service
 *     层 buildResultFromPayload 已做此防御；
 *   - **indicators_snapshot JSONB** 保留生成时的 RSI / MACD / BBands 等技术指标
 *     原始值，便于审计 "AI 当时看到的数据是什么"；
 *   - **status 字段** 与 AIStockAnalysisReport 同款：completed / partial /
 *     failed（启发式 fallback 标记成 'partial' 让 UI 知道 AI 远端失败）；
 *   - **nlp_engine 字段** 标记 trading_agents / openai / heuristic_fallback；
 *     与 EastMoneyQATopic / AnnouncementSummary 同款字段命名。
 *
 * **24 小时 TTL 缓存读端逻辑**：
 *   - `findActiveCache(stock_code, lookback_days)` =
 *     `where { stock_code, lookback_days, expires_at: { [Op.gt]: new Date() } }`
 *     order by `generated_at DESC` limit 1；
 *   - 命中 → 返回 `from_cache=true` 跳过远端调用；
 *   - 未命中 → 生成新 report 并写一行（旧行保留作历史快照）；
 *   - `expires_at = generated_at + 24h`，由 service 层 buildResultFromPayload 计算。
 *
 * 消费方：
 *   - POST /api/ai/technical-analysis — 前端 K 线图右侧 "AI 技术面解读" 抽屉；
 *   - 未来 US-062 Copilot 调参 / US-080 周报可拉历史 reports 做趋势可视化；
 *   - StockDetail / TodayWorkspace 直接显示最新 cache 行（如无则触发新生成）。
 *
 * **6 项 AI feature checklist** (US-055 范式同款 — 实施在 TechnicalAnalysisService):
 *   1. DataSource DI（callRemoteAnalyze / saveReport / loadBars / findCache）；
 *   2. pure helpers 全 export（buildIndicatorContext / parseRemoteAnalysis /
 *      formatSummary / buildHeuristicFallback / cacheKey / isCacheActive）；
 *   3. plain-object 返回类型（TechnicalAnalysisResult）；
 *   4. status='partial' / 'failed' 仍 persist 让 UI 看到 "曾尝试过"；
 *   5. fail-OPEN on saveReport — DB 故障不阻塞 caller（仍返回结果）；
 *   6. 双重防御 try/catch — DataSource 层 catch + service 层再 catch.
 */
@Table({
  tableName: 'technical_analysis_reports',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      fields: ['stock_code', 'lookback_days', 'expires_at'],
      name: 'tech_analysis_stock_window_expires',
    },
    { fields: ['stock_code'] },
    { fields: ['stock_code', 'generated_at'] },
    { fields: ['expires_at'] },
    { fields: ['status'] },
  ],
})
export class TechnicalAnalysisReport extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    field: 'stock_code',
    comment: '已规范化的股票代码（sh.600519 / sz.000001 等，与 normalizeSymbol 输出一致）',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '股票名称（生成时 snapshot，便于 UI 无需 JOIN）',
  })
  declare stock_name: string | null;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'lookback_days',
    comment: '技术面分析回看 K 线根数（默认 60，范围 20-250 自然日，service 层 clamp）',
  })
  declare lookback_days: number;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'unknown',
    comment: '趋势判断：uptrend / downtrend / sideways / breakout / reversal / unknown',
  })
  declare trend: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'support_levels',
    comment: '支撑位价格数组（递减，最多 3 档；JSONB number[]）',
  })
  declare support_levels: number[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'resistance_levels',
    comment: '压力位价格数组（递增，最多 3 档；JSONB number[]）',
  })
  declare resistance_levels: number[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'buy_zone',
    comment: '推荐买入区间 [low, high]（JSONB number[]，2 元素元组，可能为空数组）',
  })
  declare buy_zone: number[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'sell_zone',
    comment: '推荐卖出区间 [low, high]（JSONB number[]，2 元素元组，可能为空数组）',
  })
  declare sell_zone: number[];

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '中文一段 markdown 总览（前端 Modal 顶部直接渲染）',
  })
  declare summary: string | null;

  @Column({
    type: DataType.DECIMAL(5, 2),
    allowNull: true,
    comment: 'AI 综合置信分 0-100（heuristic_fallback 取 50 兜底）',
  })
  declare confidence: number | null;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: 'completed',
    comment: 'completed / partial / failed（partial = 启发式 fallback 兜底成功）',
  })
  declare status: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'nlp_engine',
    comment: 'NLP 引擎标签（trading_agents / openai / heuristic_fallback）',
  })
  declare nlp_engine: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'indicators_snapshot',
    comment:
      '生成时的技术指标 snapshot（last_close / last_rsi / last_macd / last_bbands / vol_ratio）',
  })
  declare indicators_snapshot: Record<string, unknown>;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '失败 / 部分时的错误描述（status=failed/partial 时使用）',
  })
  declare error: string | null;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'generated_at',
    comment: '报告生成时间戳',
  })
  declare generated_at: Date;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    field: 'expires_at',
    comment: '缓存过期时间（生成时 + 24h；service 读端按 expires_at > now() 找命中）',
  })
  declare expires_at: Date;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    comment: '原始 TradingAgents payload + 调用参数 metadata',
  })
  declare metadata: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
