import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const UP = fs.readFileSync(
  path.join(ROOT, 'scripts/migrations/2026-07-14-multibagger-classification-provenance.sql'),
  'utf8'
);
const DOWN = fs.readFileSync(
  path.join(
    ROOT,
    'scripts/migrations/2026-07-14-multibagger-classification-provenance-rollback.sql'
  ),
  'utf8'
);
const MODEL = fs.readFileSync(
  path.join(ROOT, 'src/models/MultibaggerCandidateSnapshot.ts'),
  'utf8'
);
const CONTROLLER = fs.readFileSync(
  path.join(ROOT, 'src/api/controllers/MultibaggerController.ts'),
  'utf8'
);

let failed = 0;
let passed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}`);
  }
}

assert(
  'forward ownership preflight blocks legacy rows',
  UP.includes("obj_description('multibagger_candidate_snapshot'::regclass") &&
    UP.includes('IF EXISTS (SELECT 1 FROM multibagger_candidate_snapshot)')
);
assert(
  'forward adds exact non-null provenance columns',
  /ADD COLUMN classification_policy_version TEXT NOT NULL/.test(UP) &&
    /ADD COLUMN classification_reason_codes JSONB NOT NULL/.test(UP)
);
assert(
  'reason codes require non-empty string array',
  /jsonb_array_length\(classification_reason_codes\) > 0/.test(UP) &&
    /@\.type\(\) != "string" \|\| @ == ""/.test(UP)
);
assert(
  'rollback removes only provenance columns after ownership preflight',
  DOWN.includes('DROP COLUMN classification_reason_codes') &&
    DOWN.includes('DROP COLUMN classification_policy_version') &&
    !DOWN.includes('DROP TABLE')
);
assert(
  'Sequelize model exposes both persisted fields',
  MODEL.includes("field: 'classification_policy_version'") &&
    MODEL.includes("field: 'classification_reason_codes'")
);
assert(
  'list and detail API project both provenance fields',
  (CONTROLLER.match(/candidate\.classification_policy_version/g) || []).length === 2 &&
    (CONTROLLER.match(/candidate\.classification_reason_codes/g) || []).length === 2 &&
    CONTROLLER.includes('classification_policy_version: row.classification_policy_version') &&
    CONTROLLER.includes('classification_reason_codes: parseJson(row.classification_reason_codes)')
);
assert(
  'list and detail API expose physical proof pins',
  (CONTROLLER.match(/candidate\.fact_hash/g) || []).length === 2 &&
    (CONTROLLER.match(/candidate\.source_fact_hashes/g) || []).length === 2 &&
    (CONTROLLER.match(/candidate\.strategy_version/g) || []).length === 2 &&
    CONTROLLER.includes('fact_hash: row.fact_hash') &&
    CONTROLLER.includes('source_fact_hashes: parseJson(row.source_fact_hashes)') &&
    CONTROLLER.includes('as_of_utc: row.as_of_utc') &&
    CONTROLLER.includes('available_at_utc: row.available_at_utc')
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
