import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'backend/src/scripts/data-cli.ts'), 'utf8');
const dataSyncSource = fs.readFileSync(
  path.join(root, 'backend/src/data/services/DataSyncService.ts'),
  'utf8'
);

assert.match(
  source,
  /async function connectDatabase[\s\S]{0,240}DATA_CLI_SYNC_SCHEMA === 'true'[\s\S]{0,100}sequelize\.sync\(\)/,
  'schema sync must require an explicit data-CLI opt-in'
);
assert.doesNotMatch(
  source,
  /await sequelize\.authenticate\(\);\s*await sequelize\.sync\(\);/,
  'data commands must not mutate schema before performing their requested work'
);
assert.equal(
  (source.match(/await connectDatabase\(\);/g) || []).length,
  7,
  'every data CLI command must use the schema-safe database bootstrap'
);
assert.match(
  dataSyncSource,
  /const payload: Record<string, unknown>[\s\S]{0,900}payload\[key\] === null[\s\S]{0,220}Stock\.upsert\(payload/,
  'a shallow stock-list source must not erase richer nullable master-data fields'
);

console.log('data CLI schema safety: 4 assertions passed');
