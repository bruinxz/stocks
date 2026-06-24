import { Table, Column, Model, DataType, CreatedAt } from 'sequelize-typescript';

/**
 * IndustryFlowIntraday — BK-1 (2026-06-24)
 *
 * **盘中 10min 行业资金流时序快照**. 一行 = (snapshot_ts, industry_code) 二元组,
 * 用于前端画"分时累计资金流图"(类似抖音 / 同花顺截图).
 *
 * 与既有 `industry_flows` (单日聚合, 一行业一行) 互补:
 *   - industry_flows: 日度终态 (T 日 15:30 后由 INDUSTRY_FLOW_SYNC 写入)
 *   - industry_flow_intraday: 盘中时序 (T 日 9:30-15:00 每 10min 一次)
 *
 * 数据源: AKShare `stock_sector_fund_flow_rank(indicator='今日', sector_type='行业资金流')`
 * — 返回每个行业**截至调用时刻的累计净流入** (亿元), 配合 snapshot_ts 形成时序.
 *
 * 主键 (snapshot_ts, industry_code):
 *   - snapshot_ts: TIMESTAMPTZ 5min/10min 整点 (如 2026-06-24T09:35:00+0800)
 *   - industry_code: 板块代码 (BKxxxx, 与 industry_flows 同口径)
 *
 * 保留期: 3 个交易日 (cron INDUSTRY_FLOW_INTRADAY_CLEANUP 每日 16:00 删 > 3 日数据).
 * 估算量级: 86 行业 × 24 snapshot/日 × 3 日 ≈ 6200 行 (非 hypertable 够用).
 *
 * 累计语义重要: main_inflow 已经是 "9:30 至 snapshot_ts 的累计净流入" (不是 5min 增量),
 * 前端直接画 = 截图那种"逐步发散"的累计曲线. 不需要再做 cumsum.
 */
@Table({
  tableName: 'industry_flow_intraday',
  timestamps: false, // 自带 created_at, 不需要 updated_at (snapshot 不修改)
  underscored: true,
  indexes: [
    { fields: ['snapshot_ts'] },
    { fields: ['industry_code'] },
    { fields: ['snapshot_ts', 'main_inflow'] }, // 排序用
  ],
})
export class IndustryFlowIntraday extends Model {
  @Column({
    type: DataType.DATE,
    allowNull: false,
    primaryKey: true,
    field: 'snapshot_ts',
    comment: 'TIMESTAMPTZ 快照时刻 (5min/10min 整点, Asia/Shanghai)',
  })
  declare snapshot_ts: Date;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'industry_code',
    comment: '行业板块代码 (BKxxxx, 与 industry_flows 同口径)',
  })
  declare industry_code: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'industry_name',
    comment: '行业板块名称 (例如 "半导体" "白酒")',
  })
  declare industry_name: string;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'main_inflow',
    comment: '截至 snapshot_ts 的累计主力净流入 (元). 正=流入, 负=流出',
  })
  declare main_inflow?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'change_pct',
    comment: '快照时刻板块涨跌幅 (%)',
  })
  declare change_pct?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'main_inflow_ratio',
    comment: '主力净流入-净占比 (%) (快照时刻)',
  })
  declare main_inflow_ratio?: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;
}
