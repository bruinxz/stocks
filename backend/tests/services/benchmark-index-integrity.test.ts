import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { isPlausibleBenchmarkLevel } from '../../src/services/BenchmarkIndexService';

const root = path.resolve(__dirname, '../../..');
const benchmarkSource = fs.readFileSync(
  path.join(root, 'backend/src/services/BenchmarkIndexService.ts'),
  'utf8'
);
const dataSyncSource = fs.readFileSync(
  path.join(root, 'backend/src/data/services/DataSyncService.ts'),
  'utf8'
);

assert.equal(isPlausibleBenchmarkLevel(4051.43), true);
assert.equal(isPlausibleBenchmarkLevel('4877.093'), true);
assert.equal(
  isPlausibleBenchmarkLevel(11.01),
  false,
  'stock prices must not pass as broad-index levels'
);
assert.equal(isPlausibleBenchmarkLevel(0), false);
assert.equal(isPlausibleBenchmarkLevel(null), false);
assert.equal(isPlausibleBenchmarkLevel(200000), false);
assert.match(
  benchmarkSource,
  /syncMultipleStocksHistory\([\s\S]{0,420}'tencent_only'[\s\S]{0,80}'repair'/,
  'benchmark synchronization must use an exchange-qualified source and repair existing dates'
);
assert.match(
  benchmarkSource,
  /isPlausibleBenchmarkLevel\(firstBar\.close\)[\s\S]{0,120}isPlausibleBenchmarkLevel\(latestBar\.close\)/,
  'existing benchmark coverage must not trust implausible price series'
);
assert.match(
  benchmarkSource,
  /isPlausibleBenchmarkLevel\(entryPrice\)[\s\S]{0,120}isPlausibleBenchmarkLevel\(exitPrice\)[\s\S]{0,300}return null/,
  'benchmark returns must fail closed even when a repair attempt could not replace polluted bars'
);
assert.doesNotMatch(
  benchmarkSource,
  /ensureBenchmarkIndices\(\)[\s\S]{0,500}data_status: 'complete'/,
  'creating benchmark security metadata must not claim that unverified bars are complete'
);
assert.match(
  dataSyncSource,
  /writeMode === 'repair'[\s\S]{0,180}updateOnDuplicate: DAILY_BAR_REPAIR_FIELDS/,
  'repair mode must overwrite a conflicting stock_id/time row'
);

console.log('benchmark index integrity: 11 assertions passed');
