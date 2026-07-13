import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'multibagger_candidate_snapshot',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_multibagger_candidate_snapshot',
      unique: true,
      fields: ['market_scope', 'exchange', 'ticker', 'as_of_utc', 'strategy_version'],
    },
    {
      name: 'ix_multibagger_candidate_as_of',
      fields: ['as_of_utc', 'market_scope'],
    },
    {
      name: 'ix_multibagger_candidate_filters',
      fields: ['stage', 'conclusion', 'market_scope', 'as_of_utc'],
    },
  ],
})
export class MultibaggerCandidateSnapshot extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'multibagger_candidate_snapshot_id',
  })
  declare multibaggerCandidateSnapshotId: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'market_scope' })
  declare marketScope: 'cn_a' | 'us' | 'jp' | 'kr';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'exchange' })
  declare exchange: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'ticker' })
  declare ticker: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'as_of_utc' })
  declare asOfUtc: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'available_at_utc' })
  declare availableAtUtc: Date;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'stage' })
  declare stage: 'seed' | 'early' | 'growth' | 'break_below' | 'deep';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'conclusion' })
  declare conclusion: 'MULTIBAGGER_2X' | 'MULTIBAGGER_5X' | 'MULTIBAGGER_10X' | 'SKIP';

  @Column({ type: DataType.JSONB, allowNull: true, field: 'score' })
  declare score: Record<string, unknown> | null;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'rating' })
  declare rating: 'A' | 'B' | 'C' | 'D' | 'F' | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'conviction' })
  declare conviction: Record<string, unknown> | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'risk_gate' })
  declare riskGate: Record<string, unknown> | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'entry_plan' })
  declare entryPlan: Record<string, unknown> | null;

  @Column({ type: DataType.JSONB, allowNull: true, field: 'latest_catalyst' })
  declare latestCatalyst: unknown;

  @Column({ type: DataType.JSONB, allowNull: false, field: 'source_fact_hashes' })
  declare sourceFactHashes: string[];

  @Column({ type: DataType.TEXT, allowNull: false, field: 'strategy_version' })
  declare strategyVersion: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'classification_policy_version' })
  declare classificationPolicyVersion: string;

  @Column({ type: DataType.JSONB, allowNull: false, field: 'classification_reason_codes' })
  declare classificationReasonCodes: string[];

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'fact_hash' })
  declare factHash: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'created_at',
  })
  declare createdAt: Date;
}
