/**
 * PaperTradingFacade evaluateQuoteStaleness 单元测试 (BETA-6, audit M-17)
 *
 *   cd backend && npx ts-node --transpile-only tests/portfolio/PaperTradingFacade.quoteStale.test.ts
 *
 * 测试 evaluateQuoteStaleness 纯函数 (无 DB / 无 RealtimeQuoteService 调用):
 *  - RealtimeQuote 在 30 min 内 → pass_realtime
 *  - RealtimeQuote 31 min 前 → stale_realtime + code='STALE_REALTIME_QUOTE' detail
 *  - RealtimeQuote 缺失 + daily_bar 12h 前 → pass_daily_bar_fallback
 *  - RealtimeQuote 缺失 + daily_bar 2 天前 → stale_daily_bar + code='STALE_DAILY_BAR'
 *  - RealtimeQuote 与 daily_bar 都不可解析 → stale_daily_bar
 */

import { evaluateQuoteStaleness } from '../../src/portfolio/PaperTradingFacade';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}

const NOW = 1_750_000_000_000; // 固定 now，确保 deterministic

function test_pass_realtime_fresh() {
  const r = evaluateQuoteStaleness({
    symbol: '600519',
    now_ms: NOW,
    realtime_quote_time: new Date(NOW - 10 * 60 * 1000).toISOString(),
    daily_bar_time: new Date(NOW).toISOString(),
    max_realtime_age_minutes: 30,
    max_daily_bar_age_days: 1,
  });
  assert('realtime 10min 前 → pass_realtime', r.kind === 'pass_realtime');
}

function test_stale_realtime_31min() {
  const r = evaluateQuoteStaleness({
    symbol: '600519',
    now_ms: NOW,
    realtime_quote_time: new Date(NOW - 31 * 60 * 1000).toISOString(),
    daily_bar_time: new Date(NOW).toISOString(),
    max_realtime_age_minutes: 30,
    max_daily_bar_age_days: 1,
  });
  assert('realtime 31min 前 → stale_realtime', r.kind === 'stale_realtime');
  assert(
    'stale_realtime detail.source=realtime_quote',
    r.detail?.source === 'realtime_quote'
  );
}

function test_stale_realtime_boundary_30min() {
  // 30min 整 — 严格 > 30 才算 stale, 所以 30min 整应该 pass
  const r = evaluateQuoteStaleness({
    symbol: '600519',
    now_ms: NOW,
    realtime_quote_time: new Date(NOW - 30 * 60 * 1000).toISOString(),
    daily_bar_time: new Date(NOW).toISOString(),
    max_realtime_age_minutes: 30,
    max_daily_bar_age_days: 1,
  });
  assert('realtime 30min 整 → pass_realtime (严格 > 才 stale)', r.kind === 'pass_realtime');
}

function test_fallback_daily_bar_fresh() {
  const r = evaluateQuoteStaleness({
    symbol: '600519',
    now_ms: NOW,
    realtime_quote_time: null, // 模拟服务不可用
    daily_bar_time: new Date(NOW - 12 * 60 * 60 * 1000).toISOString(), // 12h
    max_realtime_age_minutes: 30,
    max_daily_bar_age_days: 1,
  });
  assert(
    'realtime 缺 + daily_bar 12h 前 → pass_daily_bar_fallback',
    r.kind === 'pass_daily_bar_fallback'
  );
}

function test_stale_daily_bar_2_days() {
  const r = evaluateQuoteStaleness({
    symbol: '600519',
    now_ms: NOW,
    realtime_quote_time: null,
    daily_bar_time: new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days
    max_realtime_age_minutes: 30,
    max_daily_bar_age_days: 1,
  });
  assert(
    'realtime 缺 + daily_bar 2 天前 → stale_daily_bar',
    r.kind === 'stale_daily_bar'
  );
  assert('detail.source=daily_bar', r.detail?.source === 'daily_bar');
}

function test_unparseable_daily_bar() {
  const r = evaluateQuoteStaleness({
    symbol: '600519',
    now_ms: NOW,
    realtime_quote_time: null,
    daily_bar_time: 'not-a-date',
    max_realtime_age_minutes: 30,
    max_daily_bar_age_days: 1,
  });
  assert('双源不可解析 → stale_daily_bar', r.kind === 'stale_daily_bar');
}

function test_realtime_invalid_ts_fallback_daily_bar() {
  // realtime_quote_time 解析失败 → 走 daily_bar fallback
  const r = evaluateQuoteStaleness({
    symbol: '600519',
    now_ms: NOW,
    realtime_quote_time: 'not-a-date',
    daily_bar_time: new Date(NOW - 12 * 60 * 60 * 1000).toISOString(),
    max_realtime_age_minutes: 30,
    max_daily_bar_age_days: 1,
  });
  assert(
    'realtime ts 不可解析 → daily_bar fallback pass',
    r.kind === 'pass_daily_bar_fallback'
  );
}

test_pass_realtime_fresh();
test_stale_realtime_31min();
test_stale_realtime_boundary_30min();
test_fallback_daily_bar_fresh();
test_stale_daily_bar_2_days();
test_unparseable_daily_bar();
test_realtime_invalid_ts_fallback_daily_bar();

console.log('');
console.log(`✅ passed=${passed}`);
console.log(`❌ failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
