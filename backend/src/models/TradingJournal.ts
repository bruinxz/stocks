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
  tableName: 'trading_journals',
  timestamps: true,
})
export class TradingJournal extends Model {
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
  })
  declare userId: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    comment: '复盘日期',
  })
  declare date: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    comment: '大盘整体表现总结 (由 AI 生成)',
  })
  declare marketSummary: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    comment: '个人持仓/模拟盘表现分析 (由 AI 结合用户持仓生成)',
  })
  declare portfolioAnalysis: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: 'AI 明日交易建议或注意事项',
  })
  declare actionPlan: string;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    comment: '标签(如: 止损、追高、打板)',
  })
  declare tags: string[];

  @Column({
    type: DataType.STRING(20),
    allowNull: true,
    comment: '情绪状态(如: 平静、焦虑、兴奋)',
  })
  declare mood: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
