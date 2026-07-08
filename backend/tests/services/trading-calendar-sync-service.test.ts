/**
 * TradingCalendarSyncService 单测 (Path C · §D4.G2 三方完形后置件).
 *
 * 跑: npx ts-node --transpile-only tests/services/trading-calendar-sync-service.test.ts
 *
 * 覆盖:
 *   - enumerateDates 边界 (含 start/end · 跨月 · 单日)
 *   - buildCalendarRows prev/next_trade_date 单次线性扫描正确性
 *   - is_half 半日市 gate (仅 is_open=true 才判定)
 *   - Baostock client error path 返回 error 结果 (zero side-effect)
 *   - source 字段固定写 'baostock'
 */

import {
  TradingCalendarSyncService,
  enumerateDates,
  buildCalendarRows,
  SyncCalendarResult,
} from '../../src/data/services/TradingCalendarSyncService';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    // eslint-disable-next-line no-console
    console.log(`  PASS ${label}`);
  } else {
    fail += 1;
    // eslint-disable-next-line no-console
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
  // ---------------- enumerateDates ----------------
  const oneDay = enumerateDates('2026-01-01', '2026-01-01');
  equal('single day length=1', oneDay.length, 1);
  equal('single day[0]', oneDay[0], '2026-01-01');

  const week = enumerateDates('2026-01-01', '2026-01-07');
  equal('week length=7', week.length, 7);
  equal('week[0]', week[0], '2026-01-01');
  equal('week[6]', week[6], '2026-01-07');

  const crossMonth = enumerateDates('2026-01-30', '2026-02-02');
  equal('cross-month length=4', crossMonth.length, 4);
  equal('cross-month[0]', crossMonth[0], '2026-01-30');
  equal('cross-month[1]', crossMonth[1], '2026-01-31');
  equal('cross-month[2]', crossMonth[2], '2026-02-01');
  equal('cross-month[3]', crossMonth[3], '2026-02-02');

  // ---------------- buildCalendarRows: 单日交易日 ----------------
  const dates = enumerateDates('2026-01-01', '2026-01-07');
  // 假设周一二三四五 (2026-01-01=Thu 元旦休市, 2/3 周五周六周日一部分)
  // 简化: 交易日 = 01-02, 01-05, 01-06, 01-07
  const tradingSet = new Set<string>(['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07']);
  const halfSet = new Set<string>(['2026-01-05']); // 假半日市
  const rows = buildCalendarRows(dates, tradingSet, halfSet);

  equal('rows length=7', rows.length, 7);
  equal('row[0] date', rows[0].trade_date, '2026-01-01');
  equal('row[0] is_open=false (元旦)', rows[0].is_open, false);
  equal('row[0] is_half=false (休市不判 half)', rows[0].is_half, false);
  equal('row[0] prev=null (首日)', rows[0].prev_trade_date, null);
  equal('row[0] next=01-02', rows[0].next_trade_date, '2026-01-02');

  equal('row[1] date', rows[1].trade_date, '2026-01-02');
  equal('row[1] is_open=true', rows[1].is_open, true);
  equal('row[1] is_half=false (不在名单)', rows[1].is_half, false);
  equal('row[1] prev=null (前无交易日)', rows[1].prev_trade_date, null);
  equal('row[1] next=01-05', rows[1].next_trade_date, '2026-01-05');

  // row[2] 01-03 sat, row[3] 01-04 sun — 均非交易日
  equal('row[2] is_open=false', rows[2].is_open, false);
  equal('row[2] prev=01-02', rows[2].prev_trade_date, '2026-01-02');
  equal('row[2] next=01-05', rows[2].next_trade_date, '2026-01-05');

  equal('row[4] date', rows[4].trade_date, '2026-01-05');
  equal('row[4] is_open=true', rows[4].is_open, true);
  equal('row[4] is_half=true (在名单)', rows[4].is_half, true);
  equal('row[4] prev=01-02', rows[4].prev_trade_date, '2026-01-02');
  equal('row[4] next=01-06', rows[4].next_trade_date, '2026-01-06');

  equal('row[6] is_open=true', rows[6].is_open, true);
  equal('row[6] prev=01-06', rows[6].prev_trade_date, '2026-01-06');
  equal('row[6] next=null (末日无未来交易日)', rows[6].next_trade_date, null);

  // ---------------- source 字段固定 ----------------
  check(
    'all rows source=baostock',
    rows.every((r) => r.source === 'baostock')
  );

  // ---------------- is_half 只在 is_open=true 才可能 true ----------------
  const halfContradict = buildCalendarRows(
    ['2026-01-01'],
    new Set<string>(),
    new Set<string>(['2026-01-01']) // 名单里但非交易日
  );
  equal(
    'is_half gate: 非交易日强制 is_half=false',
    halfContradict[0].is_half,
    false
  );

  // ---------------- syncRange error path (mock client throws) ----------------
  const throwingClient = {
    queryTradeDates: async () => {
      throw new Error('mock network fail');
    },
  } as unknown as import('../../src/data/sources/BaostockClient').BaostockClient;

  const svc = new TradingCalendarSyncService(throwingClient);
  const errResult: SyncCalendarResult = await svc.syncRange({
    startDate: '2026-01-01',
    endDate: '2026-01-07',
  });
  equal('error result upserted=0', errResult.upserted, 0);
  equal('error result trading_days=0', errResult.trading_days, 0);
  equal('error result total_calendar_days=0', errResult.total_calendar_days, 0);
  check('error result has error message', errResult.error === 'mock network fail');
  equal('error result source=baostock', errResult.source, 'baostock');

  // ---------------- syncRange input validation ----------------
  let threw = false;
  try {
    await svc.syncRange({ startDate: 'bad', endDate: '2026-01-07' });
  } catch (e) {
    threw = true;
  }
  check('invalid date format throws', threw);

  threw = false;
  try {
    await svc.syncRange({ startDate: '2026-01-07', endDate: '2026-01-01' });
  } catch (e) {
    threw = true;
  }
  check('start > end throws', threw);

  // ---------------- 收敛报告 ----------------
  // eslint-disable-next-line no-console
  console.log(`\n=== TradingCalendarSyncService test summary: ${pass} pass / ${fail} fail ===\n`);
  if (fail > 0) {
    process.exit(1);
  }
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
