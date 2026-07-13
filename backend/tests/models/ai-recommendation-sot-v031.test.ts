import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const UP_PATH = join(ROOT, 'scripts/migrations/2026-07-12-ai-recommendation-sot-v031.sql');
const DOWN_PATH = join(
  ROOT,
  'scripts/migrations/2026-07-12-ai-recommendation-sot-v031-rollback.sql'
);
const SNAPSHOT_MODEL = join(ROOT, 'src/models/AiRecommendationSnapshot.ts');
const ITEM_MODEL = join(ROOT, 'src/models/AiRecommendationItem.ts');
const DATABASE = join(ROOT, 'src/config/database.ts');
const INDEX = join(ROOT, 'src/models/index.ts');

const up = readFileSync(UP_PATH, 'utf8');
const down = readFileSync(DOWN_PATH, 'utf8');
const snapshotModel = readFileSync(SNAPSHOT_MODEL, 'utf8');
const itemModel = readFileSync(ITEM_MODEL, 'utf8');
const database = readFileSync(DATABASE, 'utf8');
const index = readFileSync(INDEX, 'utf8');

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const semverColumns = [
  'profile_version',
  'pipeline_version',
  'model_version',
  'strategy_version',
] as const;
const validSemvers = ['0.0.0', '1.2.3-alpha-beta.1+build-meta-7'];
const invalidSemvers = [
  '１.2.3',
  '1.2.3-α',
  'current',
  'v1.2.3',
  '01.2.3',
  '1.2.3-01',
  '1.2.3-',
  '1.2.3+',
  '1.2.3-alpha..1',
  '1.2.3+build..1',
];

function sqlSemverPattern(column: (typeof semverColumns)[number]): string | undefined {
  return up.match(
    new RegExp(
      `${column}\\s+TEXT\\s+NOT\\s+NULL\\s+CHECK\\s*\\(` +
        `\\s*${column}\\s+COLLATE\\s+"C"\\s*~\\s*'([^']+)'`
    )
  )?.[1];
}

function modelColumnHasValidator(column: (typeof semverColumns)[number]): boolean {
  const fieldIndex = snapshotModel.indexOf(`field: '${column}'`);
  if (fieldIndex < 0) return false;
  const decoratorStart = snapshotModel.lastIndexOf('@Column({', fieldIndex);
  const decoratorEnd = snapshotModel.indexOf('})', fieldIndex);
  if (decoratorStart < 0 || decoratorEnd < 0) return false;
  const decorator = snapshotModel.slice(decoratorStart, decoratorEnd + 2);
  return /validate:\s*\{\s*is:\s*STRICT_SEMVER_PATTERN\s*\}/.test(decorator);
}

assert('[files] forward exists', existsSync(UP_PATH));
assert('[files] rollback exists', existsSync(DOWN_PATH));
assert('[files] snapshot model exists', existsSync(SNAPSHOT_MODEL));
assert('[files] item model exists', existsSync(ITEM_MODEL));
assert('[sql] forward transaction', /BEGIN;[\s\S]*COMMIT;/.test(up));
assert('[sql] rollback transaction', /BEGIN;[\s\S]*COMMIT;/.test(down));
assert(
  '[sql] exact canonical tables',
  /CREATE TABLE ai_recommendation_snapshot\b/.test(up) &&
    /CREATE TABLE ai_recommendation_item\b/.test(up)
);
assert(
  '[sql] no suffixed table fork',
  !/CREATE TABLE ai_recommendation_(?:snapshot|item)_v031\b/.test(up)
);
assert(
  '[sql] exact six persisted profiles',
  /'us_preferred'[\s\S]*?'multibagger'[\s\S]*?'japan_blue_chip'[\s\S]*?'japan_multibagger'[\s\S]*?'korea_semiconductor_chain'[\s\S]*?'korea_multibagger'/.test(
    up
  ) && !/\bcustom\b/.test(up)
);
assert(
  '[sql] exact four scopes and compatibility',
  /market_scope IN \('cn_a', 'us', 'jp', 'kr'\)/.test(up) &&
    /ck_ai_recommendation_snapshot_profile_scope/.test(up)
);
assert(
  '[sql] contract and replay pins',
  /contract_version = '0.3.1'/.test(up) &&
    /profile_version TEXT NOT NULL/.test(up) &&
    /input_fingerprint TEXT NOT NULL/.test(up) &&
    /strategy_version TEXT NOT NULL/.test(up) &&
    /pipeline_version TEXT NOT NULL/.test(up)
);
assert(
  '[sql] four strict ASCII SemVer checks',
  semverColumns.every(column => {
    const source = sqlSemverPattern(column);
    if (!source || /\\d|\[\[:digit:\]\]/.test(source)) return false;
    const pattern = new RegExp(source);
    return (
      validSemvers.every(value => pattern.test(value)) &&
      invalidSemvers.every(value => !pattern.test(value))
    );
  })
);
assert(
  '[sql] semantic fingerprint preimage bytes',
  /fingerprint_preimage_jcs TEXT NOT NULL/.test(up) &&
    /ck_ai_recommendation_snapshot_fingerprint_hash/.test(up) &&
    /fingerprint_preimage_jcs::JSONB IS DISTINCT FROM semantic_envelope/.test(up)
);
assert(
  '[sql] complete envelope and disclaimer',
  /envelope_json JSONB NOT NULL/.test(up) &&
    /jsonb_typeof\(envelope_json->'items'\) = 'array'/.test(up) &&
    /jsonb_typeof\(envelope_json->'disclaimer'\) = 'object'/.test(up) &&
    /jsonb_typeof\(envelope_json->'meta'\) = 'object'/.test(up)
);
assert(
  '[sql] item exact JSON and JCS/hash',
  /recommendation_json JSONB NOT NULL/.test(up) &&
    /recommendation_jcs TEXT NOT NULL/.test(up) &&
    /recommendation_hash TEXT NOT NULL CHECK/.test(up) &&
    /recommendation_jcs::JSONB = recommendation_json/.test(up) &&
    /ENCODE\(SHA256\(CONVERT_TO\(recommendation_jcs, 'UTF8'\)\), 'hex'\)/.test(up)
);
assert(
  '[sql] UUIDv4 and envelope as-of pins',
  /SUBSTRING\(snapshot_id::TEXT FROM 15 FOR 1\) = '4'/.test(up) &&
    /SUBSTRING\(item_id::TEXT FROM 20 FOR 1\) IN \('8', '9', 'a', 'b'\)/.test(up) &&
    /\(envelope_json->>'as_of'\)::TIMESTAMPTZ = as_of_utc/.test(up)
);
assert(
  '[sql] item projections use current contract',
  /rating_band IN \('A', 'B', 'C', 'D', 'F'\)/.test(up) &&
    /risk_gate_status TEXT NOT NULL CHECK \(risk_gate_status = 'GREEN'\)/.test(up) &&
    /recommendation_json->'risk_gate'->>'gate' = 'GREEN'/.test(up) &&
    /\(recommendation_json->'risk_gate'->>'ok_to_enter'\)::BOOLEAN = TRUE/.test(up) &&
    /size_hint_tier IN \('TIER_5', 'TIER_3', 'TIER_2', 'TIER_1', 'SKIP'\)/.test(up)
);
assert(
  '[sql] atomic FK cascade and identities',
  /REFERENCES ai_recommendation_snapshot\(snapshot_id\) ON DELETE CASCADE/.test(up) &&
    /UNIQUE \(snapshot_id, ticker\)/.test(up) &&
    /UNIQUE \(snapshot_id, sort_rank\)/.test(up) &&
    /UNIQUE \(idempotency_key\)/.test(up)
);
assert(
  '[sql] deferred cross-SOT binding',
  /CREATE FUNCTION validate_ai_recommendation_snapshot_v031/.test(up) &&
    /CREATE CONSTRAINT TRIGGER ck_ai_recommendation_snapshot_items_deferred/.test(up) &&
    /CREATE CONSTRAINT TRIGGER ck_ai_recommendation_item_snapshot_deferred/.test(up) &&
    /DEFERRABLE INITIALLY DEFERRED/.test(up) &&
    /envelope_json->'items' IS DISTINCT FROM actual_items/.test(up) &&
    /minimum_rank <> 0 OR maximum_rank <> actual_count - 1/.test(up) &&
    /recommendation_json->>'id' = item_id::TEXT/.test(up)
);
assert(
  '[sql] ownership safe rollback',
  /migration:2026-07-12-ai-recommendation-sot-v031/.test(up) &&
    /rollback ownership mismatch/.test(down) &&
    /function ownership mismatch/.test(down) &&
    !/DROP\s+INDEX/i.test(down)
);
assert('[model] snapshot table', /tableName:\s*'ai_recommendation_snapshot'/.test(snapshotModel));
assert('[model] item table', /tableName:\s*'ai_recommendation_item'/.test(itemModel));
assert('[model] string-safe conviction', /declare convictionFinal:\s*string/.test(itemModel));
assert(
  '[model] four strict ASCII SemVer validators',
  /const STRICT_SEMVER_PATTERN\s*=/.test(snapshotModel) &&
    semverColumns.every(modelColumnHasValidator)
);
assert(
  '[model] GREEN-only risk validator and type',
  /field:\s*'risk_gate_status'[\s\S]{0,160}validate:\s*\{[\s\S]{0,100}'GREEN'/.test(itemModel) &&
    /declare riskGateStatus:\s*'GREEN'/.test(itemModel)
);
assert(
  '[model] FK/cascade association',
  /@ForeignKey\(\(\) => AiRecommendationSnapshot\)/.test(itemModel) &&
    /@BelongsTo\(\(\) => AiRecommendationSnapshot\)/.test(itemModel)
);
assert(
  '[registration] database',
  /import \{ AiRecommendationSnapshot \}/.test(database) &&
    /import \{ AiRecommendationItem \}/.test(database) &&
    /\bAiRecommendationSnapshot,\s*\n\s*AiRecommendationItem,/.test(database)
);
assert(
  '[registration] barrel',
  /export \* from '\.\/AiRecommendationSnapshot'/.test(index) &&
    /export \* from '\.\/AiRecommendationItem'/.test(index)
);

console.log(`ai-recommendation-sot-v031: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
