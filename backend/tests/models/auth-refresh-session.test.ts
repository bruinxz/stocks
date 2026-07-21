import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const model = fs.readFileSync(path.join(ROOT, 'src/models/AuthRefreshSession.ts'), 'utf8');
const controller = fs.readFileSync(
  path.join(ROOT, 'src/api/controllers/AuthController.ts'),
  'utf8'
);
const registry = fs.readFileSync(path.join(ROOT, 'src/config/database.ts'), 'utf8');
const modelIndex = fs.readFileSync(path.join(ROOT, 'src/models/index.ts'), 'utf8');
const up = fs.readFileSync(
  path.join(ROOT, 'scripts/migrations/2026-07-16-auth-refresh-sessions.sql'),
  'utf8'
);
const down = fs.readFileSync(
  path.join(ROOT, 'scripts/migrations/2026-07-16-auth-refresh-sessions-rollback.sql'),
  'utf8'
);
const pgHarness = fs.readFileSync(
  path.join(ROOT, 'tests/models/auth-refresh-session.pg.sh'),
  'utf8'
);
const indexSource = fs.readFileSync(path.join(ROOT, 'src/index.ts'), 'utf8');
const schemaGuard = fs.readFileSync(
  path.join(ROOT, 'src/auth/AuthRefreshSessionSchema.ts'),
  'utf8'
);
const deployScript = fs.readFileSync(
  path.join(ROOT, '../scripts/deployment/deploy_remote_build.sh'),
  'utf8'
);
const smokeScript = fs.readFileSync(
  path.join(ROOT, '../scripts/tests/smoke_readonly_core.js'),
  'utf8'
);
const healthGateSource = fs.readFileSync(
  path.join(ROOT, '../scripts/deployment/release_health_gate.js'),
  'utf8'
);

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

assert('snake_case table', /tableName:\s*'auth_refresh_sessions'/.test(model));
for (const field of [
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
]) {
  assert(`model declares ${field}`, new RegExp(`declare\\s+${field}\\b`).test(model));
}
assert('model never declares a raw token field', !/declare\s+(refresh_)?token\b/.test(model));
assert('database registers model', /models:\s*\[[\s\S]*\bAuthRefreshSession\b/.test(registry));
assert('model index exports model', /export\s+\{\s*AuthRefreshSession\s*\}/.test(modelIndex));
assert(
  'schema probe normalizes PostgreSQL name[] to text[]',
  /array_agg\(a\.attname::TEXT ORDER BY a\.attnum\)/.test(schemaGuard)
);

assert('forward migration is transactional', /\bBEGIN;[\s\S]*\bCOMMIT;/.test(up));
assert('rollback migration is transactional', /\bBEGIN;[\s\S]*\bCOMMIT;/.test(down));
assert('migration owns expected table', /CREATE TABLE auth_refresh_sessions/.test(up));
assert('session belongs to users', /REFERENCES users\s*\(id\)\s*ON DELETE CASCADE/.test(up));
assert('token hash is lowercase SHA-256', /token_hash[\s\S]*\^\[0-9a-f\]\{64\}\$/.test(up));
assert('jti is unique', /uq_auth_refresh_sessions_jti UNIQUE \(jti\)/.test(up));
assert('active family index exists', /ix_auth_refresh_sessions_active_family/.test(up));
assert('password-change revocation reason is physical', /'password_changed'/.test(up));
assert('raw refresh token column is absent', !/\brefresh_token\b/.test(up));
assert('rollback checks ownership marker', /rollback ownership mismatch/.test(down));
assert(
  'registration does not print User instances',
  !/console\.log\(['"]User (object|id)/.test(controller)
);
assert(
  'refresh rotation uses a database transaction',
  /refreshToken[\s\S]*sequelize\.transaction/.test(controller)
);
assert('reuse detection revokes a family', /revokeFamily\([\s\S]*reuse_detected/.test(controller));
assert(
  'production startup verifies exact auth-session schema',
  /if \(isProduction\) \{\s*await assertAuthRefreshSessionSchema\(sequelize\)/.test(indexSource)
);
assert(
  'deployment applies auth migration before restart',
  deployScript.indexOf('node dist/scripts/apply-auth-refresh-session-migration.js') > 0 &&
    deployScript.indexOf('node dist/scripts/apply-auth-refresh-session-migration.js') <
      deployScript.indexOf('systemctl restart')
);
assert(
  'migration command runs compiled guarded entrypoint',
  /APPLY_AUTH_REFRESH_SESSION_MIGRATION=1 NODE_ENV=production[\s\\]*node dist\/scripts\/apply-auth-refresh-session-migration\.js/.test(
    deployScript
  )
);
assert(
  'release health gate runs through privileged ops channel',
  /printf '%s\\n' "\$OPS_PASSWORD" \| ssh_ops "sudo -S env/.test(deployScript)
);
assert(
  'release health gate avoids nested bash quoting',
  /node '\$CURRENT\/scripts\/deployment\/release_health_gate\.js'/.test(deployScript) &&
    !/bash -lc '\s*if \[ -f \$CURRENT\/scripts\/deployment\/release_health_gate\.js/.test(
      deployScript
    )
);
assert(
  'remote frontend build defaults to a production-safe heap cap',
  /FRONTEND_BUILD_MAX_OLD_SPACE_MB="\$\{FRONTEND_BUILD_MAX_OLD_SPACE_MB:-3072\}"/.test(deployScript)
);
assert(
  'release smoke password is required before deployment mutates production',
  deployScript.indexOf('RELEASE_SMOKE_PASSWORD is required') > 0 &&
    deployScript.indexOf('RELEASE_SMOKE_PASSWORD is required') <
      deployScript.indexOf("Confirm branch '$BRANCH'")
);
assert(
  'release gate defaults to the stocks account',
  /const defaultSmokeUser = ["']stocks["']/.test(healthGateSource)
);
assert(
  'release gate polls slow service readiness',
  /function waitForCommand\(/.test(healthGateSource) &&
    /RELEASE_HEALTH_READY_TIMEOUT_SECONDS/.test(healthGateSource) &&
    !/run\('sleep 8'\)/.test(healthGateSource)
);
for (const retiredPath of [
  '/api/quant/fusion-audits?limit=5',
  '/api/quant/rankings?limit=5',
  '/api/ai/recommendations/loop-policy-snapshots?limit=5',
]) {
  assert(`retired smoke probe is removed: ${retiredPath}`, !smokeScript.includes(retiredPath));
}

assert(
  'PG harness is destructive-test guarded',
  /AUTH_REFRESH_SESSION_PG_DISPOSABLE_TEST/.test(pgHarness)
);
assert('PG harness forbids ambient DATABASE_URL', /DATABASE_URL is forbidden/.test(pgHarness));
assert('PG harness requires Unix socket', /local Unix-socket directory/.test(pgHarness));
assert(
  'PG harness exercises rotation',
  /rotation did not create one active successor/.test(pgHarness)
);
assert(
  'PG harness exercises reuse family revocation',
  /reuse did not revoke the family/.test(pgHarness)
);
assert(
  'PG harness exercises rollback ownership',
  /expected tampered rollback to fail/.test(pgHarness)
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
