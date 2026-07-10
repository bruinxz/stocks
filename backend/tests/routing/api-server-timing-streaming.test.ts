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

  // -----------------------------------------------------------------------
  // §4.7.2.1 · SSE keep-alive heartbeat sub-vertical (HTML5 §9.2.6
  // comment-frame). Scenarios ay-bj cover the pure-emit primitive
  // (serializeSseHeartbeat), the sanitize primitive, the interval
  // validator, the sendHeartbeat + startHeartbeat handler surface, the
  // heartbeatCount getter, the fail-OPEN 4-axis silent-drop, timer unref,
  // idempotent stop-fn, and res.on('close') auto-cleanup.
  // -----------------------------------------------------------------------

  const {
    serializeSseHeartbeat,
    sanitizeHeartbeatComment,
    isValidHeartbeatInterval,
  } = __test__;

  console.log('\n--- (ay) serializeSseHeartbeat produces HTML5 §9.2.6 comment-frame ---');
  {
    assertEq('(ay1) default keep-alive', serializeSseHeartbeat('keep-alive'), ': keep-alive\n\n');
    assertEq('(ay2) empty comment yields ": \\n\\n"', serializeSseHeartbeat(''), ': \n\n');
    assertEq('(ay3) trailing \\n\\n present', serializeSseHeartbeat('x').endsWith('\n\n'), true);
    assertEq('(ay4) leading ": " present', serializeSseHeartbeat('x').startsWith(': '), true);
    assertEq('(ay5) alphanumeric comment', serializeSseHeartbeat('hb1'), ': hb1\n\n');
  }

  console.log('\n--- (az) sanitizeHeartbeatComment strips CR/LF and rejects non-string ---');
  {
    assertEq('(az1) plain passthrough', sanitizeHeartbeatComment('keep-alive'), 'keep-alive');
    assertEq('(az2) CR stripped', sanitizeHeartbeatComment('a\rb'), 'ab');
    assertEq('(az3) LF stripped', sanitizeHeartbeatComment('a\nb'), 'ab');
    assertEq('(az4) CRLF stripped', sanitizeHeartbeatComment('a\r\nb'), 'ab');
    assertEq('(az5) whitespace-only defaults', sanitizeHeartbeatComment('   '), 'keep-alive');
    assertEq('(az6) empty defaults', sanitizeHeartbeatComment(''), 'keep-alive');
    assertEq('(az7) number rejected → default', sanitizeHeartbeatComment(42 as unknown), 'keep-alive');
    assertEq('(az8) null rejected → default', sanitizeHeartbeatComment(null as unknown), 'keep-alive');
    assertEq('(az9) undefined rejected → default', sanitizeHeartbeatComment(undefined as unknown), 'keep-alive');
    assertEq('(az10) object rejected → default', sanitizeHeartbeatComment({} as unknown), 'keep-alive');
  }

  console.log('\n--- (ba) isValidHeartbeatInterval validator ---');
  {
    assertEq('(ba1) 30000 valid', isValidHeartbeatInterval(30000), true);
    assertEq('(ba2) 1 valid', isValidHeartbeatInterval(1), true);
    assertEq('(ba3) 0 rejected', isValidHeartbeatInterval(0), false);
    assertEq('(ba4) negative rejected', isValidHeartbeatInterval(-1), false);
    assertEq('(ba5) NaN rejected', isValidHeartbeatInterval(NaN), false);
    assertEq('(ba6) Infinity rejected', isValidHeartbeatInterval(Infinity), false);
    assertEq('(ba7) string rejected', isValidHeartbeatInterval('30000' as unknown), false);
    assertEq('(ba8) null rejected', isValidHeartbeatInterval(null as unknown), false);
    assertEq('(ba9) undefined rejected', isValidHeartbeatInterval(undefined as unknown), false);
  }

  console.log('\n--- (bb) heartbeat default-OFF · sendHeartbeat no-op when disabled ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = buildStreamApp({ enabled: true }, (adapter) => {
      captured = adapter;
    });
    const r = await request(app).get('/sse');
    captured.sendHeartbeat();
    captured.sendHeartbeat();
    assertEq('(bb1) status 200', r.status, 200);
    assertEq('(bb2) heartbeatCount 0 (disabled default-OFF)', captured.heartbeatCount, 0);
  }

  console.log('\n--- (bc) heartbeat enabled · SSE sendHeartbeat writes comment-frame ---');
  {
    const chunks: string[] = [];
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      heartbeat_enabled: true,
      heartbeat_comment: 'keep-alive',
    }));
    app.get('/sse-hb', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      const origWrite = res.write.bind(res);
      (res as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => {
        chunks.push(String(chunk));
        return origWrite(chunk as string);
      };
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.sendHeartbeat();
      captured.sendHeartbeat();
      res.end();
    });
    const r = await request(app).get('/sse-hb');
    assertEq('(bc1) status 200', r.status, 200);
    assertEq('(bc2) heartbeatCount 2', captured.heartbeatCount, 2);
    assertTrue('(bc3) at least one comment-frame captured', chunks.some((c) => c === ': keep-alive\n\n'));
  }

  console.log('\n--- (bd) heartbeat WS-kind no-op (comment-frame is SSE-only) ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      heartbeat_enabled: true,
    }));
    app.get('/ws-hb', (_req, res) => {
      (res.locals as Record<string, unknown>).serverTimingStreamWebSocket = new FakeSocket();
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.sendHeartbeat();
      captured.sendHeartbeat();
      res.status(200).json({ kind: captured.kind, heartbeatCount: captured.heartbeatCount });
    });
    const r = await request(app).get('/ws-hb');
    assertEq('(bd1) kind websocket', r.body.kind, 'websocket');
    assertEq('(bd2) heartbeatCount 0 on WS (SSE-only)', r.body.heartbeatCount, 0);
  }

  console.log('\n--- (be) heartbeat none-kind no-op (JSON response path) ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      heartbeat_enabled: true,
    }));
    app.get('/none-hb', (_req, res) => {
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.sendHeartbeat();
      res.status(200).json({ kind: captured.kind, heartbeatCount: captured.heartbeatCount });
    });
    const r = await request(app).get('/none-hb');
    assertEq('(be1) kind none', r.body.kind, 'none');
    assertEq('(be2) heartbeatCount 0 on none', r.body.heartbeatCount, 0);
  }

  console.log('\n--- (bf) heartbeat disabled explicit false · no-op ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = buildStreamApp({ enabled: true, heartbeat_enabled: false }, (adapter) => {
      captured = adapter;
      adapter.sendHeartbeat();
    });
    const r = await request(app).get('/sse');
    assertEq('(bf1) status 200', r.status, 200);
    assertEq('(bf2) heartbeatCount 0 disabled', captured.heartbeatCount, 0);
  }

  console.log('\n--- (bg) startHeartbeat returns idempotent stop-fn (disabled path) ---');
  {
    let stopA!: () => void;
    let stopB!: () => void;
    let captured!: ServerTimingStreamAdapter;
    const app = buildStreamApp({ enabled: true }, (adapter) => {
      captured = adapter;
      stopA = adapter.startHeartbeat();
      stopB = adapter.startHeartbeat();
    });
    await request(app).get('/sse');
    assertEq('(bg1) startHeartbeat returns function A', typeof stopA, 'function');
    assertEq('(bg2) startHeartbeat returns function B', typeof stopB, 'function');
    stopA();
    stopA();
    stopB();
    assertEq('(bg3) heartbeatCount 0 disabled path', captured.heartbeatCount, 0);
  }

  console.log('\n--- (bh) startHeartbeat enabled · sets interval · unref-safe · idempotent stop ---');
  {
    let captured!: ServerTimingStreamAdapter;
    let stop!: () => void;
    let afterStop = 0;
    let afterQuiet = 0;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      heartbeat_enabled: true,
      heartbeat_interval_ms: 20,
    }));
    app.get('/sse-timer', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      stop = captured.startHeartbeat();
      await delay(70);
      stop();
      afterStop = captured.heartbeatCount;
      await delay(40);
      afterQuiet = captured.heartbeatCount;
      res.end();
    });
    await request(app).get('/sse-timer');
    assertTrue('(bh1) at least 1 heartbeat fired', afterStop >= 1);
    assertEq('(bh2) stop-fn halts timer', afterQuiet, afterStop);
    stop();
    assertTrue('(bh3) idempotent stop safe', true);
  }

  console.log('\n--- (bi) close() clears timer · sendHeartbeat post-close no-op ---');
  {
    let captured!: ServerTimingStreamAdapter;
    let beforeClose = 0;
    let postClose1 = 0;
    let postClose2 = 0;
    let afterQuiet = 0;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      heartbeat_enabled: true,
      heartbeat_interval_ms: 15,
    }));
    app.get('/sse-close', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.startHeartbeat();
      await delay(40);
      beforeClose = captured.heartbeatCount;
      captured.close();
      postClose1 = captured.heartbeatCount;
      captured.sendHeartbeat();
      postClose2 = captured.heartbeatCount;
      await delay(40);
      afterQuiet = captured.heartbeatCount;
      res.end();
    });
    await request(app).get('/sse-close');
    assertTrue('(bi1) beforeClose ≥1', beforeClose >= 1);
    assertEq('(bi2) close snapshot equals beforeClose', postClose1, beforeClose);
    assertEq('(bi3) sendHeartbeat post-close no-op', postClose2, beforeClose);
    assertEq('(bi4) quiet post-close (timer cleared)', afterQuiet, beforeClose);
  }

  console.log('\n--- (bj) buildNoopAdapter heartbeat surface complete ---');
  {
    const noop = __test__.buildNoopAdapter();
    assertEq('(bj1) noop.heartbeatCount 0', noop.heartbeatCount, 0);
    assertEq('(bj2) noop.sendHeartbeat callable', typeof noop.sendHeartbeat, 'function');
    assertEq('(bj3) noop.startHeartbeat returns fn', typeof noop.startHeartbeat(), 'function');
    noop.sendHeartbeat();
    const stop = noop.startHeartbeat();
    stop();
    stop();
    assertEq('(bj4) noop.heartbeatCount stays 0', noop.heartbeatCount, 0);
  }

  console.log('\n--- (bk) §4.7.2.2 · resume-config validators + header-name sanitize ---');
  {
    const { isValidResumeHistorySize, sanitizeResumeHeaderName, getLastEventIdFromHeader } = __test__;
    assertEq('(bk1) size 100', isValidResumeHistorySize(100), true);
    assertEq('(bk2) size 1', isValidResumeHistorySize(1), true);
    assertEq('(bk3) size 0 rejected', isValidResumeHistorySize(0), false);
    assertEq('(bk4) size -1 rejected', isValidResumeHistorySize(-1), false);
    assertEq('(bk5) size NaN rejected', isValidResumeHistorySize(NaN), false);
    assertEq('(bk6) size 1.5 rejected', isValidResumeHistorySize(1.5), false);
    assertEq('(bk7) size undef rejected', isValidResumeHistorySize(undefined), false);
    assertEq('(bk8) name default when undef', sanitizeResumeHeaderName(undefined), 'Last-Event-ID');
    assertEq('(bk9) name default when empty', sanitizeResumeHeaderName(''), 'Last-Event-ID');
    assertEq('(bk10) name default when non-token', sanitizeResumeHeaderName('bad name'), 'Last-Event-ID');
    assertEq('(bk11) name custom token accepted', sanitizeResumeHeaderName('X-Resume-Id'), 'X-Resume-Id');
  }
  {
    const { getLastEventIdFromHeader } = __test__;
    assertEq('(bk12) header lower-case lookup',
      getLastEventIdFromHeader({ headers: { 'last-event-id': 'abc123' } }, 'Last-Event-ID'), 'abc123');
    assertEq('(bk13) header exact-case fallback',
      getLastEventIdFromHeader({ headers: { 'Last-Event-ID': 'abc123' } as unknown as Record<string, string> }, 'Last-Event-ID'), 'abc123');
    assertEq('(bk14) missing → null',
      getLastEventIdFromHeader({ headers: {} }, 'Last-Event-ID'), null);
    assertEq('(bk15) empty-string → null',
      getLastEventIdFromHeader({ headers: { 'last-event-id': '' } }, 'Last-Event-ID'), null);
    assertEq('(bk16) non-token → null',
      getLastEventIdFromHeader({ headers: { 'last-event-id': 'a b c' } }, 'Last-Event-ID'), null);
    assertEq('(bk17) array first element',
      getLastEventIdFromHeader({ headers: { 'last-event-id': ['xy1', 'xy2'] } }, 'Last-Event-ID'), 'xy1');
    assertEq('(bk18) no headers obj → null',
      getLastEventIdFromHeader({} as { headers?: Record<string, string> }, 'Last-Event-ID'), null);
    assertEq('(bk19) custom header name',
      getLastEventIdFromHeader({ headers: { 'x-resume-id': 'zz' } }, 'X-Resume-Id'), 'zz');
  }

  console.log('\n--- (bl) §4.7.2.2 · serializeSseFrame with id emits id-line first ---');
  {
    const f = serializeSseFrame('server-timing', 'db', 12.5, 'query', 'abc123');
    assertEq('(bl1) id-line first', f, 'id: abc123\nevent: server-timing\ndata: db;desc="query";dur=12.5\n\n');
    const f2 = serializeSseFrame('server-timing', 'db', undefined, undefined, 'id42');
    assertEq('(bl2) id + name only', f2, 'id: id42\nevent: server-timing\ndata: db\n\n');
    const f3 = serializeSseFrame('server-timing', 'db', 1, undefined, '');
    assertEq('(bl3) empty id dropped', f3, 'event: server-timing\ndata: db;dur=1\n\n');
    const f4 = serializeSseFrame('server-timing', 'db', 1, undefined, 'bad id');
    assertEq('(bl4) non-token id dropped', f4, 'event: server-timing\ndata: db;dur=1\n\n');
    const f5 = serializeSseFrame('server-timing', 'db', 1, undefined, undefined);
    assertEq('(bl5) undefined id backwards-compat', f5, 'event: server-timing\ndata: db;dur=1\n\n');
  }

  console.log('\n--- (bm) §4.7.2.2 · adapter.emit(id) advances lastEventId + fills ring-buffer ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const chunks: string[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      resume_enabled: true,
      resume_history_size: 3,
    }));
    app.get('/sse-r', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      const origWrite = res.write.bind(res);
      (res as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
        chunks.push(typeof c === 'string' ? c : String(c));
        return origWrite(c as string);
      };
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1, undefined, 'id1');
      captured.emit('b', 2, undefined, 'id2');
      captured.emit('c', 3, undefined, 'id3');
      captured.emit('d', 4, undefined, 'id4');
      res.end();
    });
    await request(app).get('/sse-r');
    assertEq('(bm1) lastEventId is id4', captured.lastEventId, 'id4');
    assertEq('(bm2) count 4', captured.count, 4);
    const withIdLines = chunks.filter((c) => c.startsWith('id: '));
    assertEq('(bm3) 4 id-lines emitted', withIdLines.length, 4);
  }

  console.log('\n--- (bn) §4.7.2.2 · emit without id keeps lastEventId unchanged ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      resume_enabled: true,
    }));
    app.get('/sse-mixed', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1);
      assertEq('(bn1) lastEventId null pre-id', captured.lastEventId, null);
      captured.emit('b', 2, undefined, 'id1');
      assertEq('(bn2) lastEventId id1', captured.lastEventId, 'id1');
      captured.emit('c', 3);
      assertEq('(bn3) lastEventId still id1 after no-id emit', captured.lastEventId, 'id1');
      captured.emit('d', 4, undefined, 'bad id');
      assertEq('(bn4) lastEventId still id1 after non-token id', captured.lastEventId, 'id1');
      res.end();
    });
    await request(app).get('/sse-mixed');
    assertEq('(bn5) count 4 (all emits landed)', captured.count, 4);
  }

  console.log('\n--- (bo) §4.7.2.2 · resumeFrom replays entries strictly-after cursor ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const replayed: string[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      resume_enabled: true,
      resume_history_size: 5,
    }));
    app.get('/sse-resume', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1, undefined, 'id1');
      captured.emit('b', 2, undefined, 'id2');
      captured.emit('c', 3, undefined, 'id3');
      captured.resumeFrom('id1', (e) => replayed.push(`${e.id}:${e.name}:${e.dur}`));
      res.end();
    });
    await request(app).get('/sse-resume');
    assertEq('(bo1) replay strictly-after id1', replayed.join(','), 'id2:b:2,id3:c:3');
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const replayed: string[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      resume_enabled: true,
    }));
    app.get('/sse-resume-all', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1, undefined, 'id1');
      captured.emit('b', 2, undefined, 'id2');
      captured.resumeFrom(null, (e) => replayed.push(e.id));
      captured.resumeFrom(undefined, (e) => replayed.push(`u:${e.id}`));
      captured.resumeFrom('', (e) => replayed.push(`e:${e.id}`));
      captured.resumeFrom('not-in-cache', (e) => replayed.push(`x:${e.id}`));
      res.end();
    });
    await request(app).get('/sse-resume-all');
    assertEq('(bo2) null cursor → replay all',
      replayed.join(','),
      'id1,id2,u:id1,u:id2,e:id1,e:id2,x:id1,x:id2');
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const replayed: string[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      resume_enabled: true,
    }));
    app.get('/sse-resume-last', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1, undefined, 'id1');
      captured.emit('b', 2, undefined, 'id2');
      captured.resumeFrom('id2', (e) => replayed.push(e.id));
      res.end();
    });
    await request(app).get('/sse-resume-last');
    assertEq('(bo3) cursor at newest → nothing to replay', replayed.length, 0);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const replayed: string[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      resume_enabled: true,
    }));
    app.get('/sse-resume-throw', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1, undefined, 'id1');
      captured.emit('b', 2, undefined, 'id2');
      captured.emit('c', 3, undefined, 'id3');
      captured.resumeFrom(null, (e) => {
        if (e.id === 'id2') throw new Error('boom');
        replayed.push(e.id);
      });
      res.end();
    });
    await request(app).get('/sse-resume-throw');
    assertEq('(bo4) per-entry throw fail-OPEN · other entries still replayed',
      replayed.join(','), 'id1,id3');
  }

  console.log('\n--- (bp) §4.7.2.2 · ring-buffer bounded LIFO cap ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const replayed: string[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      resume_enabled: true,
      resume_history_size: 2,
    }));
    app.get('/sse-cap', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1, undefined, 'id1');
      captured.emit('b', 2, undefined, 'id2');
      captured.emit('c', 3, undefined, 'id3');
      captured.emit('d', 4, undefined, 'id4');
      captured.resumeFrom(null, (e) => replayed.push(e.id));
      res.end();
    });
    await request(app).get('/sse-cap');
    assertEq('(bp1) only newest 2 retained (LIFO cap)', replayed.join(','), 'id3,id4');
    assertEq('(bp2) lastEventId is id4', captured.lastEventId, 'id4');
  }

  console.log('\n--- (bq) §4.7.2.2 · resumeFrom no-op when disabled / non-SSE / closed ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const replayed: string[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, resume_enabled: false }));
    app.get('/sse-off', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1, undefined, 'id1');
      captured.resumeFrom(null, (e) => replayed.push(e.id));
      res.end();
    });
    await request(app).get('/sse-off');
    assertEq('(bq1) resume disabled → no replay', replayed.length, 0);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const replayed: string[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, resume_enabled: true }));
    app.get('/none-r', (_req, res) => {
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.resumeFrom(null, (e) => replayed.push(e.id));
      res.status(200).json({ ok: true });
    });
    await request(app).get('/none-r');
    assertEq('(bq2) kind:none → no replay', replayed.length, 0);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const replayed: string[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, resume_enabled: true }));
    app.get('/sse-closed', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1, undefined, 'id1');
      captured.close();
      captured.resumeFrom(null, (e) => replayed.push(e.id));
      res.end();
    });
    await request(app).get('/sse-closed');
    assertEq('(bq3) closed → no replay', replayed.length, 0);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    let called = 0;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, resume_enabled: true }));
    app.get('/sse-badcb', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('a', 1, undefined, 'id1');
      captured.resumeFrom(null, undefined as unknown as (e: unknown) => void);
      called = captured.count;
      res.end();
    });
    await request(app).get('/sse-badcb');
    assertEq('(bq4) non-fn replay callback → no throw', called, 1);
  }

  console.log('\n--- (br) §4.7.2.2 · buildNoopAdapter resume surface complete ---');
  {
    const noop = __test__.buildNoopAdapter();
    assertEq('(br1) noop.lastEventId null', noop.lastEventId, null);
    assertEq('(br2) noop.resumeFrom callable', typeof noop.resumeFrom, 'function');
    let called = 0;
    noop.emit('n', 1, undefined, 'id1');
    noop.resumeFrom('id1', () => { called++; });
    assertEq('(br3) noop.resumeFrom no-op zero-call', called, 0);
    assertEq('(br4) noop.lastEventId stays null', noop.lastEventId, null);
  }

  console.log('\n--- (bs) §4.7.2.3 · retry config validators ---');
  assertEq('(bs1) isValidRetryMs 3000 cap 300000', __test__.isValidRetryMs(3000, 300000), true);
  assertEq('(bs2) isValidRetryMs 1 cap 1', __test__.isValidRetryMs(1, 1), true);
  assertEq('(bs3) isValidRetryMs 300000 cap 300000', __test__.isValidRetryMs(300000, 300000), true);
  assertEq('(bs4) isValidRetryMs 0 → false', __test__.isValidRetryMs(0, 300000), false);
  assertEq('(bs5) isValidRetryMs -1 → false', __test__.isValidRetryMs(-1, 300000), false);
  assertEq('(bs6) isValidRetryMs > cap → false', __test__.isValidRetryMs(300001, 300000), false);
  assertEq('(bs7) isValidRetryMs 1.5 → false', __test__.isValidRetryMs(1.5, 300000), false);
  assertEq('(bs8) isValidRetryMs NaN → false', __test__.isValidRetryMs(NaN, 300000), false);
  assertEq('(bs9) isValidRetryMs Infinity → false', __test__.isValidRetryMs(Infinity, 300000), false);
  assertEq('(bs10) isValidRetryMs string → false', __test__.isValidRetryMs('3000', 300000), false);
  assertEq('(bs11) isValidRetryMs null → false', __test__.isValidRetryMs(null, 300000), false);
  assertEq('(bs12) isValidRetryMs undefined → false', __test__.isValidRetryMs(undefined, 300000), false);
  assertEq('(bs13) isValidRetryCap 300000 → true', __test__.isValidRetryCap(300000), true);
  assertEq('(bs14) isValidRetryCap 1 → true', __test__.isValidRetryCap(1), true);
  assertEq('(bs15) isValidRetryCap 0 → false', __test__.isValidRetryCap(0), false);
  assertEq('(bs16) isValidRetryCap -1 → false', __test__.isValidRetryCap(-1), false);
  assertEq('(bs17) isValidRetryCap 1.5 → false', __test__.isValidRetryCap(1.5), false);
  assertEq('(bs18) isValidRetryCap NaN → false', __test__.isValidRetryCap(NaN), false);
  assertEq('(bs19) isValidRetryCap "1" → false', __test__.isValidRetryCap('1'), false);
  assertEq('(bs20) isValidRetryCap null → false', __test__.isValidRetryCap(null), false);

  console.log('\n--- (bt) §4.7.2.3 · serializeSseRetryFrame frame-shape ---');
  assertEq('(bt1) serialize 3000', __test__.serializeSseRetryFrame(3000), 'retry: 3000\n\n');
  assertEq('(bt2) serialize 1', __test__.serializeSseRetryFrame(1), 'retry: 1\n\n');
  assertEq('(bt3) serialize 300000', __test__.serializeSseRetryFrame(300000), 'retry: 300000\n\n');

  console.log('\n--- (bu) §4.7.2.3 · adapter.setReconnectMs SSE success path ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const chunks: Buffer[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: true }));
    app.get('/sse-retry-ok', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      const origWrite = res.write.bind(res);
      (res as unknown as { write: typeof origWrite }).write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
        else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof origWrite;
      captured.setReconnectMs(5000);
      captured.setReconnectMs(2500);
      res.end();
    });
    await request(app).get('/sse-retry-ok');
    const joined = Buffer.concat(chunks).toString('utf8');
    assertEq('(bu1) sse retry frame 5000 emitted', joined.includes('retry: 5000\n\n'), true);
    assertEq('(bu2) sse retry frame 2500 emitted', joined.includes('retry: 2500\n\n'), true);
    assertEq('(bu3) reconnectMs cursor last-wins 2500', captured.reconnectMs, 2500);
  }

  console.log('\n--- (bv) §4.7.2.3 · setReconnectMs fail-OPEN 6-axis ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: false }));
    app.get('/sse-retry-disabled', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.setReconnectMs(3000);
      res.end();
    });
    await request(app).get('/sse-retry-disabled');
    assertEq('(bv1) retry_enabled=false → reconnectMs stays null', captured.reconnectMs, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: true }));
    app.get('/json-retry', async (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.setReconnectMs(3000);
      res.json({ ok: true });
    });
    await request(app).get('/json-retry');
    assertEq('(bv2) kind !== sse → reconnectMs stays null', captured.reconnectMs, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: true }));
    app.get('/sse-retry-zero', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.setReconnectMs(0);
      captured.setReconnectMs(-1);
      captured.setReconnectMs(1.5);
      captured.setReconnectMs(NaN);
      captured.setReconnectMs('3000' as unknown as number);
      res.end();
    });
    await request(app).get('/sse-retry-zero');
    assertEq('(bv3) invalid ms 5-way rejects → reconnectMs stays null', captured.reconnectMs, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: true }));
    app.get('/sse-retry-closed', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.close();
      captured.setReconnectMs(3000);
      res.end();
    });
    await request(app).get('/sse-retry-closed');
    assertEq('(bv4) adapter.close() then setReconnectMs → reconnectMs stays null', captured.reconnectMs, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: true, retry_max_ms: 10000 }));
    app.get('/sse-retry-cap', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.setReconnectMs(10001);
      res.end();
    });
    await request(app).get('/sse-retry-cap');
    assertEq('(bv5) ms > retry_max_ms cap → reconnectMs stays null', captured.reconnectMs, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: true, retry_max_ms: -1 as unknown as number }));
    app.get('/sse-retry-badcap', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.setReconnectMs(299999);
      res.end();
    });
    await request(app).get('/sse-retry-badcap');
    assertEq('(bv6) invalid retry_max_ms falls back to default 300000 → 299999 accepted', captured.reconnectMs, 299999);
  }

  console.log('\n--- (bw) §4.7.2.3 · setReconnectMs cap boundary + config default resolution ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: true, retry_max_ms: 5000 }));
    app.get('/sse-retry-boundary', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.setReconnectMs(5000);
      res.end();
    });
    await request(app).get('/sse-retry-boundary');
    assertEq('(bw1) ms === cap 5000 accepted (inclusive upper bound)', captured.reconnectMs, 5000);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: true }));
    app.get('/sse-retry-lower', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.setReconnectMs(1);
      res.end();
    });
    await request(app).get('/sse-retry-lower');
    assertEq('(bw2) ms === 1 accepted (inclusive lower bound)', captured.reconnectMs, 1);
  }

  console.log('\n--- (bx) §4.7.2.3 · retry frame does not affect emit/count/lastEventId ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, retry_enabled: true }));
    app.get('/sse-retry-crossaxis', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.setReconnectMs(3000);
      captured.emit('m', 1);
      res.end();
    });
    await request(app).get('/sse-retry-crossaxis');
    assertEq('(bx1) retry does not bump count', captured.count, 1);
    assertEq('(bx2) retry does not touch lastEventId', captured.lastEventId, null);
    assertEq('(bx3) reconnectMs 3000 set', captured.reconnectMs, 3000);
  }

  console.log('\n--- (by) §4.7.2.3 · buildNoopAdapter retry surface parity ---');
  {
    const noop = __test__.buildNoopAdapter();
    assertEq('(by1) noop.reconnectMs null', noop.reconnectMs, null);
    assertEq('(by2) noop.setReconnectMs callable', typeof noop.setReconnectMs, 'function');
    noop.setReconnectMs(3000);
    assertEq('(by3) noop.setReconnectMs no-op keeps reconnectMs null', noop.reconnectMs, null);
    assertEq('(by4) noop kind stays none', noop.kind, 'none');
  }

  console.log('\n--- (bz) §4.7.2.4 · error-frame validators + sanitizer ---');
  assertEq('(bz1) isValidErrorReason plain token', __test__.isValidErrorReason('stream_terminated'), true);
  assertEq('(bz2) isValidErrorReason tchar mix', __test__.isValidErrorReason("a!#$%&'*+-.^_`|~0-9A-Za-z"), true);
  assertEq('(bz3) isValidErrorReason empty → false', __test__.isValidErrorReason(''), false);
  assertEq('(bz4) isValidErrorReason space → false', __test__.isValidErrorReason('stream terminated'), false);
  assertEq('(bz5) isValidErrorReason CRLF → false', __test__.isValidErrorReason('a\nb'), false);
  assertEq('(bz6) isValidErrorReason semicolon → false', __test__.isValidErrorReason('a;b'), false);
  assertEq('(bz7) isValidErrorReason unicode → false', __test__.isValidErrorReason('数据库'), false);
  assertEq('(bz8) isValidErrorReason undefined → false', __test__.isValidErrorReason(undefined), false);
  assertEq('(bz9) isValidErrorReason number → false', __test__.isValidErrorReason(500 as unknown), false);
  assertEq('(bz10) isValidErrorReason null → false', __test__.isValidErrorReason(null), false);
  assertEq('(bz11) sanitize default plain', __test__.sanitizeErrorFrameDefaultReason('client_gone'), 'client_gone');
  assertEq('(bz12) sanitize default empty → fallback', __test__.sanitizeErrorFrameDefaultReason(''), 'stream_terminated');
  assertEq('(bz13) sanitize default non-token → fallback', __test__.sanitizeErrorFrameDefaultReason('a b'), 'stream_terminated');
  assertEq('(bz14) sanitize default undefined → fallback', __test__.sanitizeErrorFrameDefaultReason(undefined), 'stream_terminated');
  assertEq('(bz15) sanitize default number → fallback', __test__.sanitizeErrorFrameDefaultReason(42 as unknown), 'stream_terminated');

  console.log('\n--- (ca) §4.7.2.4 · serializeSseErrorFrame frame-shape ---');
  assertEq('(ca1) serialize plain', __test__.serializeSseErrorFrame('stream_terminated'), ': error stream_terminated\n\n');
  assertEq('(ca2) serialize tchar', __test__.serializeSseErrorFrame('upstream_5xx'), ': error upstream_5xx\n\n');
  assertEq('(ca3) serialize single-char', __test__.serializeSseErrorFrame('x'), ': error x\n\n');

  console.log('\n--- (cb) §4.7.2.4 · adapter.emitStreamError SSE success path ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const chunks: Buffer[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, error_frame_enabled: true }));
    app.get('/sse-err-ok', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      const origWrite = res.write.bind(res);
      (res as unknown as { write: typeof origWrite }).write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
        else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof origWrite;
      captured.emitStreamError('upstream_5xx');
      captured.emitStreamError('client_gone');
      res.end();
    });
    await request(app).get('/sse-err-ok');
    const joined = Buffer.concat(chunks).toString('utf8');
    assertEq('(cb1) sse error frame upstream_5xx emitted', joined.includes(': error upstream_5xx\n\n'), true);
    assertEq('(cb2) sse error frame client_gone emitted', joined.includes(': error client_gone\n\n'), true);
    assertEq('(cb3) errorReason cursor last-wins client_gone', captured.errorReason, 'client_gone');
    assertEq('(cb4) reconnectMs stays null when retriable omitted', captured.reconnectMs, null);
  }

  console.log('\n--- (cc) §4.7.2.4 · emitStreamError retriable emits preceding retry frame ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const chunks: Buffer[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      error_frame_enabled: true,
      retry_default_ms: 4500,
    }));
    app.get('/sse-err-retriable', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      const origWrite = res.write.bind(res);
      (res as unknown as { write: typeof origWrite }).write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
        else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof origWrite;
      captured.emitStreamError('transient_fault', true);
      res.end();
    });
    await request(app).get('/sse-err-retriable');
    const joined = Buffer.concat(chunks).toString('utf8');
    const retryIdx = joined.indexOf('retry: 4500\n\n');
    const errIdx = joined.indexOf(': error transient_fault\n\n');
    assertEq('(cc1) retry frame emitted', retryIdx >= 0, true);
    assertEq('(cc2) error frame emitted', errIdx >= 0, true);
    assertEq('(cc3) retry precedes error frame', retryIdx >= 0 && errIdx > retryIdx, true);
    assertEq('(cc4) reconnectMs updated from retriable=true', captured.reconnectMs, 4500);
    assertEq('(cc5) errorReason updated', captured.errorReason, 'transient_fault');
  }

  console.log('\n--- (cd) §4.7.2.4 · emitStreamError fail-OPEN 6-axis ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, error_frame_enabled: false }));
    app.get('/sse-err-disabled', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emitStreamError('boom');
      res.end();
    });
    await request(app).get('/sse-err-disabled');
    assertEq('(cd1) error_frame_enabled=false → errorReason stays null', captured.errorReason, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, error_frame_enabled: true }));
    app.get('/json-err', async (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emitStreamError('boom');
      res.json({ ok: true });
    });
    await request(app).get('/json-err');
    assertEq('(cd2) kind !== sse → errorReason stays null', captured.errorReason, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, error_frame_enabled: true }));
    app.get('/sse-err-invalid', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emitStreamError('');
      captured.emitStreamError('has space');
      captured.emitStreamError('a\nb');
      captured.emitStreamError(42 as unknown as string);
      captured.emitStreamError(undefined as unknown as string);
      res.end();
    });
    await request(app).get('/sse-err-invalid');
    assertEq('(cd3) invalid reason 5-way rejects → errorReason stays null', captured.errorReason, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, error_frame_enabled: true }));
    app.get('/sse-err-closed', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.close();
      captured.emitStreamError('boom');
      res.end();
    });
    await request(app).get('/sse-err-closed');
    assertEq('(cd4) adapter.close() then emitStreamError → errorReason stays null', captured.errorReason, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, error_frame_enabled: true }));
    app.get('/sse-err-writable-ended', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      res.end();
      captured.emitStreamError('post_end');
    });
    await request(app).get('/sse-err-writable-ended');
    assertEq('(cd5) writableEnded → errorReason stays null', captured.errorReason, null);
  }
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, error_frame_enabled: true }));
    app.get('/sse-err-writethrow', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      const origWrite = res.write.bind(res);
      let firstCall = true;
      (res as unknown as { write: typeof origWrite }).write = ((chunk: unknown, ...rest: unknown[]) => {
        if (firstCall) {
          firstCall = false;
          throw new Error('EPIPE');
        }
        return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof origWrite;
      captured.emitStreamError('should_not_persist');
      res.end();
    });
    await request(app).get('/sse-err-writethrow');
    assertEq('(cd6) res.write throw → fail-OPEN, errorReason stays null', captured.errorReason, null);
  }

  console.log('\n--- (ce) §4.7.2.4 · retriable=true with invalid retry_default_ms skips retry but emits error ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const chunks: Buffer[] = [];
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({
      enabled: true,
      error_frame_enabled: true,
      retry_default_ms: -5 as unknown as number,
      retry_max_ms: 100,
    }));
    app.get('/sse-err-badretry', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      const origWrite = res.write.bind(res);
      (res as unknown as { write: typeof origWrite }).write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
        else if (Buffer.isBuffer(chunk)) chunks.push(chunk);
        return (origWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof origWrite;
      captured.emitStreamError('degraded', true);
      res.end();
    });
    await request(app).get('/sse-err-badretry');
    const joined = Buffer.concat(chunks).toString('utf8');
    // retry_default_ms bad → falls back to 3000 (default constant). retry_max_ms 100 caps → 3000 > 100 → retry emit skipped.
    assertEq('(ce1) retry frame skipped when default resolves > cap', joined.includes('retry: '), false);
    assertEq('(ce2) error frame still emitted', joined.includes(': error degraded\n\n'), true);
    assertEq('(ce3) errorReason updated even without retry', captured.errorReason, 'degraded');
    assertEq('(ce4) reconnectMs stays null when retry emit skipped', captured.reconnectMs, null);
  }

  console.log('\n--- (cf) §4.7.2.4 · emitStreamError does not affect emit/count/lastEventId/heartbeatCount ---');
  {
    let captured!: ServerTimingStreamAdapter;
    const app = express();
    app.use(buildApiServerTimingStreamingMiddleware({ enabled: true, error_frame_enabled: true }));
    app.get('/sse-err-crossaxis', async (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.status(200);
      captured = (res.locals as Record<string, unknown>).serverTimingStream as ServerTimingStreamAdapter;
      captured.emit('m', 1);
      captured.emitStreamError('after_metric');
      res.end();
    });
    await request(app).get('/sse-err-crossaxis');
    assertEq('(cf1) error does not bump count', captured.count, 1);
    assertEq('(cf2) error does not touch lastEventId', captured.lastEventId, null);
    assertEq('(cf3) error does not touch heartbeatCount', captured.heartbeatCount, 0);
    assertEq('(cf4) errorReason set', captured.errorReason, 'after_metric');
  }

  console.log('\n--- (cg) §4.7.2.4 · buildNoopAdapter error surface parity ---');
  {
    const noop = __test__.buildNoopAdapter();
    assertEq('(cg1) noop.errorReason null', noop.errorReason, null);
    assertEq('(cg2) noop.emitStreamError callable', typeof noop.emitStreamError, 'function');
    noop.emitStreamError('boom');
    noop.emitStreamError('boom', true);
    assertEq('(cg3) noop.emitStreamError no-op keeps errorReason null', noop.errorReason, null);
    assertEq('(cg4) noop.emitStreamError no-op keeps reconnectMs null', noop.reconnectMs, null);
    assertEq('(cg5) noop kind stays none', noop.kind, 'none');
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
