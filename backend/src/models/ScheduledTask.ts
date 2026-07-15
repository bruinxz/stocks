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
  declare cron_expression: string;

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
  declare is_active: boolean;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_run_at',
  })
  declare last_run_at: Date;

  @Column({
    type: DataType.STRING(50),
    allowNull: true,
    field: 'last_run_status',
    comment: 'SUCCESS, FAILED, RUNNING, SKIPPED',
  })
  declare last_run_status: string;

  /**
   * Batch T (2026-06-17, C-S4): 连续失败计数. markTaskFinished('FAILED') 时 +1,
   * 成功时清零. ≥ FAILURE_KILL_THRESHOLD (默认 5) 时自动 is_active=false + 写
   * RiskAlert HIGH 让运维感知. 防告警淹没 + 防"task 一直 fail 仍每 N 分钟 retry"
   * 的资源浪费.
   */
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'consecutive_failure_count',
  })
  declare consecutive_failure_count: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
