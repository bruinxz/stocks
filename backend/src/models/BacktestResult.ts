import { Table, Column, Model, DataType, HasMany, CreatedAt, UpdatedAt, ForeignKey, BelongsTo } from 'sequelize-typescript';
import { Trade } from './Trade';
import { User } from './User';

export enum BacktestStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Table({
  tableName: 'backtest_results',
  timestamps: true,
  indexes: [
    {
      name: 'idx_backtest_results_created_at',
      fields: ['createdAt'],
    },
    {
      name: 'idx_backtest_results_status',
      fields: ['status'],
    },
  ],
})
export class BacktestResult extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
  })
  declare id: string;

  @Column({
    type: DataType.STRING(200),
    allowNull: false,
    comment: '回测名称',
  })
  declare name: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '回测描述',
  })
  declare description?: string;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    comment: '用户ID',
    field: 'user_id',
  })
  declare userId: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    comment: '策略配置',
  })
  declare strategyConfig: any;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    comment: '开始日期',
  })
  declare startDate: Date;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    comment: '结束日期',
  })
  declare endDate: Date;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    comment: '初始资金',
  })
  declare initialCapital: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    comment: '最终资金',
  })
  finalCapital!: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: false,
    comment: '总收益率(%)',
  })
  totalReturn!: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '年化收益率(%)',
  })
  annualizedReturn?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '夏普比率',
  })
  sharpeRatio?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '索提诺比率',
  })
  sortinoRatio?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '最大回撤(%)',
  })
  maxDrawdown?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '胜率(%)',
  })
  winRate?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '盈亏比',
  })
  profitLossRatio?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: '总交易次数',
  })
  totalTrades!: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: '盈利交易次数',
  })
  profitTrades!: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: '亏损交易次数',
  })
  lossTrades!: number;

  @Column({
    type: DataType.STRING(20),
    defaultValue: BacktestStatus.PENDING,
    comment: '回测状态',
    validate: {
      isIn: [Object.values(BacktestStatus)],
    },
  })
  status!: BacktestStatus;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '错误信息',
  })
  errorMessage?: string;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    comment: '详细指标',
  })
  detailedMetrics?: any;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '年化波动率',
  })
  annualizedVolatility?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '信息比率',
  })
  informationRatio?: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    comment: '卡玛比率',
  })
  calmarRatio?: number;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;

  // 关联关系
  @HasMany(() => Trade)
  declare trades: Trade[];
}