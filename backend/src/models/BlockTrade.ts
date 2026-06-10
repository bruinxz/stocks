import { Table, Column, Model, DataType, PrimaryKey, CreatedAt, UpdatedAt } from 'sequelize-typescript';

/**
 * 大宗交易明细 — 折溢价 + 营业部信息 (2026-06-11 新增).
 *
 * 一行 = 一笔大宗交易. 同一天同一只股票可能多笔.
 * PK 是 自增 id 不容易做唯一约束 (买卖营业部 + 价格 + 量 都重复才唯一),
 * 用 (trade_date, stock_code, buyer, seller, amount) 5-tuple unique idx.
 *
 * 用途:
 *   - **大宗折价 → 短期反转策略**：折价 5%+ 通常是利空尾声，短期反弹概率高
 *   - **大宗溢价 → 利好接盘信号**：溢价 5%+ 说明买方愿意付溢价拿货，看好后市
 *   - **营业部活跃度**：跟踪知名游资 / 机构席位的高频成交对象
 *
 * 数据源 AKShare `stock_dzjy_mrmx(symbol='A股', start_date, end_date)`.
 * 日度 cron 拉一次.
 */
@Table({
  tableName: 'block_trades',
  indexes: [
    { fields: ['trade_date'] },
    { fields: ['stock_code'] },
    { fields: ['stock_code', 'trade_date'] },
    {
      name: 'block_trades_unique_key',
      unique: true,
      fields: ['trade_date', 'stock_code', 'buyer', 'seller', 'amount'],
    },
  ],
  comment: '大宗交易明细 + 折溢价 + 营业部',
})
export class BlockTrade extends Model<BlockTrade> {
  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'trade_date' })
  declare trade_date: string;

  @Column({ type: DataType.STRING(10), allowNull: false, field: 'stock_code' })
  declare stock_code: string;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'stock_name' })
  declare stock_name: string | null;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'price' })
  declare price: number | null; // 成交价

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'close_price' })
  declare close_price: number | null; // 当日收盘价 (计算折溢价用)

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: true, field: 'volume' })
  declare volume: number | null; // 成交量 (股)

  @Column({ type: DataType.DECIMAL(20, 4), allowNull: false, field: 'amount' })
  declare amount: number; // 成交金额 (元)

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'premium_pct' })
  declare premium_pct: number | null; // 折溢价 % = (price - close) / close * 100

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: true, field: 'change_pct' })
  declare change_pct: number | null; // 当日涨跌幅

  @Column({ type: DataType.STRING(200), allowNull: false, defaultValue: '', field: 'buyer' })
  declare buyer: string; // 买方营业部

  @Column({ type: DataType.STRING(200), allowNull: false, defaultValue: '', field: 'seller' })
  declare seller: string; // 卖方营业部

  @Column({ type: DataType.STRING(50), allowNull: false, defaultValue: 'akshare', field: 'source' })
  declare source: string;

  @CreatedAt
  declare created_at: Date;

  @UpdatedAt
  declare updated_at: Date;
}
