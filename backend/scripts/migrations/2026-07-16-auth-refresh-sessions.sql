-- Durable refresh-token rotation and reuse-detection state.
-- Raw refresh tokens are deliberately absent; only lowercase SHA-256 hashes
-- and server-generated UUID identifiers may be stored.

BEGIN;

CREATE TABLE auth_refresh_sessions (
  session_id UUID NOT NULL,
  user_id INTEGER NOT NULL,
  jti UUID NOT NULL,
  family_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_jti UUID,
  revocation_reason VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_auth_refresh_sessions PRIMARY KEY (session_id),
  CONSTRAINT fk_auth_refresh_sessions_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT uq_auth_refresh_sessions_jti UNIQUE (jti),
  CONSTRAINT uq_auth_refresh_sessions_token_hash UNIQUE (token_hash),
  CONSTRAINT ck_auth_refresh_sessions_revocation_reason CHECK (
    revocation_reason IN (
      'rotated',
      'logout',
      'reuse_detected',
      'expired',
      'user_inactive',
      'password_changed'
    )
  ),
  CONSTRAINT ck_auth_refresh_sessions_session_uuid_v4 CHECK (
    SUBSTRING(session_id::TEXT FROM 15 FOR 1) = '4'
    AND SUBSTRING(session_id::TEXT FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT ck_auth_refresh_sessions_jti_uuid_v4 CHECK (
    SUBSTRING(jti::TEXT FROM 15 FOR 1) = '4'
    AND SUBSTRING(jti::TEXT FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT ck_auth_refresh_sessions_family_uuid_v4 CHECK (
    SUBSTRING(family_id::TEXT FROM 15 FOR 1) = '4'
    AND SUBSTRING(family_id::TEXT FROM 20 FOR 1) IN ('8', '9', 'a', 'b')
  ),
  CONSTRAINT ck_auth_refresh_sessions_token_hash CHECK (
    token_hash COLLATE "C" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT ck_auth_refresh_sessions_lifetime CHECK (expires_at > created_at),
  CONSTRAINT ck_auth_refresh_sessions_revocation_state CHECK (
    (
      revoked_at IS NULL
      AND replaced_by_jti IS NULL
      AND revocation_reason IS NULL
    )
    OR (
      revoked_at IS NOT NULL
      AND revoked_at >= created_at
      AND revocation_reason IS NOT NULL
    )
  ),
  CONSTRAINT ck_auth_refresh_sessions_replacement CHECK (
    replaced_by_jti IS NULL OR replaced_by_jti <> jti
  ),
  CONSTRAINT ck_auth_refresh_sessions_updated_at CHECK (updated_at >= created_at)
);

CREATE INDEX ix_auth_refresh_sessions_active_family
  ON auth_refresh_sessions (family_id)
  WHERE revoked_at IS NULL;

CREATE INDEX ix_auth_refresh_sessions_user_expiry
  ON auth_refresh_sessions (user_id, expires_at);

COMMENT ON TABLE auth_refresh_sessions IS
  'migration:2026-07-16-auth-refresh-sessions';

COMMIT;
