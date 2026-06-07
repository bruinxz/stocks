/**
 * SnowballHotKeywordSyncService 单元测试 (US-058)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/snowball-hot-keyword-sync-service.test.ts
 *
 * 完全脱离 DB / Python 子进程: 注入 fake SnowballHotKeywordClient.
 *
 * 由于 sync service 内部直接调 `SnowballHotKeyword.bulkCreate` / `.findAll` / `.count`,
 * 这些都是 Sequelize Model 静态方法 — 我们用 monkey-patch 替换成 fake backing store。
 * (与 ai-advisor-service / kol-aggregator-service 同款 "in-memory model" 测试模式)。
 *
 * 覆盖维度:
 *   - 纯函数:
 *     - parseIsoDate (有效 / 无效);
 *     - sleep (resolve);
 *   - service.syncDate() e2e:
 *     - happy path: 拉 5 行, 全部 upsert, is_new 全部 false (无 baseline);
 *     - 有 baseline 时正确识别 new 关键词;
 *     - client.fetchKeywords throws → returns error result;
 *     - client returns [] → returns ok + 0 rows;
 *     - 默认 symbol='最热门' / limit=200 边界;
 *     - 自定义 symbol/limit 透传到 client;
 *   - service.syncRange() e2e:
 *     - start > end → throws;
 *     - 多日遍历 + intervalMs=0;
 *     - skipExisting 跳过已存在日;
 *     - 单日失败不阻塞其他日;
 *   - service.loadPreviousKeywords():
 *     - 无任何数据 → null;
 *     - 有上一日 → 返回 keyword Set + tradeDate;
 *     - 跳过空白节假日 (最近 ≤ N 日);
 *   - service.listByDate():
 *     - 默认取最近一日;
 *     - onlyNew filter;
 *     - limit clamp;
 */

import {
  SnowballHotKeywordSyncService,
  parseIsoDate,
  sleep,
  SyncDateResult,
} from '../../src/data/services/SnowballHotKeywordSyncService';
import {
  SnowballHotKeywordClient,
  SnowballHotKeywordRow,
  SnowballSymbol,
} from '../../src/data/sources/SnowballHotKeywordClient';
import { SnowballHotKeyword } from '../../src/models/SnowballHotKeyword';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

async function expectThrow(name: string, fn: () => Promise<unknown>, includes?: string): Promise<void> {
  try {
    await fn();
    failed += 1;
    console.error(`❌ ${name}  expected throw but did not`);
  } catch (e) {
    const msg = (e as Error).message;
    if (includes && !msg.includes(includes)) {
      failed += 1;
      console.error(`❌ ${name}  threw '${msg}' but did not include '${includes}'`);
    } else {
      passed += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory backing-store: 用 monkey-patch 替换 Sequelize Model 静态方法.
// 每个 test 开头调用 resetStore() 让测试互不影响。
// ---------------------------------------------------------------------------

interface FakeRowState {
  trade_date: string;
  keyword: string;
  heat_score: number;
  rank?: number;
  related_stocks_json?: unknown;
  source?: string;
  is_new?: boolean;
  raw_payload?: unknown;
  updated_at?: Date;
}

let store: FakeRowState[] = [];

function resetStore(): void {
  store = [];
}

function installModelStubs(): void {
  // bulkCreate: upsert by (trade_date, keyword) composite key
  (SnowballHotKeyword as any).bulkCreate = async (
    records: FakeRowState[],
    _options?: unknown
  ): Promise<FakeRowState[]> => {
    for (const r of records) {
      const idx = store.findIndex(s => s.trade_date === r.trade_date && s.keyword === r.keyword);
      const merged: FakeRowState = { ...r, updated_at: new Date() };
      if (idx >= 0) {
        store[idx] = merged;
      } else {
        store.push(merged);
      }
    }
    return records;
  };

  // count: where { trade_date }
  (SnowballHotKeyword as any).count = async (options: any): Promise<number> => {
    const td = options?.where?.trade_date;
    if (!td) return store.length;
    return store.filter(s => s.trade_date === td).length;
  };

  // findOne: order DESC, optional where trade_date < / >= ranges via Op (we test as plain string)
  (SnowballHotKeyword as any).findOne = async (options: any): Promise<FakeRowState | null> => {
    let candidates = [...store];
    const td = options?.where?.trade_date;
    if (td) {
      const symbols = Object.getOwnPropertySymbols(td);
      for (const sym of symbols) {
        const symStr = sym.toString();
        const v = td[sym];
        if (symStr.includes('lt') && !symStr.includes('lte')) {
          candidates = candidates.filter(s => s.trade_date < v);
        } else if (symStr.includes('gte')) {
          candidates = candidates.filter(s => s.trade_date >= v);
        } else if (symStr.includes('lte')) {
          candidates = candidates.filter(s => s.trade_date <= v);
        } else if (symStr.includes('gt')) {
          candidates = candidates.filter(s => s.trade_date > v);
        }
      }
    }
    // order
    if (options?.order) {
      const [field, dir] = options.order[0];
      candidates.sort((a: any, b: any) => {
        const av = a[field];
        const bv = b[field];
        if (av === bv) return 0;
        return dir === 'DESC' ? (av < bv ? 1 : -1) : (av < bv ? -1 : 1);
      });
    }
    return candidates.length > 0 ? candidates[0] : null;
  };

  // findAll: where + order + limit (subset of features needed)
  (SnowballHotKeyword as any).findAll = async (options: any): Promise<FakeRowState[]> => {
    let candidates = [...store];
    const td = options?.where?.trade_date;
    if (typeof td === 'string') {
      candidates = candidates.filter(s => s.trade_date === td);
    }
    const isNewFilter = options?.where?.is_new;
    if (typeof isNewFilter === 'boolean') {
      candidates = candidates.filter(s => Boolean(s.is_new) === isNewFilter);
    }
    if (options?.order) {
      for (const ord of options.order.slice().reverse()) {
        const [field, dir] = ord;
        candidates.sort((a: any, b: any) => {
          const av = a[field];
          const bv = b[field];
          if (av === bv) return 0;
          return dir === 'DESC' ? (av < bv ? 1 : -1) : (av < bv ? -1 : 1);
        });
      }
    }
    if (options?.limit) {
      candidates = candidates.slice(0, options.limit);
    }
    return candidates;
  };
}

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

interface FakeClientState {
  shouldThrow?: boolean;
  rows?: SnowballHotKeywordRow[];
  /** Override per-call: receives (tradeDate, symbol, limit), returns rows */
  rowsFn?: (
    tradeDate: string,
    symbol: SnowballSymbol,
    limit: number
  ) => SnowballHotKeywordRow[];
  calls: Array<{ tradeDate: string; symbol: SnowballSymbol; limit: number }>;
}

function makeFakeClient(state: FakeClientState): SnowballHotKeywordClient {
  return {
    fetchKeywords: async (tradeDate: string, symbol: SnowballSymbol, limit: number) => {
      state.calls.push({ tradeDate, symbol, limit });
      if (state.shouldThrow) throw new Error('fake client outage');
      if (state.rowsFn) return state.rowsFn(tradeDate, symbol, limit);
      return state.rows ?? [];
    },
  } as unknown as SnowballHotKeywordClient;
}

function emptyClientState(overrides: Partial<FakeClientState> = {}): FakeClientState {
  return {
    calls: [],
    ...overrides,
  };
}

function makeFakeRows(keywords: string[], tradeDate = '2026-06-08'): SnowballHotKeywordRow[] {
  return keywords.map((kw, idx) => ({
    trade_date: tradeDate,
    keyword: kw,
    stock_code: `60000${idx}`.slice(-6),
    stock_name: kw,
    heat_score: 100000 - idx * 1000,
    latest_price: 100 + idx,
    rank: idx + 1,
    source: 'xueqiu_follow',
    raw_payload: {},
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testParseIsoDate(): void {
  const d = parseIsoDate('2026-06-08');
  assert(
    'parseIsoDate valid',
    d.getUTCFullYear() === 2026 && d.getUTCMonth() === 5 && d.getUTCDate() === 8
  );
  // Date constructor coerces 2026-13-01 → 2027-01-01 (overflow); getTime() is still finite —
  // not a strict gibberish case. Use truly invalid input to exercise the RangeError path.
  let threw = false;
  try {
    parseIsoDate('not-a-date');
  } catch (e) {
    threw = e instanceof RangeError;
  }
  assert('parseIsoDate gibberish throws RangeError', threw);
}

async function testSleep(): Promise<void> {
  const start = Date.now();
  await sleep(20);
  const elapsed = Date.now() - start;
  assert('sleep ~20ms', elapsed >= 15);
}

async function testSyncDateHappyPath(): Promise<void> {
  resetStore();
  const clientState = emptyClientState({
    rows: makeFakeRows(['贵州茅台', '比亚迪', '京东方A'], '2026-06-08'),
  });
  const client = makeFakeClient(clientState);
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.syncDate('2026-06-08');
  assertEqual('happy: fetched', result.fetched, 3);
  assertEqual('happy: upserted', result.upserted, 3);
  assertEqual('happy: new_keywords_count (no baseline)', result.new_keywords_count, 0);
  assertEqual('happy: baseline_trade_date', result.baseline_trade_date, null);
  assertEqual('happy: error', result.error, undefined);
  assertEqual('happy: store count', store.length, 3);
  // 验证 client call 默认 symbol='最热门' / limit=200
  assertEqual('happy: client called once', clientState.calls.length, 1);
  assertEqual('default symbol', clientState.calls[0].symbol, '最热门');
  assertEqual('default limit', clientState.calls[0].limit, 200);
  assertEqual('client tradeDate forwarded', clientState.calls[0].tradeDate, '2026-06-08');
}

async function testSyncDateWithBaseline(): Promise<void> {
  resetStore();
  // 先 seed 上一日 baseline: ['贵州茅台', '京东方A']
  store.push(
    { trade_date: '2026-06-07', keyword: '贵州茅台', heat_score: 100 },
    { trade_date: '2026-06-07', keyword: '京东方A', heat_score: 90 }
  );
  const clientState = emptyClientState({
    rows: makeFakeRows(['贵州茅台', '比亚迪', '京东方A', '新进股A'], '2026-06-08'),
  });
  const client = makeFakeClient(clientState);
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.syncDate('2026-06-08');
  assertEqual('baseline: upserted', result.upserted, 4);
  assertEqual('baseline: new_keywords_count', result.new_keywords_count, 2);
  assertEqual('baseline: baseline_trade_date', result.baseline_trade_date, '2026-06-07');

  // 验证哪几个被标 is_new=true
  const todayRows = store
    .filter(r => r.trade_date === '2026-06-08')
    .map(r => ({ keyword: r.keyword, is_new: !!r.is_new }))
    .sort((a, b) => a.keyword.localeCompare(b.keyword));

  // 茅台/京东方A 是 baseline 已有 → is_new=false; 比亚迪/新进股A → is_new=true
  const maotai = todayRows.find(r => r.keyword === '贵州茅台');
  const byd = todayRows.find(r => r.keyword === '比亚迪');
  const boe = todayRows.find(r => r.keyword === '京东方A');
  const newA = todayRows.find(r => r.keyword === '新进股A');
  assert('茅台 is_new=false', !!maotai && maotai.is_new === false);
  assert('比亚迪 is_new=true', !!byd && byd.is_new === true);
  assert('京东方A is_new=false', !!boe && boe.is_new === false);
  assert('新进股A is_new=true', !!newA && newA.is_new === true);
}

async function testSyncDateClientThrows(): Promise<void> {
  resetStore();
  const clientState = emptyClientState({ shouldThrow: true });
  const client = makeFakeClient(clientState);
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.syncDate('2026-06-08');
  assertEqual('throw: fetched', result.fetched, 0);
  assertEqual('throw: upserted', result.upserted, 0);
  assert('throw: error msg includes outage', !!result.error && result.error.includes('fake client outage'));
  assertEqual('throw: store unchanged', store.length, 0);
}

async function testSyncDateEmptyRows(): Promise<void> {
  resetStore();
  const clientState = emptyClientState({ rows: [] });
  const client = makeFakeClient(clientState);
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.syncDate('2026-06-08');
  assertEqual('empty: fetched', result.fetched, 0);
  assertEqual('empty: upserted', result.upserted, 0);
  assertEqual('empty: error', result.error, undefined);
  assertEqual('empty: store unchanged', store.length, 0);
}

async function testSyncDateCustomOptions(): Promise<void> {
  resetStore();
  const clientState = emptyClientState({
    rows: makeFakeRows(['茅台'], '2026-06-08'),
  });
  const client = makeFakeClient(clientState);
  const service = new SnowballHotKeywordSyncService(client);

  await service.syncDate('2026-06-08', {
    symbol: '本周新增',
    limit: 50,
    baselineLookbackDays: 30,
  });
  assertEqual('custom: symbol passed', clientState.calls[0].symbol, '本周新增');
  assertEqual('custom: limit passed', clientState.calls[0].limit, 50);
}

async function testSyncDateLimitClamp(): Promise<void> {
  resetStore();
  const clientState = emptyClientState({ rows: makeFakeRows(['x'], '2026-06-08') });
  const client = makeFakeClient(clientState);
  const service = new SnowballHotKeywordSyncService(client);

  // limit=0 → clamped to 1
  await service.syncDate('2026-06-08', { limit: 0 });
  assertEqual('limit clamp lower', clientState.calls[0].limit, 1);

  clientState.calls = [];
  // limit=99999 → clamped to 1000
  await service.syncDate('2026-06-08', { limit: 99999 });
  assertEqual('limit clamp upper', clientState.calls[0].limit, 1000);
}

async function testLoadPreviousKeywordsNone(): Promise<void> {
  resetStore();
  const client = makeFakeClient(emptyClientState());
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.loadPreviousKeywords('2026-06-08', 14);
  assertEqual('loadPrev: none → null', result, null);
}

async function testLoadPreviousKeywordsHappyPath(): Promise<void> {
  resetStore();
  store.push(
    { trade_date: '2026-06-06', keyword: 'A', heat_score: 1 },
    { trade_date: '2026-06-06', keyword: 'B', heat_score: 2 },
    { trade_date: '2026-06-07', keyword: 'A', heat_score: 3 },
    { trade_date: '2026-06-07', keyword: 'C', heat_score: 4 }
  );
  const client = makeFakeClient(emptyClientState());
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.loadPreviousKeywords('2026-06-08', 14);
  assert('loadPrev: not null', result !== null);
  assertEqual('loadPrev: latest baseline date is 2026-06-07', result!.tradeDate, '2026-06-07');
  assertEqual('loadPrev: keyword set size 2', result!.keywords.size, 2);
  assert('loadPrev: has A', result!.keywords.has('A'));
  assert('loadPrev: has C', result!.keywords.has('C'));
  assert('loadPrev: no B (B is on 2026-06-06)', !result!.keywords.has('B'));
}

async function testLoadPreviousKeywordsSkipsHoliday(): Promise<void> {
  resetStore();
  // 2026-06-01..06-03 是节假日无数据; 2026-05-30 是上一个有效日
  store.push(
    { trade_date: '2026-05-30', keyword: 'X', heat_score: 1 },
    { trade_date: '2026-05-30', keyword: 'Y', heat_score: 2 }
  );
  const client = makeFakeClient(emptyClientState());
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.loadPreviousKeywords('2026-06-04', 14);
  assert('skipsHoliday: not null', result !== null);
  assertEqual('skipsHoliday: tradeDate', result!.tradeDate, '2026-05-30');
  assertEqual('skipsHoliday: size', result!.keywords.size, 2);
}

async function testSyncRangeInvalid(): Promise<void> {
  resetStore();
  const client = makeFakeClient(emptyClientState());
  const service = new SnowballHotKeywordSyncService(client);

  await expectThrow(
    'syncRange start > end throws',
    () => service.syncRange('2026-06-10', '2026-06-08'),
    'after end'
  );
}

async function testSyncRangeMultipleDays(): Promise<void> {
  resetStore();
  const clientState = emptyClientState({
    rowsFn: (td) => makeFakeRows(['A', 'B'], td),
  });
  const client = makeFakeClient(clientState);
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.syncRange('2026-06-01', '2026-06-03', {
    intervalMs: 0,
    skipExisting: false,
  });
  assertEqual('range: total_days', result.total_days, 3);
  assertEqual('range: succeeded', result.succeeded, 3);
  assertEqual('range: failed', result.failed, 0);
  assertEqual('range: store has 6 rows', store.length, 6);
  // 3 calls to client
  assertEqual('range: client calls', clientState.calls.length, 3);
}

async function testSyncRangeSkipsExisting(): Promise<void> {
  resetStore();
  // seed 2026-06-02 with data
  store.push({ trade_date: '2026-06-02', keyword: 'pre-existing', heat_score: 1 });
  const clientState = emptyClientState({
    rowsFn: (td) => makeFakeRows(['A'], td),
  });
  const client = makeFakeClient(clientState);
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.syncRange('2026-06-01', '2026-06-03', {
    intervalMs: 0,
    skipExisting: true,
  });
  assertEqual('skip: total_days', result.total_days, 3);
  assertEqual('skip: succeeded (non-skipped) = 2', result.succeeded, 2);
  assertEqual('skip: skipped = 1', result.skipped, 1);
  // only 06-01 and 06-03 should have been fetched
  assertEqual('skip: client calls', clientState.calls.length, 2);
  const dates = clientState.calls.map(c => c.tradeDate).sort();
  assertEqual('skip: dates fetched', dates, ['2026-06-01', '2026-06-03']);
}

async function testSyncRangeSingleDayFailsButContinues(): Promise<void> {
  resetStore();
  const clientState = emptyClientState({
    rowsFn: (td) => {
      if (td === '2026-06-02') throw new Error('outage on 06-02');
      return makeFakeRows(['ok'], td);
    },
  });
  const client = makeFakeClient(clientState);
  const service = new SnowballHotKeywordSyncService(client);

  const result = await service.syncRange('2026-06-01', '2026-06-03', {
    intervalMs: 0,
    skipExisting: false,
  });
  assertEqual('partial: total_days', result.total_days, 3);
  assertEqual('partial: succeeded', result.succeeded, 2);
  assertEqual('partial: failed', result.failed, 1);
  const failedDetail = result.details.find((d: SyncDateResult) => d.trade_date === '2026-06-02');
  assert('partial: 06-02 has error', !!failedDetail && !!failedDetail.error);
  // 06-01 and 06-03 succeeded
  assertEqual('partial: store has 2 rows', store.length, 2);
}

async function testListByDateDefault(): Promise<void> {
  resetStore();
  store.push(
    { trade_date: '2026-06-07', keyword: 'old', heat_score: 1, rank: 1 },
    { trade_date: '2026-06-08', keyword: 'new1', heat_score: 10, rank: 1, is_new: true },
    { trade_date: '2026-06-08', keyword: 'new2', heat_score: 9, rank: 2, is_new: false }
  );
  const client = makeFakeClient(emptyClientState());
  const service = new SnowballHotKeywordSyncService(client);

  const rows = await service.listByDate();
  assertEqual('list default: count', rows.length, 2);
  assertEqual('list default: latest date used', rows[0].trade_date, '2026-06-08');
}

async function testListByDateOnlyNew(): Promise<void> {
  resetStore();
  store.push(
    { trade_date: '2026-06-08', keyword: 'a', heat_score: 10, rank: 1, is_new: true },
    { trade_date: '2026-06-08', keyword: 'b', heat_score: 9, rank: 2, is_new: false },
    { trade_date: '2026-06-08', keyword: 'c', heat_score: 8, rank: 3, is_new: true }
  );
  const client = makeFakeClient(emptyClientState());
  const service = new SnowballHotKeywordSyncService(client);

  const rows = await service.listByDate('2026-06-08', true);
  assertEqual('list onlyNew: count', rows.length, 2);
  for (const r of rows) {
    assert(`list onlyNew row ${r.keyword} is_new=true`, !!r.is_new);
  }
}

async function testListByDateLimitClamp(): Promise<void> {
  resetStore();
  for (let i = 0; i < 5; i++) {
    store.push({ trade_date: '2026-06-08', keyword: `k${i}`, heat_score: 100 - i, rank: i + 1 });
  }
  const client = makeFakeClient(emptyClientState());
  const service = new SnowballHotKeywordSyncService(client);

  // limit=0 → clamp 1
  let rows = await service.listByDate('2026-06-08', false, 0);
  assertEqual('list limit clamp lower', rows.length, 1);

  rows = await service.listByDate('2026-06-08', false, 3);
  assertEqual('list limit 3', rows.length, 3);

  rows = await service.listByDate('2026-06-08', false, 99999);
  assertEqual('list limit clamp upper (only 5 in store)', rows.length, 5);
}

async function testListByDateNoMatch(): Promise<void> {
  resetStore();
  const client = makeFakeClient(emptyClientState());
  const service = new SnowballHotKeywordSyncService(client);

  // Empty store
  let rows = await service.listByDate();
  assertEqual('list no data → []', rows.length, 0);

  // Explicit date with no rows
  rows = await service.listByDate('2026-06-08', false);
  assertEqual('list specific date no rows → []', rows.length, 0);
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  installModelStubs();

  testParseIsoDate();
  await testSleep();

  await testSyncDateHappyPath();
  await testSyncDateWithBaseline();
  await testSyncDateClientThrows();
  await testSyncDateEmptyRows();
  await testSyncDateCustomOptions();
  await testSyncDateLimitClamp();

  await testLoadPreviousKeywordsNone();
  await testLoadPreviousKeywordsHappyPath();
  await testLoadPreviousKeywordsSkipsHoliday();

  await testSyncRangeInvalid();
  await testSyncRangeMultipleDays();
  await testSyncRangeSkipsExisting();
  await testSyncRangeSingleDayFailsButContinues();

  await testListByDateDefault();
  await testListByDateOnlyNew();
  await testListByDateLimitClamp();
  await testListByDateNoMatch();

  console.log(`\n${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
