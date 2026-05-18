import {
  Table,
  Column,
  Model,
  DataType,
  HasMany,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
} from 'sequelize-typescript';
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
      fields: ['created_at'],
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
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'strategy_config',
    comment: '策略配置',
  })
  declare strategy_config: any;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'start_date',
    comment: '开始日期',
  })
  declare start_date: Date;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'end_date',
    comment: '结束日期',
  })
  declare end_date: Date;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    field: 'initial_capital',
    comment: '初始资金',
  })
  declare initial_capital: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    field: 'final_capital',
    comment: '最终资金',
  })
  declare final_capital: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: false,
    field: 'total_return',
    comment: '总收益率(%)',
  })
  declare total_return: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'annualized_return',
    comment: '年化收益率(%)',
  })
  declare annualized_return: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'sharpe_ratio',
    comment: '夏普比率',
  })
  declare sharpe_ratio: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'sortino_ratio',
    comment: '索提诺比率',
  })
  declare sortino_ratio: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'max_drawdown',
    comment: '最大回撤(%)',
  })
  declare max_drawdown: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'win_rate',
    comment: '胜率(%)',
  })
  declare win_rate: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'profit_loss_ratio',
    comment: '盈亏比',
  })
  declare profit_loss_ratio: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'total_trades',
    defaultValue: 0,
    comment: '总交易次数',
  })
  declare total_trades: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'profit_trades',
    defaultValue: 0,
    comment: '盈利交易次数',
  })
  declare profit_trades: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'loss_trades',
    defaultValue: 0,
    comment: '亏损交易次数',
  })
  declare loss_trades: number;

  @Column({
    type: DataType.STRING(20),
    defaultValue: BacktestStatus.PENDING,
    comment: '回测状态',
    validate: {
      isIn: [Object.values(BacktestStatus)],
    },
  })
  declare status: BacktestStatus;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'error_message',
    comment: '错误信息',
  })
  declare error_message: string;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    field: 'detailed_metrics',
    comment: '详细指标',
  })
  declare detailed_metrics: any;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'annualized_volatility',
    comment: '年化波动率',
  })
  declare annualized_volatility: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'information_ratio',
    comment: '信息比率',
  })
  declare information_ratio: number;

  @Column({
    type: DataType.DECIMAL(10, 4),
    allowNull: true,
    field: 'calmar_ratio',
    comment: '卡玛比率',
  })
  declare calmar_ratio: number;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    field: 'equity_curve',
    comment: '资金曲线',
  })
  declare equity_curve: any;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    field: 'daily_returns',
    comment: '每日收益率',
  })
  declare daily_returns: any;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  // 关联关系
  @HasMany(() => Trade)
  declare trades: Trade[];
}
