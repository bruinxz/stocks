import { BelongsTo, Column, DataType, ForeignKey, Model, Table } from 'sequelize-typescript';
import { BacktestPitSnapshot } from './BacktestPitSnapshot';

@Table({
  tableName: 'backtest_pit_holding',
  timestamps: false,
  underscored: true,
  indexes: [
    {
      name: 'uq_backtest_pit_holding_order',
      unique: true,
      fields: ['snapshot_id', 'position_order'],
    },
    {
      name: 'uq_backtest_pit_holding_ticker',
      unique: true,
      fields: ['snapshot_id', 'market_scope', 'ticker'],
    },
    { name: 'ix_pit_holding_snapshot', fields: ['snapshot_id', 'position_order'] },
    {
      name: 'ix_pit_holding_ticker',
      fields: ['market_scope', 'ticker', 'available_at_utc'],
    },
  ],
})
export class BacktestPitHolding extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
    field: 'backtest_pit_holding_id',
  })
  declare backtestPitHoldingId: string;

  @ForeignKey(() => BacktestPitSnapshot)
  @Column({ type: DataType.UUID, allowNull: false, field: 'snapshot_id' })
  declare snapshotId: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'snapshot_as_of_utc' })
  declare snapshotAsOfUtc: Date;

  @Column({ type: DataType.INTEGER, allowNull: false, field: 'position_order' })
  declare positionOrder: number;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'market_scope' })
  declare marketScope: 'cn_a' | 'us' | 'jp' | 'kr';

  @Column({ type: DataType.TEXT, allowNull: false, field: 'ticker' })
  declare ticker: string;

  @Column({ type: DataType.DECIMAL(18, 10), allowNull: false, field: 'weight' })
  declare weight: string;

  @Column({ type: DataType.DECIMAL(24, 10), allowNull: false, field: 'return_since_entry' })
  declare returnSinceEntry: string;

  @Column({
    type: DataType.BOOLEAN,
    allowNull: false,
    defaultValue: false,
    field: 'is_stale',
  })
  declare isStale: boolean;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_kind' })
  declare sourceKind: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_document_id' })
  declare sourceDocumentId: string;

  @Column({ type: DataType.TEXT, allowNull: false, field: 'source_version' })
  declare sourceVersion: string;

  @Column({ type: DataType.DATE, allowNull: false, field: 'available_at_utc' })
  declare availableAtUtc: Date;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'lineage' })
  declare lineage: Record<string, unknown>;

  @Column({ type: DataType.STRING(64), allowNull: false, field: 'fact_hash' })
  declare factHash: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
    defaultValue: DataType.NOW,
    field: 'created_at',
  })
  declare createdAt: Date;

  @BelongsTo(() => BacktestPitSnapshot)
  declare snapshot: BacktestPitSnapshot;
}
