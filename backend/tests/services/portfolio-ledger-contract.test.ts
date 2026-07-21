import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  classifyQuoteFreshness,
  classifyResearchFreshness,
  correctionTouchesPosition,
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
  'same-day recent quote is live during the session',
  classifyQuoteFreshness('2026-07-21T01:55:00.000Z', '2026-07-21', now).freshness === 'live'
);
assert(
  'previous completed close is valid before open',
  classifyQuoteFreshness(
    '2026-07-20T07:00:00.000Z',
    '2026-07-20',
    new Date('2026-07-21T01:00:00.000Z')
  ).freshness === 'close'
);
assert(
  'same-day close stays valid after market close',
  classifyQuoteFreshness(
    '2026-07-21T07:00:00.000Z',
    '2026-07-21',
    new Date('2026-07-21T12:00:00.000Z')
  ).freshness === 'close'
);
assert(
  'an intraday quote cannot masquerade as the closing quote after close',
  classifyQuoteFreshness(
    '2026-07-21T02:00:00.000Z',
    '2026-07-21',
    new Date('2026-07-21T12:00:00.000Z')
  ).freshness === 'stale'
);
assert(
  'prior trading-day quote is stale',
  classifyQuoteFreshness('2026-07-20T07:00:00.000Z', '2026-07-20', now).freshness === 'stale'
);
assert(
  'missing quote is explicit',
  classifyQuoteFreshness(null, null, now).freshness === 'missing'
);
assert(
  'research snapshot on expected completed day is fresh',
  classifyResearchFreshness('2026-07-20', '2026-07-20').freshness === 'fresh'
);
assert(
  'research snapshot one session behind is delayed',
  classifyResearchFreshness('2026-07-17', '2026-07-20').freshness === 'delayed'
);
assert(
  'correction matching traverses structured portfolio and symbol fields',
  correctionTouchesPosition(
    {
      entity_id: '447',
      before_state: { portfolio: { id: 65 } },
      after_state: { position: { symbol: 'sh.600483' } },
    },
    65,
    'sh.600483'
  )
);
assert(
  'correction matching rejects an unrelated portfolio',
  !correctionTouchesPosition(
    {
      before_state: { portfolio: { id: 66 } },
      after_state: { position: { symbol: 'sh.600483' } },
    },
    65,
    'sh.600483'
  )
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
    invalidated: false,
  },
  {
    id: 'a',
    type: 'trade',
    title: 'a',
    detail: null,
    occurred_at: '2026-07-21T01:00:00Z',
    status: null,
    corrected: false,
    invalidated: false,
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
const facade = readFileSync(
  resolve(__dirname, '../../src/portfolio/PaperTradingFacade.ts'),
  'utf8'
);
const rebalance = readFileSync(
  resolve(__dirname, '../../src/portfolio/RebalanceEngine.ts'),
  'utf8'
);
const recommendationRead = readFileSync(
  resolve(__dirname, '../../src/recommendations/SequelizeRecommendationSnapshotReadAdapter.ts'),
  'utf8'
);
const multibaggerController = readFileSync(
  resolve(__dirname, '../../src/api/controllers/MultibaggerController.ts'),
  'utf8'
);
const drawdownBreaker = readFileSync(
  resolve(__dirname, '../../src/portfolio/risk/DrawdownCircuitBreaker.ts'),
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
  'ledger accepts only explicitly scoped portfolio alerts and notifications',
  ledger.includes('metadata: { [Op.contains]: { portfolio_id } }') &&
    !ledger.includes('account_alerts:') &&
    !ledger.includes('activePortfolioIds.length === 1') &&
    !ledger.includes('portfoliosBySymbol')
);
assert(
  'multibagger matching selects the latest eligible row per ticker',
  ledger.includes('DISTINCT ON (market_scope, exchange, ticker)') &&
    ledger.includes('available_at_utc <= :now')
);
assert(
  'trade linkage uses the exact outcome entry trade before fallback',
  ledger.includes('row.id === outcome.entry_trade_id')
);
assert(
  'manual order mutation requires explicit portfolio scope',
  controller.includes('portfolio_id 必须为正整数，禁止自动选择其他模拟盘') &&
    !facade.includes('[facade.placeOrder] user_id=')
);
assert(
  'legacy portfolio and snapshot readers cannot choose the first portfolio',
  !facade.includes('[facade.getPortfolio] user_id=') &&
    !facade.includes('[facade.getDailySnapshot] user_id=') &&
    facade.includes("err.code = 'PORTFOLIO_SCOPE_REQUIRED'")
);
assert(
  'stop loss and take profit writes carry explicit portfolio scope',
  controller.includes('portfolio_id: requiredPortfolioId(portfolio_id)') &&
    !facade.includes('[facade.applyAutomation] set_*_price')
);
assert(
  'account-wide drawdown alerts declare account scope instead of one portfolio',
  drawdownBreaker.includes("ledger_scope: 'account_risk'") &&
    drawdownBreaker.includes('portfolio_ids: input.portfolio_ids') &&
    drawdownBreaker.includes('portfolio_id: null')
);
assert(
  'rebalance execution carries the requested portfolio id into every order',
  rebalance.includes('portfolio_id: input.portfolio_id') &&
    rebalance.includes('portfolio_id,\n            user_id: portfolio.user_id')
);
assert(
  'public morning feed rejects future snapshots and uses the same latest ordering',
  recommendationRead.includes('AND as_of_utc <= NOW()') &&
    ledger.includes("['asOfUtc', 'DESC']") &&
    ledger.includes("['createdAt', 'DESC']")
);
assert(
  'public multibagger feed and ledger both enforce candidate availability',
  (multibaggerController.match(/available_at_utc <= NOW\(\)/g) || []).length === 2 &&
    ledger.includes('available_at_utc <= :now')
);
assert(
  'ledger implementation has no model writes',
  !/\.save\(|\.update\(|\.create\(|\.destroy\(/.test(ledger)
);

console.log(`${24 - failed} ok, ${failed} failed`);
if (failed) process.exitCode = 1;
