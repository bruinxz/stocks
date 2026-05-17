import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_strategy_weights',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['strategy_key'] },
    { fields: ['weight'] },
    { fields: ['action'] },
  ],
})
export class QuantStrategyWeight extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'strategy_name' })
  declare strategy_name?: string;

  @Column({ type: DataType.DECIMAL(10, 4), allowNull: false, defaultValue: 1 })
  declare weight: number;

  @Column({ type: DataType.STRING(30), allowNull: false, defaultValue: 'observe' })
  declare action: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'quality_score' })
  declare quality_score?: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'sample_count' })
  declare sample_count: number;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0, field: 'closed_count' })
  declare closed_count: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason?: string;

  @Column({ type: DataType.DATE, allowNull: true, field: 'last_evaluated_at' })
  declare last_evaluated_at?: Date;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metrics: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
