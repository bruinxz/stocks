import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  classifyQuoteFreshness,
  sortLedgerTimeline,
} from '../../src/portfolio/internal/PortfolioLedgerService';

let failed = 0;
function assert(name: string, condition: boolean) {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const now = new Date('2026-07-21T02:00:00.000Z');
assert(
  'same-day recent quote is fresh',
  classifyQuoteFreshness('2026-07-21T01:55:00.000Z', '2026-07-21', now).freshness === 'fresh'
);
assert(
  'prior trading-day quote is stale',
  classifyQuoteFreshness('2026-07-20T07:00:00.000Z', '2026-07-20', now).freshness === 'stale'
);
assert(
  'missing quote is explicit',
  classifyQuoteFreshness(null, null, now).freshness === 'missing'
);

const timeline = sortLedgerTimeline([
  {
    id: 'b',
    type: 'alert',
    title: 'b',
    detail: null,
    occurred_at: '2026-07-21T02:00:00Z',
    status: null,
    corrected: false,
  },
  {
    id: 'a',
    type: 'trade',
    title: 'a',
    detail: null,
    occurred_at: '2026-07-21T01:00:00Z',
    status: null,
    corrected: false,
  },
]);
assert('timeline is chronological', timeline.map(item => item.id).join(',') === 'a,b');

const controller = readFileSync(
  resolve(__dirname, '../../src/api/controllers/PaperTradingController.ts'),
  'utf8'
);
const ledger = readFileSync(
  resolve(__dirname, '../../src/portfolio/internal/PortfolioLedgerService.ts'),
  'utf8'
);
assert(
  'ledger route passes authenticated user id',
  controller.includes('getForUser(user.id, portfolio_id)')
);
assert(
  'ownership query scopes id and user_id',
  ledger.includes('where: { id: portfolio_id, user_id }')
);
assert(
  'risk alerts stay inside the selected portfolio',
  ledger.includes('metadata: { [Op.contains]: { portfolio_id } }')
);
assert(
  'ledger implementation has no model writes',
  !/\.save\(|\.update\(|\.create\(|\.destroy\(/.test(ledger)
);

console.log(`${8 - failed} ok, ${failed} failed`);
if (failed) process.exitCode = 1;
