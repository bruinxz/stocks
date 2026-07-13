import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { AiRecommendationSnapshot } from './AiRecommendationSnapshot';

@Table({
  tableName: 'ai_recommendation_item',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_ai_recommendation_item_ticker',
      unique: true,
      fields: ['snapshot_id', 'ticker'],
    },
    {
      name: 'uq_ai_recommendation_item_rank',
      unique: true,
      fields: ['snapshot_id', 'sort_rank'],
    },
    {
      name: 'uq_ai_recommendation_item_hash',
      unique: true,
      fields: ['snapshot_id', 'recommendation_hash'],
    },
    {
      name: 'ix_ai_recommendation_item_snapshot_rank',
      fields: ['snapshot_id', 'sort_rank'],
    },
  ],
})
export class AiRecommendationItem extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'item_id',
  })
  declare itemId: string;

  @ForeignKey(() => AiRecommendationSnapshot)
  @Column({ type: DataType.UUID, allowNull: false, field: 'snapshot_id' })
  declare snapshotId: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'ticker' })
  declare ticker: string;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'sort_rank' })
  declare sortRank: number;

  @Column({ type: DataType.JSONB, allowNull: false, field: 'recommendation_json' })
  declare recommendationJson: Record<string, unknown>;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'recommendation_jcs' })
  declare recommendationJcs: string;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'recommendation_hash' })
  declare recommendationHash: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'rating_band' })
  declare ratingBand: 'A' | 'B' | 'C' | 'D' | 'F';

  @Column({ type: DataType.DECIMAL(5, 1), allowNull: false, field: 'conviction_final' })
  declare convictionFinal: string;

  @Column({
    type: DataType.TEXT,
    allowNull: false,
    field: 'risk_gate_status',
    validate: { isIn: [['GREEN']] },
  })
  declare riskGateStatus: 'GREEN';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'size_hint_tier' })
  declare sizeHintTier: 'TIER_5' | 'TIER_3' | 'TIER_2' | 'TIER_1' | 'SKIP';

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'created_at',
  })
  declare createdAt: Date;

  @BelongsTo(() => AiRecommendationSnapshot)
  declare snapshot: AiRecommendationSnapshot;
}
