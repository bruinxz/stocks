import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { User } from './User';

export type AuthRefreshSessionRevocationReason =
  | 'rotated'
  | 'logout'
  | 'reuse_detected'
  | 'expired'
  | 'user_inactive'
  | 'password_changed';

/**
 * Server-side refresh-token state.
 *
 * Raw bearer tokens must never be persisted. token_hash is the lowercase
 * SHA-256 digest used to bind a signed JWT to exactly one durable session.
 */
@Table({
  tableName: 'auth_refresh_sessions',
  timestamps: true,
  indexes: [
    { name: 'uq_auth_refresh_sessions_jti', unique: true, fields: ['jti'] },
    {
      name: 'uq_auth_refresh_sessions_token_hash',
      unique: true,
      fields: ['token_hash'],
    },
    {
      name: 'ix_auth_refresh_sessions_active_family',
      fields: ['family_id'],
      where: { revoked_at: null },
    },
    {
      name: 'ix_auth_refresh_sessions_user_expiry',
      fields: ['user_id', 'expires_at'],
    },
  ],
})
export class AuthRefreshSession extends Model {
  @Column({
    type: DataType.UUID,
    primaryKey: true,
    defaultValue: DataType.UUIDV4,
  })
  declare session_id: string;

  @ForeignKey(() => User)
  @Column({
    type: DataType.INTEGER,
    allowNull: false,
  })
  declare user_id: number;

  @Column({
    type: DataType.UUID,
    allowNull: false,
  })
  declare jti: string;

  @Column({
    type: DataType.UUID,
    allowNull: false,
  })
  declare family_id: string;

  @Column({
    type: DataType.CHAR(64),
    allowNull: false,
  })
  declare token_hash: string;

  @Column({
    type: DataType.DATE,
    allowNull: false,
  })
  declare expires_at: Date;

  @Column({
    type: DataType.DATE,
    allowNull: true,
  })
  declare revoked_at: Date | null;

  @Column({
    type: DataType.UUID,
    allowNull: true,
  })
  declare replaced_by_jti: string | null;

  @Column({
    type: DataType.STRING(32),
    allowNull: true,
  })
  declare revocation_reason: AuthRefreshSessionRevocationReason | null;

  @CreatedAt
  @Column({ field: 'created_at' })
  declare created_at: Date;

  @UpdatedAt
  @Column({ field: 'updated_at' })
  declare updated_at: Date;

  @BelongsTo(() => User)
  declare user: User;
}
