import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 行业资金流与板块强度日度快照（东方财富 / 申万一级 86+ 个行业板块）
 *
 * 一条记录 = 某交易日 / 某只行业板块的资金流与板块强度。主键 (trade_date,
 * industry_code) 用于单日 upsert，单只行业当日只有一条记录。
 *
 * 数据源：AKShare 三接口合并入库
 *   - `stock_sector_fund_flow_rank(indicator='今日', sector_type='行业资金流')`
 *     — 提供 今日涨跌幅 / 主力净流入-净额 / 主力净流入-净占比 / 主力净流入最大股
 *   - `stock_board_industry_name_em()` — 提供 板块代码 (BKxxxx) ↔ 板块名称 映射
 *   - `stock_board_industry_cons_em(symbol=...)` — 行业内成份股，用于识别"当日龙头"
 *
 * 字段含义：
 *   industry_code             板块代码（例如 BK1027；东财行业板块编码）
 *   industry_name             板块名称（例如 "半导体" "光伏设备" "白酒"）
 *   change_pct                板块当日涨跌幅 (%)
 *   main_inflow               主力净流入（元）
 *   main_inflow_ratio         主力净流入-净占比 (%)
 *   limit_up_count            行业内当日涨停股票数（来自 LimitUpStock 库内 join）
 *   leader_stock_code         行业当日龙头股代码（涨幅最大且非一字板）
 *   leader_stock_name         行业当日龙头股简称（冗余便于看图）
 *   leader_stock_change_pct   行业当日龙头股涨跌幅 (%)
 *   advancing_count           上涨家数（板块成份股内）
 *   declining_count           下跌家数（板块成份股内）
 *
 * 行业轮动策略关注：主力净流入排名 top 10 + limit_up_count > 0 + 龙头股可跟。
 */
@Table({
  tableName: 'industry_flows',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['industry_code'] },
    { fields: ['industry_name'] },
    { fields: ['trade_date', 'main_inflow'] },
    { fields: ['trade_date', 'change_pct'] },
  ],
})
export class IndustryFlow extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '交易日 (YYYY-MM-DD)',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'industry_code',
    comment: '行业板块代码（东财，例如 BK1027）',
  })
  declare industry_code: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'industry_name',
    comment: '行业板块名称（例如 "半导体" "白酒"）',
  })
  declare industry_name: string;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'change_pct',
    comment: '板块当日涨跌幅 (%)，例如 1.2345 表示 +1.2345%',
  })
  declare change_pct?: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: true,
    field: 'main_inflow',
    comment: '主力净流入（元）。正=净流入；负=净流出',
  })
  declare main_inflow?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'main_inflow_ratio',
    comment: '主力净流入-净占比 (%)',
  })
  declare main_inflow_ratio?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'limit_up_count',
    comment: '行业内当日涨停股票数（来自 LimitUpStock 库内 join）',
  })
  declare limit_up_count: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    field: 'leader_stock_code',
    comment: '行业当日龙头股代码（涨幅最大且非一字板）',
  })
  declare leader_stock_code?: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'leader_stock_name',
    comment: '行业当日龙头股简称',
  })
  declare leader_stock_name?: string;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'leader_stock_change_pct',
    comment: '行业当日龙头股涨跌幅 (%)',
  })
  declare leader_stock_change_pct?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'advancing_count',
    comment: '板块成份股内当日上涨家数',
  })
  declare advancing_count?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'declining_count',
    comment: '板块成份股内当日下跌家数',
  })
  declare declining_count?: number;

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
    comment: '原始 AKShare 行（fund_flow_row / board_row / leader_row 三层合并）',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
