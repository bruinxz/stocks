import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'jpkr_disclosure_event',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_jpkr_disclosure_source_version',
      unique: true,
      fields: ['source_kind', 'source_document_id', 'source_version'],
    },
    {
      name: 'ix_jpkr_disclosure_ticker_time',
      fields: ['market_scope', 'ticker', 'event_time_utc'],
    },
    {
      name: 'ix_jpkr_disclosure_pit',
      fields: ['available_at_utc', 'market_scope', 'ticker'],
    },
  ],
})
export class JpkrDisclosureEvent extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'jpkr_disclosure_event_id',
  })
  declare jpkrDisclosureEventId: string;

  @Column({ type: DataType.STRING(8), allowNull: false, field: 'market_scope' })
  declare marketScope: 'jp' | 'kr';

  @Column({ type: DataType.TEXT, allowNull: true, field: 'provider_market_label' })
  declare providerMarketLabel: string | null;

  @Column({ type: DataType.STRING(32), allowNull: false, field: 'ticker' })
  declare ticker: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'disclosure_kind' })
  declare disclosureKind: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'event_headline_local' })
  declare eventHeadlineLocal: string;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'event_body_url' })
  declare eventBodyUrl: string | null;

  @Column({ type: DataType.DATE, allowNull: false, field: 'event_time_utc' })
  declare eventTimeUtc: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'available_at_utc' })
  declare availableAtUtc: Date;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'source_kind' })
  declare sourceKind: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_document_id' })
  declare sourceDocumentId: string;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'source_version' })
  declare sourceVersion: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'source_payload' })
  declare sourcePayload: Record<string, unknown>;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'fact_hash' })
  declare factHash: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'ingested_at',
  })
  declare ingestedAt: Date;
}
