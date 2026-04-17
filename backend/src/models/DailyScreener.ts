import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'daily_screeners',
  timestamps: true,
})
export class DailyScreener extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    comment: '评估日期',
  })
  declare date: string;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: '股票代码',
  })
  declare symbol: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    comment: '股票名称',
  })
  declare name: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    comment: 'AI 综合决策 (e.g., STRONG_BUY, BUY, HOLD, SELL)',
  })
  declare decision: string;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '核心看多/看空理由简述',
  })
  declare rationale: string;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    comment: '各维度评分明细 (技术面、基本面、情绪面等)',
  })
  declare scores: any;

  @Column({
    type: DataType.DECIMAL(10, 2),
    allowNull: true,
    comment: 'AI 综合评分 (0-100)',
  })
  declare score: number;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
