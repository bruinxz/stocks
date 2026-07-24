import assert from 'assert';
import { Op } from 'sequelize';
import { RealtimeQuote } from '../../src/models/RealtimeQuote';
import { realtimeQuoteService } from '../../src/data/services/RealtimeQuoteService';

async function main() {
  const symbols = ['sh.600790', 'sh.601669', 'sz.002203', 'sz.300867', 'sz.300970', 'sz.301246'];
  const calls: any[] = [];
  const originalFindAll = RealtimeQuote.findAll;
  (RealtimeQuote as any).findAll = async (options: any) => {
    calls.push(options);
    if (calls.length === 1) {
      return symbols.map((symbol, index) => ({
        symbol,
        latest_quote_time: new Date(`2026-07-24T07:00:0${index}.000Z`),
      }));
    }
    return symbols.map(symbol => ({ symbol }));
  };

  try {
    const rows = await realtimeQuoteService.getLatestQuotes(symbols);
    assert.deepEqual(
      rows.map(row => (row as any).symbol),
      symbols,
      'every requested symbol must retain its latest quote'
    );
    assert.deepEqual(calls[0].group, ['symbol']);
    assert.equal(calls[0].raw, true);
    assert.equal(calls[1].where[Op.or].length, symbols.length);
    assert.deepEqual(
      calls[1].where[Op.or].map((row: any) => row.symbol),
      symbols
    );
  } finally {
    (RealtimeQuote as any).findAll = originalFindAll;
  }
}

main()
  .then(() => console.log('realtime latest quote tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
