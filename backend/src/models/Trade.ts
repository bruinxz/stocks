import {
  Table,
  Column,
  Model,
  DataType,
  ForeignKey,
  BelongsTo,
  Index,
  CreatedAt,
  UpdatedAt,
} from 'sequelize-typescript';
import { BacktestResult } from './BacktestResult';
import { Stock } from './Stock';

export enum TradeDirection {
  LONG = 'long',
  SHORT = 'short',
}

@Table({
  tableName: 'trades',
  timestamps: true,
  indexes: [
    {
      name: 'idx_trades_backtest_id',
      fields: ['backtest_id'],
    },
    {
      name: 'idx_trades_entry_date',
      fields: ['entry_date'],
    },
    {
      name: 'idx_trades_exit_date',
      fields: ['exit_date'],
    },
    {
      name: 'idx_trades_stock_id',
      fields: ['stock_id'],
    },
  ],
})
export class Trade extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
  })
  declare id: string;

  @ForeignKey(() => BacktestResult)
  @Column({
    type: DataType.UUID,
    allowNull: false,
    field: 'backtest_id',
    comment: '回测ID',
  })
  declare backtest_id: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    comment: '入场日期',
    field: 'entry_date',
  })
  declare entry_date: Date;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    comment: '出场日期',
    field: 'exit_date',
  })
  declare exit_date: Date;

  @ForeignKey(() => Stock)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'stock_id',
    comment: '股票ID',
  })
  declare stock_id: number;

  @Column({
    type: DataType.ENUM(...Object.values(TradeDirection)),
    allowNull: false,
    comment: '交易方向',
  })
  declare direction: TradeDirection;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'entry_price',
    comment: '入场价格',
  })
  declare entry_price: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'exit_price',
    comment: '出场价格',
  })
  declare exit_price: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    comment: '交易数量',
  })
  declare quantity: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '盈亏金额',
  })
  declare pnl: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: false,
    field: 'pnl_percent',
    comment: '盈亏比例(%)',
  })
  declare pnl_percent: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'holding_days',
    comment: '持有天数',
  })
  declare holding_days: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'entry_value',
    comment: '入场市值',
  })
  declare entry_value: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    field: 'exit_value',
    comment: '出场市值',
  })
  declare exit_value: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '佣金费用',
  })
  declare commission?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'stamp_duty',
    comment: '印花税',
  })
  declare stamp_duty?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'transfer_fee',
    comment: '过户费',
  })
  declare transfer_fee?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'total_fee',
    comment: '总费用',
  })
  declare total_fee?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'net_pnl',
    comment: '净盈亏',
  })
  declare net_pnl?: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'entry_signal',
    comment: '入场信号',
  })
  declare entry_signal?: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'exit_signal',
    comment: '出场信号',
  })
  declare exit_signal?: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '备注',
  })
  declare notes?: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  // 关联关系
  @BelongsTo(() => BacktestResult)
  declare backtest: BacktestResult;

  @BelongsTo(() => Stock)
  declare stock: Stock;
}
