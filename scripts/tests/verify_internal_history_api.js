#!/usr/bin/env node

/**
 * Verify TradingAgents internal history endpoints.
 *
 * Usage:
 *   INTERNAL_API_BASE_URL=https://internal-api.example.invalid \
 *   INTERNAL_API_KEY=... \
 *   node scripts/tests/verify_internal_history_api.js sh.600000 sz.000001
 */

const assert = require('assert');

const baseUrl = process.env.INTERNAL_API_BASE_URL;
const apiKey = process.env.INTERNAL_API_KEY;

if (!baseUrl) {
  throw new Error('INTERNAL_API_BASE_URL is required; no production endpoint default is allowed');
}
if (!apiKey) {
  throw new Error('INTERNAL_API_KEY is required; no credential fallback is allowed');
}
const symbols = process.argv.slice(2);
const targetSymbols = symbols.length > 0 ? symbols : ['sh.600000'];

const headers = {
  'Content-Type': 'application/json',
  'X-API-Key': apiKey,
};

const requiredBarFields = ['trade_date', 'date', 'open', 'high', 'low', 'close', 'volume'];

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`Non-JSON response ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok || json.success !== true) {
    throw new Error(`API failed ${response.status}: ${JSON.stringify(json).slice(0, 800)}`);
  }
  return json;
}

function assertBarShape(bar, context) {
  for (const field of requiredBarFields) {
    assert.ok(Object.prototype.hasOwnProperty.call(bar, field), `${context} missing ${field}`);
  }
  assert.match(String(bar.trade_date), /^\d{4}-\d{2}-\d{2}$/, `${context} invalid trade_date`);
  assert.strictEqual(bar.date, bar.trade_date, `${context} date should mirror trade_date`);
  for (const field of ['open', 'high', 'low', 'close']) {
    assert.strictEqual(typeof bar[field], 'number', `${context} ${field} should be number`);
  }
}

(async () => {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const singleSymbol = targetSymbols[0];
  const singleUrl = new URL('/api/internal/data/history', baseUrl);
  singleUrl.searchParams.set('symbol', singleSymbol);
  singleUrl.searchParams.set('start_date', start);
  singleUrl.searchParams.set('end_date', end);

  const single = await requestJson(singleUrl.toString());
  assert.strictEqual(single.symbol, singleSymbol, 'single symbol mismatch');
  assert.ok(Array.isArray(single.data), 'single data should be array');
  assert.ok(single.data.length > 0, `single endpoint returned no bars for ${singleSymbol}`);
  assertBarShape(single.data[0], `single ${singleSymbol}`);

  const batch = await requestJson(new URL('/api/internal/data/batch-history', baseUrl).toString(), {
    method: 'POST',
    body: JSON.stringify({ symbols: targetSymbols, start_date: start, end_date: end }),
  });
  assert.ok(batch.data && typeof batch.data === 'object', 'batch data should be object');

  for (const symbol of targetSymbols) {
    assert.ok(Array.isArray(batch.data[symbol]), `batch missing array for ${symbol}`);
    if (batch.data[symbol].length === 0) {
      console.warn(`WARN: batch endpoint returned no bars for ${symbol}`);
      continue;
    }
    assertBarShape(batch.data[symbol][0], `batch ${symbol}`);
  }

  console.log(
    JSON.stringify(
      {
        success: true,
        baseUrl,
        start,
        end,
        single: {
          symbol: single.symbol,
          count: single.count,
          first: single.data[0],
          last: single.data[single.data.length - 1],
        },
        batch_counts: Object.fromEntries(
          Object.entries(batch.data).map(([symbol, bars]) => [symbol, bars.length])
        ),
      },
      null,
      2
    )
  );
})().catch(error => {
  console.error(error);
  process.exit(1);
});
