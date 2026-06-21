/**
 * US-073 [FE-034] /ws/alerts WebSocket server — 纯 helper + wiring 单元测试.
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/realtime/alerts-websocket-server.test.ts
 * 或:
 *   cd backend && npm test -- --filter=alerts-websocket-server
 *
 * 覆盖维度:
 *   [1] 常量 sanity
 *   [2] extractTokenFromQuery — 缺 / 空 / trim / encoded
 *   [3] verifyAlertsToken — 缺 token/secret / decoded.user_id / decoded.user.id / 非法
 *   [4] loadJwtSecretFromEnv — JWT_SECRET / LIVE_DEV_JWT_SECRET / production fail-CLOSED
 *   [5] META-GUARD — index.ts 含 attachAlertsWebSocketServer 接入 + http.createServer
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';

import {
  ALERTS_WS_CLOSE,
  ALERTS_WS_PATH,
  ALERTS_WS_PING_INTERVAL_MS,
  extractTokenFromQuery,
  loadJwtSecretFromEnv,
  verifyAlertsToken,
} from '../../src/realtime/alertsWebSocketServer';

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

// ============================================================
// [1] 常量 sanity
// ============================================================
assert('[1.1] ALERTS_WS_PATH = /ws/alerts', ALERTS_WS_PATH === '/ws/alerts');
assert('[1.2] PING_INTERVAL > 0', ALERTS_WS_PING_INTERVAL_MS > 0);
assert(
  '[1.3] PING_INTERVAL >= 10s (防 NAT 断 idle)',
  ALERTS_WS_PING_INTERVAL_MS >= 10_000
);
assert(
  '[1.4] PING_INTERVAL <= 60s (前端 polling 兜底 30s, ping 不能比兜底慢)',
  ALERTS_WS_PING_INTERVAL_MS <= 60_000
);
assert(
  '[1.5] CLOSE.POLICY_VIOLATION = 1008',
  ALERTS_WS_CLOSE.POLICY_VIOLATION === 1008
);
assert(
  '[1.6] CLOSE.TRY_AGAIN_LATER = 1013',
  ALERTS_WS_CLOSE.TRY_AGAIN_LATER === 1013
);

// ============================================================
// [2] extractTokenFromQuery
// ============================================================
assert(
  '[2.1] 正常 ?token=abc → "abc"',
  extractTokenFromQuery('/ws/alerts?token=abc') === 'abc'
);
assert(
  '[2.2] 缺 ?token → null',
  extractTokenFromQuery('/ws/alerts') === null
);
assert('[2.3] undefined → null', extractTokenFromQuery(undefined) === null);
assert('[2.4] 空 string → null', extractTokenFromQuery('') === null);
assert(
  '[2.5] ?token=  ws→ trim 空 → null',
  extractTokenFromQuery('/ws/alerts?token=   ') === null
);
assert(
  '[2.6] ?token=xx&foo=bar → "xx"',
  extractTokenFromQuery('/ws/alerts?token=xx&foo=bar') === 'xx'
);
assert(
  '[2.7] URL encoded 自动 decode',
  extractTokenFromQuery('/ws/alerts?token=a%2Bb') === 'a+b'
);

// ============================================================
// [3] verifyAlertsToken
// ============================================================
{
  const secret = 'unit-test-secret';
  const goodToken = jwt.sign({ user_id: 42, username: 'alice' }, secret);
  const v = verifyAlertsToken(goodToken, secret);
  assert('[3.1] valid token → {user_id, username}', !!v && v.user_id === 42 && v.username === 'alice');

  const wrongSecret = verifyAlertsToken(goodToken, 'another-secret');
  assert('[3.2] 错 secret → null', wrongSecret === null);

  assert('[3.3] 缺 token → null', verifyAlertsToken(null, secret) === null);
  assert('[3.4] 缺 secret → null', verifyAlertsToken(goodToken, null) === null);
  assert(
    '[3.5] 缺 secret + 缺 token → null',
    verifyAlertsToken(null, null) === null
  );

  // 嵌套 user.id 兼容
  const nestedToken = jwt.sign({ user: { id: 7, username: 'bob' } }, secret);
  const nv = verifyAlertsToken(nestedToken, secret);
  assert(
    '[3.6] decoded.user.id 兼容',
    !!nv && nv.user_id === 7 && nv.username === 'bob'
  );

  // 顶层 id (e.g. AuthController 旧 token shape)
  const idToken = jwt.sign({ id: 99 }, secret);
  const idv = verifyAlertsToken(idToken, secret);
  assert('[3.7] decoded.id 兼容', !!idv && idv.user_id === 99);

  // 0 / 负 / NaN → null
  const zeroToken = jwt.sign({ user_id: 0 }, secret);
  assert('[3.8] user_id=0 → null', verifyAlertsToken(zeroToken, secret) === null);
  const negToken = jwt.sign({ user_id: -5 }, secret);
  assert('[3.9] user_id=-5 → null', verifyAlertsToken(negToken, secret) === null);
  const emptyToken = jwt.sign({}, secret);
  assert(
    '[3.10] 缺 user_id 字段 → null',
    verifyAlertsToken(emptyToken, secret) === null
  );

  // 损坏 token
  assert(
    '[3.11] 损坏 token → null',
    verifyAlertsToken('not.a.jwt', secret) === null
  );

  // 过期 token
  const expiredToken = jwt.sign({ user_id: 1 }, secret, { expiresIn: '-1h' });
  assert(
    '[3.12] 过期 token → null',
    verifyAlertsToken(expiredToken, secret) === null
  );
}

// ============================================================
// [4] loadJwtSecretFromEnv
// ============================================================
{
  // 显式 env 注入, 不影响真实 process.env
  const e1: NodeJS.ProcessEnv = { JWT_SECRET: 'main-s', NODE_ENV: 'production' };
  assert('[4.1] JWT_SECRET 配置 → 返该值', loadJwtSecretFromEnv(e1) === 'main-s');

  const e2: NodeJS.ProcessEnv = {
    JWT_SECRET: '',
    LIVE_DEV_JWT_SECRET: 'dev-s',
    NODE_ENV: 'development',
  };
  assert(
    '[4.2] JWT_SECRET 空 + dev mode → fallback LIVE_DEV_JWT_SECRET',
    loadJwtSecretFromEnv(e2) === 'dev-s'
  );

  const e3: NodeJS.ProcessEnv = {
    JWT_SECRET: '',
    LIVE_DEV_JWT_SECRET: 'dev-s',
    NODE_ENV: 'production',
  };
  assert(
    '[4.3] production 模式不退到 LIVE_DEV_JWT_SECRET → null (fail-CLOSED)',
    loadJwtSecretFromEnv(e3) === null
  );

  const e4: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  assert('[4.4] 全缺 (production) → null', loadJwtSecretFromEnv(e4) === null);

  const e5: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
  assert(
    '[4.5] 全缺 (development) → null (不静默退 fallback 字符串)',
    loadJwtSecretFromEnv(e5) === null
  );
}

// ============================================================
// [5] META-GUARD — index.ts 接入
// ============================================================
const indexSrc = readFileSync(join(__dirname, '../../src/index.ts'), 'utf8');
assert(
  '[5.1] index.ts 含 attachAlertsWebSocketServer import',
  /attachAlertsWebSocketServer/.test(indexSrc)
);
assert(
  '[5.2] index.ts 用 http.createServer(app) 包 app',
  /http\.createServer\(app\)/.test(indexSrc) || /createServer\(app\)/.test(indexSrc)
);
assert(
  '[5.3] index.ts 调 httpServer.listen 替代 app.listen (主路径)',
  /httpServer\.listen\(/.test(indexSrc)
);
assert(
  '[5.4] index.ts 调 attachAlertsWebSocketServer(httpServer)',
  /attachAlertsWebSocketServer\(httpServer[)\s,]/.test(indexSrc) ||
    /attachAlertsWebSocketServer\(httpServerOverride/.test(indexSrc)
);
// override 路径也接入了
assert(
  '[5.5] index.ts DB-offline override 路径也 attach 了 ws (高可用)',
  /attachAlertsWsOverride|attachAlertsWebSocketServer\(httpServerOverride/.test(indexSrc)
);

// ============================================================
// summary
// ============================================================
console.log(`\nalerts-websocket-server: ${passed} ok / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
