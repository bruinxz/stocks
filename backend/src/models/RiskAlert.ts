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
  tableName: 'risk_alerts',
  timestamps: true,
})
export class RiskAlert extends Model {
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
  declare userId: number;

  @BelongsTo(() => User)
  declare user: User;

  @Column({
    type: DataType.STRING(20),
    allowNull: false,
    comment: '触发告警的股票代码',
  })
  declare symbol: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    comment: '触发告警的股票名称',
  })
  declare name: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    comment: '告警级别 (e.g., HIGH, MEDIUM, LOW)',
  })
  declare level: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    comment: '告警详细内容，如 AI 建议卖出或跌破支撑位等',
  })
  declare message: string;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: false,
    field: 'is_read',
    comment: '是否已读',
  })
  declare isRead: boolean;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updatedAt: Date;
}
