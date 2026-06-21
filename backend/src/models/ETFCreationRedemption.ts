import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * ETFCreationRedemption — US-147 KOL-001 ETF 一级市场申赎 + 折溢价快照.
 *
 * 一行 = `(trade_date, etf_code)` 二元 PK 的一份 per-ETF 日度申赎 + 折溢价记录:
 *   "159995 芯片ETF华夏, 2026-06-21, 半导体, 当日净申购 1.2e8 元, 净赎回 0.3e8 元,
 *    收盘 IOPV 溢价率 0.45%".
 *
 * 与 ETFFlow (US-092) 的关系:
 *   - **ETFFlow** (既有): 用 `(share_count[T] - share_count[T-1]) × nav[T]`
 *     **代理** 净申赎金额, 优点 = 历史端点稳定; 缺点 = 只看到 net, 看不到 gross 申购
 *     和 gross 赎回(净 0 也可能是大额双向对冲).
 *   - **ETFCreationRedemption** (本表 US-147): 拿 AKShare `fund_etf_iopv_em` / 申赎清
 *     单端点的 **gross 申购金额 + gross 赎回金额** 双字段, 同时落 **premium_pct**
 *     (二级价 / IOPV - 1, 一级 vs 二级套利驱动力). 让下游 KOLAggregator
 *     `aggregateForIndustry` 能识别 "净 0 但 gross 大 = 套利对倒" vs
 *     "净申购大 = 真增量资金" 两种 regime, 这是 net_inflow 单字段做不到的.
 *
 * **AC 必需 7 字段** (PRD US-147):
 *   1. trade_date — DATE PK 一半
 *   2. etf_code — VARCHAR PK 一半 (6 位)
 *   3. etf_name — VARCHAR 简称
 *   4. industry — VARCHAR 跟踪行业标签 (与 ETFFlow.underlying_industry 同口径,
 *      由 constants/etfIndustry.ts 白名单提供; 不在白名单的 ETF 不入库)
 *   5. net_creation — DECIMAL(24,4) 当日 **gross 申购金额** (元, ≥0)
 *   6. net_redemption — DECIMAL(24,4) 当日 **gross 赎回金额** (元, ≥0)
 *   7. premium_pct — DECIMAL(8,4) 折溢价率 (二级收盘价 / IOPV - 1) × 100,
 *      正 = 溢价 (二级贵, 利好申购套利); 负 = 折价 (二级便宜, 利好赎回套利)
 *
 * **AKShare 端点选型**:
 *   - 首选 `fund_etf_iopv_em()` — 全市场实时 IOPV + 二级现价, 收盘抓取计算
 *     premium_pct.
 *   - gross 申购/赎回 由 `fund_etf_dividend_sina` 或 `fund_etf_fund_info_em`
 *     的"申购金额/赎回金额" 字段 (AKShare 不同版本字段名不一, helper 层做
 *     normalize). 实在拉不到则降级 = `null` (而非 0, 避免与"真 0" 混淆;
 *     下游 KOLAggregator 用 `coalesce(net_creation, 0)` 兜底).
 *   - **net_creation / net_redemption 都 NOT NULL? — 不**: AC 字段层面要求 7 字段,
 *     但允许 NULL 以表达"未拉到数据"语义, 这是与 ETFFlow.net_inflow 同款
 *     fail-safe 设计 (一级数据稀疏期 ≠ 真 0).
 *
 * **fail-safe 默认值**:
 *   - source / raw_payload 默认值与 ETFFlow 同款 ('akshare' / `{}`);
 *   - 字段允许 NULL 表达"未拉到"(net_creation / net_redemption / premium_pct).
 *
 * 索引:
 *   - PK (trade_date, etf_code) 隐含;
 *   - (trade_date) 单列 — "今日全 ETF 申赎榜" 类查询;
 *   - (etf_code) 单列 — "某 ETF 近 30 天申赎序列";
 *   - (industry) 单列 — "近期半导体 ETF 全行业申赎";
 *   - (trade_date, industry) — "今日半导体行业全 ETF" 复合;
 *   - 不加 (premium_pct) — 折溢价排序场景少, 加索引开销 > 收益.
 *
 * 与既有模型区分 (5 维分清):
 *   - ETFFlow (US-092): net_inflow 代理 (单字段 net, 适合"已发生资金净流");
 *   - ETFCreationRedemption (本表): gross 申/赎 双字段 + 折溢价 (适合"申赎结构"
 *     与 "套利驱动力" 分析);
 *   - IndustryFlow (US-008): 个股聚合的主力净流入, 二级市场;
 *   - MarginTradingBalance (US-091): per-stock 融资融券, 不涉及 ETF;
 *   - FundTopHolding: ETF/基金的持仓快照, 不涉及申赎.
 *
 * 上游 service (后续 story 接入):
 *   - **KOL-002**: 新建 `data/sources/ETFCreationRedemptionClient.ts` 拉
 *     fund_etf_iopv_em + 申赎清单端点;
 *   - **KOL-003**: CLI `npm run sync:etf-creation-redemption -- --date=YYYY-MM-DD`;
 *   - **KOL-004**: SchedulerService 注册 cron `ETF_CR_SYNC` (17:30 工作日);
 *   - **KOL-006**: KOLAggregator.fetchETFCreationRedemption(industry) →
 *     aggregateForIndustry 加 "净申购增量 / 折溢价" 信号.
 *
 * **本 story (KOL-001) 只新增 model + migration**, service / CLI / cron / KOLAggregator
 * 接入由后续 story 完成. 因此本测试聚焦 schema 形状 + 双处挂载 (database.ts +
 * models/index.ts) + migration up/down 形态, 与 AIDiaryEntry (US-089) /
 * KOLAuthorStat (US-140) 同款 META-GUARD fs+regex 模式.
 */
@Table({
  tableName: 'etf_creation_redemption',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'], name: 'idx_etf_creation_redemption_trade_date' },
    { fields: ['etf_code'], name: 'idx_etf_creation_redemption_etf_code' },
    { fields: ['industry'], name: 'idx_etf_creation_redemption_industry' },
    {
      fields: ['trade_date', 'industry'],
      name: 'idx_etf_creation_redemption_trade_date_industry',
    },
  ],
})
export class ETFCreationRedemption extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD), PK 一半',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'etf_code',
    comment: '6 位 ETF 代码 (无市场前缀), 例如 159995 (芯片ETF华夏), PK 一半',
  })
  declare etf_code: string;

  // ===== AC 必需字段 (PRD US-147) =====
  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'etf_name',
    comment: 'AC 必需字段: ETF 简称 (e.g. "芯片ETF华夏" / "医药ETF")',
  })
  declare etf_name: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    field: 'industry',
    comment:
      'AC 必需字段: 跟踪的底层行业分类标签 (e.g. "半导体" / "医药" / "新能源车"). ' +
      '与 ETFFlow.underlying_industry 同口径, 由 constants/etfIndustry.ts 白名单提供; ' +
      '不在白名单的 ETF 不入库.',
  })
  declare industry: string;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'net_creation',
    comment:
      'AC 必需字段: 当日 gross 申购金额 (元, ≥0). ' +
      'NULL = 未从 AKShare 拉到 (一级数据稀疏期), 与"真 0" 区分; ' +
      '下游 KOLAggregator 用 coalesce(net_creation, 0) 兜底.',
  })
  declare net_creation: number | null;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'net_redemption',
    comment:
      'AC 必需字段: 当日 gross 赎回金额 (元, ≥0). ' + 'NULL = 未从 AKShare 拉到, 与"真 0" 区分.',
  })
  declare net_redemption: number | null;

  @Column({
    type: DataType.DECIMAL(8, 4),
    allowNull: true,
    field: 'premium_pct',
    comment:
      'AC 必需字段: 折溢价率 (%, 二级收盘价 / IOPV - 1) × 100. ' +
      '正 = 溢价 (二级贵, 利好申购套利); 负 = 折价 (二级便宜, 利好赎回套利). ' +
      'NULL = IOPV / 二级价任一缺失.',
  })
  declare premium_pct: number | null;

  // ===== 审计 / 数据源 =====
  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'akshare',
    comment: '数据源标识',
  })
  declare source: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment:
      '原始 AKShare 行 (保留所有字段, 便于事后回溯 — IOPV / 二级价 / 申购确认日 / 端点版本等)',
  })
  declare raw_payload: Record<string, unknown>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
