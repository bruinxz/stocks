/**
 * LastHourMomentumDetector 单测 (PR-O3 2026-06-30).
 */

import {
  SOURCE_TYPE_LAST_HOUR,
  TIMING_TAG_CLOSING_GRAB,
  scoreFromR1,
  buildLastHourReason,
  buildLastHourSourceId,
  isAfter1430Shanghai,
  todayTradeDate,
  LastHourMomentumDetector,
  LastHourMomentumDataSource,
} from '../../src/services/LastHourMomentumDetector';

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

(async () => {
  equal('SOURCE_TYPE', SOURCE_TYPE_LAST_HOUR, 'last_hour_momentum');
  equal('TIMING_TAG', TIMING_TAG_CLOSING_GRAB, 'closing_grab');

  equal('r1=0.5 → 60', scoreFromR1(0.5), 60);
  equal('r1=1.0 → 70', scoreFromR1(1.0), 70);
  equal('r1=1.5 → 70', scoreFromR1(1.5), 70);
  equal('r1=2.0 → 80', scoreFromR1(2.0), 80);
  equal('r1=2.5 → 80', scoreFromR1(2.5), 80);
  equal('r1=3.0 → 88', scoreFromR1(3.0), 88);
  equal('r1=4.5 → 88', scoreFromR1(4.5), 88);
  equal('r1=5.0 → 95', scoreFromR1(5.0), 95);
  equal('r1=10 → 95', scoreFromR1(10), 95);

  const reason = buildLastHourReason(2.5);
  check('reason 含尾盘埋', reason.includes('尾盘埋'));
  check('reason 含 +2.50%', reason.includes('+2.50%'));
  check('reason 含 Yang 2022', reason.includes('Yang 2022'));

  equal(
    'buildLastHourSourceId',
    buildLastHourSourceId('sh.600519', '2026-06-30'),
    'last_hour_momentum::sh.600519::2026-06-30'
  );

  equal('13:00 → false', isAfter1430Shanghai(new Date('2026-06-30T05:00:00Z')), false);
  equal('14:29 → false', isAfter1430Shanghai(new Date('2026-06-30T06:29:00Z')), false);
  equal('14:30 → true', isAfter1430Shanghai(new Date('2026-06-30T06:30:00Z')), true);
  equal('15:00 → true', isAfter1430Shanghai(new Date('2026-06-30T07:00:00Z')), true);
  equal('todayTradeDate', todayTradeDate(new Date('2026-06-30T06:30:00Z')), '2026-06-30');

  const noopDs: LastHourMomentumDataSource = {
    async loadSymbolsAndR1() {
      return [];
    },
    async writeSignals() {
      return { created: 0, updated: 0, errors: 0 };
    },
  };
  const svc = new LastHourMomentumDetector(noopDs);

  let res = await svc.runOnce({ now: new Date('2026-06-28T06:30:00Z') });
  equal('Sunday → not_trading_day', res.skipped_reason, 'not_trading_day');

  res = await svc.runOnce({ now: new Date('2026-06-30T06:30:00Z'), force: true });
  equal('empty → skipped', res.skipped_reason, 'empty_universe');

  let wroteRows: any[] = [];
  const happyDs: LastHourMomentumDataSource = {
    async loadSymbolsAndR1() {
      return [
        { symbol: 'sh.600519', name: 'A', r1_pct: 5.5 },
        { symbol: 'sz.000001', name: 'B', r1_pct: 2.5 },
        { symbol: 'sh.600036', name: 'C', r1_pct: 1.2 },
        { symbol: 'sh.600000', name: 'D', r1_pct: 0.5 },
        { symbol: 'sh.601318', name: 'E', r1_pct: -2 },
        { symbol: 'sh.601398', name: 'F', r1_pct: null },
      ];
    },
    async writeSignals(rows) {
      wroteRows = rows;
      return { created: rows.length, updated: 0, errors: 0 };
    },
  };
  res = await new LastHourMomentumDetector(happyDs).runOnce({
    now: new Date('2026-06-30T06:30:00Z'),
    force: true,
  });
  equal('happy scanned=6', res.scanned, 6);
  equal('happy matched=3', res.matched, 3);
  equal('happy written=3', res.written, 3);
  equal('wroteRows=3', wroteRows.length, 3);
  equal('top1 sh.600519', wroteRows[0].symbol, 'sh.600519');
  equal('top1 score=95', wroteRows[0].confidence_score, 95);
  equal('top2 sz.000001', wroteRows[1].symbol, 'sz.000001');
  equal('top3 sh.600036', wroteRows[2].symbol, 'sh.600036');
  equal('top1 timing_tag', (wroteRows[0].metadata as any).timing_tag, TIMING_TAG_CLOSING_GRAB);

  wroteRows = [];
  res = await new LastHourMomentumDetector(happyDs).runOnce({
    now: new Date('2026-06-30T06:30:00Z'),
    force: true,
    top_k: 1,
  });
  equal('top_k=1 written=1', res.written, 1);
  equal('top_k=1 wroteRows=1', wroteRows.length, 1);

  wroteRows = [];
  res = await new LastHourMomentumDetector(happyDs).runOnce({
    now: new Date('2026-06-30T06:30:00Z'),
    force: true,
    dry_run: true,
  });
  equal('dry_run matched=3', res.matched, 3);
  equal('dry_run written=0', res.written, 0);

  const throwDs: LastHourMomentumDataSource = {
    async loadSymbolsAndR1() {
      throw new Error('boom');
    },
    async writeSignals() {
      return { created: 0, updated: 0, errors: 0 };
    },
  };
  res = await new LastHourMomentumDetector(throwDs).runOnce({
    now: new Date('2026-06-30T06:30:00Z'),
    force: true,
  });
  equal('load throw → empty_universe', res.skipped_reason, 'empty_universe');
  check(
    'load error logged',
    res.errors.some(e => e.includes('load'))
  );

  console.log(`\n========= LastHourMomentumDetector tests: ${pass} pass, ${fail} fail =========`);
  if (fail > 0) process.exit(1);
})();
