import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'jpkr_security_master',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_jpkr_security_source_version',
      unique: true,
      fields: ['source_kind', 'source_document_id', 'source_version', 'ticker'],
    },
    {
      name: 'ix_jpkr_security_lookup',
      fields: ['market_scope', 'exchange', 'ticker', 'available_at_utc'],
    },
    {
      name: 'ix_jpkr_security_active',
      fields: ['market_scope', 'is_active', 'ticker'],
    },
  ],
})
export class JpkrSecurityMaster extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'security_id',
  })
  declare securityId: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'market_scope' })
  declare marketScope: 'jp' | 'kr';

  @Column({ type: DataType.TEXT, allowNull: true, field: 'provider_market_label' })
  declare providerMarketLabel: string | null;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'exchange' })
  declare exchange: 'tse' | 'ose' | 'krx' | 'kosdaq';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'ticker' })
  declare ticker: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'ticker_name_local' })
  declare tickerNameLocal: string;

  @Column({ type: DataType.TEXT, allowNull: true, field: 'ticker_name_en' })
  declare tickerNameEn: string | null;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'currency' })
  declare currency: 'JPY' | 'KRW';

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'listing_day' })
  declare listingDay: string | null;

  @Column({ type: DataType.DATEONLY, allowNull: true, field: 'delisting_day' })
  declare delistingDay: string | null;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: true,
    field: 'is_active',
  })
  declare isActive: boolean;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_kind' })
  declare sourceKind: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_document_id' })
  declare sourceDocumentId: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_version' })
  declare sourceVersion: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'available_at_utc' })
  declare availableAtUtc: Date;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'fact_hash' })
  declare factHash: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'source_payload' })
  declare sourcePayload: Record<string, unknown>;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'created_at',
  })
  declare createdAt: Date;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'updated_at',
  })
  declare updatedAt: Date;
}
