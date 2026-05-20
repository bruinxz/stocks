import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_strategies',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['strategy_key'] },
    { fields: ['category'] },
    { fields: ['enabled'] },
  ],
})
export class QuantStrategyModel extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'strategy_key' })
  declare strategy_key: string;

  @Column({ type: DataType.STRING(120), allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare description?: string;

  @Column({ type: DataType.STRING(40), allowNull: false })
  declare category: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'default_params' })
  declare default_params: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'execution_policy' })
  declare execution_policy: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'environment_policy' })
  declare environment_policy: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'lifecycle_policy' })
  declare lifecycle_policy: Record<string, any>;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true })
  declare enabled: boolean;

  @Column({ type: DataType.STRING(20), allowNull: true, field: 'risk_level' })
  declare risk_level?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare tags: string[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'latest_metrics' })
  declare latest_metrics: Record<string, any>;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare notes?: string;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'display_order' })
  declare display_order?: number;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
