/**
 * AuctionSnapshotSyncService 单测 (PR-M2 2026-06-29).
 *
 * 跑: npx ts-node --transpile-only tests/services/auction-snapshot-sync-service.test.ts
 *
 * 覆盖:
 *   - pure helpers (classifyAuctionPattern / quoteToSnapshotRow / numberOrNull / roundTo / counters / isAfterAuctionEnd / todayTradeDate)
 *   - runOnce fail-OPEN (universe / fetch / classify 路径)
 *   - 守卫 (before_auction_end / not_trading_day / empty_universe)
 *   - dry_run 不写库
 */

import {
  AuctionPattern,
  ALL_AUCTION_PATTERNS,
  HIGH_OPEN_VOLUME_PCT_THRESHOLD,
  GAP_UP_PCT_THRESHOLD,
  GAP_DOWN_PCT_THRESHOLD,
  AUCTION_END_HOUR,
  AUCTION_END_MINUTE,
  AuctionSnapshotSyncService,
  AuctionSnapshotDataSource,
  AuctionSnapshotRow,
  AuctionSpotQuote,
  classifyAuctionPattern,
  quoteToSnapshotRow,
  numberOrNull,
  roundTo,
  emptyPatternCounter,
  countByPatternInMemory,
  isAfterAuctionEnd,
  todayTradeDate,
} from '../../src/services/AuctionSnapshotSyncService';

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
  // ---------------- 常量 ----------------
  equal('GAP_UP=1', GAP_UP_PCT_THRESHOLD, 1.0);
  equal('GAP_DOWN=-1', GAP_DOWN_PCT_THRESHOLD, -1.0);
  equal('HIGH_OPEN=3', HIGH_OPEN_VOLUME_PCT_THRESHOLD, 3.0);
  equal('AUCTION_END_HOUR=9', AUCTION_END_HOUR, 9);
  equal('AUCTION_END_MINUTE=25', AUCTION_END_MINUTE, 25);
  equal('ALL_PATTERNS length=9', ALL_AUCTION_PATTERNS.length, 9);

  // ---------------- numberOrNull ----------------
  equal('numberOrNull(5)=5', numberOrNull(5), 5);
  equal('numberOrNull("3.14")=3.14', numberOrNull('3.14'), 3.14);
  equal('numberOrNull("abc")=null', numberOrNull('abc'), null);
  equal('numberOrNull(NaN)=null', numberOrNull(NaN), null);
  equal('numberOrNull(undef)=null', numberOrNull(undefined), null);
  equal('numberOrNull("")=null', numberOrNull(''), null);

  // ---------------- roundTo ----------------
  equal('roundTo(1.2345, 2)=1.23', roundTo(1.2345, 2), 1.23);
  equal('roundTo(1.999, 2)=2', roundTo(1.999, 2), 2);

  // ---------------- classifyAuctionPattern ----------------
  // 缺数据
  let r = classifyAuctionPattern({ symbol: 'sh.600519', open: null, prev_close: 100 });
  equal('open=null → normal', r.pattern, 'normal');
  equal('open=null → pct null', r.open_change_pct, null);
  r = classifyAuctionPattern({ symbol: 'sh.600519', open: 100, prev_close: null });
  equal('prev_close=null → normal', r.pattern, 'normal');
  r = classifyAuctionPattern({ symbol: 'sh.600519', open: 100, prev_close: 0 });
  equal('prev_close=0 → normal', r.pattern, 'normal');

  // 平开
  r = classifyAuctionPattern({ symbol: 'sh.600519', open: 100, prev_close: 100 });
  equal('+0% → normal', r.pattern, 'normal');
  equal('+0% pct=0', r.open_change_pct, 0);

  // gap_up
  r = classifyAuctionPattern({ symbol: 'sh.600519', open: 102, prev_close: 100 });
  equal('+2% → gap_up', r.pattern, 'gap_up');

  // high_open_volume
  r = classifyAuctionPattern({ symbol: 'sh.600519', open: 104, prev_close: 100 });
  equal('+4% → high_open_volume', r.pattern, 'high_open_volume');

  // gap_down
  r = classifyAuctionPattern({ symbol: 'sh.600519', open: 98, prev_close: 100 });
  equal('-2% → gap_down', r.pattern, 'gap_down');

  // one_word — 主板 +10% 且 OHL 相等
  r = classifyAuctionPattern({
    symbol: 'sh.600519',
    open: 110,
    high: 110,
    low: 110,
    prev_close: 100,
  });
  equal('OHL=110 主板 +10% → one_word', r.pattern, 'one_word');
  equal('one_word is_limit_up=true', r.is_limit_up, true);

  // ST 5% +5% 且 OHL 相等
  r = classifyAuctionPattern({
    symbol: 'sh.600519',
    name: 'ST 招商',
    open: 105,
    high: 105,
    low: 105,
    prev_close: 100,
  });
  equal('ST OHL=105 → one_word', r.pattern, 'one_word');

  // OHL 相等但涨幅 < limit → high_open_volume
  r = classifyAuctionPattern({
    symbol: 'sh.600519',
    open: 105,
    high: 105,
    low: 105,
    prev_close: 100,
  });
  equal('主板 OHL 相等 +5% (非 limit) → high_open_volume', r.pattern, 'high_open_volume');

  // ---------------- quoteToSnapshotRow ----------------
  const q: AuctionSpotQuote = {
    symbol: 'sh.600519',
    name: '贵州茅台',
    open: 102,
    high: 103,
    low: 101.5,
    current: 102.5,
    prev_close: 100,
    volume: 1000,
    turnover: 102000,
  };
  const row = quoteToSnapshotRow('2026-06-29', q);
  equal('row.symbol', row.symbol, 'sh.600519');
  equal('row.trade_date', row.trade_date, '2026-06-29');
  equal('row.pattern=gap_up', row.pattern, 'gap_up');
  equal('row.is_limit_up=false', row.is_limit_up, false);
  equal('row.open_amount=turnover', row.open_amount, 102000);
  // turnover 缺失 → open × volume
  const row2 = quoteToSnapshotRow('2026-06-29', { ...q, turnover: null });
  equal('row.open_amount = open*volume', row2.open_amount, 102000);

  // ---------------- counters ----------------
  const c = emptyPatternCounter();
  equal('emptyPatternCounter one_word=0', c.one_word, 0);
  equal('emptyPatternCounter normal=0', c.normal, 0);
  const rows: AuctionSnapshotRow[] = [row, row, row2];
  const cnt = countByPatternInMemory(rows);
  equal('count gap_up=3', cnt.gap_up, 3);

  // ---------------- isAfterAuctionEnd / todayTradeDate ----------------
  // 9:24 → false; 9:25 → true; 14:00 → true (Asia/Shanghai)
  const before = new Date('2026-06-29T01:20:00Z'); // = 9:20 Asia/Shanghai
  const after = new Date('2026-06-29T01:30:00Z'); // = 9:30 Asia/Shanghai
  equal('9:20 Shanghai → isAfter false', isAfterAuctionEnd(before), false);
  equal('9:30 Shanghai → isAfter true', isAfterAuctionEnd(after), true);
  equal('todayTradeDate 2026-06-29 Shanghai', todayTradeDate(after), '2026-06-29');

  // ---------------- runOnce: 守卫 before_auction_end ----------------
  const fakeDs: AuctionSnapshotDataSource = {
    async loadUniverseSymbols() {
      return ['sh.600519', 'sz.000001'];
    },
    async fetchSpotQuotes(symbols) {
      return symbols.map((s, i) => ({
        symbol: s,
        name: `name${i}`,
        open: 100 + i * 2,
        high: 101 + i * 2,
        low: 99 + i * 2,
        current: 100 + i * 2,
        prev_close: 100,
        volume: 1000,
        turnover: 100000,
      }));
    },
    async upsertSnapshots(_d, rs) {
      return rs.length;
    },
  };

  const svc = new AuctionSnapshotSyncService(fakeDs);
  let res = await svc.runOnce({ now: before, dry_run: true });
  equal('before_auction skipped', res.skipped_reason, 'before_auction_end');
  equal('before_auction scanned=0', res.scanned, 0);

  // ---------------- runOnce: force + dry_run, happy path ----------------
  res = await svc.runOnce({ now: after, force: true, dry_run: true });
  equal('force scanned=2', res.scanned, 2);
  equal('force inserted=0 (dry)', res.inserted, 0);
  equal('happy skipped_reason null', res.skipped_reason, null);

  // ---------------- runOnce: force + real upsert ----------------
  res = await svc.runOnce({ now: after, force: true, dry_run: false });
  equal('real inserted=2', res.inserted, 2);

  // ---------------- runOnce: universe load throws ----------------
  const badUniverseDs: AuctionSnapshotDataSource = {
    async loadUniverseSymbols() {
      throw new Error('universe boom');
    },
    async fetchSpotQuotes() {
      return [];
    },
    async upsertSnapshots() {
      return 0;
    },
  };
  res = await new AuctionSnapshotSyncService(badUniverseDs).runOnce({
    now: after,
    force: true,
  });
  equal('universe throw → empty_universe', res.skipped_reason, 'empty_universe');

  // ---------------- runOnce: fetch throws ----------------
  const badFetchDs: AuctionSnapshotDataSource = {
    async loadUniverseSymbols() {
      return ['sh.600519'];
    },
    async fetchSpotQuotes() {
      throw new Error('fetch boom');
    },
    async upsertSnapshots() {
      return 0;
    },
  };
  res = await new AuctionSnapshotSyncService(badFetchDs).runOnce({
    now: after,
    force: true,
  });
  equal('fetch throw → scanned=0 但 SUCCESS', res.scanned, 0);
  equal('fetch throw → skipped null', res.skipped_reason, null);

  // ---------------- by_pattern counter 计入 normal ----------------
  const mixedDs: AuctionSnapshotDataSource = {
    async loadUniverseSymbols() {
      return ['sh.600519', 'sz.000001', 'sh.600036'];
    },
    async fetchSpotQuotes() {
      return [
        // gap_up
        { symbol: 'sh.600519', name: 'A', open: 102, high: 103, low: 101, current: 102, prev_close: 100, volume: 1000, turnover: 102000 },
        // gap_down
        { symbol: 'sz.000001', name: 'B', open: 98, high: 99, low: 97, current: 98, prev_close: 100, volume: 1000, turnover: 98000 },
        // normal
        { symbol: 'sh.600036', name: 'C', open: 100.2, high: 100.5, low: 99.9, current: 100.2, prev_close: 100, volume: 1000, turnover: 100200 },
      ];
    },
    async upsertSnapshots(_d, rs) {
      return rs.length;
    },
  };
  res = await new AuctionSnapshotSyncService(mixedDs).runOnce({
    now: after,
    force: true,
  });
  equal('mixed by_pattern.gap_up=1', res.by_pattern.gap_up, 1);
  equal('mixed by_pattern.gap_down=1', res.by_pattern.gap_down, 1);
  equal('mixed by_pattern.normal=1', res.by_pattern.normal, 1);
  equal('mixed inserted=3', res.inserted, 3);

  // eslint-disable-next-line no-console
  console.log(`\n========= AuctionSnapshotSyncService tests: ${pass} pass, ${fail} fail =========`);
  if (fail > 0) process.exit(1);
})();
