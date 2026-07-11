import { Column, DataType, HasMany, Model, Table } from 'sequelize-typescript';
import { BacktestPitHolding } from './BacktestPitHolding';

@Table({
  tableName: 'backtest_pit_snapshot',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_backtest_pit_exact_as_of',
      unique: true,
      fields: ['strategy', 'as_of_utc'],
    },
    {
      name: 'uq_backtest_pit_snapshot_as_of',
      unique: true,
      fields: ['snapshot_id', 'as_of_utc'],
    },
    { name: 'ix_pit_strategy_as_of', fields: ['strategy', 'as_of_utc'] },
    { name: 'ix_pit_snapshot_day', fields: ['strategy', 'snapshot_day'] },
  ],
})
export class BacktestPitSnapshot extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'snapshot_id',
  })
  declare snapshotId: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'strategy' })
  declare strategy: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'as_of_utc' })
  declare asOfUtc: Date;

  @Column({ type: DataType.DATEONLY, allowNull: false, field: 'snapshot_day' })
  declare snapshotDay: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'published_at_utc',
  })
  declare publishedAtUtc: Date;

  @Column({ type: DataType.BOOLEAN, allowNull: false, field: 'is_survivorship_biased' })
  declare isSurvivorshipBiased: boolean;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_delisted_at_as_of',
  })
  declare isDelistedAtAsOf: boolean;

  @Column({ type: DataType.JSONB, allowNull: false, field: 'source_versions' })
  declare sourceVersions: Record<string, string>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'lineage_closure' })
  declare lineageClosure: Record<string, unknown>;

  @Column({ type: DataType.JSONB, allowNull: false, field: 'metrics' })
  declare metrics: Record<string, unknown>;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'fact_hash' })
  declare factHash: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'created_at',
  })
  declare createdAt: Date;

  @HasMany(() => BacktestPitHolding)
  declare holdings: BacktestPitHolding[];
}
