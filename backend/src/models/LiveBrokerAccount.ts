import { Table, Column, Model, DataType, CreatedAt, UpdatedAt, Index } from 'sequelize-typescript';

@Table({
  tableName: 'live_broker_accounts',
  timestamps: true,
  underscored: true,
  indexes: [
    { unique: true, fields: ['user_id', 'broker_key'] },
    { fields: ['user_id'] },
    { fields: ['broker_key'] },
    { fields: ['connection_status'] },
    { fields: ['is_active'] },
  ],
})
export class LiveBrokerAccount extends Model {
  @Column({ type: DataType.INTEGER, primaryKey: true, autoIncrement: true })
  declare id: number;

  @Index
  @Column({ type: DataType.INTEGER, allowNull: false, field: 'user_id' })
  declare user_id: number;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'broker_key' })
  declare broker_key: string;

  @Column({ type: DataType.STRING(120), allowNull: false, field: 'broker_name' })
  declare broker_name: string;

  @Column({ type: DataType.STRING(120), allowNull: true, field: 'account_alias' })
  declare account_alias?: string;

  @Column({ type: DataType.STRING(80), allowNull: false, field: 'account_no_masked' })
  declare account_no_masked: string;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'read_only', field: 'permission_scope' })
  declare permission_scope: string;

  @Column({ type: DataType.STRING(40), allowNull: false, defaultValue: 'not_bound', field: 'connection_status' })
  declare connection_status: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: true, field: 'is_active' })
  declare is_active: boolean;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'readonly_enabled' })
  declare readonly_enabled: boolean;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false, field: 'trading_enabled' })
  declare trading_enabled: boolean;

  @Column({ type: DataType.DATE, allowNull: true, field: 'last_sync_at' })
  declare last_sync_at?: Date;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {}, field: 'risk_config' })
  declare risk_config: Record<string, any>;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: {} })
  declare metadata: Record<string, any>;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;
}
