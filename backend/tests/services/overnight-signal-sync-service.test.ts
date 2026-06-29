/**
 * OvernightSignalSyncService 单元测试 (PR-M1)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/overnight-signal-sync-service.test.ts
 *
 * 完全脱离 DB / Python 子进程: 注入 fake OvernightSignalClient + monkey-patch
 * Sequelize Model 静态方法 (in-memory backing store, 同
 * etf-flow-sync-service.test.ts 模式).
 */

import {
  OvernightSignalSyncService,
  toNullableNumber,
  pickLatestPerSource,
  deriveMarketDirection,
  OvernightSignalType,
} from '../../src/services/OvernightSignalSyncService';
import {
  OvernightSignalClient,
  OvernightSignalRow,
} from '../../src/data/sources/OvernightSignalClient';
import { OvernightSignal } from '../../src/models/OvernightSignal';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`X ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ===========================================================================
// In-memory backing-store for OvernightSignal model
// ===========================================================================

interface FakeRow {
  id?: number;
  signal_type: string;
  source: string | null;
  collected_at: Date;
  value: number | null;
  change_pct: number | null;
  raw_payload: any;
}

let store: FakeRow[] = [];
let nextId = 1;

function resetStore(): void {
  store = [];
  nextId = 1;
}

function installModelStubs(): void {
  (OvernightSignal as any).bulkCreate = async (
    records: FakeRow[],
    _opts?: unknown
  ): Promise<FakeRow[]> => {
    for (const r of records) {
      const idx = store.findIndex(
        s =>
          s.signal_type === r.signal_type &&
          s.collected_at.getTime() === r.collected_at.getTime()
      );
      if (idx >= 0) {
        store[idx] = { ...store[idx], ...r };
      } else {
        store.push({ id: nextId++, ...r });
      }
    }
    return records;
  };

  (OvernightSignal as any).findAll = async (options: any): Promise<FakeRow[]> => {
    let candidates = [...store];
    const at = options?.where?.collected_at;
    if (at) {
      const syms = Object.getOwnPropertySymbols(at);
      for (const sym of syms) {
        const ss = sym.toString();
        const v = at[sym];
        if (ss.includes('gte')) {
          const dv = v instanceof Date ? v : new Date(v);
          candidates = candidates.filter(s => s.collected_at >= dv);
        } else if (ss.includes('lte')) {
          const dv = v instanceof Date ? v : new Date(v);
          candidates = candidates.filter(s => s.collected_at <= dv);
        }
      }
    }
    if (options?.order) {
      const orders = [...options.order].reverse();
      for (const ord of orders) {
        const [field, dir] = ord;
        candidates.sort((a: any, b: any) => {
          const av = a[field] instanceof Date ? a[field].getTime() : a[field];
          const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
          if (av === bv) return 0;
          return dir === 'DESC' ? (av < bv ? 1 : -1) : av < bv ? -1 : 1;
        });
      }
    }
    if (options?.limit) candidates = candidates.slice(0, options.limit);
    return candidates;
  };
}

// ===========================================================================
// Fake OvernightSignalClient
// ===========================================================================

interface FakeClientState {
  shouldThrow?: boolean;
  rows?: OvernightSignalRow[];
}

function makeFakeClient(state: FakeClientState): OvernightSignalClient {
  return {
    fetchAll: async () => {
      if (state.shouldThrow) throw new Error('fake outage');
      return state.rows ?? [];
    },
  } as unknown as OvernightSignalClient;
}

function makeRow(
  signalType: OvernightSignalType,
  changePct: number | null = 0,
  value: number = 100
): OvernightSignalRow {
  return {
    signal_type: signalType,
    source: 'fake_source',
    value,
    change_pct: changePct,
    raw_payload: { fake: true },
  };
}

// ===========================================================================
// 纯函数测试
// ===========================================================================

async function run(): Promise<void> {
  console.log('\n## toNullableNumber');
  assertEqual('null', toNullableNumber(null), null);
  assertEqual('undefined', toNullableNumber(undefined), null);
  assertEqual('NaN', toNullableNumber(NaN), null);
  assertEqual('Infinity', toNullableNumber(Infinity), null);
  assertEqual('-Infinity', toNullableNumber(-Infinity), null);
  assertEqual('number 0', toNullableNumber(0), 0);
  assertEqual('number 123.456', toNullableNumber(123.456), 123.456);
  assertEqual('string "1.5"', toNullableNumber('1.5'), 1.5);
  assertEqual('string "abc"', toNullableNumber('abc'), null);
  assertEqual('string ""', toNullableNumber(''), null);

  console.log('\n## pickLatestPerSource');
  {
    const t1 = new Date('2026-06-29T05:00:00Z');
    const t2 = new Date('2026-06-29T06:00:00Z'); // 更新
    const rows = [
      {
        signal_type: 'a50_future',
        source: 'sa',
        value: 12345,
        change_pct: -0.5,
        raw_payload: {},
        collected_at: t2, // DESC 先到
      },
      {
        signal_type: 'a50_future',
        source: 'sa',
        value: 12340,
        change_pct: -0.6,
        raw_payload: {},
        collected_at: t1,
      },
      {
        signal_type: 'hk_hsi',
        source: 'sb',
        value: 23000,
        change_pct: 1.2,
        raw_payload: {},
        collected_at: t2,
      },
    ];
    const m = pickLatestPerSource(rows);
    assert('has a50_future', m.has('a50_future'));
    assert('has hk_hsi', m.has('hk_hsi'));
    const a50 = m.get('a50_future')!;
    assertEqual('a50 latest value', a50.value, 12345);
    assertEqual('a50 latest change_pct', a50.change_pct, -0.5);
  }

  console.log('\n## pickLatestPerSource skip null value');
  {
    const t1 = new Date('2026-06-29T06:00:00Z');
    const rows = [
      {
        signal_type: 'us_vix',
        source: 's',
        value: null,
        change_pct: 5,
        raw_payload: {},
        collected_at: t1,
      },
    ];
    const m = pickLatestPerSource(rows);
    assert('skip null value rows', m.size === 0);
  }

  console.log('\n## deriveMarketDirection — bearish strong (a50<-1 + vix>+10)');
  {
    const sig = new Map();
    const ts = new Date();
    sig.set('a50_future', {
      signal_type: 'a50_future',
      source: 's',
      value: 12000,
      change_pct: -1.5,
      raw_payload: {},
      collected_at: ts,
    });
    sig.set('us_vix', {
      signal_type: 'us_vix',
      source: 's',
      value: 25,
      change_pct: 15,
      raw_payload: {},
      collected_at: ts,
    });
    const { direction, reason } = deriveMarketDirection(sig);
    assertEqual('strong bearish direction', direction, 'bearish');
    assert('强烈走弱 reason', reason.includes('强烈走弱'));
  }

  console.log('\n## deriveMarketDirection — bearish 普跌 (a50+hk both < -0.5)');
  {
    const sig = new Map();
    const ts = new Date();
    sig.set('a50_future', {
      signal_type: 'a50_future',
      source: 's',
      value: 12000,
      change_pct: -0.8,
      raw_payload: {},
      collected_at: ts,
    });
    sig.set('hk_hsi', {
      signal_type: 'hk_hsi',
      source: 's',
      value: 23000,
      change_pct: -0.7,
      raw_payload: {},
      collected_at: ts,
    });
    sig.set('us_nasdaq', {
      signal_type: 'us_nasdaq',
      source: 's',
      value: 18000,
      change_pct: 0.1,
      raw_payload: {},
      collected_at: ts,
    });
    const { direction, reason } = deriveMarketDirection(sig);
    assertEqual('bearish 普跌', direction, 'bearish');
    assert('普跌 reason', reason.includes('普跌'));
  }

  console.log('\n## deriveMarketDirection — bullish 普涨');
  {
    const sig = new Map();
    const ts = new Date();
    sig.set('a50_future', {
      signal_type: 'a50_future',
      source: 's',
      value: 12000,
      change_pct: 1.2,
      raw_payload: {},
      collected_at: ts,
    });
    sig.set('hk_hsi', {
      signal_type: 'hk_hsi',
      source: 's',
      value: 23000,
      change_pct: 0.8,
      raw_payload: {},
      collected_at: ts,
    });
    sig.set('us_nasdaq', {
      signal_type: 'us_nasdaq',
      source: 's',
      value: 18000,
      change_pct: 1.5,
      raw_payload: {},
      collected_at: ts,
    });
    const { direction, reason } = deriveMarketDirection(sig);
    assertEqual('bullish 普涨', direction, 'bullish');
    assert('普涨 reason', reason.includes('普涨'));
  }

  console.log('\n## deriveMarketDirection — neutral (1 up 1 down)');
  {
    const sig = new Map();
    const ts = new Date();
    sig.set('a50_future', {
      signal_type: 'a50_future',
      source: 's',
      value: 12000,
      change_pct: 0.7,
      raw_payload: {},
      collected_at: ts,
    });
    sig.set('hk_hsi', {
      signal_type: 'hk_hsi',
      source: 's',
      value: 23000,
      change_pct: -0.7,
      raw_payload: {},
      collected_at: ts,
    });
    sig.set('us_nasdaq', {
      signal_type: 'us_nasdaq',
      source: 's',
      value: 18000,
      change_pct: 0.1,
      raw_payload: {},
      collected_at: ts,
    });
    const { direction, reason } = deriveMarketDirection(sig);
    assertEqual('neutral direction', direction, 'neutral');
    assert('中性 reason', reason.includes('中性'));
  }

  console.log('\n## deriveMarketDirection — unknown (全缺)');
  {
    const sig = new Map();
    const { direction } = deriveMarketDirection(sig);
    assertEqual('unknown direction', direction, 'unknown');
  }

  // ===========================================================================
  // service.syncAllSources e2e
  // ===========================================================================

  console.log('\n## syncAllSources — happy path');
  {
    installModelStubs();
    resetStore();
    const client = makeFakeClient({
      rows: [
        makeRow('a50_future', -0.3, 12500),
        makeRow('hk_hsi', 0.5, 23000),
        makeRow('us_nasdaq', 1.2, 18500),
        makeRow('us_dxy', -0.1, 104),
        makeRow('us_vix', 5, 18),
      ],
    });
    const svc = new OvernightSignalSyncService(client);
    const r = await svc.syncAllSources(new Date('2026-06-29T08:00:00Z'));
    assertEqual('fetched=5', r.fetched, 5);
    assertEqual('upserted=5', r.upserted, 5);
    assert('error null', r.error === null);
    assertEqual('store len 5', store.length, 5);
    const okCount = r.per_source.filter(p => p.ok).length;
    assertEqual('per_source ok=5', okCount, 5);
  }

  console.log('\n## syncAllSources — fetchAll throw');
  {
    installModelStubs();
    resetStore();
    const client = makeFakeClient({ shouldThrow: true });
    const svc = new OvernightSignalSyncService(client);
    const r = await svc.syncAllSources();
    assertEqual('fetched=0 on throw', r.fetched, 0);
    assertEqual('upserted=0', r.upserted, 0);
    assert('error msg', r.error !== null && r.error.includes('fake outage'));
  }

  console.log('\n## syncAllSources — 部分 source 缺失');
  {
    installModelStubs();
    resetStore();
    const client = makeFakeClient({
      rows: [makeRow('a50_future', -0.5), makeRow('hk_hsi', 0.3)],
    });
    const svc = new OvernightSignalSyncService(client);
    const r = await svc.syncAllSources();
    assertEqual('fetched=2', r.fetched, 2);
    assertEqual('upserted=2', r.upserted, 2);
    assertEqual('per_source len 5', r.per_source.length, 5);
    const failCount = r.per_source.filter(p => !p.ok).length;
    assertEqual('missing 3', failCount, 3);
  }

  console.log('\n## syncAllSources — empty response');
  {
    installModelStubs();
    resetStore();
    const client = makeFakeClient({ rows: [] });
    const svc = new OvernightSignalSyncService(client);
    const r = await svc.syncAllSources();
    assertEqual('empty fetched=0', r.fetched, 0);
    assertEqual('empty upserted=0', r.upserted, 0);
    assertEqual('empty store', store.length, 0);
    assertEqual('per_source len 5 all fail', r.per_source.length, 5);
    assert('all not ok', r.per_source.every(p => !p.ok));
  }

  // ===========================================================================
  // service.loadRecentContext e2e
  // ===========================================================================

  console.log('\n## loadRecentContext — happy path');
  {
    installModelStubs();
    resetStore();
    const now = new Date('2026-06-29T08:00:00Z');
    const tRecent = new Date('2026-06-29T07:00:00Z');
    const tOlder = new Date('2026-06-29T06:00:00Z');
    store.push({
      id: 1,
      signal_type: 'a50_future',
      source: 's',
      collected_at: tOlder,
      value: 12500,
      change_pct: -2.0,
      raw_payload: {},
    });
    store.push({
      id: 2,
      signal_type: 'a50_future',
      source: 's',
      collected_at: tRecent,
      value: 12550,
      change_pct: -1.5,
      raw_payload: {},
    });
    store.push({
      id: 3,
      signal_type: 'us_vix',
      source: 's',
      collected_at: tRecent,
      value: 25,
      change_pct: 15,
      raw_payload: {},
    });

    const svc = new OvernightSignalSyncService();
    const ctx = await svc.loadRecentContext(now);
    assert('signals size 2', ctx.signals.size === 2);
    const a50 = ctx.signals.get('a50_future')!;
    assertEqual('a50 latest change_pct', a50.change_pct, -1.5);
    assertEqual('direction bearish', ctx.market_direction, 'bearish');
    assert('reason 强烈走弱', ctx.reason.includes('强烈走弱'));
  }

  console.log('\n## loadRecentContext — out of 12h window');
  {
    installModelStubs();
    resetStore();
    const now = new Date('2026-06-29T20:00:00Z');
    const tStale = new Date('2026-06-29T05:00:00Z');
    store.push({
      id: 1,
      signal_type: 'a50_future',
      source: 's',
      collected_at: tStale,
      value: 12500,
      change_pct: -1.5,
      raw_payload: {},
    });
    const svc = new OvernightSignalSyncService();
    const ctx = await svc.loadRecentContext(now);
    assertEqual('no signals in window', ctx.signals.size, 0);
    assertEqual('unknown', ctx.market_direction, 'unknown');
  }

  console.log('\n## loadRecentContext — findAll throw');
  {
    installModelStubs();
    (OvernightSignal as any).findAll = async (): Promise<any[]> => {
      throw new Error('DB down');
    };
    const svc = new OvernightSignalSyncService();
    const ctx = await svc.loadRecentContext();
    assertEqual('fail-OPEN unknown', ctx.market_direction, 'unknown');
    assertEqual('empty signals', ctx.signals.size, 0);
    assert('reason includes DB', ctx.reason.includes('加载隔夜信号失败'));
  }
}

run()
  .then(() => {
    console.log(`\n## RESULT: passed=${passed}  failed=${failed}`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(err => {
    console.error(`Test harness crashed: ${err}`);
    process.exit(1);
  });
