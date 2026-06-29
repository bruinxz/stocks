/**
 * QuantBacktestService create response contract.
 *
 * Async backtest creation is the first visible action in the simplified
 * workspace. It should return a queued task payload quickly and leave complete
 * results/trades/audit loading to the polling detail endpoint.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

console.log('\n## QuantBacktestService async create response contract');

const source = readFileSync(
  join(process.cwd(), 'src/quant/backtest/internal/QuantBacktestService.ts'),
  'utf8'
);

const createBody = source.match(/async createBacktestTask[\s\S]*?\n  async createWalkForwardBacktests/)?.[0] || '';
const asyncBranch = createBody.match(/const job = await quantBacktestQueue\.add[\s\S]*?return \{[\s\S]*?\n    \};/)?.[0] || '';

assert(
  'async create returns through a lightweight queued payload helper',
  source.includes('private buildQueuedBacktestPayload') &&
    asyncBranch.includes('this.buildQueuedBacktestPayload(')
);
assert(
  'async create does not call full getBacktest before responding',
  !asyncBranch.includes('this.getBacktest(task.id)')
);
assert(
  'queued payload preserves detail endpoint shape without loading results or trades',
  source.includes('results: []') &&
    source.includes('trades: []') &&
    source.includes('credibility_verdict')
);
assert(
  'easy async create delays worker start briefly so the HTTP response can flush first',
  source.includes('private resolveCreateQueueDelayMs') &&
    source.includes('EASY_QUANT_BACKTEST_QUEUE_DELAY_MS') &&
    /delay:\s*this\.resolveCreateQueueDelayMs\(normalizedOptions\)/.test(asyncBranch)
);
assert(
  'queue job id persistence is deferred outside the HTTP response path',
  source.includes('private persistQueueJobIdAfterResponse') &&
    asyncBranch.includes('this.persistQueueJobIdAfterResponse(') &&
    !/await task\.update\(\{\s*parameters:[\s\S]*queue_job_id/.test(asyncBranch)
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
