import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const UP_PATH = join(
  ROOT,
  'scripts/migrations/2026-07-14-multibagger-source-version-integrity.sql'
);
const DOWN_PATH = join(
  ROOT,
  'scripts/migrations/2026-07-14-multibagger-source-version-integrity-rollback.sql'
);
const PG_PATH = join(
  ROOT,
  'tests/models/multibagger-source-version-integrity.pg.sh'
);
const E2E_PATH = join(ROOT, 'tests/e2e/tab4-multibagger-live.pg.sh');

const up = readFileSync(UP_PATH, 'utf8');
const down = readFileSync(DOWN_PATH, 'utf8');
const pg = readFileSync(PG_PATH, 'utf8');
const e2e = readFileSync(E2E_PATH, 'utf8');

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

const versionKeys = [
  'quality_engine',
  'growth_engine',
  'valuation_engine',
  'moat_engine',
  'trend_engine',
  'risk_engine',
];

assert(
  '[files] forward rollback and disposable PG tests exist',
  existsSync(UP_PATH) && existsSync(DOWN_PATH) && existsSync(PG_PATH)
);
assert(
  '[sql] forward and rollback are transactional',
  /\bBEGIN;[\s\S]*\bCOMMIT;/.test(up) && /\bBEGIN;[\s\S]*\bCOMMIT;/.test(down)
);
assert(
  '[forward] both phase1 table ownership markers are verified',
  up.includes('multibagger universe phase1 ownership mismatch') &&
    up.includes('multibagger candidate phase1 ownership mismatch') &&
    (up.match(/obj_description\([^,]+, 'pg_class'\)/g) || []).length >= 2 &&
    up.includes('migration:2026-07-11-sprint3-market-storage-phase1')
);
assert(
  '[forward] legacy invalid rows and constraint collisions fail closed',
  up.includes('legacy multibagger universe source_version is invalid') &&
    up.includes('legacy multibagger candidate score.source_versions is invalid') &&
    up.includes('multibagger source-version constraint name collision') &&
    up.includes("c.conname = 'ck_multibagger_universe_source_version_ascii'") &&
    up.includes("c.conname = 'ck_multibagger_candidate_score_source_versions'")
);
assert(
  '[constraint] universe source_version is printable ASCII under C collation',
  /ADD CONSTRAINT ck_multibagger_universe_source_version_ascii CHECK \(\s*source_version COLLATE "C" ~ '\^\[!-~\]\+\$'\s*\)/.test(
    up
  )
);
assert(
  '[constraint] candidate source_versions has exactly six keys',
  /\(score->'source_versions'\) \?& ARRAY\[/.test(up) &&
    versionKeys.every(key => up.includes(`'${key}'`)) &&
    /score->'source_versions'[\s\S]*- 'quality_engine'[\s\S]*- 'risk_engine'\) = '\{\}'::JSONB/.test(
      up
    )
);
assert(
  '[constraint] every candidate version is a printable ASCII JSON string',
  versionKeys.every(
    key =>
      up.includes(`jsonb_typeof(score->'source_versions'->'${key}') = 'string'`) &&
      up.includes(
        `(score->'source_versions'->>'${key}') COLLATE "C" ~ '^[!-~]+$'`
      )
  )
);
assert(
  '[constraint] NULL score remains compatible and malformed JSON fails closed',
  /WHEN score IS NULL THEN TRUE/.test(up) &&
    /WHEN jsonb_typeof\(score\) <> 'object' THEN FALSE/.test(up) &&
    /WHEN jsonb_typeof\(score->'source_versions'\) <> 'object' THEN FALSE/.test(up) &&
    /ELSE COALESCE\(/.test(up)
);
assert(
  '[ownership] both constraints receive the migration marker',
  (up.match(/migration:2026-07-14-multibagger-source-version-integrity/g) || [])
    .length === 2 &&
    /COMMENT ON CONSTRAINT ck_multibagger_universe_source_version_ascii/.test(up) &&
    /COMMENT ON CONSTRAINT ck_multibagger_candidate_score_source_versions/.test(up)
);
assert(
  '[rollback] table and constraint ownership is checked before exact drops',
  down.includes('rollback table ownership mismatch') &&
    down.includes('rollback constraint ownership mismatch') &&
    (down.match(/obj_description\([^,]+, 'pg_constraint'\)/g) || []).length === 2 &&
    (down.match(/pg_get_constraintdef\(c\.oid, TRUE\)/g) || []).length === 2 &&
    down.includes('universe rollback constraint shape mismatch') &&
    down.includes('candidate rollback constraint shape mismatch') &&
    down.includes('c.convalidated') &&
    down.includes('c.connoinherit') &&
    /DROP CONSTRAINT ck_multibagger_universe_source_version_ascii;/.test(down) &&
    /DROP CONSTRAINT ck_multibagger_candidate_score_source_versions;/.test(down) &&
    !/DROP (?:TABLE|COLUMN)/.test(down) &&
    !/DROP CONSTRAINT IF EXISTS/.test(down)
);
assert(
  '[pg] destructive test is restricted to an explicit local Unix socket',
  pg.includes('MULTIBAGGER_SOURCE_VERSION_INTEGRITY_PG_DISPOSABLE_TEST') &&
    pg.includes('ambient DATABASE_URL is forbidden') &&
    pg.includes('PGHOSTADDR is forbidden') &&
    pg.includes('PGHOST must be an absolute local Unix-socket directory') &&
    pg.includes('PGHOST does not contain the requested local PostgreSQL socket') &&
    pg.includes('PGUSER must equal the current OS user') &&
    pg.includes('--no-password')
);
assert(
  '[pg] adversarial matrix covers values shapes ownership and rollback',
  pg.includes("to_jsonb(''::TEXT)") &&
  pg.includes("' leading'") &&
    pg.includes("'trailing '") &&
    pg.includes("'internal space'") &&
    pg.includes("E'\\tcontrol\\t'") &&
    pg.includes("'版本-v1'") &&
    pg.includes("candidate_versions - 'risk_engine'") &&
    pg.includes('future_engine') &&
    pg.includes("'[]'::JSONB") &&
    pg.includes("'\"not-an-object\"'::JSONB") &&
    pg.includes("'NULL-C'") &&
    pg.includes('rollback accepted a foreign constraint marker') &&
    pg.includes('rollback accepted a foreign same-marker constraint shape') &&
    pg.includes("'ROLLBACK-C'")
);
assert(
  '[e2e] live chain applies rolls back and attacks the new integrity migration',
  e2e.includes('2026-07-14-multibagger-source-version-integrity.sql') &&
    e2e.includes('2026-07-14-multibagger-source-version-integrity-rollback.sql') &&
    e2e.includes('resealed invalid candidate')
);

console.log(
  `multibagger-source-version-integrity: ${passed} ok / ${failed} failed`
);
process.exit(failed ? 1 : 0);
