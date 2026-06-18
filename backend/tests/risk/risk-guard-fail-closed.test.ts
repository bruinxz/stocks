/**
 * RiskGuardFailClosed 单元测试 — US-011 (PR-006)
 *
 *   cd backend && npx ts-node --transpile-only tests/risk/risk-guard-fail-closed.test.ts
 *
 * 不依赖 DB / jest。覆盖维度:
 *   [1] RiskGuardUnavailableError 类形态 (statusCode/code/guardName/detail)
 *   [2] wrapFailClosed: 正常返值 / re-throw 已经是 RiskGuardUnavailableError /
 *       wrap any other Error → RiskGuardUnavailableError + guardName/cause
 *   [3] buildRiskGuardUnavailablePayload: 已知 guard 翻译标签 / 未知 guard 透传 /
 *       message 含 ⚠️ + caller + symbol + fail-CLOSED 标识 / metadata 合并 detail
 *   [4] handleRiskGuardUnavailable: 调 dataSource.create 一次 + 返结构化 payload /
 *       dataSource.create throw 不掩盖 rejection / payload caller/guard 透传
 *   [5] META-GUARD: 用 fs+regex 扫 PaperTradingFacade.ts / preTradeGuards.ts /
 *       PositionLimitGuard.ts / DrawdownCircuitBreaker.ts 五条边界
 *       (a) Facade + preTradeGuards 必须 import handleRiskGuardUnavailable
 *       (b) Facade + preTradeGuards 不再 inline 写 'SYSTEM:RISK_GUARD_UNAVAILABLE'
 *           的 RiskAlert.create (已统一走 handleRiskGuardUnavailable)
 *       (c) PositionLimitGuard.checkBuyOrder 必须用 wrapFailClosed('position_limit', ...)
 *       (d) DrawdownCircuitBreaker.checkBuyAllowed 必须用 wrapFailClosed('drawdown_breaker', ...)
 *       (e) RiskGuardUnavailableError 在 DrawdownCircuitBreaker.ts 必须 re-export
 *           而非二次声明 (back-compat 但单一事实源)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  RiskGuardUnavailableError,
  buildRiskGuardUnavailablePayload,
  handleRiskGuardUnavailable,
  wrapFailClosed,
  RiskAlertCreator,
} from '../../src/portfolio/risk/RiskGuardFailClosed';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`❌ ${name}${detail ? ' detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
//  [1] Error class shape
// ---------------------------------------------------------------------------
function testErrorClass() {
  const err = new RiskGuardUnavailableError('boom', 'drawdown_breaker', { user_id: 7 });
  assert('is instance of Error', err instanceof Error);
  assert('is instance of RiskGuardUnavailableError', err instanceof RiskGuardUnavailableError);
  assertEqual('message', err.message, 'boom');
  assertEqual('statusCode=503', err.statusCode, 503);
  assertEqual('code=RISK_GUARD_UNAVAILABLE', err.code, 'RISK_GUARD_UNAVAILABLE');
  assertEqual('guardName', err.guardName, 'drawdown_breaker');
  assertEqual('detail.user_id', err.detail?.user_id, 7);
  assertEqual('name=RiskGuardUnavailableError', err.name, 'RiskGuardUnavailableError');
}

// ---------------------------------------------------------------------------
//  [2] wrapFailClosed
// ---------------------------------------------------------------------------
async function testWrapFailClosedHappy() {
  const r = await wrapFailClosed('drawdown_breaker', async () => ({ ok: true, val: 42 }));
  assertEqual('happy passes value through', r, { ok: true, val: 42 });
}

async function testWrapFailClosedRethrowsExisting() {
  const inner = new RiskGuardUnavailableError('inner boom', 'position_limit', { rule: 'count' });
  let caught: unknown = null;
  try {
    await wrapFailClosed(
      'drawdown_breaker',
      async () => {
        throw inner;
      },
      { user_id: 1 }
    );
  } catch (e) {
    caught = e;
  }
  // The inner one is re-thrown unchanged (preserves original guardName=position_limit)
  assert('same instance re-thrown', caught === inner);
  if (caught instanceof RiskGuardUnavailableError) {
    assertEqual('preserves inner guardName', caught.guardName, 'position_limit');
    assertEqual('preserves inner detail', caught.detail?.rule, 'count');
  }
}

async function testWrapFailClosedConvertsUnexpected() {
  let caught: unknown = null;
  try {
    await wrapFailClosed(
      'position_limit',
      async () => {
        throw new Error('Sequelize: connection refused');
      },
      { user_id: 7, symbol: 'A.SH' }
    );
  } catch (e) {
    caught = e;
  }
  assert('caught is RiskGuardUnavailableError', caught instanceof RiskGuardUnavailableError);
  if (caught instanceof RiskGuardUnavailableError) {
    assertEqual('outer guardName tagged', caught.guardName, 'position_limit');
    assert('message includes guardName + reason', /position_limit 不可用.*connection refused/.test(caught.message));
    assertEqual('detail.user_id passed through', caught.detail?.user_id, 7);
    assertEqual('detail.symbol passed through', caught.detail?.symbol, 'A.SH');
    assertEqual('detail.cause is original message', caught.detail?.cause, 'Sequelize: connection refused');
    assertEqual('statusCode=503', caught.statusCode, 503);
  }
}

async function testWrapFailClosedHandlesNonError() {
  // 防御性: 万一 fn 抛了 string / number 等非 Error
  let caught: unknown = null;
  try {
    await wrapFailClosed('drawdown_breaker', async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string thrown';
    });
  } catch (e) {
    caught = e;
  }
  assert('non-Error throw still converted to RiskGuardUnavailableError', caught instanceof RiskGuardUnavailableError);
  if (caught instanceof RiskGuardUnavailableError) {
    assert('message includes string repr', /string thrown/.test(caught.message));
  }
}

// ---------------------------------------------------------------------------
//  [3] buildRiskGuardUnavailablePayload
// ---------------------------------------------------------------------------
function testBuildPayloadKnownGuard() {
  const p = buildRiskGuardUnavailablePayload({
    user_id: 7,
    guardName: 'drawdown_breaker',
    symbol: '600519.SH',
    reason: 'DB outage',
    callerLabel: 'facade.placeOrder',
    detail: { user_id: 7, symbol: '600519.SH' },
  });
  assertEqual('user_id', p.user_id, 7);
  assertEqual('symbol = SYSTEM sentinel', p.symbol, 'SYSTEM:RISK_GUARD_UNAVAILABLE');
  assertEqual('level=HIGH', p.level, 'HIGH');
  assertEqual('rule_id=guardName', p.rule_id, 'drawdown_breaker');
  assertEqual('name has human label', p.name, '风控不可用 — DrawdownCircuitBreaker');
  assert('message has ⚠️ prefix', p.message.startsWith('⚠️'));
  assert('message mentions human label', p.message.includes('DrawdownCircuitBreaker'));
  assert('message mentions caller', p.message.includes('facade.placeOrder'));
  assert('message mentions symbol', p.message.includes('600519.SH'));
  assert('message mentions fail-CLOSED', p.message.includes('fail-CLOSED'));
  assertEqual('metadata.guard', p.metadata.guard, 'drawdown_breaker');
  assertEqual('metadata.symbol', p.metadata.symbol, '600519.SH');
  assertEqual('metadata.caller', p.metadata.caller, 'facade.placeOrder');
  assertEqual('is_read=false', p.is_read, false);
}

function testBuildPayloadUnknownGuard() {
  const p = buildRiskGuardUnavailablePayload({
    user_id: 1,
    guardName: 'brand_new_guard',
    symbol: 'X',
    reason: 'r',
    callerLabel: 'c',
  });
  // Unknown guard label falls back to the raw guardName.
  assertEqual('name falls back to raw guardName', p.name, '风控不可用 — brand_new_guard');
  assertEqual('rule_id still = guardName', p.rule_id, 'brand_new_guard');
  // No detail passed → metadata only has the standard 3 keys.
  assertEqual('metadata.guard', p.metadata.guard, 'brand_new_guard');
}

function testBuildPayloadAllKnownGuards() {
  // Sanity: every guard listed in GUARD_LABELS produces a non-empty human name.
  const guards = [
    'drawdown_breaker',
    'position_limit',
    'trailing_stop',
    'per_stock_stop_loss',
    'industry_concentration',
    'black_swan',
    'market_regime',
    'morning_checkup',
    'restricted_share',
  ];
  for (const g of guards) {
    const p = buildRiskGuardUnavailablePayload({
      user_id: 1,
      guardName: g,
      symbol: 'X',
      reason: 'r',
      callerLabel: 'c',
    });
    assert(`${g} → human label resolved`, !p.name.endsWith(`— ${g}`), `name=${p.name}`);
  }
}

// ---------------------------------------------------------------------------
//  [4] handleRiskGuardUnavailable
// ---------------------------------------------------------------------------
function makeFakeAlertCreator(opts: { shouldThrow?: boolean } = {}): {
  ds: RiskAlertCreator;
  calls: any[];
} {
  const calls: any[] = [];
  const ds: RiskAlertCreator = {
    async create(input: any) {
      calls.push(input);
      if (opts.shouldThrow) throw new Error('RiskAlert table also unavailable');
      return input;
    },
  };
  return { ds, calls };
}

async function testHandleHappy() {
  const { ds, calls } = makeFakeAlertCreator();
  const err = new RiskGuardUnavailableError('boom', 'drawdown_breaker', { user_id: 7 });
  const p = await handleRiskGuardUnavailable({
    err,
    user_id: 7,
    symbol: '600519.SH',
    callerLabel: 'facade.placeOrder',
    dataSource: ds,
  });
  assertEqual('RiskAlert.create called exactly once', calls.length, 1);
  assertEqual('payload.user_id matches', calls[0].user_id, 7);
  assertEqual('payload.symbol = SYSTEM', calls[0].symbol, 'SYSTEM:RISK_GUARD_UNAVAILABLE');
  assertEqual('payload.level=HIGH', calls[0].level, 'HIGH');
  assertEqual('payload.rule_id=guardName', calls[0].rule_id, 'drawdown_breaker');
  assertEqual('returned payload matches what was sent', p.message, calls[0].message);
}

async function testHandleAlertWriteFailsSilently() {
  // If RiskAlert.create itself throws, handleRiskGuardUnavailable must not
  // re-throw — the primary outcome is the rejection, not the alert.
  const { ds, calls } = makeFakeAlertCreator({ shouldThrow: true });
  const err = new RiskGuardUnavailableError('boom', 'position_limit');
  let caught: unknown = null;
  let payload: any = null;
  try {
    payload = await handleRiskGuardUnavailable({
      err,
      user_id: 7,
      symbol: 'X',
      callerLabel: 'caller-x',
      dataSource: ds,
    });
  } catch (e) {
    caught = e;
  }
  assert('handleRiskGuardUnavailable does not re-throw alert write failures', caught === null);
  assertEqual('alert was attempted once', calls.length, 1);
  assert('payload still returned', payload !== null);
}

async function testHandleUnknownGuardName() {
  // err.guardName missing → falls back to 'unknown_guard'
  const { ds, calls } = makeFakeAlertCreator();
  const err = new RiskGuardUnavailableError('boom', '' /* empty */, undefined);
  await handleRiskGuardUnavailable({
    err,
    user_id: 7,
    symbol: 'X',
    callerLabel: 'caller-x',
    dataSource: ds,
  });
  // Empty guardName → loaders fall back to 'unknown_guard'
  assertEqual('rule_id falls back to unknown_guard', calls[0].rule_id, 'unknown_guard');
}

// ---------------------------------------------------------------------------
//  [5] META-GUARD — fs+regex scan five boundaries
// ---------------------------------------------------------------------------
function testMetaGuard() {
  const facadeSrc = readFileSync(
    resolve(__dirname, '../../src/portfolio/PaperTradingFacade.ts'),
    'utf-8'
  );
  const preTradeSrc = readFileSync(
    resolve(__dirname, '../../src/portfolio/internal/preTradeGuards.ts'),
    'utf-8'
  );
  const positionSrc = readFileSync(
    resolve(__dirname, '../../src/portfolio/risk/PositionLimitGuard.ts'),
    'utf-8'
  );
  const drawdownSrc = readFileSync(
    resolve(__dirname, '../../src/portfolio/risk/DrawdownCircuitBreaker.ts'),
    'utf-8'
  );

  // (a) Facade + preTradeGuards must import handleRiskGuardUnavailable
  assert(
    'facade imports handleRiskGuardUnavailable',
    /import\s*\{[^}]*handleRiskGuardUnavailable[^}]*\}\s*from\s*['"]\.\/risk\/RiskGuardFailClosed['"]/.test(
      facadeSrc
    )
  );
  assert(
    'preTradeGuards imports handleRiskGuardUnavailable',
    /import\s*\{[^}]*handleRiskGuardUnavailable[^}]*\}\s*from\s*['"]\.\.\/risk\/RiskGuardFailClosed['"]/.test(
      preTradeSrc
    )
  );

  // (b) Facade + preTradeGuards no longer inline-construct
  //     `SYSTEM:RISK_GUARD_UNAVAILABLE` RiskAlert.create payloads.
  //     (Inline construction would mean message/metadata could drift from the
  //     shared helper; we want a single source of truth.)
  assert(
    'facade no longer inline-writes SYSTEM:RISK_GUARD_UNAVAILABLE RiskAlert.create',
    !/RiskAlert\.create\s*\(\s*\{[^}]*SYSTEM:RISK_GUARD_UNAVAILABLE/s.test(facadeSrc)
  );
  assert(
    'preTradeGuards no longer inline-writes SYSTEM:RISK_GUARD_UNAVAILABLE RiskAlert.create',
    !/RiskAlert\.create\s*\(\s*\{[^}]*SYSTEM:RISK_GUARD_UNAVAILABLE/s.test(preTradeSrc)
  );

  // (c) PositionLimitGuard.checkBuyOrder must use wrapFailClosed('position_limit', ...)
  assert(
    'PositionLimitGuard imports wrapFailClosed from RiskGuardFailClosed',
    /import\s*\{[^}]*wrapFailClosed[^}]*\}\s*from\s*['"]\.\/RiskGuardFailClosed['"]/.test(positionSrc)
  );
  assert(
    "PositionLimitGuard.checkBuyOrder body wraps in wrapFailClosed('position_limit', ...)",
    /async\s+checkBuyOrder[\s\S]*?wrapFailClosed\(\s*['"]position_limit['"]/.test(positionSrc)
  );

  // (d) DrawdownCircuitBreaker.checkBuyAllowed must use wrapFailClosed('drawdown_breaker', ...)
  assert(
    'DrawdownCircuitBreaker imports wrapFailClosed from RiskGuardFailClosed',
    /import\s*\{[^}]*wrapFailClosed[^}]*\}\s*from\s*['"]\.\/RiskGuardFailClosed['"]/.test(drawdownSrc)
  );
  assert(
    "DrawdownCircuitBreaker.checkBuyAllowed body wraps in wrapFailClosed('drawdown_breaker', ...)",
    /async\s+checkBuyAllowed[\s\S]*?wrapFailClosed\(\s*['"]drawdown_breaker['"]/.test(drawdownSrc)
  );

  // (e) DrawdownCircuitBreaker must re-export (not re-declare) RiskGuardUnavailableError.
  //     "export class RiskGuardUnavailableError" would mean two definitions, both
  //     would be `instanceof`-checkable but with different identity → silent bugs.
  assert(
    'DrawdownCircuitBreaker does NOT re-declare RiskGuardUnavailableError',
    !/export\s+class\s+RiskGuardUnavailableError/.test(drawdownSrc)
  );
  assert(
    'DrawdownCircuitBreaker re-exports RiskGuardUnavailableError from RiskGuardFailClosed',
    /export\s*\{\s*RiskGuardUnavailableError[^}]*\}/.test(drawdownSrc) ||
      /import\s*\{[^}]*RiskGuardUnavailableError[^}]*\}\s*from\s*['"]\.\/RiskGuardFailClosed['"]/.test(
        drawdownSrc
      )
  );
}

// ---------------------------------------------------------------------------
//  runner
// ---------------------------------------------------------------------------
(async () => {
  // [1]
  testErrorClass();
  // [2]
  await testWrapFailClosedHappy();
  await testWrapFailClosedRethrowsExisting();
  await testWrapFailClosedConvertsUnexpected();
  await testWrapFailClosedHandlesNonError();
  // [3]
  testBuildPayloadKnownGuard();
  testBuildPayloadUnknownGuard();
  testBuildPayloadAllKnownGuards();
  // [4]
  await testHandleHappy();
  await testHandleAlertWriteFailsSilently();
  await testHandleUnknownGuardName();
  // [5]
  testMetaGuard();

  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
