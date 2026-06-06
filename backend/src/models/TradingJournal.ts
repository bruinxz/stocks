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
    field: 'user_id',
  })
  declare user_id: number;

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
    field: 'market_summary',
    comment: '大盘整体表现总结 (由 AI 生成)',
  })
  declare market_summary: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'portfolio_analysis',
    comment: '个人持仓/模拟盘表现分析 (由 AI 结合用户持仓生成)',
  })
  declare portfolio_analysis: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'action_plan',
    comment: 'AI 明日交易建议或注意事项',
  })
  declare action_plan: string;

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

  /**
   * 用户手动追加的复盘手记 (US-017)。
   *
   * 数据 shape: `{ content: string, created_at: ISO8601 }[]`，按 created_at
   * 升序保存。每次 `POST /api/journals/:date/notes` 在数组末尾 append 一条。
   * 不允许在前端原地编辑既有 note —— 历史心路只允许追加，不允许改写
   * （类似 git commit 不允许修改既有 hash）。
   */
  @Column({
    type: DataType.JSONB,
    allowNull: true,
    field: 'user_notes',
    defaultValue: [],
    comment: '用户追加的复盘手记 [{content, created_at}]',
  })
  declare user_notes: Array<{ content: string; created_at: string }>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
