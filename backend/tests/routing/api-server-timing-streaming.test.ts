/**
 * api-server-timing-streaming.test.ts — ADR-0010 §4.14 · §4.7.2 vertical-of-vertical.
 *
 *   cd backend && npx ts-node --transpile-only tests/routing/api-server-timing-streaming.test.ts
 */
import request from 'supertest';
import express from 'express';
import {
  buildApiServerTimingStreamingMiddleware,
  apiServerTimingStreamingMiddleware,
  CURRENT_STREAMING_CONFIG,
  ServerTimingStreamingConfig,
  ServerTimingStreamAdapter,
  ServerTimingStreamSocket,
  __test__,
} from '../../src/middlewares/apiServerTimingStreaming';

let passed = 0;
let failed = 0;

function assertEq<T>(label: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(label: string, actual: boolean): void {
  if (actual) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}: expected true`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSocket implements ServerTimingStreamSocket {
  public readyState: number = 1;
  public sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

function buildStreamApp(
  config: ServerTimingStreamingConfig | null,
  onHandler: (adapter: ServerTimingStreamAdapter, res: express.Response) => void | Promise<void>,
): express.Express {
  const app = express();
  app.use(buildApiServerTimingStreamingMiddleware(config));
  app.get('/none', (_req, res) => {
    const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
    void onHandler(adapter, res);
    res.status(200).json({ ok: true });
  });
  app.get('/sse', async (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200);
    res.write(':\n\n');
    const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
    await onHandler(adapter, res);
    res.end();
  });
  return app;
}

async function run(): Promise<void> {
  const { isValidMetricName, isValidDur, serializeSseFrame, serializeWsFrame, detectKind, buildNoopAdapter, buildAdapter } = __test__;

  console.log('\n--- (aa) tchar token validator RFC 7230 §3.2.6 ---');
  assertEq('(aa1) plain token', isValidMetricName('db'), true);
  assertEq('(aa2) tchar mix', isValidMetricName("a!#$%&'*+-.^_`|~0-9A-Za-z"), true);
  assertEq('(aa3) empty rejected', isValidMetricName(''), false);
  assertEq('(aa4) space rejected', isValidMetricName('db lookup'), false);
  assertEq('(aa5) semicolon rejected', isValidMetricName('a;b'), false);
  assertEq('(aa6) unicode rejected', isValidMetricName('数据库'), false);
  assertEq('(aa7) undefined rejected', isValidMetricName(undefined), false);
  assertEq('(aa8) number rejected', isValidMetricName(123 as unknown), false);

  console.log('\n--- (ab) dur validator ---');
  assertEq('(ab1) positive', isValidDur(12.5), true);
  assertEq('(ab2) zero', isValidDur(0), true);
  assertEq('(ab3) negative rejected', isValidDur(-1), false);
  assertEq('(ab4) NaN rejected', isValidDur(NaN), false);
  assertEq('(ab5) Infinity rejected', isValidDur(Infinity), false);
  assertEq('(ab6) undefined rejected', isValidDur(undefined), false);
  assertEq('(ab7) string rejected', isValidDur('1' as unknown), false);

  console.log('\n--- (ac) SSE frame HTML5 §9.2 serialization ---');
  assertEq('(ac1) name only', serializeSseFrame('server-timing', 'db', undefined, undefined), 'event: server-timing\ndata: db\n\n');
  assertEq('(ac2) name+dur', serializeSseFrame('server-timing', 'db', 12.5, undefined), 'event: server-timing\ndata: db;dur=12.5\n\n');
  assertEq('(ac3) name+desc', serializeSseFrame('server-timing', 'db', undefined, 'query'), 'event: server-timing\ndata: db;desc="query"\n\n');
  assertEq('(ac4) name+dur+desc', serializeSseFrame('server-timing', 'db', 12.5, 'query'), 'event: server-timing\ndata: db;desc="query";dur=12.5\n\n');
  assertEq('(ac5) desc quote-escape', serializeSseFrame('server-timing', 'db', 1, 'has"quote'), 'event: server-timing\ndata: db;desc="has\\"quote";dur=1\n\n');
  assertEq('(ac6) desc backslash-escape', serializeSseFrame('server-timing', 'db', 1, 'a\\b'), 'event: server-timing\ndata: db;desc="a\\\\b";dur=1\n\n');
  assertEq('(ac7) custom event name', serializeSseFrame('perf', 'db', 5, undefined), 'event: perf\ndata: db;dur=5\n\n');
  assertEq('(ac8) invalid dur dropped', serializeSseFrame('server-timing', 'db', -1, undefined), 'event: server-timing\ndata: db\n\n');

  console.log('\n--- (ad) WebSocket JSON envelope RFC 6455 ---');
  assertEq('(ad1) name only', serializeWsFrame('server-timing', 'db', undefined, undefined), '{"type":"server-timing","name":"db"}');
  assertEq('(ad2) name+dur', serializeWsFrame('server-timing', 'db', 12.5, undefined), '{"type":"server-timing","name":"db","dur":12.5}');
  assertEq('(ad3) name+desc', serializeWsFrame('server-timing', 'db', undefined, 'query'), '{"type":"server-timing","name":"db","desc":"query"}');
  assertEq('(ad4) full', serializeWsFrame('server-timing', 'db', 12.5, 'query'), '{"type":"server-timing","name":"db","dur":12.5,"desc":"query"}');
  assertEq('(ad5) custom type', serializeWsFrame('perf', 'db', 5, undefined), '{"type":"perf","name":"db","dur":5}');
  assertEq('(ad6) desc JSON quote-escape', serializeWsFrame('server-timing', 'db', 1, 'has"q'), '{"type":"server-timing","name":"db","dur":1,"desc":"has\\"q"}');
  assertEq('(ad7) invalid dur dropped', serializeWsFrame('server-timing', 'db', -1, undefined), '{"type":"server-timing","name":"db"}');

  console.log('\n--- (ae) noop adapter default-OFF ---');
  {
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware(null));
    app.get('/n', (_req, res) => {
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('db', 12.5, 'query');
      adapter.start('scope')();
      const stop = adapter.start('other');
      stop();
      stop();
      res.status(200).json({ kind: adapter.kind, count: adapter.count });
    });
    const r = await request(app).get('/n');
    assertEq('(ae1) status', r.status, 200);
    assertEq('(ae2) kind none', r.body.kind, 'none');
    assertEq('(ae3) count 0', r.body.count, 0);
    assertEq('(ae4) no Server-Timing header', r.headers['server-timing'], undefined);
  }
  {
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: false }));
    app.get('/n2', (_req, res) => {
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('db');
      res.status(200).json({ kind: adapter.kind });
    });
    const r = await request(app).get('/n2');
    assertEq('(ae5) enabled=false noop', r.body.kind, 'none');
  }

  console.log('\n--- (af) enabled + non-stream response = kind:none ---');
  {
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/plain', (_req, res) => {
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('db', 5);
      res.status(200).json({ kind: adapter.kind, count: adapter.count });
    });
    const r = await request(app).get('/plain');
    assertEq('(af1) status', r.status, 200);
    assertEq('(af2) kind none', r.body.kind, 'none');
    assertEq('(af3) count 0', r.body.count, 0);
  }

  console.log('\n--- (ag) SSE detection via Content-Type ---');
  {
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/sse', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      res.write(':\n\n');
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('db', 12.5, 'query');
      adapter.emit('cache', 3.1);
      // Idle 5ms so frames are flushed before res.end().
      await delay(5);
      res.end();
    });
    const r = await request(app).get('/sse');
    assertEq('(ag1) status', r.status, 200);
    assertTrue('(ag2) SSE Content-Type', r.headers['content-type'].startsWith('text/event-stream'));
    assertTrue('(ag3) frame db emitted', r.text.includes('event: server-timing\ndata: db;desc="query";dur=12.5\n\n'));
    assertTrue('(ag4) frame cache emitted', r.text.includes('event: server-timing\ndata: cache;dur=3.1\n\n'));
  }

  console.log('\n--- (ah) SSE emit invalid name dropped ---');
  {
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/sse2', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      res.write(':\n\n');
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('bad name');
      adapter.emit('');
      adapter.emit('数据库');
      adapter.emit('valid', 1);
      await delay(5);
      res.end();
    });
    const r = await request(app).get('/sse2');
    assertEq('(ah1) status', r.status, 200);
    assertTrue('(ah2) valid frame present', r.text.includes('event: server-timing\ndata: valid;dur=1\n\n'));
    assertEq('(ah3) invalid names dropped', (r.text.match(/event: server-timing/g) || []).length, 1);
  }

  console.log('\n--- (ai) WebSocket path via res.locals injection ---');
  {
    const ws = new FakeSocket();
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/ws', (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = ws;
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('db', 12.5, 'query');
      adapter.emit('cache', 3.1);
      res.status(200).json({ kind: adapter.kind, count: adapter.count });
    });
    const r = await request(app).get('/ws');
    assertEq('(ai1) status', r.status, 200);
    assertEq('(ai2) kind websocket', r.body.kind, 'websocket');
    assertEq('(ai3) count 2', r.body.count, 2);
    assertEq('(ai4) frame 1', ws.sent[0], '{"type":"server-timing","name":"db","dur":12.5,"desc":"query"}');
    assertEq('(ai5) frame 2', ws.sent[1], '{"type":"server-timing","name":"cache","dur":3.1}');
  }

  console.log('\n--- (aj) WebSocket readyState !== OPEN skipped ---');
  {
    const ws = new FakeSocket();
    ws.readyState = 3;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/ws2', (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = ws;
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('db', 5);
      res.status(200).json({ count: adapter.count });
    });
    const r = await request(app).get('/ws2');
    assertEq('(aj1) count 0', r.body.count, 0);
    assertEq('(aj2) sent 0', ws.sent.length, 0);
  }

  console.log('\n--- (ak) close() idempotent flush + release ---');
  {
    const ws = new FakeSocket();
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/close', (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = ws;
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('a', 1);
      adapter.close();
      adapter.close();
      adapter.emit('b', 2);
      res.status(200).json({ count: adapter.count });
    });
    const r = await request(app).get('/close');
    assertEq('(ak1) count 1', r.body.count, 1);
    assertEq('(ak2) sent 1', ws.sent.length, 1);
    assertEq('(ak3) only a emitted', ws.sent[0], '{"type":"server-timing","name":"a","dur":1}');
  }

  console.log('\n--- (al) emitAsync WebSocket ns-precision monotonic clock ---');
  {
    const ws = new FakeSocket();
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/emitAsync', async (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = ws;
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      const result = await adapter.emitAsync('db', delay(10).then(() => 'ok'), 'query');
      res.status(200).json({ result, count: adapter.count });
    });
    const r = await request(app).get('/emitAsync');
    assertEq('(al1) result', r.body.result, 'ok');
    assertEq('(al2) count 1', r.body.count, 1);
    const parsed = JSON.parse(ws.sent[0]) as { type: string; name: string; dur: number; desc: string };
    assertEq('(al3) type', parsed.type, 'server-timing');
    assertEq('(al4) name', parsed.name, 'db');
    assertEq('(al5) desc', parsed.desc, 'query');
    assertTrue('(al6) dur >= 8ms', parsed.dur >= 8);
    assertTrue('(al7) dur < 500ms', parsed.dur < 500);
  }

  console.log('\n--- (am) emitAsync rethrows + still emits ---');
  {
    const ws = new FakeSocket();
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/reject', async (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = ws;
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      let caught: string | null = null;
      try {
        await adapter.emitAsync('op', delay(5).then(() => { throw new Error('boom'); }));
      } catch (err) {
        caught = (err as Error).message;
      }
      res.status(200).json({ caught, count: adapter.count });
    });
    const r = await request(app).get('/reject');
    assertEq('(am1) caught', r.body.caught, 'boom');
    assertEq('(am2) count 1', r.body.count, 1);
  }

  console.log('\n--- (an) start() scope-scoped + idempotent ---');
  {
    const ws = new FakeSocket();
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/scope', async (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = ws;
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      const stop1 = adapter.start('scope1', 'first');
      const stop2 = adapter.start('scope2');
      await delay(5);
      stop1();
      stop1();
      stop2();
      res.status(200).json({ count: adapter.count });
    });
    const r = await request(app).get('/scope');
    assertEq('(an1) count 2', r.body.count, 2);
    assertEq('(an2) sent 2', ws.sent.length, 2);
    const p1 = JSON.parse(ws.sent[0]) as { name: string; dur: number };
    assertEq('(an3) scope1 name', p1.name, 'scope1');
    assertTrue('(an4) scope1 dur >= 3ms', p1.dur >= 3);
  }

  console.log('\n--- (ao) invalid emitAsync name still awaits promise ---');
  {
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/badname', async (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = new FakeSocket();
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      const result = await adapter.emitAsync('bad name', delay(3).then(() => 'ok'));
      res.status(200).json({ result, count: adapter.count });
    });
    const r = await request(app).get('/badname');
    assertEq('(ao1) result preserved', r.body.result, 'ok');
    assertEq('(ao2) count 0', r.body.count, 0);
  }

  console.log('\n--- (ap) SSE custom event name from config ---');
  {
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, sse_event_name: 'perf-metric' }));
    app.get('/sse3', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      res.write(':\n\n');
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('db', 12.5);
      await delay(5);
      res.end();
    });
    const r = await request(app).get('/sse3');
    assertTrue('(ap1) custom event name', r.text.includes('event: perf-metric\n'));
  }

  console.log('\n--- (aq) WebSocket custom frame type from config ---');
  {
    const ws = new FakeSocket();
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, ws_frame_type: 'timing.metric' }));
    app.get('/ws3', (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = ws;
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('db', 12.5);
      res.status(200).json({ ok: true });
    });
    await request(app).get('/ws3');
    const parsed = JSON.parse(ws.sent[0]) as { type: string };
    assertEq('(aq1) custom frame type', parsed.type, 'timing.metric');
  }

  console.log('\n--- (ar) invalid custom names fall back to defaults ---');
  {
    const ws = new FakeSocket();
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      sse_event_name: 'bad name',
      ws_frame_type: 'bad;type',
    }));
    app.get('/ws-fb', (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = ws;
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('db', 1);
      res.status(200).json({ ok: true });
    });
    await request(app).get('/ws-fb');
    const parsed = JSON.parse(ws.sent[0]) as { type: string };
    assertEq('(ar1) ws fallback to server-timing', parsed.type, 'server-timing');
  }

  console.log('\n--- (as) detectKind unit ---');
  {
    const mockRes = {
      locals: {},
      getHeader() { return undefined; },
    } as unknown as express.Response;
    assertEq('(as1) empty → none', detectKind(mockRes), 'none');
  }
  {
    const mockRes = {
      locals: { serverTimingStreamWebSocket: new FakeSocket() },
      getHeader() { return undefined; },
    } as unknown as express.Response;
    assertEq('(as2) ws local → websocket', detectKind(mockRes), 'websocket');
  }
  {
    const mockRes = {
      locals: {},
      getHeader(_k: string) { return 'text/event-stream; charset=utf-8'; },
    } as unknown as express.Response;
    assertEq('(as3) sse Content-Type → sse', detectKind(mockRes), 'sse');
  }
  {
    const mockRes = {
      locals: {},
      getHeader(_k: string) { return ['text/event-stream']; },
    } as unknown as express.Response;
    assertEq('(as4) array Content-Type → sse', detectKind(mockRes), 'sse');
  }
  {
    const mockRes = {
      locals: {},
      getHeader(_k: string) { return 'application/json'; },
    } as unknown as express.Response;
    assertEq('(as5) json Content-Type → none', detectKind(mockRes), 'none');
  }

  console.log('\n--- (at) factory + CURRENT_STREAMING_CONFIG surface ---');
  {
    const mw = apiServerTimingStreamingMiddleware();
    assertTrue('(at1) factory returns function', typeof mw === 'function');
    assertTrue('(at2) factory arity 3', mw.length === 3);
    // pkg.json currently declares enabled:false so config is present but adapter is noop.
    assertTrue(
      '(at3) CURRENT_STREAMING_CONFIG shape',
      CURRENT_STREAMING_CONFIG === null || typeof CURRENT_STREAMING_CONFIG === 'object',
    );
  }

  console.log('\n--- (au) buildNoopAdapter surface ---');
  {
    const noop = buildNoopAdapter();
    assertEq('(au1) kind', noop.kind, 'none');
    assertEq('(au2) count 0', noop.count, 0);
    noop.emit('x', 1);
    assertEq('(au3) count still 0 after emit', noop.count, 0);
    const p = noop.emitAsync('op', Promise.resolve(42));
    const val = await p;
    assertEq('(au4) noop emitAsync pass-through', val, 42);
    const stop = noop.start('scope');
    stop();
    stop();
    noop.close();
    noop.close();
    assertEq('(au5) count still 0', noop.count, 0);
  }

  console.log('\n--- (av) app-level integration: parallel SSE + WS + noop paths ---');
  {
    const ws = new FakeSocket();
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/x-ws', (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = ws;
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('w', 1);
      res.status(200).json({ kind: adapter.kind });
    });
    app.get('/x-sse', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      res.write(':\n\n');
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('s', 1);
      await delay(3);
      res.end();
    });
    app.get('/x-none', (_req, res) => {
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('n', 1);
      res.status(200).json({ kind: adapter.kind, count: adapter.count });
    });
    const [rw, rs, rn] = await Promise.all([
      request(app).get('/x-ws'),
      request(app).get('/x-sse'),
      request(app).get('/x-none'),
    ]);
    assertEq('(av1) ws kind', rw.body.kind, 'websocket');
    assertTrue('(av2) sse frame', rs.text.includes('event: server-timing\ndata: s;dur=1\n\n'));
    assertEq('(av3) none kind', rn.body.kind, 'none');
    assertEq('(av4) none count 0', rn.body.count, 0);
    assertEq('(av5) ws sent 1', ws.sent.length, 1);
  }

  console.log('\n--- (aw) adapter surface parity assert (kind/count getter semantics) ---');
  {
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/surface', (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = new FakeSocket();
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      const beforeKind = adapter.kind;
      const beforeCount = adapter.count;
      adapter.emit('a', 1);
      adapter.emit('b', 2);
      res.status(200).json({
        beforeKind,
        beforeCount,
        afterKind: adapter.kind,
        afterCount: adapter.count,
      });
    });
    const r = await request(app).get('/surface');
    assertEq('(aw1) kind stable', r.body.afterKind, r.body.beforeKind);
    assertEq('(aw2) beforeCount 0', r.body.beforeCount, 0);
    assertEq('(aw3) afterCount 2', r.body.afterCount, 2);
  }

  console.log('\n--- (ax) fail-OPEN on WebSocket send throw ---');
  {
    class ThrowSocket implements ServerTimingStreamSocket {
      readyState = 1;
      send(_data: string): void { throw new Error('sink broken'); }
    }
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true }));
    app.get('/throw', (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = new ThrowSocket();
      const adapter = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      adapter.emit('a', 1);
      adapter.emit('b', 2);
      res.status(200).json({ count: adapter.count });
    });
    const r = await request(app).get('/throw');
    assertEq('(ax1) status 200', r.status, 200);
    assertEq('(ax2) count 0 after fail-OPEN', r.body.count, 0);
  }

  console.log('\n=================================');
  console.log(`PASS: ${passed}`);
  console.log(`FAIL: ${failed}`);
  console.log('=================================');
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
