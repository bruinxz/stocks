/**
 * PaperTradingFacade.placeOrder 顶层 throw 时 ops 告警 (Phase 10 通知审计 2026-06-28)
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only \
 *     tests/portfolio/PaperTradingFacade.placeOrderOpsAlert.test.ts
 *
 * 验:
 *   [1] _placeOrderInner throw → pushSystemAdminAlertFireAndForget 被调
 *       1 次, level='WARN', dedup_key 含 direction + code
 *   [2] 成功路径 (无 throw) → pushSystemAdminAlertFireAndForget 0 次
 *   [3] pusher 内部 throw → placeOrder 仍把原 error 抛出 (不被告警链路吞掉)
 *
 * mock 策略: hijack require cache 让 SystemAdminAlertPusher 返回 spy.
 */

import path from 'path';

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

// ---------------------------------------------------------------------------
// hijack SystemAdminAlertPusher in require cache 之前 require facade
// ---------------------------------------------------------------------------

const pushCalls: any[] = [];
let pusherThrows = false;
const sysModPath = path.join(
  __dirname,
  '../../src/services/SystemAdminAlertPusher.ts'
);
const sysModResolved = require.resolve(sysModPath);
require.cache[sysModResolved] = {
  id: sysModResolved,
  filename: sysModResolved,
  loaded: true,
  exports: {
    pushSystemAdminAlertFireAndForget: (input: any) => {
      pushCalls.push(input);
      if (pusherThrows) throw new Error('fake pusher throw');
    },
    pushSystemAdminAlert: async (input: any) => {
      pushCalls.push(input);
      return { pushed: true, deduped: false } as any;
    },
  },
} as any;

// import facade 之前 hijack 完成
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PaperTradingFacade } = require('../../src/portfolio/PaperTradingFacade');

// ---------------------------------------------------------------------------
// helper: 构造 facade 实例并 stub _placeOrderInner
// ---------------------------------------------------------------------------

function buildFacadeThatThrows(error: any): any {
  const facade = new PaperTradingFacade();
  facade._placeOrderInner = async () => {
    throw error;
  };
  return facade;
}

function buildFacadeThatSucceeds(result: any = { ok: true }): any {
  const facade = new PaperTradingFacade();
  facade._placeOrderInner = async () => result;
  return facade;
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

(async () => {
  console.log('[1] placeOrder throw → pushSystemAdminAlertFireAndForget 1 次');
  {
    pushCalls.length = 0;
    pusherThrows = false;
    const err: any = new Error('facade.placeOrder: portfolio 不存在');
    err.code = 'PORTFOLIO_NOT_FOUND';
    const facade = buildFacadeThatThrows(err);
    let threw = false;
    try {
      await facade.placeOrder({
        user_id: 1,
        portfolio_id: 42,
        symbol: '600519',
        direction: 'BUY',
        quantity: 100,
      });
    } catch (e: any) {
      threw = true;
      assert('throw: 原 error.message 透传', String(e?.message || '').includes('portfolio 不存在'));
    }
    assert('throw: placeOrder 仍重抛 error', threw === true);
    assert('throw: pusher 调 1 次', pushCalls.length === 1);
    const c = pushCalls[0];
    assert('throw: dedup_key 含 direction', String(c?.dedup_key || '').includes('BUY'));
    assert('throw: dedup_key 含 code', String(c?.dedup_key || '').includes('PORTFOLIO_NOT_FOUND'));
    assert('throw: level=WARN', c?.level === 'WARN');
    assert('throw: title 含 BUY', String(c?.title || '').includes('BUY'));
    assert('throw: title 含 symbol', String(c?.title || '').includes('600519'));
    assert('throw: body_markdown 含 user_id', String(c?.body_markdown || '').includes('1'));
    assert('throw: body_markdown 含 error', String(c?.body_markdown || '').includes('portfolio'));
  }

  console.log('\n[2] placeOrder 成功 → pusher 0 次');
  {
    pushCalls.length = 0;
    pusherThrows = false;
    const facade = buildFacadeThatSucceeds({ id: 99 });
    const r = await facade.placeOrder({
      user_id: 1,
      portfolio_id: 42,
      symbol: '600519',
      direction: 'BUY',
      quantity: 100,
    });
    assert('success: 返回 result', r?.id === 99);
    assert('success: pusher 0 次', pushCalls.length === 0);
  }

  console.log('\n[3] pusher 内部 throw → 原 error 仍重抛 (告警链路不阻塞)');
  {
    pushCalls.length = 0;
    pusherThrows = true;
    const err: any = new Error('风控触发');
    err.code = 'PER_STOCK_STOP_LOSS_PAUSED';
    const facade = buildFacadeThatThrows(err);
    let threwOriginal = false;
    try {
      await facade.placeOrder({
        user_id: 1,
        portfolio_id: 42,
        symbol: '600519',
        direction: 'SELL',
        quantity: 100,
      });
    } catch (e: any) {
      // 必须是原 error, 不是 pusher 的 'fake pusher throw'
      if (String(e?.message || '').includes('风控触发')) threwOriginal = true;
    }
    assert('pusher throw: placeOrder 仍重抛原 error', threwOriginal === true);
    assert('pusher throw: pusher 调 1 次 (即便它内部 throw)', pushCalls.length === 1);
    pusherThrows = false; // reset
  }

  console.log('\n[4] direction / code 缺失时不崩 (defensive default)');
  {
    pushCalls.length = 0;
    pusherThrows = false;
    // direction undefined, error 无 code 也无 message
    const err: any = new Error();
    const facade = buildFacadeThatThrows(err);
    facade._placeOrderInner = async () => {
      throw err;
    };
    let threw = false;
    try {
      await facade.placeOrder({} as any);
    } catch {
      threw = true;
    }
    assert('defensive: throw 仍发生', threw === true);
    assert('defensive: pusher 仍调 1 次', pushCalls.length === 1);
    const c = pushCalls[0];
    assert(
      'defensive: dedup_key 含 unknown direction',
      String(c?.dedup_key || '').includes('unknown')
    );
  }

  console.log(`\n========================================`);
  console.log(`placeOrderOpsAlert test summary: ${passed} ok / ${failed} failed`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('unexpected test runner crash:', err);
  process.exit(2);
});
