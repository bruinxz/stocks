import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const up = fs.readFileSync(
  path.join(ROOT, 'scripts/migrations/2026-07-14-multibagger-text-hit-provenance.sql'),
  'utf8'
);
const down = fs.readFileSync(
  path.join(
    ROOT,
    'scripts/migrations/2026-07-14-multibagger-text-hit-provenance-rollback.sql'
  ),
  'utf8'
);
const model = fs.readFileSync(path.join(ROOT, 'src/models/MultibaggerTextHit.ts'), 'utf8');
const repository = fs.readFileSync(
  path.join(ROOT, '../strategy/materialization/postgres_repository.py'),
  'utf8'
);

const checks: Array<[string, boolean]> = [
  [
    'forward aborts rather than inventing legacy provenance',
    up.includes('IF EXISTS (SELECT 1 FROM multibagger_text_hit)') &&
      up.includes('cannot add text-hit provenance while legacy rows exist'),
  ],
  [
    'forward adds source version and authenticated hit hash',
    /ADD COLUMN source_version TEXT NOT NULL/.test(up) &&
      /ADD COLUMN hit_fact_hash TEXT NOT NULL/.test(up) &&
      /source_version COLLATE "C" ~ '\^\[!-~\]\+\$'/.test(up),
  ],
  [
    'rollback removes only the owned columns and constraints',
    down.includes('DROP COLUMN hit_fact_hash') &&
      down.includes('DROP COLUMN source_version') &&
      !down.includes('DROP TABLE'),
  ],
  [
    'Sequelize exposes new fields with snake_case attributes',
    model.includes('declare source_version: string') &&
      model.includes('declare hit_fact_hash: string'),
  ],
  [
    'Strategy repository reads provenance directly without an N+1 inference query',
    repository.includes('source_document_id, source_version') &&
      repository.includes('context_hash, hit_fact_hash') &&
      !repository.includes('TEXT_HIT_VERSION_SQL'),
  ],
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? '  ok  ' : '  FAIL '}${name}`);
  if (!ok) failed += 1;
}
console.log(`\nResult: ${checks.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
