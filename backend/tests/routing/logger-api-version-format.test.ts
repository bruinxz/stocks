/**
 * logger-api-version-format.test.ts — ADR-0010 §4.2 Phase 2 · winston format 输出
 * 末尾追加 `api_version=<x>` 后缀. 断言 appendContext hook 把 currentApiVersion()
 * 结果拼进 message 尾部, 与 trace_id / module 语义完全对称.
 *
 * 不依赖 jest · 与 backend/src/scripts/run-tests.ts 约定一致:
 *   cd backend && npx ts-node --transpile-only tests/routing/logger-api-version-format.test.ts
 *
 * 测试隔离: 用 winston.transports.Stream 把输出转 in-memory buffer, 不写实盘.
 */
import winston from 'winston';
import { Writable } from 'stream';
import request from 'supertest';
import express from 'express';
import {
  currentApiVersion,
  runWithLoggingContext,
  runWithModule,
} from '../../src/utils/loggingContext';
import { requestContextMiddleware } from '../../src/middlewares/requestContext';
import { CURRENT_API_VERSION } from '../../src/middlewares/apiVersion';

let passed = 0;
let failed = 0;

function assertEq<T>(label: string, actual: T, expected: T): void {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}\n    expected: ${String(expected)}\n    actual:   ${String(actual)}`);
  }
}

function assertTrue(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? `\n    ${detail}` : ''}`);
  }
}

/**
 * 构一个 in-memory logger, format 与 production logger.ts 里 `appendContext` +
 * printf 完全同源 — 只是 sink 换成 buffer 而非 file/stdout. 这样能纯 unit-test
 * appendContext 行为而不依赖 runtime file system.
 */
function buildInMemoryLogger(): { logger: winston.Logger; buf: () => string } {
  let captured = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      captured += chunk.toString();
      cb();
    },
  });

  const appendContext = winston.format(info => {
    const msg = String(info.message ?? '');
    if (!/trace_id=/.test(msg)) {
      // 同源 import — 与 production 逻辑一致.
      const { currentTraceId, currentModule, currentApiVersion: cav } = require('../../src/utils/loggingContext');
      info.message = `${msg} trace_id=${currentTraceId()} module=${currentModule()} api_version=${cav()}`;
    }
    return info;
  });

  const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
      appendContext(),
      winston.format.printf(info => `${info.level}: ${info.message}`),
    ),
    transports: [new winston.transports.Stream({ stream: sink })],
  });

  return { logger, buf: () => captured };
}

(async () => {
  // (a) 无 ALS 时 currentApiVersion() 返 '-', logger 输出末尾 `api_version=-`.
  {
    const { logger, buf } = buildInMemoryLogger();
    logger.info('hello');
    // winston async flush — 等一 tick 让 stream write 完成.
    await new Promise(resolve => setImmediate(resolve));
    const out = buf();
    assertTrue(
      'no-ALS: logger.info output has api_version=- suffix',
      /api_version=-/.test(out),
      `got: ${out.trim()}`,
    );
    assertTrue(
      'no-ALS: also has trace_id=- module=- (对称 fail-OPEN)',
      /trace_id=-/.test(out) && /module=-/.test(out),
      `got: ${out.trim()}`,
    );
  }

  // (b) runWithLoggingContext 注入 api_version 后 logger 输出携注入值.
  {
    const { logger, buf } = buildInMemoryLogger();
    runWithLoggingContext(
      { trace_id: 'trace-abc', module: 'http', api_version: '1.0' },
      () => logger.info('inside-run'),
    );
    await new Promise(resolve => setImmediate(resolve));
    const out = buf();
    assertTrue(
      'runWithLoggingContext: api_version=1.0 suffix present',
      /api_version=1\.0/.test(out),
      `got: ${out.trim()}`,
    );
    assertTrue(
      'runWithLoggingContext: trace_id=trace-abc + module=http 一致',
      /trace_id=trace-abc/.test(out) && /module=http/.test(out),
      `got: ${out.trim()}`,
    );
  }

  // (c) runWithModule 继承外层 api_version (§4.2 canonical: cron / dispatcher 子作用域
  //     仍带同一个 API 契约版本).
  {
    const { logger, buf } = buildInMemoryLogger();
    runWithLoggingContext(
      { trace_id: 'trace-xyz', module: 'http', api_version: '1.0' },
      () => runWithModule('scheduler', () => logger.info('sched-tick')),
    );
    await new Promise(resolve => setImmediate(resolve));
    const out = buf();
    assertTrue(
      'runWithModule inherits api_version=1.0',
      /api_version=1\.0/.test(out),
      `got: ${out.trim()}`,
    );
    assertTrue(
      'runWithModule overrides module=scheduler + preserves trace_id',
      /module=scheduler/.test(out) && /trace_id=trace-xyz/.test(out),
      `got: ${out.trim()}`,
    );
  }

  // (d) 已含 trace_id= 的 msg 不重复追加 (幂等 gate · 与 production 语义一致).
  {
    const { logger, buf } = buildInMemoryLogger();
    runWithLoggingContext(
      { trace_id: 'trace-A', module: 'http', api_version: '1.0' },
      () => logger.info('pre-fmt trace_id=custom-xyz module=biz api_version=9.9'),
    );
    await new Promise(resolve => setImmediate(resolve));
    const out = buf();
    // 应保留 caller 手写值, 不追加第二个 api_version=1.0.
    assertTrue(
      'idempotent: caller-provided trace_id=custom-xyz retained',
      /trace_id=custom-xyz/.test(out),
      `got: ${out.trim()}`,
    );
    assertTrue(
      'idempotent: caller-provided api_version=9.9 retained (no re-append)',
      /api_version=9\.9/.test(out) && !/api_version=1\.0/.test(out),
      `got: ${out.trim()}`,
    );
  }

  // (e) HTTP roundtrip — requestContextMiddleware 注入 CURRENT_API_VERSION, handler
  //     内调 logger.info 输出后缀应含 CURRENT_API_VERSION.
  {
    const { logger, buf } = buildInMemoryLogger();
    const app = express();
    app.use(requestContextMiddleware());
    app.get('/log-echo', (_req, res) => {
      logger.info('handler-tick');
      res.json({ ok: true, api: currentApiVersion() });
    });
    const res = await request(app).get('/log-echo');
    await new Promise(resolve => setImmediate(resolve));
    assertEq('/log-echo status = 200', res.status, 200);
    assertEq('/log-echo body.api = CURRENT_API_VERSION', res.body.api, CURRENT_API_VERSION);
    const out = buf();
    const expectedPattern = new RegExp(
      `api_version=${CURRENT_API_VERSION.replace(/\./g, '\\.')}`,
    );
    assertTrue(
      '/log-echo logger output has api_version=CURRENT_API_VERSION suffix',
      expectedPattern.test(out),
      `expected pattern ${expectedPattern} · got: ${out.trim()}`,
    );
    assertTrue(
      '/log-echo logger output has non-"-" trace_id (middleware-generated)',
      /trace_id=[A-Za-z0-9-]{1,128}/.test(out) && !/trace_id=- /.test(out),
      `got: ${out.trim()}`,
    );
  }

  // (f) fmt 结构 sanity: `${level}: ${msg}` 头段仍能被简单正则解析
  //     (与 production printf `${ts} ${level}: ${msg}` 语义对齐 · LogController 正则
  //     解析头段不受影响).
  {
    const { logger, buf } = buildInMemoryLogger();
    logger.info('sanity');
    await new Promise(resolve => setImmediate(resolve));
    const out = buf().trim();
    assertTrue(
      'fmt: line starts with `info: sanity` prefix (level + msg intact)',
      out.startsWith('info: sanity'),
      `got: ${out}`,
    );
    assertTrue(
      'fmt: suffix order = trace_id → module → api_version',
      /trace_id=\S+ module=\S+ api_version=\S+$/.test(out),
      `got: ${out}`,
    );
  }

  console.log(`\n=== logger-api-version-format: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
