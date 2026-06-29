/**
 * OpeningRushDetector 单测 (PR-O3 2026-06-30).
 *
 * 跑: npx ts-node --transpile-only tests/services/opening-rush-detector.test.ts
 */

import {
  ACTIONABLE_PATTERNS,
  HIGH_OPEN_MIN_PCT,
  GAP_UP_MIN_PCT,
  SOURCE_TYPE_OPENING_RUSH,
  TIMING_TAG_OPENING_RUSH,
  deriveBattlePlay,
  deriveBattlePlayLabel,
  shouldPush,
  scoreOpeningRush,
  buildHitReason,
  buildSourceId,
  hitToSignalRow,
  emptyByPattern,
  isAfterAuctionEnd,
  todayTradeDate,
  OpeningRushDetector,
  OpeningRushDataSource,
  AuctionSnapshotLike,
  WriteSignalRow,
  PATTERN_TO_BATTLE_PLAY,
} from '../../src/services/OpeningRushDetector';
import type {
  OvernightContext,
  MarketDirection,
} from '../../src/services/OvernightSignalSyncService';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}`);
  }
}
function equal<T>(label: string, actual: T, expected: T): void {
  check(
    `${label} (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})`,
    actual === expected
  );
}

function fakeOvernight(direction: MarketDirection, a50Pct = 0.5): OvernightContext {
  const sigs = new Map<any, any>();
  sigs.set('a50_future', {
    signal_type: 'a50_future',
    source: 'sina',
    value: 13000,
    change_pct: a50Pct,
    raw_payload: {},
    collected_at: new Date(),
  });
  return {
    signals: sigs,
    market_direction: direction,
    reason: `A50 ${a50Pct.toFixed(2)}%`,
    source_count: 1,
    as_of: new Date(),
  };
}

(async () => {
  equal('HIGH_OPEN_MIN=3', HIGH_OPEN_MIN_PCT, 3.0);
  equal('GAP_UP_MIN=2', GAP_UP_MIN_PCT, 2.0);
  equal('SOURCE_TYPE_OPENING_RUSH', SOURCE_TYPE_OPENING_RUSH, 'opening_rush_detector');
  equal('TIMING_TAG_OPENING_RUSH', TIMING_TAG_OPENING_RUSH, 'opening_rush');
  equal('ACTIONABLE_PATTERNS includes one_word', ACTIONABLE_PATTERNS.includes('one_word'), true);
  equal('ACTIONABLE_PATTERNS no gap_down', ACTIONABLE_PATTERNS.includes('gap_down'), false);
  equal('ACTIONABLE_PATTERNS no normal', ACTIONABLE_PATTERNS.includes('normal'), false);

  equal('one_word → one_word_play', deriveBattlePlay('one_word'), 'one_word_play');
  equal(
    'high_open_volume → high_open_volume_play',
    deriveBattlePlay('high_open_volume'),
    'high_open_volume_play'
  );
  equal('unknown → normal_play', deriveBattlePlay('xyz'), 'normal_play');
  equal('PATTERN_TO_BATTLE_PLAY length=9', Object.keys(PATTERN_TO_BATTLE_PLAY).length, 9);

  check('one_word label has 🚀', deriveBattlePlayLabel('one_word').includes('🚀'));
  check('high_open_volume label has ☀️', deriveBattlePlayLabel('high_open_volume').includes('☀️'));
  equal('gap_down label empty', deriveBattlePlayLabel('gap_down'), '');

  const baseSnap: AuctionSnapshotLike = {
    trade_date: '2026-06-30',
    symbol: 'sh.600519',
    name: '贵州茅台',
    open_price: 1000,
    open_volume: 1000,
    open_amount: 1000000,
    prev_close: 950,
    open_change_pct: null,
    is_limit_up: false,
    pattern: 'normal',
  };

  equal('normal → no push', shouldPush({ ...baseSnap, pattern: 'normal' }), false);
  equal('gap_down → no push', shouldPush({ ...baseSnap, pattern: 'gap_down' }), false);
  equal('one_word → push', shouldPush({ ...baseSnap, pattern: 'one_word' }), true);
  equal(
    'high_open_volume +2% → no push',
    shouldPush({ ...baseSnap, pattern: 'high_open_volume', open_change_pct: 2.0 }),
    false
  );
  equal(
    'high_open_volume +3.5% → push',
    shouldPush({ ...baseSnap, pattern: 'high_open_volume', open_change_pct: 3.5 }),
    true
  );
  equal(
    'gap_up +1.5% → no push (< 2)',
    shouldPush({ ...baseSnap, pattern: 'gap_up', open_change_pct: 1.5 }),
    false
  );
  equal(
    'gap_up +2.5% → push',
    shouldPush({ ...baseSnap, pattern: 'gap_up', open_change_pct: 2.5 }),
    true
  );

  const bull = fakeOvernight('bullish', 1.5);
  const neutral = fakeOvernight('neutral', 0.1);
  const score1 = scoreOpeningRush(
    { ...baseSnap, pattern: 'one_word', is_limit_up: true, open_change_pct: 9.9 },
    bull
  );
  check(`one_word + bullish + limit_up + +9.9% → 99 cap (got ${score1})`, score1 === 99);
  const score2 = scoreOpeningRush(
    { ...baseSnap, pattern: 'gap_up', open_change_pct: 2.5 },
    neutral
  );
  equal('gap_up + neutral + +2.5% → 70', score2, 70);
  const score3 = scoreOpeningRush(
    { ...baseSnap, pattern: 'gap_up', open_change_pct: 2.5 },
    null
  );
  equal('gap_up + null overnight + +2.5% → 69', score3, 69);

  const r1 = buildHitReason(
    { ...baseSnap, pattern: 'one_word', open_change_pct: 9.99, is_limit_up: true },
    bull
  );
  check(`reason 含一字板`, r1.includes('一字板'));
  check(`reason 含 +9.99%`, r1.includes('+9.99%'));
  check(`reason 含 走强`, r1.includes('走强'));

  equal(
    'buildSourceId',
    buildSourceId('sh.600519', '2026-06-30'),
    'opening_rush::sh.600519::2026-06-30'
  );
  const cnt = emptyByPattern();
  equal('emptyByPattern one_word=0', cnt.one_word, 0);
  equal('emptyByPattern gap_up=0', cnt.gap_up, 0);

  const hit = {
    symbol: 'sh.600519',
    name: '贵州茅台',
    pattern: 'one_word',
    battle_play: 'one_word_play',
    battle_play_label: '🚀 一字板',
    open_change_pct: 9.99,
    is_limit_up: true,
    confidence_score: 95,
    reason: 'r',
    overnight_a50: 1.5,
    overnight_direction: 'bullish' as MarketDirection,
  };
  const row = hitToSignalRow(hit, '2026-06-30', bull);
  equal('row.source_type', row.source_type, SOURCE_TYPE_OPENING_RUSH);
  equal('row.normalized_decision', row.normalized_decision, 'buy');
  equal('row.signal_date', row.signal_date, '2026-06-30');
  equal('row.metadata.timing_tag', (row.metadata as any).timing_tag, TIMING_TAG_OPENING_RUSH);
  equal('row.metadata.battle_play', (row.metadata as any).battle_play, 'one_word_play');
  equal('row.metadata.pattern', (row.metadata as any).pattern, 'one_word');

  const before = new Date('2026-06-30T01:20:00Z');
  const after = new Date('2026-06-30T01:30:00Z');
  equal('9:20 Shanghai → false', isAfterAuctionEnd(before), false);
  equal('9:30 Shanghai → true', isAfterAuctionEnd(after), true);
  equal('todayTradeDate', todayTradeDate(after), '2026-06-30');

  const noopDs: OpeningRushDataSource = {
    async loadOvernightContext() {
      return fakeOvernight('bullish');
    },
    async loadAuctionSnapshots() {
      return [];
    },
    async writeSignals() {
      return { created: 0, updated: 0, errors: 0 };
    },
  };
  const svc = new OpeningRushDetector(noopDs);

  let res = await svc.runOnce({ now: before });
  equal('before 9:25 → skipped before_auction_end', res.skipped_reason, 'before_auction_end');

  const bearishDs: OpeningRushDataSource = {
    async loadOvernightContext() {
      return fakeOvernight('bearish', -2.0);
    },
    async loadAuctionSnapshots() {
      return [
        {
          trade_date: '2026-06-30',
          symbol: 'sh.600519',
          name: 'A',
          open_price: 100,
          open_volume: 1000,
          open_amount: 100000,
          prev_close: 95,
          open_change_pct: 5.26,
          is_limit_up: false,
          pattern: 'high_open_volume',
        },
      ];
    },
    async writeSignals() {
      return { created: 1, updated: 0, errors: 0 };
    },
  };
  res = await new OpeningRushDetector(bearishDs).runOnce({ now: after, force: true });
  equal('bearish overnight → skipped', res.skipped_reason, 'bearish_overnight');
  equal('bearish written=0', res.written, 0);
  equal('bearish direction', res.overnight_direction, 'bearish');

  let wroteRows: WriteSignalRow[] = [];
  const happyDs: OpeningRushDataSource = {
    async loadOvernightContext() {
      return fakeOvernight('bullish', 1.5);
    },
    async loadAuctionSnapshots() {
      return [
        {
          trade_date: '2026-06-30',
          symbol: 'sh.600519',
          name: '一字板票',
          open_price: 110,
          open_volume: 100,
          open_amount: 11000,
          prev_close: 100,
          open_change_pct: 10.0,
          is_limit_up: true,
          pattern: 'one_word',
        },
        {
          trade_date: '2026-06-30',
          symbol: 'sz.000001',
          name: '高开巨量票',
          open_price: 104,
          open_volume: 1000,
          open_amount: 104000,
          prev_close: 100,
          open_change_pct: 4.0,
          is_limit_up: false,
          pattern: 'high_open_volume',
        },
        {
          trade_date: '2026-06-30',
          symbol: 'sh.600036',
          name: '低开票 - 应被过滤',
          open_price: 98,
          open_volume: 1000,
          open_amount: 98000,
          prev_close: 100,
          open_change_pct: -2.0,
          is_limit_up: false,
          pattern: 'gap_down',
        },
      ];
    },
    async writeSignals(rows) {
      wroteRows = rows;
      return { created: rows.length, updated: 0, errors: 0 };
    },
  };
  res = await new OpeningRushDetector(happyDs).runOnce({ now: after, force: true });
  equal('happy scanned=3', res.scanned, 3);
  equal('happy matched=2 (gap_down 过滤)', res.matched, 2);
  equal('happy written=2', res.written, 2);
  equal('happy by_pattern.one_word=1', res.by_pattern.one_word, 1);
  equal('happy by_pattern.high_open_volume=1', res.by_pattern.high_open_volume, 1);
  equal('wrote 2 rows', wroteRows.length, 2);
  equal(
    'wrote one_word first (higher score)',
    (wroteRows[0].metadata as any).pattern,
    'one_word'
  );

  wroteRows = [];
  res = await new OpeningRushDetector(happyDs).runOnce({
    now: after,
    force: true,
    dry_run: true,
  });
  equal('dry_run matched=2', res.matched, 2);
  equal('dry_run written=0', res.written, 0);
  equal('dry_run wroteRows=0', wroteRows.length, 0);

  const emptyDs: OpeningRushDataSource = {
    async loadOvernightContext() {
      return fakeOvernight('neutral');
    },
    async loadAuctionSnapshots() {
      return [];
    },
    async writeSignals() {
      return { created: 0, updated: 0, errors: 0 };
    },
  };
  res = await new OpeningRushDetector(emptyDs).runOnce({ now: after, force: true });
  equal('empty auction → skipped', res.skipped_reason, 'empty_auction');

  const overnightThrowDs: OpeningRushDataSource = {
    async loadOvernightContext() {
      throw new Error('overnight boom');
    },
    async loadAuctionSnapshots() {
      return [
        {
          trade_date: '2026-06-30',
          symbol: 'sh.600519',
          name: 'A',
          open_price: 110,
          open_volume: 100,
          open_amount: 11000,
          prev_close: 100,
          open_change_pct: 10.0,
          is_limit_up: true,
          pattern: 'one_word',
        },
      ];
    },
    async writeSignals(rows) {
      return { created: rows.length, updated: 0, errors: 0 };
    },
  };
  res = await new OpeningRushDetector(overnightThrowDs).runOnce({
    now: after,
    force: true,
  });
  equal('overnight throw → still runs', res.matched, 1);
  equal('overnight throw → direction unknown', res.overnight_direction, 'unknown');
  check('overnight error logged', res.errors.some(e => e.includes('overnight')));

  const manyDs: OpeningRushDataSource = {
    async loadOvernightContext() {
      return fakeOvernight('neutral');
    },
    async loadAuctionSnapshots() {
      const rows: AuctionSnapshotLike[] = [];
      for (let i = 0; i < 10; i++) {
        rows.push({
          trade_date: '2026-06-30',
          symbol: `sh.60${String(i).padStart(4, '0')}`,
          name: `n${i}`,
          open_price: 110,
          open_volume: 100,
          open_amount: 11000,
          prev_close: 100,
          open_change_pct: 10.0,
          is_limit_up: true,
          pattern: 'one_word',
        });
      }
      return rows;
    },
    async writeSignals(rows) {
      return { created: rows.length, updated: 0, errors: 0 };
    },
  };
  res = await new OpeningRushDetector(manyDs).runOnce({
    now: after,
    force: true,
    top_k: 3,
  });
  equal('top_k=3 matched=10 but written=3', res.written, 3);
  equal('top_k=3 hits.length=3', res.hits.length, 3);

  const sunday = new Date('2026-06-28T01:30:00Z');
  res = await new OpeningRushDetector(noopDs).runOnce({ now: sunday });
  equal('Sunday → not_trading_day', res.skipped_reason, 'not_trading_day');

  console.log(`\n========= OpeningRushDetector tests: ${pass} pass, ${fail} fail =========`);
  if (fail > 0) process.exit(1);
})();
