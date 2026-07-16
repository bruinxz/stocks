import { QueryTypes, Sequelize } from 'sequelize';

const TABLE = 'auth_refresh_sessions';
const MARKER = 'migration:2026-07-16-auth-refresh-sessions';
const EXPECTED_COLUMNS = [
  'session_id',
  'user_id',
  'jti',
  'family_id',
  'token_hash',
  'expires_at',
  'revoked_at',
  'replaced_by_jti',
  'revocation_reason',
  'created_at',
  'updated_at',
] as const;

interface SchemaProbe {
  table_exists: boolean;
  marker: string | null;
  columns: string[] | null;
  constraint_count: string | number;
  index_count: string | number;
  has_active_family_index: boolean;
  has_user_expiry_index: boolean;
}

export class AuthRefreshSessionSchemaError extends Error {
  constructor() {
    super('Required auth refresh-session migration is not applied');
    this.name = 'AuthRefreshSessionSchemaError';
  }
}

export async function authRefreshSessionTableExists(sequelize: Sequelize): Promise<boolean> {
  const rows = (await sequelize.query(
    `SELECT to_regclass('public.${TABLE}') IS NOT NULL AS table_exists`,
    { type: QueryTypes.SELECT }
  )) as Array<{ table_exists: boolean }>;
  return rows.length === 1 && rows[0].table_exists === true;
}

/** Fail closed unless the physical SQL migration contract is exact. */
export async function assertAuthRefreshSessionSchema(sequelize: Sequelize): Promise<void> {
  const rows = (await sequelize.query(
    `
      SELECT
        to_regclass('public.${TABLE}') IS NOT NULL AS table_exists,
        obj_description(to_regclass('public.${TABLE}'), 'pg_class') AS marker,
        (
          SELECT array_agg(a.attname::TEXT ORDER BY a.attnum)
          FROM pg_attribute a
          WHERE a.attrelid = to_regclass('public.${TABLE}')
            AND a.attnum > 0
            AND NOT a.attisdropped
        ) AS columns,
        (
          SELECT COUNT(*)
          FROM pg_constraint c
          WHERE c.conrelid = to_regclass('public.${TABLE}')
        ) AS constraint_count,
        (
          SELECT COUNT(*)
          FROM pg_index i
          WHERE i.indrelid = to_regclass('public.${TABLE}')
        ) AS index_count,
        to_regclass('public.ix_auth_refresh_sessions_active_family') IS NOT NULL
          AS has_active_family_index,
        to_regclass('public.ix_auth_refresh_sessions_user_expiry') IS NOT NULL
          AS has_user_expiry_index
    `,
    { type: QueryTypes.SELECT }
  )) as SchemaProbe[];
  const row = rows[0];
  if (
    !row ||
    row.table_exists !== true ||
    row.marker !== MARKER ||
    JSON.stringify(row.columns) !== JSON.stringify(EXPECTED_COLUMNS) ||
    Number(row.constraint_count) !== 13 ||
    Number(row.index_count) !== 5 ||
    row.has_active_family_index !== true ||
    row.has_user_expiry_index !== true
  ) {
    throw new AuthRefreshSessionSchemaError();
  }
}
