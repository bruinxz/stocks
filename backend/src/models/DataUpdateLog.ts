import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

export enum UpdateType {
  DAILY_UPDATE = 'daily_update', // 每日数据更新
  NEW_STOCKS_SYNC = 'new_stocks_sync', // 新股同步
  WEEKLY_COMPLETENESS_CHECK = 'weekly_completeness_check', // 周数据完整性检查
  MANUAL_SYNC = 'manual_sync', // 手动同步
  BULK_SYNC_CUSTOM = 'bulk_sync_custom', // 批量同步自定义任务
}

export enum UpdateStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Table({
  tableName: 'data_update_logs',
  timestamps: true,
  indexes: [
    {
      fields: ['type', 'status'],
    },
    {
      fields: ['created_at'],
    },
    {
      fields: ['date'],
    },
  ],
})
export class DataUpdateLog extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    comment: '更新类型',
  })
  declare type: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: UpdateStatus.PENDING,
    comment: '更新状态',
  })
  declare status: string;

  @Column({
    type: DataType.DATEONLY,
    allowNull: false,
    comment: '更新日期（用于检查当天是否已更新）',
  })
  declare date: string;

  @Column({
    type: DataType.JSONB,
    allowNull: true,
    comment: '更新结果详情',
  })
  declare result?: any;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '错误信息',
  })
  declare error?: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'affected_stocks',
    comment: '影响的股票数量',
  })
  declare affectedStocks?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'inserted_records',
    comment: '插入的数据条数',
  })
  declare insertedRecords?: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'started_at',
    comment: '开始时间',
  })
  declare startedAt?: Date;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'completed_at',
    comment: '完成时间',
  })
  declare completedAt?: Date;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare createdAt: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updatedAt: Date;
}
