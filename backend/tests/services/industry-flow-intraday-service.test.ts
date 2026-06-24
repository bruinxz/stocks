/**
 * IndustryFlowIntradayService — BK-2 (2026-06-24) unit tests.
 *
 * pure + service e2e fake-DataSource, 不走真 DB / 真 Python.
 */
import {
  IndustryFlowIntradayService,
  IntradayFlowDataSource,
  IntradayFlowSnapshot,
  truncateTo10Min,
  isInTradingSession,
} from '../../src/services/IndustryFlowIntradayService';

let ok = 0;
let fail = 0;
function expectEqual(name: string, got: any, want: any) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`);
  }
}
function expectTrue(name: string, cond: boolean) {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}`);
  }
}

async function main() {
  // [1] truncateTo10Min
  console.log('[1] truncateTo10Min...');
  expectEqual(
    '9:32:18 → 9:30 (UTC trunc)',
    truncateTo10Min(new Date('2026-06-24T01:32:18.500Z')).toISOString(),
    '2026-06-24T01:30:00.000Z'
  );
  expectEqual(
    '整点不变',
    truncateTo10Min(new Date('2026-06-24T01:30:00.000Z')).toISOString(),
    '2026-06-24T01:30:00.000Z'
  );
  expectEqual(
    '9:39:59 → 9:30 (向下)',
    truncateTo10Min(new Date('2026-06-24T01:39:59.000Z')).toISOString(),
    '2026-06-24T01:30:00.000Z'
  );

  // [2] isInTradingSession
  console.log('[2] isInTradingSession...');
  expectTrue('SH 9:30 in', isInTradingSession(new Date('2026-06-24T01:30:00Z')));
  expectTrue('SH 9:00 out', !isInTradingSession(new Date('2026-06-24T01:00:00Z')));
  expectTrue('SH 11:30 in', isInTradingSession(new Date('2026-06-24T03:30:00Z')));
  expectTrue('SH 12:00 out', !isInTradingSession(new Date('2026-06-24T04:00:00Z')));
  expectTrue('SH 13:00 in', isInTradingSession(new Date('2026-06-24T05:00:00Z')));
  expectTrue('SH 15:00 in', isInTradingSession(new Date('2026-06-24T07:00:00Z')));
  expectTrue('SH 15:01 out', !isInTradingSession(new Date('2026-06-24T07:01:00Z')));

  // [3] e2e happy
  console.log('[3] e2e happy...');
  {
    const upserts: Array<{ ts: Date; n: number }> = [];
    const ds: IntradayFlowDataSource = {
      async fetchSnapshot() {
        return [
          { industry_code: 'BK0001', industry_name: '半导体', change_pct: 1.2, main_inflow: -8e9, main_inflow_ratio: -3.2 },
          { industry_code: 'BK0002', industry_name: '证券', change_pct: 0.8, main_inflow: 1.3e9, main_inflow_ratio: 1.1 },
        ];
      },
      async upsertSnapshot(ts, rows) {
        upserts.push({ ts, n: rows.length });
        return rows.length;
      },
      async cleanupBefore() { return 0; },
    };
    const svc = new IndustryFlowIntradayService(ds);
    const r = await svc.pullSnapshot({ now: new Date('2026-06-24T02:33:00Z'), force: false });
    expectEqual('inserted', r.inserted, 2);
    expectEqual('skipped_reason', r.skipped_reason, null);
    expectEqual('ts trunc', r.snapshot_ts.toISOString(), '2026-06-24T02:30:00.000Z');
    expectEqual('upsert n=1 call', upserts.length, 1);
  }

  // [4] not in session
  console.log('[4] not in session skip...');
  {
    const ds: IntradayFlowDataSource = {
      async fetchSnapshot() { throw new Error('nope'); },
      async upsertSnapshot() { return 0; },
      async cleanupBefore() { return 0; },
    };
    const svc = new IndustryFlowIntradayService(ds);
    const r = await svc.pullSnapshot({ now: new Date('2026-06-24T00:00:00Z') });
    expectEqual('inserted=0', r.inserted, 0);
    expectEqual('reason', r.skipped_reason, 'not_in_session');
  }

  // [5] force
  console.log('[5] force...');
  {
    let fetched = false;
    const ds: IntradayFlowDataSource = {
      async fetchSnapshot() {
        fetched = true;
        return [{ industry_code: 'BK99', industry_name: 't', change_pct: 0, main_inflow: 0, main_inflow_ratio: 0 }];
      },
      async upsertSnapshot() { return 1; },
      async cleanupBefore() { return 0; },
    };
    const svc = new IndustryFlowIntradayService(ds);
    const r = await svc.pullSnapshot({ now: new Date('2026-06-24T00:00:00Z'), force: true });
    expectTrue('fetched', fetched);
    expectEqual('inserted=1', r.inserted, 1);
  }

  // [6] fetch fail
  console.log('[6] fetch fail...');
  {
    const ds: IntradayFlowDataSource = {
      async fetchSnapshot() { throw new Error('boom'); },
      async upsertSnapshot() { throw new Error('no'); },
      async cleanupBefore() { return 0; },
    };
    const svc = new IndustryFlowIntradayService(ds);
    const r = await svc.pullSnapshot({ now: new Date('2026-06-24T02:33:00Z') });
    expectEqual('inserted=0', r.inserted, 0);
    expectEqual('reason', r.skipped_reason, 'fetch_failed');
  }

  // [7] empty
  console.log('[7] empty snapshot...');
  {
    const ds: IntradayFlowDataSource = {
      async fetchSnapshot() { return []; },
      async upsertSnapshot() { throw new Error('no'); },
      async cleanupBefore() { return 0; },
    };
    const svc = new IndustryFlowIntradayService(ds);
    const r = await svc.pullSnapshot({ now: new Date('2026-06-24T02:33:00Z') });
    expectEqual('inserted=0', r.inserted, 0);
    expectEqual('reason', r.skipped_reason, 'empty_snapshot');
  }

  // [8] upsert fail
  console.log('[8] upsert fail...');
  {
    const ds: IntradayFlowDataSource = {
      async fetchSnapshot() {
        return [{ industry_code: 'BK1', industry_name: 'x', change_pct: 0, main_inflow: 0, main_inflow_ratio: 0 } as IntradayFlowSnapshot];
      },
      async upsertSnapshot() { throw new Error('db down'); },
      async cleanupBefore() { return 0; },
    };
    const svc = new IndustryFlowIntradayService(ds);
    const r = await svc.pullSnapshot({ now: new Date('2026-06-24T02:33:00Z') });
    expectEqual('inserted=0', r.inserted, 0);
    expectEqual('reason', r.skipped_reason, 'upsert_failed');
  }

  // [9] cleanup
  console.log('[9] cleanup...');
  {
    let receivedCutoff: Date | null = null;
    const ds: IntradayFlowDataSource = {
      async fetchSnapshot() { return []; },
      async upsertSnapshot() { return 0; },
      async cleanupBefore(cutoff) {
        receivedCutoff = cutoff;
        return 42;
      },
    };
    const svc = new IndustryFlowIntradayService(ds);
    const before = Date.now();
    const n = await svc.cleanup(3);
    expectEqual('deleted=42', n, 42);
    expectTrue('cutoff set', receivedCutoff !== null);
    if (receivedCutoff) {
      const ms3 = 3 * 24 * 60 * 60 * 1000;
      const got = (receivedCutoff as Date).getTime();
      expectTrue('cutoff ~3 days ago', got >= before - ms3 - 1000 && got <= Date.now() - ms3);
    }
  }

  // [10] cleanup fail-OPEN
  console.log('[10] cleanup fail-OPEN...');
  {
    const ds: IntradayFlowDataSource = {
      async fetchSnapshot() { return []; },
      async upsertSnapshot() { return 0; },
      async cleanupBefore() { throw new Error('lock'); },
    };
    const svc = new IndustryFlowIntradayService(ds);
    const n = await svc.cleanup(3);
    expectEqual('deleted=0', n, 0);
  }

  console.log('\n========================================');
  console.log(`industry-flow-intraday: ${ok} ok / ${fail} failed`);
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
