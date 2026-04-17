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
      fields: ['createdAt'],
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
  result?: any;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    comment: '错误信息',
  })
  error?: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    comment: '影响的股票数量',
  })
  affectedStocks?: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    comment: '插入的数据条数',
  })
  insertedRecords?: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    comment: '开始时间',
  })
  startedAt?: Date;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    comment: '完成时间',
  })
  completedAt?: Date;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
