import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'scheduled_tasks',
  timestamps: true,
})
export class ScheduledTask extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    unique: true,
  })
  declare name: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'cron_expression',
    comment: 'cron表达式',
  })
  declare cronExpression: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    comment: '任务类型 (e.g., SYNC_ALL_STOCKS, SYNC_HISTORY, AI_DAILY_SCREENER)',
  })
  declare type: string;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    comment: '任务执行参数',
  })
  declare parameters: any;

  @Column({
    type: DataType.BOOLEAN,
    defaultValue: true,
    field: 'is_active',
  })
  declare isActive: boolean;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_run_at',
  })
  declare lastRunAt: Date;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'last_run_status',
    comment: 'SUCCESS, FAILED, RUNNING',
  })
  declare lastRunStatus: string;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updatedAt: Date;
}
