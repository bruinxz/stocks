/**
 * US-097 [OPS-008] 日志统一字段 — loggingContext + requestContext + winston format 验收测试.
 *
 * 跑: cd backend && npx ts-node --transpile-only tests/utils/logging-context.test.ts
 *
 * 验:
 *   [1] generateTraceId 32 hex 字符且每次不同
 *   [2] runWithLoggingContext / getLoggingContext 同步 + 异步链路传播
 *   [3] runWithModule 沿用上层 trace_id 仅替换 module
 *   [4] currentTraceId / currentModule 在无作用域时返 '-'
 *   [5] extractIncomingTraceId 合法/非法/缺失 边界
 *   [6] requestContextMiddleware 行为: 新建 trace / 透传 incoming / 写 res header / 绑定 ALS
 *   [7] winston logger 输出末尾含 `trace_id=<x> module=<y>` 后缀 (file transport stream)
 *   [8] 已含 trace_id= 的 message 不重复追加 (back-compat)
 *   [9] AC 主验收: 模拟一次请求, ALS 链路内 logger.info 写出 trace_id 与外部 inject 的一致;
 *       两个并发请求 trace_id 互不干扰
 *   [10] LogController 正则 (`^(ts)\s+([a-zA-Z]+):\s+(.*)$`) 能解析新格式的 message 段
 */

import {
  generateTraceId,
  getLoggingContext,
  runWithLoggingContext,
  runWithModule,
  currentTraceId,
  currentModule,
} from '../../src/utils/loggingContext';
import {
  extractIncomingTraceId,
  requestContextMiddleware,
  TRACE_ID_HEADER,
} from '../../src/middlewares/requestContext';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

// ─── [1] generateTraceId ────────────────────────────────────────────
{
  const a = generateTraceId();
  const b = generateTraceId();
  assert(/^[0-9a-f]{32}$/.test(a), `[1.1] generateTraceId 输出 32 hex (got=${a})`);
  assert(a !== b, '[1.2] 两次调用 trace_id 不同');
}

// ─── [2] runWithLoggingContext / getLoggingContext 传播 ──────────────
{
  let inSync: any = 'unset';
  runWithLoggingContext({ trace_id: 'sync-1', module: 'http' }, () => {
    inSync = getLoggingContext();
  });
  assert(inSync?.trace_id === 'sync-1', '[2.1] 同步链路读到 trace_id');
  assert(inSync?.module === 'http', '[2.2] 同步链路读到 module');
  assert(getLoggingContext() === undefined, '[2.3] 作用域外 getLoggingContext undefined');
}

(async () => {
  // ─── [2 async] ────────────────────────────────────────────────────
  await runWithLoggingContext({ trace_id: 'async-1', module: 'cron' }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    const ctx = getLoggingContext();
    assert(ctx?.trace_id === 'async-1', '[2.4] 跨 await + setImmediate 仍透传 trace_id');
    assert(ctx?.module === 'cron', '[2.5] 跨 await + setImmediate 仍透传 module');
  });

  // ─── [3] runWithModule 沿用 trace_id ───────────────────────────────
  await runWithLoggingContext({ trace_id: 'outer-1', module: 'http' }, async () => {
    await runWithModule('scheduler', async () => {
      const ctx = getLoggingContext();
      assert(ctx?.trace_id === 'outer-1', '[3.1] runWithModule 沿用外层 trace_id');
      assert(ctx?.module === 'scheduler', '[3.2] runWithModule 替换 module');
    });
    // 退出内层后, 外层 module 仍是 http (runWithModule 不污染外层)
    const outerCtx = getLoggingContext();
    assert(outerCtx?.module === 'http', '[3.3] 内层 runWithModule 不污染外层 module');
  });

  // ─── [4] currentTraceId / currentModule 边界 ───────────────────────
  assert(currentTraceId() === '-', '[4.1] 作用域外 currentTraceId 返 "-"');
  assert(currentModule() === '-', '[4.2] 作用域外 currentModule 返 "-"');
  runWithLoggingContext({ trace_id: 'has-1', module: 'job' }, () => {
    assert(currentTraceId() === 'has-1', '[4.3] 作用域内 currentTraceId');
    assert(currentModule() === 'job', '[4.4] 作用域内 currentModule');
  });
  runWithLoggingContext({}, () => {
    assert(currentTraceId() === '-', '[4.5] context 空 trace_id 字段 → "-"');
    assert(currentModule() === '-', '[4.6] context 空 module 字段 → "-"');
  });

  // ─── [5] extractIncomingTraceId 边界 ───────────────────────────────
  assert(extractIncomingTraceId({}) === null, '[5.1] 缺 header 返 null');
  assert(extractIncomingTraceId({ 'x-request-id': '' }) === null, '[5.2] 空字符串返 null');
  assert(
    extractIncomingTraceId({ 'x-request-id': '   ' }) === null,
    '[5.3] 全空格返 null'
  );
  assert(
    extractIncomingTraceId({ 'x-request-id': 'abc-DEF_123' }) === null,
    '[5.4] 含下划线非法字符返 null (TRACE_ID_REGEX 仅 a-zA-Z0-9-)'
  );
  assert(
    extractIncomingTraceId({ 'x-request-id': 'abc-DEF-123' }) === 'abc-DEF-123',
    '[5.5] 合法 hex+dash 透传'
  );
  assert(
    extractIncomingTraceId({ 'x-trace-id': 'fallback-1' }) === 'fallback-1',
    '[5.6] x-trace-id 备用 header 也识别'
  );
  assert(
    extractIncomingTraceId({ 'x-request-id': 'a'.repeat(200) }) === null,
    '[5.7] 长度超 128 cap 返 null'
  );
  assert(
    extractIncomingTraceId({ 'x-request-id': 'a'.repeat(128) }) === 'a'.repeat(128),
    '[5.8] 长度恰好 128 通过 (边界)'
  );
  assert(
    extractIncomingTraceId({ 'x-request-id': 123 as any }) === null,
    '[5.9] 非字符串 (e.g. 数字) 返 null'
  );

  // ─── [6] requestContextMiddleware 行为 ─────────────────────────────
  const mw = requestContextMiddleware();

  // 6.1: 缺 incoming, 中间件生成新 trace_id 写到 res header + bind 到 ALS
  {
    const reqHeaders: Record<string, string> = {};
    const resHeaders: Record<string, string> = {};
    const fakeReq: any = { headers: reqHeaders };
    const fakeRes: any = { setHeader: (k: string, v: string) => (resHeaders[k] = v) };
    let captured: any = null;
    mw(fakeReq, fakeRes, () => {
      captured = getLoggingContext();
    });
    assert(
      /^[0-9a-f]{32}$/.test(resHeaders[TRACE_ID_HEADER] || ''),
      `[6.1] 缺 incoming, 写新 trace_id 到 res header (got=${resHeaders[TRACE_ID_HEADER]})`
    );
    assert(captured?.trace_id === resHeaders[TRACE_ID_HEADER], '[6.2] ALS context trace_id 与 res header 一致');
    assert(captured?.module === 'http', '[6.3] ALS context module=http');
    assert(fakeReq.trace_id === captured?.trace_id, '[6.4] req.trace_id 同步写入');
  }

  // 6.5: 透传 incoming
  {
    const reqHeaders = { 'x-request-id': 'caller-trace-9' };
    const resHeaders: Record<string, string> = {};
    const fakeReq: any = { headers: reqHeaders };
    const fakeRes: any = { setHeader: (k: string, v: string) => (resHeaders[k] = v) };
    let captured: any = null;
    mw(fakeReq, fakeRes, () => {
      captured = getLoggingContext();
    });
    assert(captured?.trace_id === 'caller-trace-9', '[6.5] 透传 incoming trace_id');
    assert(resHeaders[TRACE_ID_HEADER] === 'caller-trace-9', '[6.6] 透传值回写 res header');
  }

  // 6.7: setHeader throw 不阻塞 next
  {
    const fakeReq: any = { headers: {} };
    const fakeRes: any = {
      setHeader: () => {
        throw new Error('headers sent');
      },
    };
    let nextCalled = false;
    let threw = false;
    try {
      mw(fakeReq, fakeRes, () => {
        nextCalled = true;
      });
    } catch {
      threw = true;
    }
    assert(!threw, '[6.7] setHeader throw 不冒泡 (try/catch 包住)');
    assert(nextCalled, '[6.8] next 仍被调用');
  }

  // ─── [9] AC 主验收: 两个并发请求 trace_id 隔离 ─────────────────────
  {
    const mw2 = requestContextMiddleware();
    const captured: string[] = [];
    const run = (incoming: string) =>
      new Promise<void>(resolve => {
        const fakeReq: any = { headers: { 'x-request-id': incoming } };
        const fakeRes: any = { setHeader: () => undefined };
        mw2(fakeReq, fakeRes, () => {
          // 模拟 service 异步链路读 trace_id
          setImmediate(() => {
            captured.push(currentTraceId());
            resolve();
          });
        });
      });
    await Promise.all([run('req-a-1234'), run('req-b-5678')]);
    assert(captured.includes('req-a-1234'), '[9.1] 并发 req-a trace 正确');
    assert(captured.includes('req-b-5678'), '[9.2] 并发 req-b trace 正确');
    assert(captured.length === 2, '[9.3] 两个独立链路各自落一次');
  }

  // ─── [7] + [8] + [10] winston logger 输出含统一字段 + 不重复 + 仍可被 LogController 正则解析 ──
  {
    const { logger } = require('../../src/utils/logger');
    const winston = require('winston');

    // 装一个内存 transport 抓取输出
    const captured: string[] = [];
    const memoryTransport = new winston.transports.Stream({
      stream: new (require('stream').Writable)({
        write(chunk: Buffer, _enc: string, cb: () => void) {
          captured.push(chunk.toString().trim());
          cb();
        },
      }),
      format: logger.transports[1].format, // 复用 fileFormat
    });
    logger.add(memoryTransport);

    try {
      // [7] 有 context — logger.info 末尾应含 trace_id=xxx module=test
      runWithLoggingContext({ trace_id: 'log-trace-77', module: 'test' }, () => {
        logger.info('hello world');
      });
      // wait microtask for winston async write
      await new Promise(resolve => setTimeout(resolve, 50));
      const withCtx = captured.find(l => l.includes('hello world'));
      assert(!!withCtx, '[7.1] logger.info 输出被 memoryTransport 捕获');
      assert(
        /trace_id=log-trace-77/.test(withCtx || ''),
        `[7.2] 输出含 trace_id=log-trace-77 (got=${withCtx})`
      );
      assert(/module=test/.test(withCtx || ''), `[7.3] 输出含 module=test (got=${withCtx})`);

      // [8] message 已含 trace_id= 不重复追加
      captured.length = 0;
      runWithLoggingContext({ trace_id: 'log-trace-88', module: 'test' }, () => {
        logger.info('manual trace_id=already-set message');
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      const noDupe = captured.find(l => l.includes('manual trace_id='));
      assert(!!noDupe, '[8.1] 输出被捕获');
      // 应该只有一个 trace_id= 出现
      const matches = (noDupe || '').match(/trace_id=/g) || [];
      assert(matches.length === 1, `[8.2] trace_id= 只出现 1 次 (got=${matches.length})`);
      assert(
        !/log-trace-88/.test(noDupe || ''),
        '[8.3] 已含 trace_id= 时不追加 ALS 的 trace_id'
      );

      // [10] LogController 正则解析新格式
      captured.length = 0;
      runWithLoggingContext({ trace_id: 'log-trace-99', module: 'test' }, () => {
        logger.warn('warn message body');
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      const raw = captured.find(l => l.includes('warn message body')) || '';
      const re = /^(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2}[.:]\d+)\s+([a-zA-Z]+):\s+(.*)$/;
      const m = raw.match(re);
      assert(!!m, `[10.1] LogController 正则匹配成功 (raw=${raw})`);
      assert(m?.[2]?.toLowerCase() === 'warn', `[10.2] level=warn (got=${m?.[2]})`);
      assert(/warn message body/.test(m?.[3] || ''), '[10.3] message 段含原 body');
      assert(/trace_id=log-trace-99/.test(m?.[3] || ''), '[10.4] message 段含 trace_id 后缀');
      assert(/module=test/.test(m?.[3] || ''), '[10.5] message 段含 module 后缀');
    } finally {
      logger.remove(memoryTransport);
    }
  }

  // ─── 总结 ──────────────────────────────────────────────────────────
  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`\nFAILURES:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  } else {
    console.log('✓ logging-context (US-097 OPS-008) tests passed.');
    process.exit(0);
  }
})().catch(e => {
  console.error('Unexpected test error:', e);
  process.exit(1);
});
