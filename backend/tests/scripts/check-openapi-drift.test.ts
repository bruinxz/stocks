/**
 * check-openapi-drift 单元测试 (US-098 / OPS-009)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/scripts/check-openapi-drift.test.ts
 *
 * 覆盖 4 件套：
 *   1. serializeSpecForCompare —— 与 generate-openapi.ts 落盘 byte-for-byte 一致
 *      (`JSON.stringify(spec, null, 2)` 无 trailing newline). 这条契约不守
 *      CI 永远会误报 drift.
 *   2. checkOpenApiDrift in_sync —— 注入 spec + 与之等价的磁盘内容 → ok=true
 *   3. checkOpenApiDrift drift —— 注入 spec + 与之不同的磁盘内容 → ok=false,
 *      reason='drift', firstDiffOffset > 0, diffSnippet 含 "+++ actual"
 *   4. checkOpenApiDrift missing_file —— existsSync 返 false → ok=false, reason='missing_file'
 *   5. buildDriftDiffSnippet —— line-level snippet 含改动行 + ±5 行上下文
 *   6. 真实集成：跑一次 buildOpenApiSpec() 后再 checkOpenApiDrift 自身 → 必须 in_sync
 *      (保证仓库提交的 docs/openapi.json 与代码同步, 防 PRD AC 退化)
 *   7. 反向覆盖：手动构造一份"少一个 path"的 spec → drift 必能侦测到
 */

import path from 'path';
import {
  serializeSpecForCompare,
  buildDriftDiffSnippet,
  checkOpenApiDrift,
} from '../../src/scripts/check-openapi-drift';
import { buildOpenApiSpec } from '../../src/config/swagger';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
// silence logger
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loggerModule = require('../../src/utils/logger');
loggerModule.logger.info = () => undefined;
loggerModule.logger.warn = () => undefined;
loggerModule.logger.error = () => undefined;

// ---------------------------------------------------------------------------
// [1] serializeSpecForCompare 契约：与 generate-openapi.ts 同 format
// ---------------------------------------------------------------------------
(function testSerializeContract() {
  const spec = { openapi: '3.0.3', info: { title: 'X', version: '1.0.0' } };
  const out = serializeSpecForCompare(spec);
  // 与 generate-openapi.ts `JSON.stringify(spec, null, 2)` 完全一致：indent=2, 无 trailing \n
  assertEqual('[1.a] serializeSpecForCompare uses 2-space indent', out, JSON.stringify(spec, null, 2));
  assert('[1.b] serializeSpecForCompare has no trailing newline', !out.endsWith('\n'));
})();

// ---------------------------------------------------------------------------
// [2] in_sync 路径
// ---------------------------------------------------------------------------
(function testInSync() {
  const spec = { openapi: '3.0.3', info: { title: 'T', version: '1' }, paths: {} };
  const serialized = serializeSpecForCompare(spec);
  const r = checkOpenApiDrift({
    spec,
    in: '/fake/openapi.json',
    existsSync: () => true,
    readFile: () => serialized,
  });
  assertEqual('[2.a] in_sync ok', r.ok, true);
  assertEqual('[2.b] in_sync reason', r.reason, 'in_sync');
  assertEqual('[2.c] in_sync inPath', r.inPath, '/fake/openapi.json');
  assertEqual('[2.d] in_sync expected==actual bytes', r.expectedBytes, r.actualBytes);
})();

// ---------------------------------------------------------------------------
// [3] drift 路径
// ---------------------------------------------------------------------------
(function testDrift() {
  const expectedSpec = { openapi: '3.0.3', info: { title: 'OLD', version: '1' } };
  const actualSpec = { openapi: '3.0.3', info: { title: 'NEW', version: '1' } };
  const r = checkOpenApiDrift({
    spec: actualSpec,
    in: '/fake/openapi.json',
    existsSync: () => true,
    readFile: () => serializeSpecForCompare(expectedSpec),
  });
  assertEqual('[3.a] drift ok=false', r.ok, false);
  assertEqual('[3.b] drift reason', r.reason, 'drift');
  assert('[3.c] drift firstDiffOffset positive', (r.firstDiffOffset ?? -1) > 0);
  assert(
    '[3.d] drift snippet contains +++ actual marker',
    typeof r.diffSnippet === 'string' && r.diffSnippet.includes('+++ actual')
  );
  assert(
    '[3.e] drift snippet contains --- expected marker',
    typeof r.diffSnippet === 'string' && r.diffSnippet.includes('--- expected')
  );
})();

// ---------------------------------------------------------------------------
// [4] missing_file 路径
// ---------------------------------------------------------------------------
(function testMissingFile() {
  const r = checkOpenApiDrift({
    in: '/nope/openapi.json',
    existsSync: () => false,
  });
  assertEqual('[4.a] missing_file ok=false', r.ok, false);
  assertEqual('[4.b] missing_file reason', r.reason, 'missing_file');
  assertEqual('[4.c] missing_file inPath', r.inPath, '/nope/openapi.json');
})();

// ---------------------------------------------------------------------------
// [5] buildDriftDiffSnippet line-level
// ---------------------------------------------------------------------------
(function testDiffSnippet() {
  const expected = ['line1', 'line2', 'line3 OLD', 'line4', 'line5'].join('\n');
  const actual = ['line1', 'line2', 'line3 NEW', 'line4', 'line5'].join('\n');
  const { offset, snippet } = buildDriftDiffSnippet(expected, actual);
  assert('[5.a] offset > 0', offset > 0);
  assert('[5.b] snippet includes OLD', snippet.includes('OLD'));
  assert('[5.c] snippet includes NEW', snippet.includes('NEW'));
  assert('[5.d] snippet labels both sides', snippet.includes('--- expected') && snippet.includes('+++ actual'));
})();

// ---------------------------------------------------------------------------
// [6] 真实集成：跑一次 buildOpenApiSpec + check 自己提交的 docs/openapi.json
//     必须 in_sync. PRD AC: "openapi.json 与代码同步 / CI 检查通过".
// ---------------------------------------------------------------------------
(function testRealRepoInSync() {
  const repoOpenApi = path.resolve(__dirname, '../../../docs/openapi.json');
  const r = checkOpenApiDrift({ in: repoOpenApi });
  if (!r.ok) {
    console.error('[6.x] REPO drift detail offset=', r.firstDiffOffset);
    console.error(r.diffSnippet);
  }
  assertEqual('[6.a] real repo docs/openapi.json in sync with code', r.ok, true);
  assertEqual('[6.b] real repo reason', r.reason, 'in_sync');
})();

// ---------------------------------------------------------------------------
// [7] 反向覆盖：构造缺一个 path 的 fake spec, 与磁盘当前 spec 比对必报 drift.
//     防"check 永远过" 这类 false-negative bug.
// ---------------------------------------------------------------------------
(function testNegativeDriftDetection() {
  const realSpec = buildOpenApiSpec() as { paths?: Record<string, unknown> };
  const realPaths = realSpec.paths || {};
  const pathKeys = Object.keys(realPaths);
  // 删一个 path 模拟"开发者改了 routes 但没重新生成"
  const fakeSpec = JSON.parse(JSON.stringify(realSpec));
  if (pathKeys.length > 0) {
    delete fakeSpec.paths[pathKeys[0]];
  }
  const expected = serializeSpecForCompare(realSpec);
  const r = checkOpenApiDrift({
    spec: fakeSpec,
    in: '/fake/openapi.json',
    existsSync: () => true,
    readFile: () => expected,
  });
  assertEqual('[7.a] negative drift detected ok=false', r.ok, false);
  assertEqual('[7.b] negative drift reason=drift', r.reason, 'drift');
  assert('[7.c] negative drift snippet non-empty', !!(r.diffSnippet && r.diffSnippet.length > 0));
})();

// ---------------------------------------------------------------------------
// 输出 summary + 退出
// ---------------------------------------------------------------------------
console.log('');
console.log(`check-openapi-drift.test.ts: ${passed} ok / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
