import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const UP_PATH = join(
  ROOT,
  'scripts/migrations/2026-07-14-ai-replay-typed-source-capture.sql'
);
const DOWN_PATH = join(
  ROOT,
  'scripts/migrations/2026-07-14-ai-replay-typed-source-capture-rollback.sql'
);
const up = readFileSync(UP_PATH, 'utf8');
const down = readFileSync(DOWN_PATH, 'utf8');

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

const expectedColumns = [
  'capture_id',
  'trading_day',
  'as_of_utc',
  'profile',
  'market_scope',
  'profile_version',
  'contract_version',
  'input_fingerprint',
  'strategy_version',
  'pipeline_version',
  'available_at_utc',
  'source_versions',
  'filings_json',
  'text_hits_json',
  'scores_json',
  'capture_hash',
  'created_at',
];
const actualColumns = [...up.matchAll(/^  ([a-z][a-z0-9_]*) (?:UUID|DATE|TIMESTAMPTZ|TEXT|JSONB)\b/gm)].map(
  match => match[1]
);
const semverColumns = ['profile_version', 'strategy_version', 'pipeline_version'] as const;
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

assert('[files] forward migration exists', existsSync(UP_PATH));
assert('[files] rollback migration exists', existsSync(DOWN_PATH));
assert('[sql] forward transaction', /\bBEGIN;[\s\S]*\bCOMMIT;/.test(up));
assert('[sql] rollback transaction', /\bBEGIN;[\s\S]*\bCOMMIT;/.test(down));
assert(
  '[sql] exact production columns',
  actualColumns.join(',') === expectedColumns.join(',')
);
assert(
  '[sql] capture identity is UUIDv4',
  /SUBSTRING\(capture_id::TEXT FROM 15 FOR 1\) = '4'/.test(up) &&
    /SUBSTRING\(capture_id::TEXT FROM 20 FOR 1\) IN \('8', '9', 'a', 'b'\)/.test(up)
);
assert(
  '[sql] exact six profiles and four scopes',
  /'us_preferred'[\s\S]*'multibagger'[\s\S]*'japan_blue_chip'[\s\S]*'japan_multibagger'[\s\S]*'korea_semiconductor_chain'[\s\S]*'korea_multibagger'/.test(
    up
  ) && /market_scope IN \('cn_a', 'us', 'jp', 'kr'\)/.test(up)
);
assert(
  '[sql] profile/scope compatibility is closed',
  /profile IN \('us_preferred', 'multibagger'\) AND market_scope IN \('cn_a', 'us'\)/.test(
    up
  ) &&
    /profile IN \('japan_blue_chip', 'japan_multibagger'\) AND market_scope = 'jp'/.test(
      up
    ) &&
    /profile IN \('korea_semiconductor_chain', 'korea_multibagger'\)[\s\S]*market_scope = 'kr'/.test(
      up
    )
);
assert(
  '[sql] three strict ASCII SemVer pins',
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
  '[sql] contract and lowercase hashes are pinned',
  /contract_version = '0\.3\.1'/.test(up) &&
    /input_fingerprint ~ '\^\[0-9a-f\]\{64\}\$'/.test(up) &&
    /capture_hash ~ '\^\[0-9a-f\]\{64\}\$'/.test(up)
);
assert(
  '[sql] replay as_of is whole-second while source availability preserves microseconds',
  /DATE_TRUNC\('second', as_of_utc\) = as_of_utc/.test(up) &&
    !/DATE_TRUNC\('second', available_at_utc\) = available_at_utc/.test(up) &&
    /available_at_utc <= as_of_utc/.test(up)
);
assert(
  '[sql] source_versions has exact four printable ASCII token keys',
  /source_versions \?& ARRAY\['signals', 'universe', 'scores', 'evidence'\]/.test(up) &&
  /source_versions - 'signals' - 'universe' - 'scores' - 'evidence'[\s\S]*= '\{\}'::JSONB/.test(
      up
    ) &&
    ['signals', 'universe', 'scores', 'evidence'].every(
      key =>
        up.includes(`jsonb_typeof(source_versions->'${key}') = 'string'`) &&
        up.includes(
          `source_versions->>'${key}' COLLATE "C" ~ '^[!-~]+$'`
        )
    )
);
assert(
  '[sql] typed payload slices remain arrays and text hits retain physical pins',
  /jsonb_typeof\(filings_json\) = 'array'/.test(up) &&
    /jsonb_typeof\(text_hits_json\) = 'array'/.test(up) &&
    /jsonb_typeof\(scores_json\) = 'array'/.test(up) &&
    /jsonb_path_query_array\(\s*text_hits_json,\s*'strict \$\[\*\]/.test(up) &&
    /@\.document\.type\(\) == "object"/.test(up) &&
    /@\.hit\.type\(\) == "object"/.test(up) &&
    /@\.hit_fact_hash\.type\(\) == "string"/.test(up) &&
    /@\.hit_fact_hash like_regex "\^\[0-9a-f\]\{64\}\$"/.test(up)
);
assert(
  '[sql] natural identity is the exact replay pin tuple',
  /CONSTRAINT uq_ai_replay_typed_source_capture_natural UNIQUE \(\s*trading_day,\s*as_of_utc,\s*profile,\s*market_scope,\s*profile_version,\s*contract_version,\s*input_fingerprint,\s*strategy_version,\s*pipeline_version\s*\)/.test(
    up
  )
);
assert(
  '[sql] update delete and truncate are rejected before mutation',
  /CREATE FUNCTION reject_ai_replay_typed_source_capture_mutation\(\)/.test(up) &&
    /ERRCODE = '55000'/.test(up) &&
    /BEFORE UPDATE OR DELETE OR TRUNCATE ON ai_replay_typed_source_capture/.test(up) &&
    /FOR EACH STATEMENT[\s\S]*EXECUTE FUNCTION reject_ai_replay_typed_source_capture_mutation\(\)/.test(
      up
    )
);
assert(
  '[sql] table/function/trigger share one ownership marker',
  (up.match(/migration:2026-07-14-ai-replay-typed-source-capture/g) || []).length === 3 &&
    /COMMENT ON TABLE ai_replay_typed_source_capture/.test(up) &&
    /COMMENT ON FUNCTION reject_ai_replay_typed_source_capture_mutation\(\)/.test(up) &&
    /COMMENT ON TRIGGER tr_ai_replay_typed_source_capture_append_only/.test(up)
);
assert(
  '[rollback] all three ownership markers are verified before exact drops',
  /rollback table ownership mismatch/.test(down) &&
    /rollback function ownership mismatch/.test(down) &&
    /rollback trigger ownership mismatch/.test(down) &&
    /obj_description\(table_oid, 'pg_class'\)/.test(down) &&
    /obj_description\(function_oid, 'pg_proc'\)/.test(down) &&
    /obj_description\(trigger_oid, 'pg_trigger'\)/.test(down) &&
    /p\.prorettype = 'trigger'::regtype/.test(down) &&
    /l\.lanname = 'plpgsql'/.test(down) &&
    /regexp_replace\(p\.prosrc, '\[\[:space:\]\]\+'/.test(down) &&
    /expected_function_body/.test(down) &&
    /t\.tgtype = 58/.test(down) &&
    /t\.tgenabled = 'O'/.test(down) &&
    /DROP TABLE ai_replay_typed_source_capture;/.test(down) &&
    /DROP FUNCTION reject_ai_replay_typed_source_capture_mutation\(\);/.test(down) &&
    !/DROP (?:TABLE|FUNCTION) IF EXISTS/.test(down)
);

console.log(`ai-replay-typed-source-capture: ${passed} ok / ${failed} failed`);
process.exit(failed ? 1 : 0);
