import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

export enum DataSourceStatus {
  HEALTHY = 'healthy',
  DEGRADED = 'degraded',
  UNHEALTHY = 'unhealthy',
  DISABLED = 'disabled',
  UNKNOWN = 'unknown',
}

@Table({
  tableName: 'data_source_health',
  timestamps: true,
  underscored: true,
  indexes: [
    {
      unique: true,
      fields: ['provider_name'],
    },
    {
      fields: ['status'],
    },
    {
      fields: ['priority'],
    },
    {
      fields: ['last_checked_at'],
    },
  ],
})
export class DataSourceHealth extends Model {
  @Column({
    type: DataType.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  })
  declare id: number;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    field: 'provider_name',
    comment: '数据源唯一名称',
  })
  declare provider_name: string;

  @Column({
    type: DataType.STRING(100),
    allowNull: false,
    field: 'provider_label',
    comment: '数据源展示名称',
  })
  declare provider_label: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    field: 'provider_type',
    comment: '数据源类型，例如 api、python、analysis',
  })
  declare provider_type: string;

  @Column({
    type: DataType.STRING(30),
    allowNull: false,
    defaultValue: DataSourceStatus.UNKNOWN,
    comment: '健康状态',
  })
  declare status: string;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 100,
    comment: 'fallback 优先级，数值越小优先级越高',
  })
  declare priority: number;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'is_enabled',
    comment: '是否启用',
  })
  declare is_enabled: boolean;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: [],
    field: 'supported_features',
    comment: '支持的能力列表',
  })
  declare supported_features: string[];

  @Column({
    type: DataType.DECIMAL(6, 2),
    allowNull: false,
    defaultValue: 60,
    field: 'health_score',
    comment: '健康评分 0-100',
  })
  declare health_score: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'success_count',
    comment: '成功次数',
  })
  declare success_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'failure_count',
    comment: '失败次数',
  })
  declare failure_count: number;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'consecutive_failures',
    comment: '连续失败次数',
  })
  declare consecutive_failures: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_success_at',
    comment: '最近成功时间',
  })
  declare last_success_at?: Date;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_failure_at',
    comment: '最近失败时间',
  })
  declare last_failure_at?: Date;

  @Column({
    type: DataType.INTEGER,
    allowNull: true,
    field: 'last_latency_ms',
    comment: '最近一次请求耗时',
  })
  declare last_latency_ms?: number;

  @Column({
    type: DataType.DATE,
    allowNull: true,
    field: 'last_checked_at',
    comment: '最近检查时间',
  })
  declare last_checked_at?: Date;

  @Column({
    type: DataType.TEXT,
    allowNull: true,
    field: 'last_error',
    comment: '最近错误信息',
  })
  declare last_error?: string;

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    comment: '额外元信息',
  })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
