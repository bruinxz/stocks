/**
 * basic-portfolio-return-units.test.ts
 *
 * The legacy event-driven backtest engine feeds Portfolio.getDailyReturns()
 * directly into Sharpe/Sortino calculations and the React chart multiplies
 * daily_returns by 100 for display. The stored daily return series therefore
 * must be decimal returns (1% => 0.01), not percentage points (1% => 1).
 */

import { EventType, FillEvent } from '../../src/backtest/engine/Event';
import { Portfolio } from '../../src/backtest/engine/Portfolio';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-9): void {
  assert(name, Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
}

console.log('\n## legacy Portfolio daily return unit is decimal');

const portfolio = new Portfolio(1000);
const trade_date = new Date('2026-06-01T00:00:00.000Z');
const next_date = new Date('2026-06-02T00:00:00.000Z');

const fill: FillEvent = {
  type: EventType.FILL,
  timestamp: trade_date,
  data: {
    orderId: 'order_1',
    symbol: 'TEST.SH',
    direction: 'buy',
    filledQuantity: 10,
    filledPrice: 10,
    commission: 0,
    timestamp: trade_date,
  },
};

portfolio.handleFillEvent(fill, trade_date);
portfolio.updatePositions(new Map([['TEST.SH', 10]]), trade_date);
portfolio.resetDailyPnl();

portfolio.updatePositions(new Map([['TEST.SH', 11]]), next_date);

const metrics = portfolio.getMetrics();
expectClose('getMetrics().dailyReturn stores 1% as 0.01', metrics.dailyReturn, 0.01);

portfolio.resetDailyPnl();
const daily_returns = portfolio.getDailyReturns();

assert('getDailyReturns records one non-zero daily return', daily_returns.length === 1);
expectClose('getDailyReturns()[0] stores 1% as 0.01', daily_returns[0], 0.01);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
