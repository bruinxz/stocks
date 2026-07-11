import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { MultibaggerUniverse } from './MultibaggerUniverse';

@Table({
  tableName: 'multibagger_text_hit',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_multibagger_text_hit_identity',
      unique: true,
      fields: [
        'document_fact_hash',
        'taxonomy_version',
        'term_id',
        'field',
        'start_offset',
        'end_offset',
      ],
    },
    {
      name: 'ix_multibagger_text_hit_ticker',
      fields: ['market_scope', 'ticker', 'available_at_utc'],
    },
    { name: 'ix_multibagger_text_hit_parent', fields: ['multibagger_universe_id'] },
  ],
})
export class MultibaggerTextHit extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'multibagger_text_hit_id',
  })
  declare multibaggerTextHitId: string;

  @ForeignKey(() => MultibaggerUniverse)
  @Column({ type: DataType.UUID, allowNull: false, field: 'multibagger_universe_id' })
  declare multibaggerUniverseId: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'market_scope' })
  declare marketScope: 'cn_a' | 'us' | 'jp' | 'kr';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'ticker' })
  declare ticker: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_document_id' })
  declare sourceDocumentId: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_version' })
  declare sourceVersion: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'document_fact_hash' })
  declare documentFactHash: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'taxonomy_version' })
  declare taxonomyVersion: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'term_id' })
  declare termId: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'hit_kind' })
  declare hitKind: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'field' })
  declare field: 'TITLE' | 'BODY';

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'start_offset' })
  declare startOffset: number;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'end_offset' })
  declare endOffset: number;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'evidence_ref' })
  declare evidenceRef: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'effective_at_utc' })
  declare effectiveAtUtc: Date;

  @Column({ type: DataType.DATE, allowNull: false, field: 'available_at_utc' })
  declare availableAtUtc: Date;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'fact_hash' })
  declare factHash: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'created_at',
  })
  declare createdAt: Date;

  @BelongsTo(() => MultibaggerUniverse)
  declare universe: MultibaggerUniverse;
}
