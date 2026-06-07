import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 指数成份股快照（US-020）
 *
 * 主键 (trade_date, index_code, stock_code) 用于同日多指数共存（一只股票可同时
 * 在沪深 300 + 中证 500 + 中证 1000 里），且不同交易日成份股可能调整。
 *
 * 主要消费方：CTA100MomentumStrategy（US-020）—— 读 index_code='000852'
 * （中证 1000）的最新一日全集作为 universe；后续 SectorRotationLeader
 * （US-021）/ EnsembleStrategy（US-028）等会读多个 index_code。
 *
 * 数据源：AKShare `index_stock_cons_sina(symbol='000852')` 等接口；典型用法
 * 每月头次调仓前同步一次，因为指数月内成份变化稀少（仅遇到季度调样）。
 *
 * index_code 用纯数字 6 位（不带 .SH / .CSI 后缀），与系统其他表 stock_code
 * 的命名约定一致：000852=中证 1000，000300=沪深 300，000905=中证 500，
 * 000016=上证 50。
 */
@Table({
  tableName: 'index_components',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['index_code'] },
    { fields: ['stock_code'] },
    { fields: ['trade_date', 'index_code'] },
    { fields: ['index_code', 'stock_code'] },
  ],
})
export class IndexComponent extends Model {
  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    primaryKey: true,
    field: 'trade_date',
    comment: '快照交易日 (YYYY-MM-DD)',
  })
  declare trade_date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'index_code',
    comment: '指数代码（无后缀），如 000852=中证 1000 / 000300=沪深 300',
  })
  declare index_code: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    primaryKey: true,
    field: 'stock_code',
    comment: '成份股代码（无后缀），如 600519 / 000001',
  })
  declare stock_code: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    field: 'stock_name',
    comment: '成份股名称',
  })
  declare stock_name?: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'index_name',
    comment: '指数名称（如"中证1000"），冗余字段便于联表查询少 JOIN',
  })
  declare index_name?: string;

  @Column({
    type: DataType.DECIMAL(12, 6),
    allowNull: true,
    field: 'weight',
    comment: '成份股权重 (%)。AKShare 部分接口不返回，nullable',
  })
  declare weight?: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'akshare',
    comment: '数据源标识，便于多数据源比较',
  })
  declare source: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'raw_payload',
    comment: '原始 AKShare 行（保留所有字段，便于以后回溯）',
  })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
