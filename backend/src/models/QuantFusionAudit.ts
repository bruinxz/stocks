import { Table, Column, Model, DataType, CreatedAt, UpdatedAt } from 'sequelize-typescript';

@Table({
  tableName: 'quant_fusion_audits',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['symbol', 'signal_date'] },
    { fields: ['quant_signal_id'] },
    { fields: ['agent_signal_id'] },
    { fields: ['final_decision'] },
    { fields: ['created_at'] },
  ],
})
export class QuantFusionAudit extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'quant_signal_id' })
  declare quant_signal_id?: number;

  @Column({ type: DataType.INTEGER, allowNull: true, field: 'agent_signal_id' })
  declare agent_signal_id?: number;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'agent_task_id' })
  declare agent_task_id?: string;

  @Column({ type: DataType.STRING(20), allowNull: false })
  declare symbol: string;

  @Column({ type: DataType.STRING(100), allowNull: true })
  declare name?: string;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'signal_date' })
  declare signal_date: string;

  @Column({ type: DataType.STRING(50), allowNull: true, field: 'strategy_key' })
  declare strategy_key?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'strategy_keys' })
  declare strategy_keys: string[];

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'quant_score' })
  declare quant_score?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'agent_score' })
  declare agent_score?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'market_regime_score' })
  declare market_regime_score?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'risk_control_score' })
  declare risk_control_score?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'disagreement_penalty' })
  declare disagreement_penalty?: number;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'final_score' })
  declare final_score?: number;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'quant_decision' })
  declare quant_decision?: string;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'agent_decision' })
  declare agent_decision?: string;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'final_decision' })
  declare final_decision?: string;

  @Column({ type: DataType.STRING(30), allowNull: true, field: 'risk_level' })
  declare risk_level?: string;

  @Column({ type: DataType.DECIMAL(12, 4), allowNull: true, field: 'current_price' })
  declare current_price?: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare rationale?: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
