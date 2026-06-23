/**
 * DataFreshnessCheckService 单测 — Batch BF-3 (2026-06-23)
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/data-freshness-check.test.ts
 *
 * 覆盖:
 *   - isTradingDay / shanghaiYmd / isIntraday / diffDays helpers
 *   - checkRealtimeQuote: 非盘中 skip / 表空 fail / lag > 1h fail / lag < 1h ok
 *   - checkDailyBar: 非工作日 skip / 表空 fail / lag > N fail / lag <= N ok
 *   - checkFactorStdZero: <= threshold ok / > threshold fail
 *   - checkScheduledTasksFailed: 0 个 ok / 1 个未严重 warn / >=3 连败 fail
 *   - checkMarketSentimentFresh: 表空 warn / lag > 2 fail / lag <= 2 ok
 *   - runDataFreshnessCheck e2e (含 runner throw fall-OPEN)
 *   - buildFreshnessReportMarkdown render
 */

import {
  isTradingDay,
  shanghaiYmd,
  isIntraday,
  diffDays,
  checkRealtimeQuote,
  checkDailyBar,
  checkFactorStdZero,
  checkScheduledTasksFailed,
  checkMarketSentimentFresh,
  runDataFreshnessCheck,
  buildFreshnessReportMarkdown,
  DataFreshnessCheckDataSource,
} from '../../src/services/DataFreshnessCheckService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`❌ ${name}${detail ? ' detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

class FakeDataSource implements DataFreshnessCheckDataSource {
  constructor(
    private opts: {
      rtMax?: Date | null;
      dailyMax?: string | null;
      zeroStd?: string[];
      failedTasks?: Array<{ id: number; type: string; name: string; consecutive_failure_count: number }>;
      sentimentMax?: string | null;
      throwOn?: 'rt' | 'daily' | 'factor' | 'tasks' | 'sentiment';
    }
  ) {}
  async getRealtimeQuoteMaxUpdatedAt(): Promise<Date | null> {
    if (this.opts.throwOn === 'rt') throw new Error('rt down');
    return this.opts.rtMax === undefined ? null : this.opts.rtMax;
  }
  async getDailyBarMaxTradeDate(): Promise<string | null> {
    if (this.opts.throwOn === 'daily') throw new Error('daily down');
    return this.opts.dailyMax === undefined ? null : this.opts.dailyMax;
  }
  async getZeroStdFactors(_since: string): Promise<string[]> {
    if (this.opts.throwOn === 'factor') throw new Error('factor down');
    return this.opts.zeroStd || [];
  }
  async listFailedScheduledTasks() {
    if (this.opts.throwOn === 'tasks') throw new Error('tasks down');
    return this.opts.failedTasks || [];
  }
  async getMarketSentimentMaxTradeDate(): Promise<string | null> {
    if (this.opts.throwOn === 'sentiment') throw new Error('sentiment down');
    return this.opts.sentimentMax === undefined ? null : this.opts.sentimentMax;
  }
}

async function main() {
  console.log('\n[1] helpers...');
  // 2026-06-22 是周一 (UTC), 2026-06-21 是周日
  assertEqual('Mon 工作日', isTradingDay(new Date('2026-06-22T03:00:00Z')), true);
  assertEqual('Sun 非工作日', isTradingDay(new Date('2026-06-21T03:00:00Z')), false);
  assertEqual(
    'shanghaiYmd UTC03 → 上海11',
    shanghaiYmd(new Date('2026-06-23T03:00:00Z')),
    '2026-06-23'
  );
  assertEqual('isIntraday Mon UTC03 (上海11) → true', isIntraday(new Date('2026-06-22T03:00:00Z')), true);
  assertEqual(
    'isIntraday Sun UTC03 → false (周末)',
    isIntraday(new Date('2026-06-21T03:00:00Z')),
    false
  );
  assertEqual(
    'isIntraday Mon UTC10 (上海18) → false (盘后)',
    isIntraday(new Date('2026-06-22T10:00:00Z')),
    false
  );
  assertEqual('diffDays', diffDays('2026-06-23', '2026-06-20'), 3);

  // ===========================================================================
  console.log('\n[2] checkRealtimeQuote...');
  const now = new Date('2026-06-22T03:00:00Z'); // 上海周一 11:00
  const r1 = await checkRealtimeQuote(new FakeDataSource({ rtMax: null }), now);
  assertEqual('表空 → fail', r1.status, 'fail');
  const r2 = await checkRealtimeQuote(
    new FakeDataSource({ rtMax: new Date('2026-06-22T01:00:00Z') }),
    now
  );
  assertEqual('lag 2h → fail', r2.status, 'fail');
  const r3 = await checkRealtimeQuote(
    new FakeDataSource({ rtMax: new Date('2026-06-22T02:30:00Z') }),
    now
  );
  assertEqual('lag 30min → ok', r3.status, 'ok');
  const rNon = await checkRealtimeQuote(
    new FakeDataSource({ rtMax: null }),
    new Date('2026-06-21T03:00:00Z')
  );
  assertEqual('非盘中跳过 → ok', rNon.status, 'ok');
  const rThrow = await checkRealtimeQuote(new FakeDataSource({ throwOn: 'rt' }), now);
  assertEqual('throw → warn', rThrow.status, 'warn');

  // ===========================================================================
  console.log('\n[3] checkDailyBar...');
  const d1 = await checkDailyBar(new FakeDataSource({ dailyMax: null }), now);
  assertEqual('表空 → fail', d1.status, 'fail');
  const d2 = await checkDailyBar(new FakeDataSource({ dailyMax: '2026-06-22' }), now);
  assertEqual('lag 0 → ok', d2.status, 'ok');
  const d3 = await checkDailyBar(new FakeDataSource({ dailyMax: '2026-06-21' }), now);
  assertEqual('lag 1 (默认 ≤1) → ok', d3.status, 'ok');
  const d4 = await checkDailyBar(new FakeDataSource({ dailyMax: '2026-06-18' }), now);
  assertEqual('lag 4 → fail', d4.status, 'fail');
  const dNon = await checkDailyBar(
    new FakeDataSource({ dailyMax: null }),
    new Date('2026-06-21T03:00:00Z')
  );
  assertEqual('非工作日 → ok', dNon.status, 'ok');

  // ===========================================================================
  console.log('\n[4] checkFactorStdZero...');
  const f1 = await checkFactorStdZero(new FakeDataSource({ zeroStd: [] }), now);
  assertEqual('0 个 → ok', f1.status, 'ok');
  const f2 = await checkFactorStdZero(
    new FakeDataSource({ zeroStd: ['northbound', 'analyst_consensus'] }),
    now
  );
  assertEqual('2 个 (= threshold) → ok', f2.status, 'ok');
  const f3 = await checkFactorStdZero(
    new FakeDataSource({ zeroStd: ['northbound', 'analyst_consensus', 'value', 'momentum'] }),
    now
  );
  assertEqual('4 个 (> threshold) → fail', f3.status, 'fail');
  assert('fail detail 含 4 个', (f3.detail || '').includes('4 个'));

  // ===========================================================================
  console.log('\n[5] checkScheduledTasksFailed...');
  const t1 = await checkScheduledTasksFailed(new FakeDataSource({ failedTasks: [] }));
  assertEqual('0 个 → ok', t1.status, 'ok');
  const t2 = await checkScheduledTasksFailed(
    new FakeDataSource({
      failedTasks: [{ id: 1, type: 'DAILY_UPDATE', name: '每日更新', consecutive_failure_count: 1 }],
    })
  );
  assertEqual('1 个连败 1 → warn', t2.status, 'warn');
  const t3 = await checkScheduledTasksFailed(
    new FakeDataSource({
      failedTasks: [{ id: 1, type: 'DAILY_UPDATE', name: '每日更新', consecutive_failure_count: 4 }],
    })
  );
  assertEqual('1 个连败 4 → fail', t3.status, 'fail');

  // ===========================================================================
  console.log('\n[6] checkMarketSentimentFresh...');
  const s1 = await checkMarketSentimentFresh(
    new FakeDataSource({ sentimentMax: '2026-06-22' }),
    now
  );
  assertEqual('lag 0 → ok', s1.status, 'ok');
  const s2 = await checkMarketSentimentFresh(
    new FakeDataSource({ sentimentMax: '2026-06-19' }),
    now
  );
  assertEqual('lag 3 → fail', s2.status, 'fail');
  const s3 = await checkMarketSentimentFresh(new FakeDataSource({ sentimentMax: null }), now);
  assertEqual('表空 → warn', s3.status, 'warn');

  // ===========================================================================
  console.log('\n[7] runDataFreshnessCheck e2e...');
  const r = await runDataFreshnessCheck(
    new FakeDataSource({
      rtMax: new Date('2026-06-22T02:30:00Z'),
      dailyMax: '2026-06-22',
      zeroStd: ['northbound'],
      failedTasks: [],
      sentimentMax: '2026-06-22',
    }),
    now
  );
  assertEqual('5 items', r.items.length, 5);
  assertEqual('全 ok → fail_count=0', r.fail_count, 0);
  assertEqual('trade_date', r.trade_date, '2026-06-22');
  assertEqual('is_trading_day true', r.is_trading_day, true);

  // 混合 fail
  const rMixed = await runDataFreshnessCheck(
    new FakeDataSource({
      rtMax: null, // fail
      dailyMax: '2026-06-22',
      zeroStd: ['northbound', 'a', 'b', 'c'], // fail
      failedTasks: [{ id: 5, type: 'X', name: 'X', consecutive_failure_count: 5 }], // fail
      sentimentMax: '2026-06-22',
    }),
    now
  );
  assertEqual('fail_count = 3', rMixed.fail_count, 3);

  // ===========================================================================
  console.log('\n[8] buildFreshnessReportMarkdown...');
  const md = buildFreshnessReportMarkdown(rMixed);
  assert('md 含汇总', md.includes('fail=3'));
  assert('md 含 emoji 🔴', md.includes('🔴'));
  assert('md 含 trade_date', md.includes('2026-06-22'));

  console.log('========================================');
  console.log(`data-freshness-check test summary: ${passed} ok / ${failed} failed`);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('test unexpected error:', err);
  process.exit(1);
});
