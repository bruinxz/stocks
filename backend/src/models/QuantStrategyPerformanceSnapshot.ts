import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_strategy_performance_snapshots',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['strategy_key'] },
    { fields: ['snapshot_date'] },
    { fields: ['source_type'] },
    {
      name: 'uniq_qs_perf_strategy_date_source_horizon',
      unique: true,
      fields: ['strategy_key', 'snapshot_date', 'source_type', 'horizon'],
    },
  ],
})
export class QuantStrategyPerformanceSnapshot extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'snapshot_date' })
  declare snapshot_date: string;

  @Column({
    type: DataType.STRING(50),
    allowNull: false,
    defaultValue: 'paper_trading',
    field: 'source_type',
  })
  declare source_type: string;

  @Column({ type: DataType.STRING(20), allowNull: false, defaultValue: 'all' })
  declare horizon: string;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'sample_count' })
  declare sample_count: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'closed_count' })
  declare closed_count: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'open_count' })
  declare open_count: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'avg_return_pct' })
  declare avg_return_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'avg_excess_return_pct' })
  declare avg_excess_return_pct?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'win_rate' })
  declare win_rate?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'excess_win_rate' })
  declare excess_win_rate?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'profit_factor' })
  declare profit_factor?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'quality_score' })
  declare quality_score?: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metrics: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
