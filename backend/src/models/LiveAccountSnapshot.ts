import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'live_account_snapshots',
  timestamps: true,
  underscored: true,
  indexes: [
    { fields: ['user_id'] },
    { fields: ['account_id'] },
    { fields: ['snapshot_time'] },
    { fields: ['account_id', 'snapshot_time'] },
  ],
})
export class LiveAccountSnapshot extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'account_id' })
  declare account_id: number;

  @Column({
    type: DataType.DECIMAL(18, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'total_asset',
  })
  declare total_asset: number;

  @Column({
    type: DataType.DECIMAL(18, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'available_cash',
  })
  declare available_cash: number;

  @Column({
    type: DataType.DECIMAL(18, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'market_value',
  })
  declare market_value: number;

  @Column({
    type: DataType.DECIMAL(18, 2),
    allowNull: false,
    defaultValue: 0,
    field: 'frozen_cash',
  })
  declare frozen_cash: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'total_pnl' })
  declare total_pnl: number;

  @Column({ type: DataType.DECIMAL(18, 2), allowNull: false, defaultValue: 0, field: 'day_pnl' })
  declare day_pnl: number;

  @Column({ type: DataType.DATE, allowNull: false, field: 'snapshot_time' })
  declare snapshot_time: Date;

  @Column({ type: DataType.STRING(80), allowNull: false, defaultValue: 'manual', field: 'source' })
  declare source: string;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'raw_payload' })
  declare raw_payload: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
