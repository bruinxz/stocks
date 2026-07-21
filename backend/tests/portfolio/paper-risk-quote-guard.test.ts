import assert from 'assert';
import {
  calculatePaperSellFinancials,
  evaluatePaperRiskQuoteGuard,
  quantizePaperExecutionPrice,
} from '../../src/portfolio/internal/PaperTradingAutomationService';

function chinaTime(hour: number, minute: number): Date {
  return new Date(
    `2026-07-21T${String(hour - 8).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`
  );
}

const preOpen = evaluatePaperRiskQuoteGuard({
  now: chinaTime(9, 15),
  quote_date: '2026-07-20',
  quote_time: '2026-07-20T06:55:00.000Z',
  quote_source: 'tencent',
});
assert.equal(preOpen.allowed, false);
assert.equal(preOpen.code, 'outside_execution_window');

const freshIntraday = evaluatePaperRiskQuoteGuard({
  now: chinaTime(9, 45),
  quote_date: '2026-07-21',
  quote_time: '2026-07-21T01:40:00.000Z',
  quote_source: 'tencent',
});
assert.equal(freshIntraday.allowed, true);
assert.equal(freshIntraday.session, 'continuous');

const oldTradingDate = evaluatePaperRiskQuoteGuard({
  now: chinaTime(9, 45),
  quote_date: '2026-07-20',
  quote_time: '2026-07-21T01:40:00.000Z',
  quote_source: 'tencent',
});
assert.equal(oldTradingDate.allowed, false);
assert.equal(oldTradingDate.code, 'quote_trade_date_mismatch');

const staleIntraday = evaluatePaperRiskQuoteGuard({
  now: chinaTime(10, 30),
  quote_date: '2026-07-21',
  quote_time: '2026-07-21T01:45:00.000Z',
  quote_source: 'tencent',
});
assert.equal(staleIntraday.allowed, false);
assert.equal(staleIntraday.code, 'intraday_quote_stale');

const dailyBarIntraday = evaluatePaperRiskQuoteGuard({
  now: chinaTime(10, 30),
  quote_date: '2026-07-21',
  quote_source: 'daily_bar',
});
assert.equal(dailyBarIntraday.allowed, false);
assert.equal(dailyBarIntraday.code, 'intraday_quote_not_realtime');

const closeSnapshot = evaluatePaperRiskQuoteGuard({
  now: chinaTime(15, 50),
  quote_date: '2026-07-21',
  quote_time: '2026-07-21T06:55:00.000Z',
  quote_source: 'tencent',
});
assert.equal(closeSnapshot.allowed, true);
assert.equal(closeSnapshot.session, 'post_close');

assert.equal(quantizePaperExecutionPrice(10.7 * (1 - 0.001)), 10.69);
assert.equal(quantizePaperExecutionPrice(10.42 * (1 + 0.001)), 10.43);

const sell = calculatePaperSellFinancials({
  latest_price: 10.7,
  quantity: 1100,
  avg_cost: 10.42,
  slippage_rate: 0.001,
  commission_rate: 0.0003,
  min_commission: 5,
  stamp_tax_rate: 0.001,
  transfer_fee_rate: 0.00001,
});
assert.equal(sell.execute_price, 10.69);
assert.equal(sell.amount, 11759);
assert.equal(sell.commission, 16.88);
assert.equal(sell.net_revenue, 11742.12);
assert.equal(sell.estimated_buy_commission, 5.11);
assert.equal(sell.realized_pnl, 275.01);
assert.equal(sell.realized_return_pct.toFixed(2), '2.40');

console.log('paper-risk-quote-guard: all assertions passed');
