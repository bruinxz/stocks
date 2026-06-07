import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
import { PaperTradingPortfolio } from './PaperTradingPortfolio';

@Table({
  tableName: 'paper_trading_positions',
  timestamps: true,
})
export class PaperTradingPosition extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @ForeignKey(() => PaperTradingPortfolio)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'portfolio_id',
  })
  declare portfolio_id: number;

  @BelongsTo(() => PaperTradingPortfolio)
  declare portfolio: PaperTradingPortfolio;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: '股票代码',
  })
  declare symbol: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: true,
    comment: '股票名称',
  })
  declare name: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: '持有股数 (股)',
  })
  declare quantity: number;

  @Column({
    type: DataType.DECIMAL(10, 3),
    allowNull: false,
    defaultValue: 0,
    field: 'avg_cost',
    comment: '平均建仓成本价',
  })
  declare avg_cost: number;

  @Column({
    type: DataType.DECIMAL(10, 3),
    allowNull: false,
    defaultValue: 0,
    field: 'current_price',
    comment: '最新价格',
  })
  declare current_price: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'market_value',
    comment: '当前持仓市值',
  })
  declare market_value: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'unrealized_pnl',
    comment: '浮动盈亏',
  })
  declare unrealized_pnl: number;

  /**
   * 用户手动设置的止损价 (US-017)。
   *
   * 设置后 UI 在持仓表里会用红色提示"现价 ≤ 止损价"，并在 US-048
   * (TrailingStopGuard) 中作为强制止损触发线。本列允许 NULL —— null 表示
   * 用户未设置硬止损（仅依赖策略级 stop_loss_pct）。
   */
  @Column({
    type: DataType.DECIMAL(10, 3),
    allowNull: true,
    field: 'stop_loss_price',
    comment: '用户设置的止损价（NULL=未设置）',
  })
  declare stop_loss_price: number | null;

  /**
   * 追踪止损 — 持仓期间观察到的最高收盘价 (US-048)。
   *
   * 每日收盘后由 TrailingStopGuard.updatePositionsAfterClose() 更新：
   * `highest_price = max(highest_price, today_close)`。初次建仓时由
   * scheduler 任务回填为 `avg_cost`（建仓成本价）。NULL = 尚未建立 high
   * 水位（新开仓后第一次定时任务跑之前的窗口）。
   */
  @Column({
    type: DataType.DECIMAL(10, 3),
    allowNull: true,
    field: 'highest_price',
    comment: '建仓后观察到的最高收盘价（追踪止损水位）',
  })
  declare highest_price: number | null;

  /**
   * 追踪止损 — 回撤比例 (US-048)。0-1 之间，默认 0.10 (10%)。
   *
   * 计算 trailing_stop_price = highest_price * (1 - trailing_stop_pct)。
   * NULL 表示该持仓回退到用户的全局配置 (User.risk_config.trailing_stop.pct
   * 默认 0.10)；策略层可在开仓时为这只票单独设置一个更紧/更松的值。
   */
  @Column({
    type: DataType.DECIMAL(6, 4),
    allowNull: true,
    field: 'trailing_stop_pct',
    comment: '追踪止损回撤比例 0-1（NULL=继承用户全局配置）',
  })
  declare trailing_stop_pct: number | null;

  /**
   * 追踪止损 — 触发价 (US-048)。
   *
   * 由 updatePositionsAfterClose() 与 highest_price 同步重算：
   * `trailing_stop_price = highest_price * (1 - effective_pct)`。
   * 次日开盘前若 prev_close ≤ trailing_stop_price 则触发 SELL 信号。
   * NULL 与 highest_price 同步（尚未建立 high 水位）。
   */
  @Column({
    type: DataType.DECIMAL(10, 3),
    allowNull: true,
    field: 'trailing_stop_price',
    comment: '追踪止损触发价 = highest_price * (1 - pct)',
  })
  declare trailing_stop_price: number | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
