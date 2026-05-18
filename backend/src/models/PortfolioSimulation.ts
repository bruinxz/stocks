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
import { User } from './User';

@Table({
  tableName: 'portfolio_simulations',
  timestamps: true,
  indexes: [
    {
      name: 'idx_portfolio_simulations_user_id',
      fields: ['user_id'],
    },
    {
      name: 'idx_portfolio_simulations_created_at',
      fields: ['created_at'],
    },
  ],
})
export class PortfolioSimulation extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
  })
  declare id: string;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'user_id',
    comment: '用户ID',
  })
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.STRING(120),
    allowNull: false,
    comment: '模拟名称',
  })
  declare name: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '模拟说明',
  })
  declare description?: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    comment: '股票代码列表',
  })
  declare symbols: string[];

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    field: 'buy_date',
    comment: '买入日期',
  })
  declare buy_date: Date;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    comment: '持有天数',
  })
  declare days: number;

  @Column({
    type: DataType.DECIMAL(20, 4),
    allowNull: false,
    field: 'initial_capital',
    comment: '初始资金',
  })
  declare initial_capital: number;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    defaultValue: 'equal',
    field: 'allocation_strategy',
    comment: '资金分配策略',
  })
  declare allocation_strategy: string;

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
  declare annualized_return?: number;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    comment: '模拟配置快照',
  })
  declare config: any;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    comment: '摘要结果',
  })
  declare summary: any;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'performance_metrics',
    comment: '绩效指标',
  })
  declare performance_metrics: any;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'daily_returns',
    comment: '每日收益曲线',
  })
  declare daily_returns: any[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    field: 'stock_returns',
    comment: '个股收益明细',
  })
  declare stock_returns: any[];

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
