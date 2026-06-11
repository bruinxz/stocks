/**
 * liveTradingRateLimit 单测。
 *
 *   cd backend && npx ts-node --transpile-only src/live-trading/middlewares/liveTradingRateLimit.test.ts
 */

import {
  liveTradingRateLimit,
  __resetRateLimiterForTests,
} from './liveTradingRateLimit';
import { AuthenticatedRequest } from '../../middlewares/auth';

let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function fakeReq(userId?: number, ip?: string): AuthenticatedRequest {
  return {
    user: userId ? ({ id: userId, role: 'user', username: 'u', email: '' } as any) : undefined,
    ip,
    headers: {},
  } as any;
}

function fakeRes() {
  const headers: Record<string, string> = {};
  const obj: any = {
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    statusCode: 200,
    bodyJson: null as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.bodyJson = data;
      return this;
    },
    _headers: headers,
  };
  return obj;
}

async function callMany(mw: any, req: any, times: number) {
  const responses: any[] = [];
  let nextCount = 0;
  for (let i = 0; i < times; i++) {
    const res = fakeRes();
    await new Promise<void>(resolve => {
      mw(req, res, () => {
        nextCount += 1;
        resolve();
      });
      // 如果 mw 已经响应了（429），next 不会被调；用 setImmediate 兜底解锁
      setImmediate(() => resolve());
    });
    responses.push(res);
  }
  return { responses, nextCount };
}

// ------------------------------------------------------------

async function test_first_call_passes() {
  __resetRateLimiterForTests();
  const mw = liveTradingRateLimit({ name: 't1', windowMs: 60_000, max: 3 });
  const { responses, nextCount } = await callMany(mw, fakeReq(1), 1);
  assert('首次调用 next 被触发', nextCount === 1);
  assert('返回 X-RateLimit-Limit', responses[0]._headers['X-RateLimit-Limit'] === '3');
  assert('返回 X-RateLimit-Remaining', responses[0]._headers['X-RateLimit-Remaining'] === '2');
}

async function test_within_limit_all_pass() {
  __resetRateLimiterForTests();
  const mw = liveTradingRateLimit({ name: 't2', windowMs: 60_000, max: 5 });
  const { nextCount } = await callMany(mw, fakeReq(1), 5);
  assert('限内 5 次全过', nextCount === 5);
}

async function test_exceed_returns_429() {
  __resetRateLimiterForTests();
  const mw = liveTradingRateLimit({ name: 't3', windowMs: 60_000, max: 2 });
  const { responses, nextCount } = await callMany(mw, fakeReq(1), 4);
  assert('前 2 次 next', nextCount === 2);
  const blocked = responses.filter(r => r.statusCode === 429);
  assert('后 2 次 429', blocked.length === 2);
  assert(
    '429 body 含 retry_after_seconds',
    typeof blocked[0].bodyJson?.retry_after_seconds === 'number'
  );
  assert(
    '429 含 Retry-After header',
    Number(blocked[0]._headers['Retry-After']) >= 1
  );
}

async function test_different_users_isolated() {
  __resetRateLimiterForTests();
  const mw = liveTradingRateLimit({ name: 't4', windowMs: 60_000, max: 1 });
  const { nextCount: u1n } = await callMany(mw, fakeReq(1), 1);
  const { nextCount: u2n } = await callMany(mw, fakeReq(2), 1);
  assert('user 1 第一次过', u1n === 1);
  assert('user 2 第一次过（与 user 1 隔离）', u2n === 1);
}

async function test_different_names_isolated() {
  __resetRateLimiterForTests();
  const mwA = liveTradingRateLimit({ name: 'A', windowMs: 60_000, max: 1 });
  const mwB = liveTradingRateLimit({ name: 'B', windowMs: 60_000, max: 1 });
  const req = fakeReq(1);
  const a = await callMany(mwA, req, 1);
  const b = await callMany(mwB, req, 1);
  assert('A 限内', a.nextCount === 1);
  assert('B 限内（与 A 同 user 但不同 name 隔离）', b.nextCount === 1);
}

async function test_unauth_falls_back_to_ip() {
  __resetRateLimiterForTests();
  const mw = liveTradingRateLimit({ name: 't5', windowMs: 60_000, max: 2 });
  // 同一 ip 应共享配额
  const r1 = await callMany(mw, fakeReq(undefined, '1.2.3.4'), 1);
  const r2 = await callMany(mw, fakeReq(undefined, '1.2.3.4'), 1);
  const r3 = await callMany(mw, fakeReq(undefined, '1.2.3.4'), 1);
  assert('未登录 ip-1 限内', r1.nextCount === 1);
  assert('未登录 ip-1 第二次仍限内', r2.nextCount === 1);
  assert(
    '未登录 ip-1 第三次 429',
    r3.responses[0].statusCode === 429,
    `got ${r3.responses[0].statusCode}`
  );

  // 不同 ip 隔离
  const r4 = await callMany(mw, fakeReq(undefined, '9.9.9.9'), 1);
  assert('未登录 ip-2 限内（与 ip-1 隔离）', r4.nextCount === 1);
}

async function test_window_reset() {
  __resetRateLimiterForTests();
  const mw = liveTradingRateLimit({ name: 't6', windowMs: 50, max: 1 });
  const r1 = await callMany(mw, fakeReq(1), 1);
  const r2 = await callMany(mw, fakeReq(1), 1);
  assert('窗口内第二次 429', r2.responses[0].statusCode === 429);
  await new Promise(r => setTimeout(r, 80));
  const r3 = await callMany(mw, fakeReq(1), 1);
  assert('窗口过期后重置', r3.nextCount === 1, `got nextCount=${r3.nextCount}`);
}

// ------------------------------------------------------------

const tests = [
  test_first_call_passes,
  test_within_limit_all_pass,
  test_exceed_returns_429,
  test_different_users_isolated,
  test_different_names_isolated,
  test_unauth_falls_back_to_ip,
  test_window_reset,
];

(async () => {
  console.log(`\n=== liveTradingRateLimit unit tests (${tests.length}) ===\n`);
  for (const t of tests) {
    try {
      await t();
    } catch (err: any) {
      failed += 1;
      console.error(`  THROW ${t.name}: ${err?.message || err}`);
    }
  }
  console.log(`\nResult: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
