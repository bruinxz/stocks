/**
 * logging-context-api-version.test.ts — ADR-0010 §4.2 · Phase 2 · request/response
 * log 对携带 api_version 字段. 断言 requestContextMiddleware 把
 * CURRENT_API_VERSION 通过 AsyncLocalStorage 传给 downstream logger.
 *
 * 不依赖 jest · 与 backend/src/scripts/run-tests.ts 约定一致:
 *   cd backend && npx ts-node --transpile-only tests/routing/logging-context-api-version.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  currentApiVersion,
  currentModule,
  currentTraceId,
  runWithLoggingContext,
  runWithModule,
  getLoggingContext,
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

(async () => {
  // (a) 未 run 时 currentApiVersion() 返 '-' fallback (与 currentTraceId / currentModule 语义对称).
  assertEq('currentApiVersion() outside ALS run = "-"', currentApiVersion(), '-');

  // (b) 显式 runWithLoggingContext 注入 api_version 后 currentApiVersion() 返注入值.
  const capturedInsideRun = runWithLoggingContext(
    { trace_id: 'trace-abc', module: 'http', api_version: '1.0' },
    () => ({
      trace: currentTraceId(),
      module: currentModule(),
      api: currentApiVersion(),
    }),
  );
  assertEq('runWithLoggingContext propagates api_version', capturedInsideRun.api, '1.0');
  assertEq('runWithLoggingContext propagates trace_id', capturedInsideRun.trace, 'trace-abc');
  assertEq('runWithLoggingContext propagates module', capturedInsideRun.module, 'http');

  // (c) runWithModule 继承 api_version + trace_id, 仅覆盖 module (ADR-0010 §4.2 cron / dispatcher
  //     场景 · 子作用域仍带同一 API 契约版本).
  const inherited = runWithLoggingContext(
    { trace_id: 'trace-xyz', module: 'http', api_version: '1.0' },
    () =>
      runWithModule('scheduler', () => ({
        trace: currentTraceId(),
        module: currentModule(),
        api: currentApiVersion(),
      })),
  );
  assertEq('runWithModule preserves api_version', inherited.api, '1.0');
  assertEq('runWithModule preserves trace_id', inherited.trace, 'trace-xyz');
  assertEq('runWithModule overrides module', inherited.module, 'scheduler');

  // (d) requestContextMiddleware 通过 HTTP 请求把 api_version 注入 ALS.
  //     用 supertest + inline express app 隔离测 middleware · downstream handler 里
  //     调 currentApiVersion() 应拿到 CURRENT_API_VERSION.
  const app = express();
  app.use(requestContextMiddleware());
  app.get('/echo-ctx', (_req, res) => {
    const ctx = getLoggingContext() ?? {};
    res.json({
      trace_id: ctx.trace_id ?? '-',
      module: ctx.module ?? '-',
      api_version: ctx.api_version ?? '-',
      // 通过 helper 拿也应等价.
      api_via_helper: currentApiVersion(),
    });
  });

  const res = await request(app).get('/echo-ctx');
  assertEq('/echo-ctx status = 200', res.status, 200);
  assertEq(
    '/echo-ctx ctx.module = "http"',
    res.body.module,
    'http',
  );
  assertEq(
    '/echo-ctx ctx.api_version = CURRENT_API_VERSION',
    res.body.api_version,
    CURRENT_API_VERSION,
  );
  assertEq(
    '/echo-ctx currentApiVersion() helper = CURRENT_API_VERSION',
    res.body.api_via_helper,
    CURRENT_API_VERSION,
  );
  assertTrue(
    '/echo-ctx ctx.trace_id present (non-"-")',
    typeof res.body.trace_id === 'string' && res.body.trace_id !== '-' && res.body.trace_id.length > 0,
    `got trace_id=${res.body.trace_id}`,
  );

  console.log(`\n=== logging-context-api-version: ${passed} pass / ${failed} fail ===`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
