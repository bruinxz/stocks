/**
 * TradingCalendarSyncService 单测 (Path C · §D4.G2 三方完形后置件 + Path C.2 韧性件).
 *
 * 跑: npx ts-node --transpile-only tests/services/trading-calendar-sync-service.test.ts
 *
 * 覆盖:
 *   - enumerateDates 边界 (含 start/end · 跨月 · 单日)
 *   - buildCalendarRows prev/next_trade_date 单次线性扫描正确性
 *   - is_half 半日市 gate (仅 is_open=true 才判定)
 *   - Baostock client error path 返回 error 结果 (zero side-effect · fallback 未配)
 *   - source 字段: baostock 主 / akshare fallback / 参数覆写
 *   - Path C.2: retryWithBackoff 尝试次数与最终失败传递
 *   - Path C.2: syncRange Baostock 三次全失败后走 AKShare fallback
 *   - Path C.2: HALF_DAY_TRADING_DATES 2025-2027 名单落库
 */

import {
  TradingCalendarSyncService,
  enumerateDates,
  buildCalendarRows,
  retryWithBackoff,
  getHalfDayTradingDates,
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
    'all rows source=baostock (default)',
    rows.every((r) => r.source === 'baostock')
  );

  // ---------------- source 参数覆写 (Path C.2) ----------------
  const akRows = buildCalendarRows(
    ['2026-01-02'],
    new Set<string>(['2026-01-02']),
    new Set<string>(),
    'akshare'
  );
  equal('source 参数覆写 akshare', akRows[0].source, 'akshare');

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

  // ---------------- Path C.2 · retryWithBackoff 尝试次数 ----------------
  let calls1 = 0;
  const okAfter2 = await retryWithBackoff(
    async () => {
      calls1 += 1;
      if (calls1 < 3) throw new Error(`transient ${calls1}`);
      return 'done';
    },
    [10, 10, 10] // 快速三档 · 测试用
  );
  equal('retryWithBackoff 第三次成功', okAfter2, 'done');
  equal('retryWithBackoff 尝试计数=3', calls1, 3);

  let calls2 = 0;
  let threwRetry = false;
  try {
    await retryWithBackoff(
      async () => {
        calls2 += 1;
        throw new Error(`always ${calls2}`);
      },
      [10, 10, 10]
    );
  } catch (e) {
    threwRetry = (e as Error).message === 'always 4';
  }
  check('retryWithBackoff 四次全败最终抛错', threwRetry);
  equal('retryWithBackoff 总尝试=4 (attempts+len(delays))', calls2, 4);

  // ---------------- syncRange error path (fallback 未配) ----------------
  const throwingClient = {
    queryTradeDates: async () => {
      throw new Error('mock network fail');
    },
  } as unknown as import('../../src/data/sources/BaostockClient').BaostockClient;

  const svc = new TradingCalendarSyncService(throwingClient, undefined, [1, 1, 1]);
  const errResult: SyncCalendarResult = await svc.syncRange({
    startDate: '2026-01-01',
    endDate: '2026-01-07',
  });
  equal('error result upserted=0', errResult.upserted, 0);
  equal('error result trading_days=0', errResult.trading_days, 0);
  equal('error result total_calendar_days=0', errResult.total_calendar_days, 0);
  check('error result has error message', errResult.error === 'mock network fail');
  equal('error result source=baostock', errResult.source, 'baostock');
  equal('error result baostock_attempts=4', errResult.baostock_attempts, 4);
  equal('error result fallback_used=false', errResult.fallback_used, false);

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

  // ---------------- Path C.2 · Baostock 全败 → AKShare fallback 成功 ----------------
  let bsCalls = 0;
  const bsAlwaysFail = {
    queryTradeDates: async () => {
      bsCalls += 1;
      throw new Error(`bs fail ${bsCalls}`);
    },
  } as unknown as import('../../src/data/sources/BaostockClient').BaostockClient;

  const akOk = {
    queryTradeDates: async () => ['2026-01-05', '2026-01-06'],
  } as unknown as import('../../src/data/sources/AKShareClient').AKShareClient;

  // 需要压制 TradingCalendar.upsert 副作用 — Sequelize 未初始化会 throw
  const originalUpsert = (await import('../../src/models/TradingCalendar')).TradingCalendar
    .upsert;
  let upsertHits = 0;
  (await import('../../src/models/TradingCalendar')).TradingCalendar.upsert = (async () => {
    upsertHits += 1;
    return [null, true] as any;
  }) as any;

  try {
    const svcFallback = new TradingCalendarSyncService(bsAlwaysFail, akOk, [1, 1, 1]);
    const fbResult = await svcFallback.syncRange({
      startDate: '2026-01-05',
      endDate: '2026-01-06',
    });
    equal('fallback source=akshare', fbResult.source, 'akshare');
    equal('fallback used=true', fbResult.fallback_used, true);
    equal('fallback baostock_attempts=4', fbResult.baostock_attempts, 4);
    equal('fallback total_calendar_days=2', fbResult.total_calendar_days, 2);
    equal('fallback trading_days=2', fbResult.trading_days, 2);
    equal('fallback upserted=2', fbResult.upserted, 2);
    check('fallback upsert called', upsertHits === 2);
    check('fallback error field cleared', fbResult.error === undefined);

    // Path C.2 · Baostock 全败 + AKShare 也败 → 结构化 error 双源合并
    const akAlsoFail = {
      queryTradeDates: async () => {
        throw new Error('ak fail');
      },
    } as unknown as import('../../src/data/sources/AKShareClient').AKShareClient;
    const svcBothFail = new TradingCalendarSyncService(bsAlwaysFail, akAlsoFail, [1, 1, 1]);
    const bothResult = await svcBothFail.syncRange({
      startDate: '2026-01-05',
      endDate: '2026-01-06',
    });
    equal('bothFail source=akshare (fallback attempted)', bothResult.source, 'akshare');
    equal('bothFail fallback_used=true', bothResult.fallback_used, true);
    equal('bothFail upserted=0', bothResult.upserted, 0);
    check(
      'bothFail error contains baostock + akshare tags',
      typeof bothResult.error === 'string' &&
        bothResult.error.includes('baostock:') &&
        bothResult.error.includes('akshare: ak fail')
    );
  } finally {
    (await import('../../src/models/TradingCalendar')).TradingCalendar.upsert =
      originalUpsert;
  }

  // ---------------- Path C.2 · HALF_DAY_TRADING_DATES 2025-2027 名单 ----------------
  const halfDaySet = getHalfDayTradingDates();
  check('half-day list 2025-01-27 存在', halfDaySet.has('2025-01-27'));
  check('half-day list 2025-09-30 存在', halfDaySet.has('2025-09-30'));
  check('half-day list 2026-02-16 存在', halfDaySet.has('2026-02-16'));
  check('half-day list 2026-09-24 存在', halfDaySet.has('2026-09-24'));
  check('half-day list 2026-09-30 存在', halfDaySet.has('2026-09-30'));
  check('half-day list 2027-02-05 存在', halfDaySet.has('2027-02-05'));
  check('half-day list 2027-09-14 存在', halfDaySet.has('2027-09-14'));
  check('half-day list 2027-09-30 存在', halfDaySet.has('2027-09-30'));
  equal('half-day list 大小=8', halfDaySet.size, 8);
  check(
    '半日名单全 YYYY-MM-DD 且 2025-2027',
    Array.from(halfDaySet).every(
      (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= '2025-01-01' && d <= '2027-12-31'
    )
  );

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
