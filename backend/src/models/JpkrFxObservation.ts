import { Column, DataType, Model, Table } from 'sequelize-typescript';

@Table({
  tableName: 'jpkr_fx_observation',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_jpkr_fx_identity',
      unique: true,
      fields: ['pair', 'direction', 'observation_day', 'source_kind', 'source_version'],
    },
    {
      name: 'ix_jpkr_fx_pair_day',
      fields: ['pair', 'observation_day', 'available_at_utc'],
    },
    { name: 'ix_jpkr_fx_pit', fields: ['available_at_utc', 'pair'] },
  ],
})
export class JpkrFxObservation extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'jpkr_fx_observation_id',
  })
  declare jpkrFxObservationId: string;

  @Column({ type: DataType.STRING(8), allowNull: false, field: 'pair' })
  declare pair: 'USDJPY' | 'USDKRW';

  @Column({ type: DataType.STRING(40), allowNull: false, field: 'direction' })
  declare direction: 'LOCAL_PER_USD_WITH_RECIPROCAL';

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'observation_day' })
  declare observationDay: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'effective_at_utc' })
  declare effectiveAtUtc: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'available_at_utc' })
  declare availableAtUtc: Date;

  @Column({ type: DataType.DECIMAL(24, 10), allowNull: false, field: 'local_per_usd' })
  declare localPerUsd: string;

  @Column({ type: DataType.DECIMAL(24, 14), allowNull: false, field: 'usd_per_local' })
  declare usdPerLocal: string;

  @Column({ type: DataType.DECIMAL(18, 8), allowNull: true, field: 'change_pct' })
  declare changePct: string | null;

  @Column({ type: DataType.STRING(32), allowNull: false, field: 'source_kind' })
  declare sourceKind: 'BOJ' | 'BOK';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_document_id' })
  declare sourceDocumentId: string;

  @Column({ type: DataType.STRING(255), allowNull: false, field: 'source_version' })
  declare sourceVersion: string;

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
