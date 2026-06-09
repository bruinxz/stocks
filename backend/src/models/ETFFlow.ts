import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 行业 ETF 申赎资金流 (ETF Flow) 入库表 — US-092 数据层.
 *
 * 一行 = (trade_date, etf_code) 二元 PK 的一份 per-ETF 日度资金流记录.
 *
 * 数据源: AKShare 多端点合并
 *   - `fund_etf_hist_em(symbol, period='daily', start, end)` — per-ETF 历史日行情
 *     (开 / 高 / 低 / 收 / 成交量 / 成交额 / 换手率); 注意此处 "成交额" 是 ETF 二级
 *     市场成交金额, NOT 一级市场申赎金额.
 *   - `fund_etf_fund_daily_em()` — 全市场 ETF 日度净值 + 单位净值 + 累计净值
 *     (用于 NAV 计算市值与申赎规模).
 *
 * **AC endpoint substitution 范式 (US-034 / US-035 / US-053 同款)**:
 *   AC 要求 "每日申赎规模" 与 "AUM (规模)"; AKShare **没有直接的 per-ETF 申赎
 *   金额 / AUM 时序端点** (fund_etf_scale_szse/_sse 是季度规模 = 慢变快照,
 *   非日度时序). 经数据源对比, 选用代理范式:
 *     - AUM 代理: 基于 "share_count[T] × nav[T]" 累积估算
 *       (share_count 由 fund_etf_fund_daily_em 提供 / fallback 用 fund_etf_fund_info_em);
 *     - net_inflow 代理: 基于 day-to-day diff 推算
 *       net_inflow[T] ≈ (share_count[T] - share_count[T-1]) × nav[T]
 *       与 US-091 MarginTrading day-to-day diff 推算 fin_repay_amt 同款 identity
 *       反推模式. 该 proxy 学术依据: 国内基金研究普遍以"份额变化 × NAV" 作为
 *       申赎净额估计 (份额是真实赎回/申购对应的会计指标, 二级市场买卖不会改变).
 *     - 升级路径: 若 AKShare 未来提供 fund_etf_subscription_em 类原生申赎端点,
 *       仅替换 Python helper + SyncService 写入逻辑, model schema 不变.
 *
 * 4 处文档同步标注 (与 US-091 同款):
 *   - model 列 comment (本文件) / Python helper docstring (akshare_helper.py) /
 *     TS Client jsdoc (ETFFlowClient.ts) / SyncService jsdoc (ETFFlowSyncService.ts).
 *
 * **限定 universe = 30+ 主流行业 ETF**:
 *   Whitelist 在 `backend/src/constants/etfIndustry.ts` 维护
 *   (半导体 / 医药 / 新能源车 / 消费 / 银行 / 5G / 光伏 / 军工 / 食品饮料 ...
 *   30+ 只). 不扫全 ETF 市场避免 (a) 货币 / 债券 / 黄金 ETF 噪音, (b) 单日 5000+
 *   ETF 拉数据耗时.
 *
 * 用途:
 *   - 行业研究: 哪些行业最近被资金大额申购 / 赎回 (e.g. "半导体 ETF 5 日净流入
 *     +20 亿" = 行业被买入信号).
 *   - 配合 IndustryFlow (US-008): IndustryFlow 看二级市场买盘 (即时主力买入金额),
 *     ETFFlow 看一级市场申赎 (实质资金流入). 两者验证则信号更强.
 *   - 未来: ETF 资金流 factor (5 日累计净流入 / 申赎比) 加入 quant pipeline,
 *     与 NorthboundHolding / MarginTradingBalance 形成 "外资 / 杠杆 / ETF" 三资金
 *     pillar.
 *
 * 与既有模型区分:
 *   - IndustryFlow (US-008): 同样按行业但是 *个股聚合的主力净流入*, 二级市场;
 *     ETFFlow 是 ETF 产品本身的申赎, 一级市场.
 *   - MarginTradingBalance (US-091): per-stock 融资融券余额, 不涉及 ETF.
 *   - DividendHistory / DailyBar 等: ETF 不参与个股的 daily/dividend 表.
 */
@Table({
  tableName: 'etf_flows',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['etf_code'] },
    { fields: ['underlying_industry'] },
    { fields: ['trade_date', 'etf_code'] },
    { fields: ['trade_date', 'underlying_industry'] },
  ],
})
export class ETFFlow extends Model {
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

  // ===== AC 必需 4 字段 =====
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
    field: 'underlying_industry',
    comment:
      'AC 必需字段: 跟踪的底层行业分类标签 (e.g. "半导体" / "医药" / "新能源车"). ' +
      '由 constants/etfIndustry.ts 白名单提供; 不在白名单的 ETF 不入库.',
  })
  declare underlying_industry: string;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'net_inflow',
    comment:
      'AC 必需字段: 当日净申赎规模 (元) — proxy = (share_count[T] - share_count[T-1]) × nav[T]. ' +
      '正数 = 净申购 (资金流入); 负数 = 净赎回 (资金流出). ' +
      '上一交易日 share_count 缺失时 NULL (sync 服务层 day-to-day diff 模式同 US-091).',
  })
  declare net_inflow?: number;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'aum',
    comment:
      'AC 必需字段: 当日基金规模 / AUM (元) = share_count[T] × nav[T]. ' +
      'share_count 或 nav 任一缺失时 NULL.',
  })
  declare aum?: number;

  // ===== 扩展字段 =====
  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'nav',
    comment: '单位净值 (元) - 用于计算 AUM / net_inflow',
  })
  declare nav?: number;

  @Column({
    type: DataType.DECIMAL(24, 6),
    allowNull: true,
    field: 'share_count',
    comment: '基金份额 (份, 万份 / 亿份均归一为份). 用于 day-to-day diff 推算 net_inflow.',
  })
  declare share_count?: number;

  @Column({
    type: DataType.DECIMAL(24, 4),
    allowNull: true,
    field: 'secondary_turnover',
    comment:
      '二级市场成交额 (元) — 来自 fund_etf_hist_em 的 "成交额" 列. ' +
      '与 net_inflow 不同: 这是市场买卖额, 不是申赎金额. 留作交叉验证 + 流动性参考.',
  })
  declare secondary_turnover?: number;

  @Column({
    type: DataType.DECIMAL(24, 6),
    allowNull: true,
    field: 'close_price',
    comment: '当日 ETF 收盘价 (元) - 来自 fund_etf_hist_em "收盘" 列',
  })
  declare close_price?: number;

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
    comment: '原始 AKShare 行 (保留所有字段, 便于事后回溯)',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
