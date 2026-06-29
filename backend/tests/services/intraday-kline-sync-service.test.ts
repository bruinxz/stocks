/**
 * IntradayKlineSyncService 单测 (PR-M2 2026-06-29).
 *
 * 跑: npx ts-node --transpile-only tests/services/intraday-kline-sync-service.test.ts
 *
 * 覆盖: pure helpers + runOnce 守卫 + per-symbol fail-OPEN + dry_run.
 */

import {
  PER_SYMBOL_TIMEOUT_MS,
  BATCH_CONCURRENCY,
  DEFAULT_UNIVERSE_LIMIT,
  FIRST_KLINE_END_HOUR,
  IntradayKlineSyncService,
  IntradayKlineDataSource,
  IntradayKlineRow,
  parseKlineTime,
  isAfterFirstKlineClose,
  todayTradeDate,
  filterTodayKlines,
  chunkSymbols,
  runConcurrent,
} from '../../src/services/IntradayKlineSyncService';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    // eslint-disable-next-line no-console
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${label}`);
  }
}
function equal<T>(label: string, actual: T, expected: T): void {
  check(`${label} (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})`, actual === expected);
}

(async () => {
  // 常量
  equal('PER_SYMBOL_TIMEOUT_MS=15000', PER_SYMBOL_TIMEOUT_MS, 15_000);
  equal('BATCH_CONCURRENCY=4', BATCH_CONCURRENCY, 4);
  equal('DEFAULT_UNIVERSE_LIMIT=500', DEFAULT_UNIVERSE_LIMIT, 500);
  equal('FIRST_KLINE_END_HOUR=10', FIRST_KLINE_END_HOUR, 10);

  // parseKlineTime
  const t1 = parseKlineTime('2026-06-29 10:00:00');
  check('parseKlineTime valid', !!t1);
  check('parseKlineTime → 10:00 Asia/Shanghai = 02:00 UTC', t1?.toISOString() === '2026-06-29T02:00:00.000Z');
  equal('parseKlineTime empty → null', parseKlineTime(''), null);
  equal('parseKlineTime bad → null', parseKlineTime('not a date'), null);

  // isAfterFirstKlineClose / todayTradeDate
  const before10 = new Date('2026-06-29T01:55:00Z'); // 9:55 Shanghai
  const after10 = new Date('2026-06-29T02:00:00Z'); // 10:00 Shanghai
  equal('before 10:00 → false', isAfterFirstKlineClose(before10), false);
  equal('after 10:00 → true', isAfterFirstKlineClose(after10), true);
  equal('todayTradeDate 2026-06-29', todayTradeDate(after10), '2026-06-29');

  // filterTodayKlines
  const rows: IntradayKlineRow[] = [
    {
      symbol: 'sh.600519',
      kline_time: parseKlineTime('2026-06-29 10:00:00')!,
      open: 1, high: 1, low: 1, close: 1, volume: 1, money: 1,
    },
    {
      symbol: 'sh.600519',
      kline_time: parseKlineTime('2026-06-28 10:00:00')!,
      open: 1, high: 1, low: 1, close: 1, volume: 1, money: 1,
    },
  ];
  const today = filterTodayKlines(rows, '2026-06-29');
  equal('filterTodayKlines length=1', today.length, 1);

  // chunkSymbols
  const c = chunkSymbols([1, 2, 3, 4, 5], 2);
  equal('chunkSymbols [1,2,3,4,5] / 2 → 3 batches', c.length, 3);
  equal('chunkSymbols first len=2', c[0].length, 2);
  equal('chunkSymbols last len=1', c[2].length, 1);
  const c0 = chunkSymbols([1, 2], 0);
  equal('chunkSymbols [1,2] / 0 → 1 batch (passthrough)', c0.length, 1);

  // runConcurrent preserves order
  const items = [3, 1, 2];
  const out = await runConcurrent(items, 2, async n => {
    await new Promise(r => setTimeout(r, n * 10));
    return n * 100;
  });
  equal('runConcurrent preserves order [3,1,2] → [300,100,200]', JSON.stringify(out), JSON.stringify([300, 100, 200]));

  // runOnce 守卫 before_first_kline_close
  const fakeDs: IntradayKlineDataSource = {
    async loadUniverseSymbols() {
      return ['sh.600519', 'sz.000001'];
    },
    async fetchSymbolKlines(sym) {
      return [
        {
          symbol: sym,
          kline_time: parseKlineTime('2026-06-29 10:00:00')!,
          open: 1, high: 1, low: 1, close: 1, volume: 1, money: 1,
        },
      ];
    },
    async upsertKlines(rs) {
      return rs.length;
    },
  };
  const svc = new IntradayKlineSyncService(fakeDs);
  let res = await svc.runOnce({ now: before10 });
  equal('守卫 before_first_kline_close', res.skipped_reason, 'before_first_kline_close');

  // happy with force + dry_run
  res = await svc.runOnce({ now: after10, force: true, dry_run: true });
  equal('happy scanned=2', res.scanned_symbols, 2);
  equal('happy ok=2', res.succeeded_symbols, 2);
  equal('happy klines=2', res.total_klines, 2);
  equal('happy inserted=0 (dry)', res.inserted, 0);

  // real upsert
  res = await svc.runOnce({ now: after10, force: true, dry_run: false });
  equal('real inserted=2', res.inserted, 2);

  // per-symbol fetch fail (some return [])
  const partialDs: IntradayKlineDataSource = {
    async loadUniverseSymbols() {
      return ['sh.A', 'sh.B', 'sh.C'];
    },
    async fetchSymbolKlines(sym) {
      if (sym === 'sh.B') throw new Error('B boom');
      if (sym === 'sh.C') return [];
      return [
        {
          symbol: sym,
          kline_time: parseKlineTime('2026-06-29 10:00:00')!,
          open: 1, high: 1, low: 1, close: 1, volume: 1, money: 1,
        },
      ];
    },
    async upsertKlines(rs) {
      return rs.length;
    },
  };
  res = await new IntradayKlineSyncService(partialDs).runOnce({
    now: after10,
    force: true,
  });
  equal('partial scanned=3', res.scanned_symbols, 3);
  // ok: A 成功+B 失败+C 空 → succeeded=A+C=2 (空也算 fetch ok)
  equal('partial succeeded_symbols=2 (B fail)', res.succeeded_symbols, 2);
  equal('partial total_klines=1 (only A)', res.total_klines, 1);

  // universe empty → empty_universe
  const emptyDs: IntradayKlineDataSource = {
    async loadUniverseSymbols() {
      return [];
    },
    async fetchSymbolKlines() {
      return [];
    },
    async upsertKlines() {
      return 0;
    },
  };
  res = await new IntradayKlineSyncService(emptyDs).runOnce({
    now: after10,
    force: true,
  });
  equal('empty universe', res.skipped_reason, 'empty_universe');

  // explicit symbols
  res = await new IntradayKlineSyncService(fakeDs).runOnce({
    now: after10,
    force: true,
    symbols: ['sh.600519'],
    dry_run: true,
  });
  equal('explicit symbols scanned=1', res.scanned_symbols, 1);

  // eslint-disable-next-line no-console
  console.log(`\n========= IntradayKlineSyncService tests: ${pass} pass, ${fail} fail =========`);
  if (fail > 0) process.exit(1);
})();
