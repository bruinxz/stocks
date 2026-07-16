-- Ownership-safe rollback for durable refresh-token sessions.

BEGIN;

DO $ownership$
DECLARE
  expected_marker CONSTANT TEXT := 'migration:2026-07-16-auth-refresh-sessions';
  expected_columns CONSTANT TEXT[] := ARRAY[
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
    'updated_at'
  ];
  table_oid OID;
  actual_columns TEXT[];
  owned_constraint_count INTEGER;
  total_constraint_count INTEGER;
  table_index_count INTEGER;
BEGIN
  SELECT c.oid
    INTO table_oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relkind = 'r'
    AND c.relname = 'auth_refresh_sessions';

  IF table_oid IS NULL
     OR obj_description(table_oid, 'pg_class') IS DISTINCT FROM expected_marker THEN
    RAISE EXCEPTION 'auth refresh session rollback ownership mismatch';
  END IF;

  SELECT ARRAY_AGG(a.attname ORDER BY a.attnum)
    INTO actual_columns
  FROM pg_attribute a
  WHERE a.attrelid = table_oid
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF actual_columns IS DISTINCT FROM expected_columns THEN
    RAISE EXCEPTION 'auth refresh session rollback column ownership mismatch';
  END IF;

  SELECT COUNT(*)
    INTO total_constraint_count
  FROM pg_constraint c
  WHERE c.conrelid = table_oid;

  SELECT COUNT(*)
    INTO owned_constraint_count
  FROM pg_constraint c
  WHERE c.conrelid = table_oid
    AND c.conname IN (
      'pk_auth_refresh_sessions',
      'fk_auth_refresh_sessions_user',
      'uq_auth_refresh_sessions_jti',
      'uq_auth_refresh_sessions_token_hash',
      'ck_auth_refresh_sessions_revocation_reason',
      'ck_auth_refresh_sessions_session_uuid_v4',
      'ck_auth_refresh_sessions_jti_uuid_v4',
      'ck_auth_refresh_sessions_family_uuid_v4',
      'ck_auth_refresh_sessions_token_hash',
      'ck_auth_refresh_sessions_lifetime',
      'ck_auth_refresh_sessions_revocation_state',
      'ck_auth_refresh_sessions_replacement',
      'ck_auth_refresh_sessions_updated_at'
    );

  IF total_constraint_count <> 13 OR owned_constraint_count <> 13 THEN
    RAISE EXCEPTION 'auth refresh session rollback constraint ownership mismatch';
  END IF;

  SELECT COUNT(*)
    INTO table_index_count
  FROM pg_index i
  WHERE i.indrelid = table_oid;

  IF table_index_count <> 5
     OR to_regclass('ix_auth_refresh_sessions_active_family') IS NULL
     OR to_regclass('ix_auth_refresh_sessions_user_expiry') IS NULL THEN
    RAISE EXCEPTION 'auth refresh session rollback index ownership mismatch';
  END IF;
END;
$ownership$;

DROP TABLE auth_refresh_sessions;

COMMIT;
