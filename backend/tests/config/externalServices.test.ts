/**
 * externalServices — unit tests (audit L-19 修复).
 *
 * 直接 ts-node:
 *   cd backend && npx ts-node --transpile-only tests/config/externalServices.test.ts
 *
 * 覆盖维度:
 *   - 默认 fallback 是 loopback 127.0.0.1 (不暴露内部 IP);
 *   - env 覆盖生效 (TRADING_AGENTS_URL=http://example.com:9000 → 同值);
 *   - 必须无尾部 `/` (调用方约定 `${base}/api/...` 拼接).
 *
 * 注: 由于 const 在 module 首次加载时取值, 单测里通过 require + delete cache
 * 实现 env 切换后重新加载验证.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';

let failed = 0;
let passed = 0;

function it(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (err: any) {
    console.error(`  FAIL ${name}: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    failed += 1;
  }
}

const modulePath = path.resolve(__dirname, '../../src/config/externalServices');

function loadFresh(): typeof import('../../src/config/externalServices') {
  delete require.cache[require.resolve(modulePath)];
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(modulePath);
}

console.log('externalServices');

it('默认值 = 127.0.0.1:8000 (无尾斜杠, 不暴露内部 IP)', () => {
  delete process.env.TRADING_AGENTS_URL;
  const { TRADING_AGENTS_BASE_URL } = loadFresh();
  assert.equal(TRADING_AGENTS_BASE_URL, 'http://127.0.0.1:8000');
});

it('env 覆盖生效', () => {
  process.env.TRADING_AGENTS_URL = 'http://example.com:9000';
  const { TRADING_AGENTS_BASE_URL } = loadFresh();
  assert.equal(TRADING_AGENTS_BASE_URL, 'http://example.com:9000');
});

it('env 空字符串 → 走默认 (空串是 falsy)', () => {
  process.env.TRADING_AGENTS_URL = '';
  const { TRADING_AGENTS_BASE_URL } = loadFresh();
  assert.equal(TRADING_AGENTS_BASE_URL, 'http://127.0.0.1:8000');
});

it('https env 也透传', () => {
  process.env.TRADING_AGENTS_URL = 'https://prod-ai.internal:8443';
  const { TRADING_AGENTS_BASE_URL } = loadFresh();
  assert.equal(TRADING_AGENTS_BASE_URL, 'https://prod-ai.internal:8443');
});

it('值不含尾部 /, 调用方拼 /api/... 不出现 //', () => {
  process.env.TRADING_AGENTS_URL = 'http://example.com:9000';
  const { TRADING_AGENTS_BASE_URL } = loadFresh();
  assert.ok(!TRADING_AGENTS_BASE_URL.endsWith('/'));
  const url = `${TRADING_AGENTS_BASE_URL}/api/analyze`;
  assert.ok(!url.includes('//api'));
});

console.log(`\nexternalServices: ${passed} ok / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
