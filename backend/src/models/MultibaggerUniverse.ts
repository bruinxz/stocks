import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'multibagger_universe',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_multibagger_source_fact',
      unique: true,
      fields: [
        'universe_source_kind',
        'record_kind',
        'ticker',
        'source_document_id',
        'source_version',
        'fact_hash',
      ],
    },
    {
      name: 'ix_multibagger_as_of',
      fields: ['as_of_utc', 'market_scope'],
    },
    {
      name: 'ix_multibagger_ticker',
      fields: ['market_scope', 'ticker', 'available_at_utc'],
    },
    {
      name: 'ix_multibagger_source_kind',
      fields: ['universe_source_kind', 'record_kind', 'as_of_utc'],
    },
  ],
})
export class MultibaggerUniverse extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'multibagger_universe_id',
  })
  declare multibaggerUniverseId: string;

  @Column({ type: DataType.STRING(8), allowNull: false, field: 'market_scope' })
  declare marketScope: 'cn_a' | 'us' | 'jp' | 'kr';

  @Column({ type: DataType.TEXT, allowNull: true, field: 'provider_market_label' })
  declare providerMarketLabel: string | null;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'exchange' })
  declare exchange: string;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'ticker' })
  declare ticker: string;

  @Column({ type: DataType.STRING(32), allowNull: false, field: 'record_kind' })
  declare recordKind: 'NEW_LISTING' | 'LIFECYCLE' | 'DAILY' | 'FRENCH_AGGREGATE' | 'TEXT_HIT';

  @Column({ type: DataType.DATE, allowNull: false, field: 'effective_at_utc' })
  declare effectiveAtUtc: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'available_at_utc' })
  declare availableAtUtc: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'as_of_utc' })
  declare asOfUtc: Date;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'universe_source_kind' })
  declare universeSourceKind: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_document_id' })
  declare sourceDocumentId: string;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'source_version' })
  declare sourceVersion: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'features' })
  declare features: Record<string, unknown>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'evidence_refs' })
  declare evidenceRefs: unknown[];

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [], field: 'text_hit_kinds' })
  declare textHitKinds: unknown[];

  @Column({
    type: DataType.JSONB,
    allowNull: false,
    defaultValue: {},
    field: 'fundamental_snapshot',
  })
  declare fundamentalSnapshot: Record<string, unknown>;

  @Column({
    type: DataType.INTEGER,
    allowNull: false,
    defaultValue: 0,
    field: 'filter_pass_bitmap',
  })
  declare filterPassBitmap: number;

  @Column({ type: DataType.DECIMAL(18, 4), allowNull: true, field: 'market_cap_cny_100m' })
  declare marketCapCny100m: string | null;

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
