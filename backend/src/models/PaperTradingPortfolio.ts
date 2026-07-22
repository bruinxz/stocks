import {
  Table,
  Column,
  Model,
  DataType,
  CreatedAt,
  UpdatedAt,
  ForeignKey,
  BelongsTo,
  HasMany,
} from 'sequelize-typescript';
import { User } from './User';
import { PaperTradingPosition } from './PaperTradingPosition';
import { PaperTradingTrade } from './PaperTradingTrade';
import { PaperTradingSnapshot } from './PaperTradingSnapshot';

@Table({
  tableName: 'paper_trading_portfolios',
  timestamps: true,
})
export class PaperTradingPortfolio extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    field: 'user_id',
  })
  declare user_id: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    comment: '模拟盘名称',
  })
  declare name: string;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 200000.0,
    field: 'initial_capital',
    comment: '初始资金',
  })
  declare initial_capital: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 200000.0,
    field: 'current_cash',
    comment: '当前可用资金',
  })
  declare current_cash: number;

  @Column({
    type: DataType.DECIMAL(15, 2),
    allowNull: false,
    defaultValue: 200000.0,
    field: 'total_value',
    comment: '当前总资产 (资金 + 持仓市值)',
  })
  declare total_value: number;

  @Column({
    type: DataType.STRING(32),
    allowNull: false,
    defaultValue: 'research_loop',
    field: 'portfolio_type',
    comment: '当前产品唯一用途：research_loop 研究闭环模拟盘',
  })
  declare portfolio_type: string;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: true,
    field: 'is_active',
    comment: '是否处于激活状态',
  })
  declare is_active: boolean;

  // AT-1 (2026-06-22) — 模拟盘 CRUD + 策略/因子可视化
  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'description',
    comment: '模拟盘描述 (用户自由填写)',
  })
  declare description: string | null;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'strategy_keys',
    comment: '研究闭环保留字段；当前执行器不读取历史策略 key',
  })
  declare strategy_keys: string[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'enabled_factors',
    comment: '该模拟盘启用的因子 key 列表. 空数组 = 策略默认.',
  })
  declare enabled_factors: string[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'risk_profile_overrides',
    comment: 'per-portfolio 风控参数 override (空对象 = 用 user.risk_config / 全局默认).',
  })
  declare risk_profile_overrides: Record<string, unknown>;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'auto_trade_enabled',
    comment: '是否参与研究闭环每日模拟执行',
  })
  declare auto_trade_enabled: boolean;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  @HasMany(() => PaperTradingPosition)
  declare positions: PaperTradingPosition[];

  @HasMany(() => PaperTradingTrade)
  declare trades: PaperTradingTrade[];

  @HasMany(() => PaperTradingSnapshot)
  declare snapshots: PaperTradingSnapshot[];
}
