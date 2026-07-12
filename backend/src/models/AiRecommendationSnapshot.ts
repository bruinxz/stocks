import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'ai_recommendation_snapshot',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_ai_recommendation_snapshot_replay',
      unique: true,
      fields: ['profile', 'market_scope', 'as_of_utc', 'output_fingerprint'],
    },
    {
      name: 'uq_ai_recommendation_snapshot_idempotency',
      unique: true,
      fields: ['idempotency_key'],
    },
    {
      name: 'ix_ai_recommendation_snapshot_latest',
      fields: ['profile', 'market_scope', 'as_of_utc'],
    },
    {
      name: 'ix_ai_recommendation_snapshot_day',
      fields: ['trading_day', 'profile', 'market_scope'],
    },
  ],
})
export class AiRecommendationSnapshot extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'snapshot_id',
  })
  declare snapshotId: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'as_of_utc' })
  declare asOfUtc: Date;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'trading_day' })
  declare tradingDay: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'profile' })
  declare profile:
    | 'us_preferred'
    | 'multibagger'
    | 'japan_blue_chip'
    | 'japan_multibagger'
    | 'korea_semiconductor_chain'
    | 'korea_multibagger';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'market_scope' })
  declare marketScope: 'cn_a' | 'us' | 'jp' | 'kr';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'contract_version' })
  declare contractVersion: '0.3.1';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'profile_version' })
  declare profileVersion: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'pipeline_version' })
  declare pipelineVersion: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'model_version' })
  declare modelVersion: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'strategy_version' })
  declare strategyVersion: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'rule_bundle_hash' })
  declare ruleBundleHash: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'template_hash' })
  declare templateHash: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'disclaimer_hash' })
  declare disclaimerHash: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'input_fingerprint' })
  declare inputFingerprint: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'output_fingerprint' })
  declare outputFingerprint: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'idempotency_key' })
  declare idempotencyKey: string;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'item_count' })
  declare itemCount: number;

  @Column({ type: DataType.JSONB, allowNull: false, field: 'envelope_json' })
  declare envelopeJson: Record<string, unknown>;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'created_at',
  })
  declare createdAt: Date;
}
