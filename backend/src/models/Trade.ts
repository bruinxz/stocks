import { Table, Column, Model, DataType, ForeignKey, BelongsTo, Index, CreatedAt, UpdatedAt } from 'sequelize-typescript';
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
      fields: ['backtestId'],
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
      fields: ['stockId'],
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
    comment: '回测ID',
  })
  declare backtestId: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    comment: '入场日期',
    field: 'entry_date',
  })
  declare entryDate: Date;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    comment: '出场日期',
    field: 'exit_date',
  })
  declare exitDate: Date;

  @ForeignKey(() => Stock)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    comment: '股票ID',
  })
  stockId!: number;

  @Column({
    type: DataType.ENUM(...Object.values(TradeDirection)),
    allowNull: false,
    comment: '交易方向',
  })
  direction!: TradeDirection;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '入场价格',
  })
  entryPrice!: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '出场价格',
  })
  exitPrice!: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    comment: '交易数量',
  })
  quantity!: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '盈亏金额',
  })
  pnl!: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: false,
    comment: '盈亏比例(%)',
  })
  pnlPercent!: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    comment: '持有天数',
  })
  holdingDays!: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '入场市值',
  })
  entryValue!: number;

  @Column({
    type: DataType.DECIMAL(12, 4),
    allowNull: false,
    comment: '出场市值',
  })
  exitValue!: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '佣金费用',
  })
  commission?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '印花税',
  })
  stampDuty?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '过户费',
  })
  transferFee?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '总费用',
  })
  totalFee?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '净盈亏',
  })
  netPnl?: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    comment: '入场信号',
  })
  entrySignal?: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    comment: '出场信号',
  })
  exitSignal?: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '备注',
  })
  notes?: string;

  @CreatedAt
  declare createdAt: Date;

  // 关联关系
  @BelongsTo(() => BacktestResult)
  declare backtest: BacktestResult;

  @BelongsTo(() => Stock)
  declare stock: Stock;
}