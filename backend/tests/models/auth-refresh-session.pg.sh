#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UP="$ROOT/scripts/migrations/2026-07-16-auth-refresh-sessions.sql"
DOWN="$ROOT/scripts/migrations/2026-07-16-auth-refresh-sessions-rollback.sql"

fail() {
  echo "auth-refresh-session.pg: $*" >&2
  exit 2
}

test "${AUTH_REFRESH_SESSION_PG_DISPOSABLE_TEST:-}" = "1" ||
  fail "set AUTH_REFRESH_SESSION_PG_DISPOSABLE_TEST=1 to enable destructive test"
test -z "${DATABASE_URL:-}" || fail "ambient DATABASE_URL is forbidden"
test -n "${PGHOST:-}" || fail "PGHOST must be an explicit local Unix-socket directory"
case "$PGHOST" in
  /*) ;;
  *) fail "PGHOST must be an absolute local Unix-socket directory" ;;
esac
test -d "$PGHOST" || fail "PGHOST directory does not exist"
test -z "${PGHOSTADDR:-}" || fail "PGHOSTADDR is forbidden"
test -z "${PGSERVICE:-}" || fail "PGSERVICE is forbidden"
test -z "${PGSERVICEFILE:-}" || fail "PGSERVICEFILE is forbidden"
test -z "${PGDATABASE:-}" || fail "PGDATABASE is forbidden"
test -z "${PGPASSWORD:-}" || fail "PGPASSWORD is forbidden"
test -z "${PGPASSFILE:-}" || fail "PGPASSFILE is forbidden"

PGPORT="${PGPORT:-5432}"
case "$PGPORT" in
  *[!0-9]* | "") fail "PGPORT must contain ASCII decimal digits only" ;;
esac
test "${#PGPORT}" -le 5 || fail "PGPORT is out of range"
((10#$PGPORT >= 1 && 10#$PGPORT <= 65535)) || fail "PGPORT is out of range"
test -S "$PGHOST/.s.PGSQL.$((10#$PGPORT))" ||
  fail "PGHOST does not contain the requested local PostgreSQL socket"

CURRENT_USER="$(id -un)"
PGUSER="${PGUSER:-$CURRENT_USER}"
test "$PGUSER" = "$CURRENT_USER" || fail "PGUSER must equal the current OS user"
export PGPORT PGUSER

SUFFIX="$(LC_ALL=C od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
case "$SUFFIX" in
  *[!0-9a-f]* | "") fail "could not generate a safe database suffix" ;;
esac
test "${#SUFFIX}" = "24" || fail "database suffix length is invalid"
DB="stocks_auth_session_$(id -u)_${SUFFIX}"
PRIVATE_PGPASS="$(mktemp "${TMPDIR:-/tmp}/stocks-auth-session.XXXXXX")"
chmod 600 "$PRIVATE_PGPASS"
PGPASSFILE="$PRIVATE_PGPASS"
export PGPASSFILE
PG_ARGS=(-h "$PGHOST" -p "$PGPORT" -U "$PGUSER" --no-password)

cleanup() {
  dropdb "${PG_ARGS[@]}" --if-exists "$DB" >/dev/null 2>&1 || true
  rm -f "$PRIVATE_PGPASS"
}
trap cleanup EXIT

createdb "${PG_ARGS[@]}" "$DB"
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
CREATE TABLE users (id INTEGER PRIMARY KEY);
INSERT INTO users (id) VALUES (7);
SQL
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null

EXPECTED_COLUMNS='{session_id,user_id,jti,family_id,token_hash,expires_at,revoked_at,replaced_by_jti,revocation_reason,created_at,updated_at}'
ACTUAL_COLUMNS="$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT array_agg(column_name ORDER BY ordinal_position)::TEXT
     FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'auth_refresh_sessions'")"
test "$ACTUAL_COLUMNS" = "$EXPECTED_COLUMNS" || fail "physical column contract drifted"

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO auth_refresh_sessions (
  session_id, user_id, jti, family_id, token_hash, expires_at
) VALUES (
  '12345678-1234-4234-8234-567812345678',
  7,
  '22345678-1234-4234-8234-567812345678',
  '32345678-1234-4234-8234-567812345678',
  repeat('a', 64),
  CURRENT_TIMESTAMP + INTERVAL '3 days'
);

DO $constraints$
BEGIN
  BEGIN
    INSERT INTO auth_refresh_sessions (
      session_id, user_id, jti, family_id, token_hash, expires_at
    ) VALUES (
      '42345678-1234-4234-8234-567812345678',
      7,
      '52345678-1234-4234-8234-567812345678',
      '32345678-1234-4234-8234-567812345678',
      repeat('A', 64),
      CURRENT_TIMESTAMP + INTERVAL '3 days'
    );
    RAISE EXCEPTION 'expected uppercase token hash rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO auth_refresh_sessions (
      session_id, user_id, jti, family_id, token_hash, expires_at,
      revocation_reason
    ) VALUES (
      '62345678-1234-4234-8234-567812345678',
      7,
      '72345678-1234-4234-8234-567812345678',
      '32345678-1234-4234-8234-567812345678',
      repeat('b', 64),
      CURRENT_TIMESTAMP + INTERVAL '3 days',
      'logout'
    );
    RAISE EXCEPTION 'expected inconsistent revocation state rejection';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END;
$constraints$;

BEGIN;
UPDATE auth_refresh_sessions
SET revoked_at = CURRENT_TIMESTAMP,
    replaced_by_jti = '82345678-1234-4234-8234-567812345678',
    revocation_reason = 'rotated'
WHERE jti = '22345678-1234-4234-8234-567812345678'
  AND revoked_at IS NULL;
INSERT INTO auth_refresh_sessions (
  session_id, user_id, jti, family_id, token_hash, expires_at
) VALUES (
  '92345678-1234-4234-8234-567812345678',
  7,
  '82345678-1234-4234-8234-567812345678',
  '32345678-1234-4234-8234-567812345678',
  repeat('b', 64),
  CURRENT_TIMESTAMP + INTERVAL '3 days'
);
COMMIT;

DO $rotation$
BEGIN
  IF (
    SELECT COUNT(*)
    FROM auth_refresh_sessions
    WHERE family_id = '32345678-1234-4234-8234-567812345678'
      AND revoked_at IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'rotation did not create one active successor';
  END IF;
END;
$rotation$;

UPDATE auth_refresh_sessions
SET revoked_at = CURRENT_TIMESTAMP,
    revocation_reason = 'reuse_detected'
WHERE family_id = '32345678-1234-4234-8234-567812345678'
  AND revoked_at IS NULL;

DO $reuse$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auth_refresh_sessions
    WHERE family_id = '32345678-1234-4234-8234-567812345678'
      AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'reuse did not revoke the family';
  END IF;
END;
$reuse$;
SQL

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc "SELECT to_regclass('auth_refresh_sessions') IS NULL")" = "t" ||
  fail "rollback did not drop owned table"

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$UP" >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON TABLE auth_refresh_sessions IS 'foreign-owner'" >/dev/null
if psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null 2>&1; then
  fail "expected tampered rollback to fail"
fi

psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 \
  -c "COMMENT ON TABLE auth_refresh_sessions IS 'migration:2026-07-16-auth-refresh-sessions'" \
  >/dev/null
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null

(
  cd "$ROOT"
  env -u DATABASE_URL -u PGHOST -u PGHOSTADDR -u PGPORT -u PGUSER \
    -u PGDATABASE -u PGPASSWORD -u PGPASSFILE -u PGSERVICE -u PGSERVICEFILE \
    APPLY_AUTH_REFRESH_SESSION_MIGRATION=1 \
    NODE_ENV=test \
    DB_HOST="$PGHOST" \
    DB_PORT="$PGPORT" \
    DB_USER="$PGUSER" \
    DB_PASSWORD=disposable-only \
    DB_NAME="$DB" \
    npx ts-node --transpile-only src/scripts/apply-auth-refresh-session-migration.ts \
    >/dev/null
)
test "$(psql "${PG_ARGS[@]}" -d "$DB" -Atc \
  "SELECT obj_description('auth_refresh_sessions'::regclass, 'pg_class')")" = \
  "migration:2026-07-16-auth-refresh-sessions" || fail "migration runner marker mismatch"

# The deployment entrypoint must be idempotent after the exact owned schema exists.
(
  cd "$ROOT"
  env -u DATABASE_URL -u PGHOST -u PGHOSTADDR -u PGPORT -u PGUSER \
    -u PGDATABASE -u PGPASSWORD -u PGPASSFILE -u PGSERVICE -u PGSERVICEFILE \
    APPLY_AUTH_REFRESH_SESSION_MIGRATION=1 \
    NODE_ENV=test \
    DB_HOST="$PGHOST" \
    DB_PORT="$PGPORT" \
    DB_USER="$PGUSER" \
    DB_PASSWORD=disposable-only \
    DB_NAME="$DB" \
    npx ts-node --transpile-only src/scripts/apply-auth-refresh-session-migration.ts \
    >/dev/null
)
psql "${PG_ARGS[@]}" -d "$DB" -v ON_ERROR_STOP=1 -f "$DOWN" >/dev/null

echo "auth-refresh-session.pg: PASS"
